import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  AgentRunLogger,
  AgentRunOptions,
  AgentRunResult,
  ResolvedAgent,
  TaskContext,
} from "../adapter.js";
import { ZCODE_SETUP_DEFAULTS, type GuiProfile } from "../../config/schema.js";
import { mkdirp } from "../../util/fs.js";
import {
  parseZcodeModel,
  exactUiName,
  ZcodeModelReadbackError,
  ZcodeReasoningLevelError,
  assertZcodeLevelSupported,
  describeZcodeLevelValueError,
  thoughtLevelOfToken,
  thoughtTierSetOf,
} from "./model.js";
import { validateTaskReferences } from "./references.js";
import {
  boundProjectVerdict,
  matchZcodeProject,
  isUnboundTriggerText,
  type ZcodeProjectItem,
} from "./project.js";
import { initialZcodeState, judgeZcodePoll, type ZcodePollState } from "./liveness.js";
import {
  ZcodeCdpClient,
  CdpDisconnectedError,
  CdpUnavailableError,
  type ZcodeClickExactResult,
  type ZcodeProjectMenuResult,
} from "./cdp.js";
import {
  ensureZcodeInstance,
  listZcodeProcessesAsync,
  type ZcodeReady,
  type ZcodeProcess,
  type ZcodeInstanceOptions,
} from "./instance.js";
import { listOwnedDialogs, selectZcodeFolder } from "./dialog.js";
import {
  ZcodeBudget,
  ZcodeBudgetError,
  ZcodeSetupPause,
  transientSetupError,
  permissionError,
} from "./recovery.js";

export interface RunZcodeArgs {
  ctx: TaskContext;
  resolved: ResolvedAgent;
  opts: AgentRunOptions;
  logFile: string;
  deps?: Partial<ZcodeRunDeps>;
}
export interface ZcodeRunDeps {
  ensureInstance: typeof ensureZcodeInstance;
  listProcesses: (options?: ZcodeInstanceOptions) => ZcodeProcess[] | Promise<ZcodeProcess[]>;
  createClient: (
    port: number,
    timeout: number,
    selectors: Record<string, string>,
  ) => ZcodeCdpClient;
  listDialogs: typeof listOwnedDialogs;
  selectFolder: typeof selectZcodeFolder;
  sleep: (ms: number) => Promise<void>;
}
const DEFAULT_DEPS: ZcodeRunDeps = {
  ensureInstance: ensureZcodeInstance,
  listProcesses: listZcodeProcessesAsync,
  createClient: (p, t, s) => new ZcodeCdpClient(p, t, s),
  listDialogs: listOwnedDialogs,
  selectFolder: selectZcodeFolder,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function guiOf(resolved: ResolvedAgent): GuiProfile {
  const g = resolved.profile.gui;
  return {
    setupRecoveryTimeoutMs:
      g?.setupRecoveryTimeoutMs ?? ZCODE_SETUP_DEFAULTS.setupRecoveryTimeoutMs,
    projectTriggerTimeoutMs:
      g?.projectTriggerTimeoutMs ?? ZCODE_SETUP_DEFAULTS.projectTriggerTimeoutMs,
    dialogProbeTimeoutMs: g?.dialogProbeTimeoutMs ?? ZCODE_SETUP_DEFAULTS.dialogProbeTimeoutMs,
    dialogOperationTimeoutMs:
      g?.dialogOperationTimeoutMs ?? ZCODE_SETUP_DEFAULTS.dialogOperationTimeoutMs,
    setupRecoveryMaxRetries:
      g?.setupRecoveryMaxRetries ?? ZCODE_SETUP_DEFAULTS.setupRecoveryMaxRetries,
    cdpPort: g?.cdpPort ?? 9333,
    cdpPortAuto: g?.cdpPortAuto ?? true,
    cdpPortRange: g?.cdpPortRange ?? 30,
    exePath: g?.exePath,
    exeArgs: g?.exeArgs ?? ["--remote-debugging-port=<port>"],
    windowMode: g?.windowMode ?? "reuse",
    launchTimeoutMs: g?.launchTimeoutMs ?? 60_000,
    pollIntervalMs: g?.pollIntervalMs ?? 3_000,
    stableRounds: g?.stableRounds ?? 4,
    idleTimeoutMs: g?.idleTimeoutMs ?? 600_000,
    stallTimeoutMs: g?.stallTimeoutMs ?? 300_000,
    cancelWaitMs: g?.cancelWaitMs ?? 15_000,
    cdpSendTimeoutMs: g?.cdpSendTimeoutMs ?? 15_000,
    progressIntervalMs: g?.progressIntervalMs ?? 30_000,
    modelSwitch: g?.modelSwitch ?? true,
    modeSwitch: false,
    freshSession: g?.freshSession ?? true,
    selectors: g?.selectors ?? {},
    modelRequired: g?.modelRequired ?? true,
    activation: g?.activation ?? "spawn",
    permissionMode: g?.permissionMode,
    defaultPermissionMode: g?.defaultPermissionMode ?? "完全访问",
    defaultAutoFixRounds: g?.defaultAutoFixRounds ?? 2,
  };
}

function fileLogger(
  file: string,
  base: AgentRunLogger,
): { logger: AgentRunLogger; close: () => Promise<void> } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
  stream.write(`\n===== zcode-gui run @ ${new Date().toISOString()} =====\n`);
  const wrap = (level: string) => (m: string) => {
    stream.write(`[${level}] ${m}\n`);
    base[level as "info"](m);
  };
  return {
    logger: { info: wrap("info"), warn: wrap("warn"), error: wrap("error"), debug: wrap("debug") },
    close: () => new Promise((r) => stream.end(r)),
  };
}

function prompt(
  ctx: TaskContext,
  refs: ReturnType<typeof validateTaskReferences>,
  initialDispatch: boolean,
): string {
  let out =
    ctx.resume?.kind === "continue" && ctx.resume.sendMessage
      ? (ctx.resume.message ?? "")
      : ctx.task;
  if (ctx.context?.trim() && initialDispatch) out += `\n\n【上下文与约束】\n${ctx.context}`;
  if (refs.length && initialDispatch)
    out += `\n\n【已验证项目引用】\n${refs.map((r) => `- ${r.directory ? "目录" : "文件"}: ${r.source} => ${r.absolutePath}`).join("\n")}`;
  if (ctx.feedback?.trim()) out += `\n\n【自动验收返修】\n${ctx.feedback}`;
  return out;
}

async function waitBound(
  cdp: ZcodeCdpClient,
  target: string,
  deps: ZcodeRunDeps,
): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    const binding = await cdp.workspaceBinding();
    // 与项目分支共用同一套分层判据（issue #24）：路径可得时严格判等，3.14.x 无路径渠道时按显示名。
    // 点击菜单项后菜单会收起、列表为空，所以这里不传列表——不能因列表缺失而否定已确认的绑定。
    const verdict = boundProjectVerdict(binding, { ambiguous: false }, target);
    if (verdict.bound) return true;
    await deps.sleep(300);
  }
  return false;
}

async function connectStableZcode(
  ready: ZcodeReady,
  gui: GuiProfile,
  deps: ZcodeRunDeps,
  allowLoginPage = false,
): Promise<ZcodeCdpClient> {
  const attempts = Math.max(1, Math.ceil(gui.launchTimeoutMs / 500));
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    const candidate = deps.createClient(ready.port, gui.cdpSendTimeoutMs, gui.selectors);
    try {
      // eslint-disable-next-line no-await-in-loop
      await candidate.connect();
      // A listed target can still belong to a busy/reloading renderer. Require
      // a real DOM round-trip before using the connection.
      // eslint-disable-next-line no-await-in-loop
      if (allowLoginPage && (await candidate.exists("loginPage"))) return candidate;
      // eslint-disable-next-line no-await-in-loop
      if (allowLoginPage && (await candidate.exists("questionCard"))) return candidate;
      // eslint-disable-next-line no-await-in-loop
      if (await candidate.exists("chatInput")) return candidate;
      lastError = new Error("ZCode 输入框尚未恢复");
    } catch (error) {
      lastError = error;
    }
    candidate.disconnect();
    // eslint-disable-next-line no-await-in-loop
    await deps.sleep(500);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`ZCode CDP 未在 ${gui.launchTimeoutMs}ms 内恢复`);
}

async function clickExactWhenReady(
  cdp: ZcodeCdpClient,
  key: "providerOption" | "modelOption" | "permissionOption" | "chooseFolder",
  value: string,
  deps: ZcodeRunDeps,
  mode: "click" | "hover" = "click",
): ReturnType<ZcodeCdpClient["clickExact"]> {
  let last: ZcodeClickExactResult = { clicked: false, count: 0, available: [] };
  for (let i = 0; i < 15; i++) {
    // eslint-disable-next-line no-await-in-loop
    last = await cdp.clickExact(key, value, mode);
    if (last.clicked || last.count > 1) return last;
    // eslint-disable-next-line no-await-in-loop
    await deps.sleep(200);
  }
  return last;
}

async function clickAnyExactWhenReady(
  cdp: ZcodeCdpClient,
  key: "chooseFolder",
  values: string[],
  deps: ZcodeRunDeps,
): ReturnType<ZcodeCdpClient["clickExact"]> {
  let last: ZcodeClickExactResult = { clicked: false, count: 0, available: [] };
  for (let i = 0; i < 15; i++) {
    for (const value of values) {
      // eslint-disable-next-line no-await-in-loop
      last = await cdp.clickExact(key, value);
      if (last.clicked || last.count > 1) return last;
    }
    // eslint-disable-next-line no-await-in-loop
    await deps.sleep(200);
  }
  return last;
}

/**
 * 项目触发器失败的归类文案：区分未挂载、不可见/裁剪、不唯一、遮挡与点击后无响应，
 * 不让早退（不唯一/禁用）被含糊成「等待超时」。
 */
function describeProjectTriggerFailure(outcome: ZcodeProjectMenuResult): string {
  const { probe, reason } = outcome;
  if (reason === "menu-not-open")
    return `点击项目触发器后项目菜单未打开（selector=${probe.selector || "n/a"}，匹配 ${probe.count} 个可见节点${probe.pageHidden ? "；ZCode 窗口当前不可见，浏览器已节流该页面，点击可能被吞——请把 ZCode 窗口置于前台后重试" : ""}）`;
  switch (probe.state) {
    case "ambiguous":
      return `无法打开 ZCode 项目列表：项目触发器不唯一（匹配 ${probe.count} 个可见节点，selector=${probe.selector}）`;
    case "disabled":
      return `无法打开 ZCode 项目列表：项目触发器处于禁用状态（selector=${probe.selector}）`;
    case "hidden":
      return `无法打开 ZCode 项目列表：项目触发器已挂载但不可见或被裁剪（selector=${probe.selector || "n/a"}）`;
    case "covered":
      return `无法打开 ZCode 项目列表：项目触发器被其他元素遮挡（selector=${probe.selector}${probe.detail ? `，命中=${probe.detail}` : ""}）`;
    default:
      return "无法打开 ZCode 项目列表：项目触发器始终未挂载（等待项目触发器超时）";
  }
}

/**
 * 运行期 CDP 断连且重连无效（issue #27）：任务已经发出，因此不再判死，
 * 而是由外层归位到可恢复出口（needs_user/setup_recovery），把现场与已确认的会话
 * 一起交回用户处理。
 */
class ZcodeRuntimeDisconnect extends Error {
  constructor(
    message: string,
    readonly session?: AgentRunResult["session"],
  ) {
    super(message);
  }
}

export async function runZcodeTask(args: RunZcodeArgs): Promise<AgentRunResult> {
  const started = Date.now(),
    { ctx, resolved, opts, logFile } = args,
    baseDeps = { ...DEFAULT_DEPS, ...args.deps };
  /**
   * 发送确认阶段观测到的**真实运行信号**（issue #31）。只认 stop/loading/activeTool，
   * 不含「对话文本发生变化」——后者不是运行信号，不能作为完成判定的前置证据。
   *
   * 声明在函数级：发送确认块是独立作用域，观察循环在它之外，二者只能通过函数级变量传递。
   * 发送阶段（点击发送后的有界观察窗口）是「本轮确实已启动」最可靠的证据来源；选择器漂移、
   * 或 turn 在观察循环开始前就跑完时，观察循环可能整段都采不到运行信号——不带过来的话，
   * 已启动的任务会被误落 idle_timeout。
   */
  let sawRunningAtSend = false;
  const gui = guiOf(resolved);
  const { logger, close } = fileLogger(logFile, opts.logger);
  const budget = new ZcodeBudget(
    started + ctx.taskTimeoutMs,
    started + gui.setupRecoveryTimeoutMs,
    { ...opts, logger },
    gui.progressIntervalMs,
  );
  const deps: ZcodeRunDeps = {
    ...baseDeps,
    sleep: (ms) => budget.run(() => baseDeps.sleep(Math.min(ms, budget.remaining()))),
    createClient: (port, timeout, selectors) => {
      const client = baseDeps.createClient(port, timeout, selectors);
      return new Proxy(client, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          if (key === "disconnect") return value.bind(target);
          return (...params: unknown[]) =>
            budget.run(async () => {
              const methodStarted = Date.now();
              try {
                return await value.apply(target, params);
              } finally {
                logger.debug(`[zcode] CDP ${String(key)} elapsed=${Date.now() - methodStarted}ms`);
              }
            });
        },
      });
    },
  };
  let cdp: ZcodeCdpClient | undefined;
  /** 运行期断连时组织诊断文案（进程侧 + 窗口侧）；在发送阶段的护栏里装配。 */
  let runtimeDiagnosis: (() => Promise<string>) | undefined;
  const result = (extra: Partial<AgentRunResult>): AgentRunResult => ({
    ok: false,
    exitCode: null,
    timeout: false,
    killed: false,
    durationMs: Date.now() - started,
    logFile,
    keptInstance: true,
    ...extra,
  });
  try {
    await mkdirp(path.dirname(logFile));
    const spec = parseZcodeModel(ctx.model, ctx.reasoningLevel);
    // 无项目模式（issue #12）：进入 ZCode 的 default 工作区，不解析项目引用、不绑定/导入项目。
    const defaultWorkspace = ctx.workspaceMode === "default";
    const refs = validateTaskReferences(
      ctx.task,
      ctx.context,
      defaultWorkspace ? undefined : ctx.projectPath,
    );
    if (!resolved.command)
      return result({
        hardFailure: true,
        error: "未找到 ZCode 可执行文件",
        endReason: "setup_failed",
      });
    let inst: Awaited<ReturnType<typeof ensureZcodeInstance>> = {};
    for (let attempt = 0; attempt <= gui.setupRecoveryMaxRetries; attempt++) {
      try {
        inst = await budget.run((signal, timeoutMs) =>
          deps.ensureInstance(
            resolved.command,
            { ...gui, launchTimeoutMs: Math.min(gui.launchTimeoutMs, timeoutMs) },
            logger,
            { signal, deadline: Date.now() + timeoutMs },
          ),
        );
        break;
      } catch (error) {
        budget.check();
        if (!transientSetupError(error)) throw error;
        if (attempt === gui.setupRecoveryMaxRetries)
          throw new ZcodeSetupPause("ZCode 项目连接尚未恢复，请检查应用状态后继续");
        logger.warn(
          `[zcode] 初始化连接暂时失败；attempt=${attempt + 1}；${error instanceof Error ? error.message : String(error)}`,
        );
        await deps.sleep(500 * (attempt + 1));
      }
    }
    if (inst.needsClose)
      return result({
        endReason: "needs_user",
        needsUserKind: "close_existing_instance",
        pendingQuestion:
          "检测到未开启 CDP 的 ZCode 实例。请保存工作并手动关闭所有 ZCode 窗口，然后调用 continue_task 确认。",
        progressSummary: "等待用户关闭既有 ZCode 实例",
      });
    if (!inst.ready)
      return result({ hardFailure: true, error: "ZCode 实例未就绪", endReason: "setup_failed" });
    const ready: ZcodeReady = inst.ready;
    cdp = await connectStableZcode(ready, gui, deps, true);
    logger.info("[zcode] ZCode CDP 页面与输入状态已稳定");
    if (await cdp.exists("loginPage"))
      return result({
        endReason: "needs_user",
        needsUserKind: "login_required",
        pendingQuestion: "请在 ZCode 窗口中完成登录或引导，然后调用 continue_task 确认。",
        session: {
          boundProjectPath: ctx.projectPath,
          provider: spec.provider,
          model: spec.model,
          permissionMode: gui.defaultPermissionMode,
        },
      });

    await cdp.dismissMenus();

    // 等待并确认项目触发器就绪的共享截止时间：上限来自集中配置（gui.projectTriggerTimeoutMs），
    // 并被 setup 恢复预算与任务总时限夹住。回退重试不重置它，也不新增第二个魔法超时值。
    const projectTriggerDeadline = (): number =>
      Math.min(
        Date.now() + gui.projectTriggerTimeoutMs,
        started + ctx.taskTimeoutMs,
        started + gui.setupRecoveryTimeoutMs,
      );
    /**
     * 新建任务后必须确认**草稿真的建立了**，不能只信点击的返回值。
     * 3.11.2-Windows 真机实测：页面停在已有会话时，顶部 `conversation-new-task` 点击返回 true
     * 却不切换页面，composer 上根本不挂载 `composer-workspace-trigger`（会话页不挂载它），
     * 于是后续 default 确认与项目绑定会一路空等到 deadline，最后只报一句 needs_user。
     * 侧栏 `task-new-button` 实测可靠。判据取「项目触发器已挂载」：它只存在于草稿页，
     * 既证明草稿建立，也证明后续等待有依托。
     */
    const draftReady = async (): Promise<boolean> => {
      const deadline = projectTriggerDeadline();
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const probe = await cdp!.probeProjectTrigger();
        if (probe.mounted > 0) return true;
        if (Date.now() >= deadline) return false;
        // eslint-disable-next-line no-await-in-loop
        await deps.sleep(Math.min(250, Math.max(0, deadline - Date.now())));
      }
    };
    const ensureFreshDraft = async (): Promise<boolean> => {
      const topClicked = await cdp!.click("newTask");
      if (topClicked && (await draftReady())) return true;
      logger.warn(
        `[zcode] 顶部新建任务按钮未建立草稿（clicked=${topClicked}）；回退侧栏新建任务按钮`,
      );
      const sidebarClicked = await cdp!.click("newTaskSidebar");
      if (sidebarClicked && (await draftReady())) {
        logger.info("[zcode] 已通过侧栏新建任务按钮进入新草稿");
        return true;
      }
      logger.warn(
        `[zcode] 未能进入新草稿（顶部点击=${topClicked}，侧栏点击=${sidebarClicked}）：项目触发器始终未挂载`,
      );
      return false;
    };

    const initialDispatch =
      !ctx.resume ||
      (ctx.resume.kind === "continue" &&
        !ctx.resume.sendMessage &&
        !ctx.resume.sessionId &&
        !ctx.resume.sessionTitle);
    if (!initialDispatch && ctx.resume) {
      if (!ctx.resume.sessionId && !ctx.resume.sessionTitle)
        return result({
          hardFailure: true,
          error: "缺少原 ZCode 会话定位信息，拒绝打开最近会话",
          endReason: "session_lost",
        });
      if (!(await cdp.selectSession(ctx.resume.sessionId, ctx.resume.sessionTitle)))
        return result({
          hardFailure: true,
          error: "无法唯一定位原 ZCode 会话，已 fail-closed",
          endReason: "session_lost",
        });
    } else if (gui.freshSession && !(await ensureFreshDraft()))
      return result({
        hardFailure: true,
        error:
          "无法创建新的 ZCode 任务会话：点击新建任务后项目触发器仍未挂载，未能进入草稿页",
        endReason: "setup_failed",
      });
    await deps.sleep(500);
    const activeSession = initialDispatch ? {} : await cdp.session();
    if (
      !initialDispatch &&
      (!activeSession.id || (ctx.resume?.sessionId && activeSession.id !== ctx.resume.sessionId))
    )
      return result({
        hardFailure: true,
        endReason: "session_lost",
        error: "ZCode 原会话回选后身份回读不一致，不发送任务",
      });

    let session = activeSession;
    // 恢复轮沿用已记录的会话权限；仅在缺失记录时回落 profile 默认值。
    const permission = ctx.resume?.permissionMode ?? gui.defaultPermissionMode ?? "完全访问";
    let answeredQuestion = false;
    /**
     * 运行期 CDP 断连的恢复位（issue #27）：单次 evaluate 超时或端点抖动不等于 CDP 已死。
     * 首次断连只**重连观察一次**（对齐 qoder/run.ts 与 codex/run.ts 的既有范式）——
     * 重连只用于继续观察，绝不重发任务；重连失败或再次断连才归位到可恢复出口。
     *
     * 护栏从**发送阶段**就生效，而不只是主循环：issue 的物理现场正是「任务已经发出、
     * agent 仍在写产物，MCP 却因一次 poll 失败把任务判死」。
     */
    let reconnected = false;
    /** 已确认发出的会话身份：随断连一起交回，用户 continue_task 时能回到原会话观察。 */
    const sessionEvidence = (): AgentRunResult["session"] => ({
      id: session.id,
      title: session.title,
      boundProjectPath: ctx.projectPath,
      provider: spec.provider,
      model: spec.model,
      permissionMode: permission,
    });
    const reconnectOnce = async (): Promise<boolean> => {
      try {
        logger.warn("[zcode] 运行期 CDP 连接中断；重连观察一次（不重发任务）");
        cdp!.disconnect();
        cdp = await connectStableZcode(
          ready,
          { ...gui, launchTimeoutMs: Math.min(gui.launchTimeoutMs, 20_000) },
          deps,
        );
        return true;
      } catch (error) {
        logger.error(
          `[zcode] 运行期 CDP 重连失败：${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    };
    const guardRuntimeCdp = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        const isCdpLoss =
          error instanceof CdpUnavailableError || error instanceof CdpDisconnectedError;
        if (!isCdpLoss) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (!reconnected) {
          reconnected = true;
          if (await reconnectOnce()) {
            logger.info("[zcode] 运行期 CDP 已重连，继续观察原任务（不重发）");
            try {
              return await operation();
            } catch (retryError) {
              if (
                !(retryError instanceof CdpUnavailableError) &&
                !(retryError instanceof CdpDisconnectedError)
              )
                throw retryError;
              throw new ZcodeRuntimeDisconnect(
                `ZCode 调试连接在任务运行期重连后再次中断（${retryError instanceof Error ? retryError.message : String(retryError)}）`,
                sessionEvidence(),
              );
            }
          }
        }
        throw new ZcodeRuntimeDisconnect(
          `ZCode 调试连接在任务运行期中断（${message}）`,
          sessionEvidence(),
        );
      }
    };
    /** 进程侧事实：区分「ZCode 已退出」与「进程还在但端点无响应」——两者的自救动作不同。 */
    const describeProcessState = async (): Promise<string> => {
      if (!ready.pid) return "未能确认 ZCode 进程 id";
      try {
        const processes = await Promise.resolve(deps.listProcesses());
        return processes.some((process) => process.pid === ready.pid)
          ? `ZCode 进程仍在（pid=${ready.pid}）但调试端点无响应`
          : `ZCode 进程已退出（pid=${ready.pid} 不在进程表中）——请重启 ZCode 客户端`;
      } catch (error) {
        return `ZCode 进程状态不可读：${error instanceof Error ? error.message : String(error)}`;
      }
    };
    /**
     * 窗口侧事实：issue 的物理现场是「agent 被判死后仍在写产物」，因此断连时必须回读
     * 窗口内是否仍有运行信号，避免把「仍在跑」误读成「已停」。
     */
    const describeRuntimeWindow = async (): Promise<string> => {
      try {
        const snapshot = await cdp!.poll();
        const running = snapshot.stopVisible || snapshot.loading || snapshot.activeTool;
        return running
          ? "窗口内仍有运行信号（stop/loading/tool-call 可见），任务可能仍在继续"
          : "窗口内未见运行信号（任务可能已停止）";
      } catch {
        return "窗口状态不可读（调试端点无响应）";
      }
    };
    runtimeDiagnosis = async () =>
      `${await describeProcessState()}；${await describeRuntimeWindow()}`;
    /**
     * 无项目模式的就绪判据：必须确认当前会话真的处于「未绑定项目的 default 工作区」。
     * 「不点击项目按钮」不足以证明——当前 UI 可能继承上一次绑定，所以要求触发器文本
     * 命中未绑定占位词、且没有回读到任何项目路径，且不处于歧义态。
     */
    const workspaceIsDefault = (binding: {
      triggerText: string;
      projectPath: string;
      ambiguous?: boolean;
    }): boolean =>
      !binding.ambiguous && !binding.projectPath && isUnboundTriggerText(binding.triggerText);
    const describeDefaultWorkspaceFailure = (binding?: {
      triggerText: string;
      projectPath: string;
      ambiguous?: boolean;
    }): string => {
      if (!binding) return "未能读取 ZCode 工作区状态";
      if (binding.ambiguous) return "ZCode 项目触发器不唯一，无法确认工作区状态";
      if (binding.projectPath)
        return `当前 ZCode 会话仍绑定项目 ${binding.projectPath}，未处于 default 工作区`;
      return `无法确认 ZCode 处于 default 工作区（触发器文本=${binding.triggerText || "空"}）`;
    };
    const confirmDefaultWorkspace = async (): Promise<
      | { ok: true; binding: { triggerText: string; projectPath: string; ambiguous?: boolean } }
      | {
          ok: false;
          reason: string;
          binding?: { triggerText: string; projectPath: string; ambiguous?: boolean };
        }
    > => {
      const deadline = projectTriggerDeadline();
      let last: { triggerText: string; projectPath: string; ambiguous?: boolean } | undefined;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        last = await cdp!.workspaceBinding();
        if (workspaceIsDefault(last)) return { ok: true, binding: last };
        // 明确绑定着某个项目：继续等不会变成 default——立即返回，让上层执行显式切换。
        if (last.projectPath && !last.ambiguous)
          return { ok: false, reason: describeDefaultWorkspaceFailure(last), binding: last };
        if (Date.now() >= deadline) break;
        // eslint-disable-next-line no-await-in-loop
        await deps.sleep(Math.min(300, Math.max(0, deadline - Date.now())));
      }
      return { ok: false, reason: describeDefaultWorkspaceFailure(last), binding: last };
    };
    /**
     * 无项目模式：把当前会话切到 ZCode 的 default 工作区。
     *
     * 真机实测（3.11.2-Windows）：新建任务会**继承上一次绑定**，所以必须先显式点开项目菜单并
     * 选择「不在项目中工作」；点击后触发器回读为占位词「选择项目」。切换仍以 workspaceBinding
     * 回读为准，不靠「点击成功」推断。
     */
    const enterDefaultWorkspace = async (): Promise<boolean> => {
      const deadline = projectTriggerDeadline();
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        await cdp!.dismissMenus();
        // eslint-disable-next-line no-await-in-loop
        const menu = await cdp!.clickProjectTriggerAndConfirm(deadline);
        if (menu.opened) {
          // eslint-disable-next-line no-await-in-loop
          const clicked = await cdp!.clickWorkOutsideProject();
          if (!clicked.clicked) {
            logger.warn(
              `[zcode] 「不在项目中工作」项不可用（匹配 ${clicked.count} 个可见节点）：无法自动切换到 default 工作区`,
            );
          } else {
            // eslint-disable-next-line no-await-in-loop
            await deps.sleep(300);
            // eslint-disable-next-line no-await-in-loop
            if (workspaceIsDefault(await cdp!.workspaceBinding())) {
              logger.info("[zcode] 已切到 default 工作区（不在项目中工作）");
              return true;
            }
          }
        }
        if (Date.now() >= deadline) return false;
        // eslint-disable-next-line no-await-in-loop
        await deps.sleep(Math.min(300, Math.max(0, deadline - Date.now())));
      }
    };
    /**
     * 绑定失败时的证据摘要：触发器文本、菜单勾选态与路径回读。
     * issue #24 要求 fail-closed 时把这几项一并写进错误信息，用户在 ZCode 里能据此判断
     * 到底绑到了哪个项目（而不是只看到一句「回读不一致」无从自救）。
     */
    const describeBinding = async (): Promise<string> => {
      try {
        const b = await cdp!.workspaceBinding();
        return `触发器文本=${b.triggerText || "空"}；菜单勾选=${b.menuChecked?.length ? b.menuChecked.join("、") : "无"}；路径回读=${b.projectPath || "无"}`;
      } catch {
        return "绑定状态回读失败";
      }
    };

    /**
     * 读一次「当前绑定是否为目标项目」的分层判定（issue #24）：
     * 路径可得时严格判等；无路径渠道（ZCode 3.14.x）时按显示名，并在列表可得时做同名消歧。
     */
    const readBoundVerdict = async () => {
      const binding = await cdp!.workspaceBinding();
      const match = matchZcodeProject(await cdp!.projects(), ctx.projectPath);
      return { verdict: boundProjectVerdict(binding, match, ctx.projectPath), match };
    };

    /**
     * 幂等确认绑定：每轮先读判定，已绑定即通过；未绑定则（必要时先展开菜单）点击目标项目再复检。
     * 不再接受外部传入的 item——那会把「菜单是否恰好还开着」变成隐式前提（issue #24 暴露的脆弱时序）。
     *
     * `unclickable`（issue #27）：所有点击尝试都**从未成功发出一次点击**（`clickProject` 每次
     * 返回 `clicked:false`，例如目标项在 UI 上不可达）。继续点下去是徒劳——上层据此回落
     * `selectZcodeFolder` 导入路径，而不是把任务判死在 project_mismatch。
     */
    const ensureProjectBound = async (): Promise<{
      bound: boolean;
      ambiguous: boolean;
      unclickable: boolean;
    }> => {
      let clickAttempts = 0;
      let clickFailures = 0;
      const attemptClick = async (item: ZcodeProjectItem): Promise<boolean> => {
        clickAttempts += 1;
        const click = await cdp!.clickProject(item.id, item.path ?? ctx.projectPath);
        if (!click.clicked) {
          clickFailures += 1;
          logger.warn(
            `[zcode] 项目项点击未生效：reason=${click.reason}；target=${item.name}；尝试=${clickAttempts}`,
          );
          return false;
        }
        return waitBound(cdp!, ctx.projectPath, deps);
      };
      for (let round = 0; round <= gui.setupRecoveryMaxRetries; round++) {
        // eslint-disable-next-line no-await-in-loop
        const { verdict, match } = await readBoundVerdict();
        if (verdict.bound) return { bound: true, ambiguous: false, unclickable: false };
        if (verdict.ambiguous) return { bound: false, ambiguous: true, unclickable: false };
        if (match.item) {
          // eslint-disable-next-line no-await-in-loop
          if (await attemptClick(match.item))
            return { bound: true, ambiguous: false, unclickable: false };
          continue;
        }
        // 目标不在当前列表（菜单多未展开）：显式展开菜单后再采集一次。
        // eslint-disable-next-line no-await-in-loop
        await cdp!.dismissMenus();
        // eslint-disable-next-line no-await-in-loop
        if (!(await cdp!.clickProjectTriggerAndConfirm(projectTriggerDeadline())).opened)
          continue;
        // eslint-disable-next-line no-await-in-loop
        await deps.sleep(300);
        // eslint-disable-next-line no-await-in-loop
        const expanded = matchZcodeProject(await cdp!.projects(), ctx.projectPath);
        if (expanded.ambiguous) return { bound: false, ambiguous: true, unclickable: false };
        if (!expanded.item) continue;
        // eslint-disable-next-line no-await-in-loop
        if (await attemptClick(expanded.item))
          return { bound: true, ambiguous: false, unclickable: false };
      }
      return {
        bound: false,
        ambiguous: false,
        unclickable: clickAttempts > 0 && clickFailures === clickAttempts,
      };
    };
    if (ctx.resume?.kind === "continue" && ctx.resume.sendMessage) {
      const pending = await cdp.poll();
      if (pending.question) {
        const answer = await cdp.answerQuestion(ctx.resume.message ?? "");
        if (!answer.answered)
          return result({
            endReason: "needs_user",
            needsUserKind: "agent_question",
            pendingQuestion: `${pending.question}\n续答未提交：匹配 ${answer.count}${answer.available.length ? `；可用选项=${answer.available.join("、")}` : ""}${answer.error ? `；${answer.error}` : ""}`,
            session: {
              id: activeSession.id,
              title: activeSession.title,
              boundProjectPath: ctx.projectPath,
              provider: spec.provider,
              model: spec.model,
              permissionMode: permission,
            },
            progressSummary: "ZCode 仍在等待可唯一匹配的用户选项",
          });
        answeredQuestion = true;
        logger.info(`[zcode] 已在原会话问题卡片中精确提交续答：${ctx.resume.message ?? ""}`);
      }
    }

    if (!answeredQuestion) {
      // 无项目模式（issue #12）：只确认 default 工作区，不进入任何项目选择/绑定/导入路径。
      if (defaultWorkspace) {
      budget.setStage("确认无项目工作区");
      let confirmed = await confirmDefaultWorkspace();
      if (!confirmed.ok && !confirmed.binding?.ambiguous) {
        // 新建任务继承了旧绑定：显式切到「不在项目中工作」后重新确认。
        budget.setStage("切换到 default 工作区");
        if (await enterDefaultWorkspace()) confirmed = await confirmDefaultWorkspace();
      }
      if (!confirmed.ok)
        return result({
          endReason: "needs_user",
          needsUserKind: "setup_recovery",
          pendingQuestion: `${confirmed.reason}。请在 ZCode 中切换到未绑定项目的新会话（default 工作区）后调用 continue_task；不会向其它项目发送任务。`,
          session: {
            id: session.id,
            title: session.title,
            provider: spec.provider,
            model: spec.model,
            permissionMode: permission,
          },
          progressSummary: "等待 ZCode 进入 default 工作区",
        });
      logger.info("[zcode] 已确认 default 工作区（无项目模式），跳过项目绑定与导入");
      await cdp.dismissMenus();
      budget.finishSetup();
      } else {
      budget.setStage("确认项目绑定");
      // 等待与点击共用同一就绪判据（结构化探测），并在点击后确认项目菜单真正打开——
      // 鼠标事件发出不等于成功。整个「等待 → 回退一次侧栏新建任务 → 再等待」共享
      // projectTriggerDeadline，重试不重置预算。
      const attemptProjectMenu = async (): Promise<ZcodeProjectMenuResult> => {
        const deadline = projectTriggerDeadline();
        const attemptStarted = Date.now();
        // 与无项目分支保持一致：先收起可能残留的菜单，避免这次点击被 toggle 成关闭。
        await cdp!.dismissMenus();
        let attempts = 0;
        let last: ZcodeProjectMenuResult = {
          opened: false,
          reason: "not-ready",
          probe: { state: "missing", selector: "", count: 0, mounted: 0, ready: false },
        };
        for (;;) {
          attempts += 1;
          // eslint-disable-next-line no-await-in-loop
          last = await cdp!.clickProjectTriggerAndConfirm(deadline);
          if (last.opened) {
            logger.debug(
              `[zcode] 项目触发器就绪且项目菜单已打开；attempts=${attempts}；elapsed=${Date.now() - attemptStarted}ms；selector=${last.probe.selector}；count=${last.probe.count}`,
            );
            return last;
          }
          // 「不唯一」「禁用」不是再等一会儿就会好的状态：继续重试只会烧掉预算，
          // 且会触发多余的回退草稿，因此在这里早退并如实归类原因。
          if (last.probe.state === "ambiguous" || last.probe.state === "disabled") break;
          if (Date.now() >= deadline) break;
          // eslint-disable-next-line no-await-in-loop
          await deps.sleep(Math.min(300, Math.max(0, deadline - Date.now())));
        }
        logger.warn(
          `[zcode] 项目触发器未就绪；state=${last.probe.state}；reason=${last.reason ?? "n/a"}；attempts=${attempts}；elapsed=${Date.now() - attemptStarted}ms；剩余预算=${Math.max(0, deadline - Date.now())}ms；selector=${last.probe.selector || "n/a"}；count=${last.probe.count}；mounted=${last.probe.mounted}；页面隐藏=${last.probe.pageHidden === true}${last.probe.detail ? `；命中=${last.probe.detail}` : ""}`,
        );
        return last;
      };
      let triggerOutcome = await attemptProjectMenu();
      if (
        !triggerOutcome.opened &&
        triggerOutcome.probe.state !== "ambiguous" &&
        triggerOutcome.probe.state !== "disabled"
      ) {
        // macOS 实测：palette 首页也带 composer-input（无工作区触发器），不能以 chatInput
        // 判断任务 composer 已打开——触发器持续缺席即回退侧栏新建任务大按钮。
        // 只回退一次（不无限新建草稿），且不重置截止时间。
        logger.warn("[zcode] 项目触发器未就绪，回退侧栏新建任务按钮后重试一次");
        await cdp.click("newTaskSidebar");
        triggerOutcome = await attemptProjectMenu();
      }
      if (!triggerOutcome.opened)
        return result({
          hardFailure: true,
          error: describeProjectTriggerFailure(triggerOutcome),
          endReason: "setup_failed",
        });
      await deps.sleep(300);
      const items = await cdp.projects();
      const matched = matchZcodeProject(items, ctx.projectPath);
      if (matched.ambiguous)
        return result({
          hardFailure: true,
          error: `项目同名或路径重复，无法消歧：${ctx.projectPath}`,
          endReason: "project_ambiguous",
          needsUserKind: "setup_recovery",
          pendingQuestion: "项目路径存在歧义，请在 ZCode 中确认目标项目后调用 continue_task。",
        });
      let projectBound = false;
      if (matched.item) {
        const binding = await ensureProjectBound();
        projectBound = binding.bound;
        if (!projectBound && binding.ambiguous)
          return result({
            hardFailure: true,
            error: `项目绑定重试时目标项目无法唯一匹配：${ctx.projectPath}；${await describeBinding()}`,
            endReason: "project_mismatch",
            needsUserKind: "setup_recovery",
            pendingQuestion: "项目绑定尚未确认，请在 ZCode 中确认目标项目后调用 continue_task。",
          });
        if (!projectBound && !binding.unclickable)
          return result({
            hardFailure: true,
            error: `ZCode 项目绑定有限重试均未生效：${ctx.projectPath}；${await describeBinding()}`,
            endReason: "project_mismatch",
            needsUserKind: "setup_recovery",
            pendingQuestion: "项目绑定尚未确认，请在 ZCode 中确认目标项目后调用 continue_task。",
          });
        // 目标项就在列表里、却一次点击都没真正落下去（issue #27 的幽灵项/不可达项）：
        // 继续重试是徒劳，但也不该直接判死——交给下面的导入路径兜底；
        // allowCreateProject=false 时仍在下一道闸门 fail-closed。
        if (!projectBound)
          logger.warn(
            `[zcode] 目标项目在列表中但点击始终不生效，回落项目导入路径：${ctx.projectPath}`,
          );
      }
      if (!projectBound && ctx.allowCreateProject === false) {
        // 明确禁止创建：在打开文件夹面板等任何导入副作用之前停止派发。
        return result({
          hardFailure: true,
          endReason: "project_not_registered",
          error: `目标目录未在 ZCode 项目列表中登记，且本次调用禁止自动创建项目（allowCreateProject=false）：${ctx.projectPath}。请在 ZCode 中手动添加该项目后重新提交，或省略 allowCreateProject 以允许自动导入。`,
        });
      }
      if (!projectBound) {
        budget.setStage("准备文件夹面板");
        let pids: number[] = [];
        let before: string[] | undefined;
        for (let attempt = 0; attempt <= gui.setupRecoveryMaxRetries; attempt++) {
          try {
            // ensureInstance already verified this root's process and CDP ownership.
            // Do not start another expensive process enumeration during cold import.
            pids = ready.pid
              ? [ready.pid]
              : (
                  await budget.run(
                    (signal, timeoutMs) =>
                      Promise.resolve(
                        deps.listProcesses({ signal, deadline: Date.now() + timeoutMs }),
                      ),
                    gui.dialogProbeTimeoutMs,
                  )
                ).map((p) => p.pid);
            if (!pids.length)
              throw new ZcodeSetupPause("无法确认目标 ZCode 进程，拒绝操作原生对话框");
            before = await budget.run(
              (signal, timeoutMs) => deps.listDialogs(pids, { signal, timeoutMs }),
              gui.dialogProbeTimeoutMs,
            );
            break;
          } catch (error) {
            budget.check();
            if (permissionError(error))
              throw new ZcodeSetupPause(
                "请授予 ZCode/System Events Accessibility 权限后继续",
                true,
              );
            logger.warn(
              `[zcode] 文件夹基线探测失败；attempt=${attempt + 1}；category=${transientSetupError(error) ? "transient" : "unknown"}；${error instanceof Error ? error.message : String(error)}`,
            );
            // Reconcile a delayed import before starting any native side effect.
            const reconciled = await ensureProjectBound();
            if (reconciled.bound) break;
            if (reconciled.ambiguous)
              throw new ZcodeSetupPause("项目路径存在歧义，请在 ZCode 中确认目标项目后继续");
            if (!transientSetupError(error) || attempt === gui.setupRecoveryMaxRetries)
              throw new ZcodeSetupPause(
                "文件夹面板探测未恢复，请在 ZCode 中完成目标项目导入后继续",
              );
            await deps.sleep(500 * (attempt + 1));
          }
        }
        if (before) {
          if (before.some((item) => item.startsWith("sheet-count:") && item !== "sheet-count:0"))
            throw new ZcodeSetupPause("ZCode 存在既有文件夹面板，请完成或关闭该面板后继续");
          budget.setStage("打开项目文件夹");
          let folderOption: ZcodeClickExactResult = {
            clicked: false,
            count: 0,
            available: [],
          };
          for (
            let round = 0;
            round <= gui.setupRecoveryMaxRetries && !folderOption.clicked;
            round++
          ) {
            // ZCode 3.11.2 的工作区下拉会吞掉第一次 outside-click。每轮均先收起残留菜单再验证新菜单。
            // eslint-disable-next-line no-await-in-loop
            await cdp.dismissMenus();
            // eslint-disable-next-line no-await-in-loop
            if (!(await cdp.click("addProject"))) continue;
            // eslint-disable-next-line no-await-in-loop
            folderOption = await clickAnyExactWhenReady(
              cdp,
              "chooseFolder",
              ["打开文件夹", "Open Folder"],
              deps,
            );
          }
          if (!folderOption.clicked)
            return result({
              hardFailure: true,
              error: `无法唯一选择 ZCode 打开文件夹菜单项（匹配 ${folderOption.count}${folderOption.available.length ? `；可见候选=${folderOption.available.slice(0, 20).join("、")}` : ""}）`,
              endReason: "setup_failed",
            });
          budget.setStage("提交项目路径并等待导入");
          let selected: Awaited<ReturnType<typeof selectZcodeFolder>>;
          try {
            selected = await budget.run(
              (signal, timeoutMs) =>
                deps.selectFolder(ctx.projectPath, pids, before!, {
                  signal,
                  timeoutMs,
                  onProgress: (stage) => logger.info(`[zcode] ${stage}`),
                }),
              gui.dialogOperationTimeoutMs,
            );
          } catch (error) {
            budget.check();
            selected = {
              ok: false,
              needsPermission: permissionError(error),
              message: error instanceof Error ? error.message : String(error),
            };
          }
          if (!selected.ok && !selected.needsPermission) {
            budget.setStage("复检项目导入结果");
            // Submission may have succeeded before the helper timed out. Never replay it blindly.
            cdp.disconnect();
            cdp = await connectStableZcode(ready, gui, deps);
            if ((await ensureProjectBound()).bound)
              selected = { ok: true, message: "项目已导入，自动恢复完成" };
            else {
              logger.warn(`[zcode] 文件夹操作未确认：${selected.message}`);
              throw new ZcodeSetupPause(
                "项目导入结果尚未确认，请在 ZCode 中完成目标项目绑定后继续",
              );
            }
          }
          if (!selected.ok)
            return result({
              endReason: selected.needsPermission ? "needs_user" : "setup_failed",
              needsUserKind: selected.needsPermission ? "system_permission" : undefined,
              pendingQuestion: selected.needsPermission
                ? "请为 ZCode/System Events 授予 Accessibility 权限后调用 continue_task 确认。"
                : undefined,
              error: selected.needsPermission ? undefined : selected.message,
              hardFailure: !selected.needsPermission,
              session: selected.needsPermission
                ? {
                    id: activeSession.id,
                    title: activeSession.title,
                    boundProjectPath: ctx.projectPath,
                    provider: spec.provider,
                    model: spec.model,
                    permissionMode: gui.defaultPermissionMode,
                  }
                : undefined,
            });
          logger.info("[zcode] 项目首次导入完成，等待 ZCode CDP 页面重新稳定");
          cdp.disconnect();
          cdp = await connectStableZcode(ready, gui, deps);
          logger.info("[zcode] 项目导入后的 ZCode CDP 页面已恢复");
        }
      }
      budget.setStage("确认项目绑定");
      const finalBinding = await ensureProjectBound();
      if (!finalBinding.bound)
        return result({
          hardFailure: true,
          error: finalBinding.ambiguous
            ? `ZCode 项目绑定回读不一致，且重试时目标项目无法唯一匹配：${ctx.projectPath}；${await describeBinding()}`
            : `ZCode 项目绑定回读与 projectPath 不一致，有限幂等重试均失败：${ctx.projectPath}；${await describeBinding()}`,
          endReason: "project_mismatch",
          needsUserKind: "setup_recovery",
          pendingQuestion: "项目绑定尚未确认，请在 ZCode 中确认目标项目后调用 continue_task。",
        });
      logger.info(`[zcode] 项目绑定回读通过：${ctx.projectPath}`);
      await cdp.dismissMenus();
      budget.finishSetup();
      }

      const readModel = async (waitForExpected = false) => {
        const until = Math.min(started + ctx.taskTimeoutMs, Date.now() + 5_000);
        let last: { display: string; internal: string } | undefined;
        let error: unknown;
        for (let attempt = 0; attempt < 25 && Date.now() < until; attempt++) {
          try {
            last = await cdp!.selection("modelValue");
            error = undefined;
            if (
              !waitForExpected ||
              ((exactUiName(last.display, spec.model) ||
                exactUiName(last.display, `${spec.provider}/${spec.model}`)) &&
                exactUiName(last.internal, spec.model))
            )
              return last;
          } catch (e) {
            if (!(e instanceof ZcodeModelReadbackError)) throw e;
            error = e;
          }
          await deps.sleep(Math.min(200, Math.max(0, until - Date.now())));
        }
        if (error) throw error;
        if (last) return last;
        budget.check();
        throw new ZcodeModelReadbackError("ZCode 模型回读未在观察期内稳定");
      };
      let modelValue = await readModel();
      const modelMatches = () =>
        (exactUiName(modelValue.display, spec.model) ||
          exactUiName(modelValue.display, `${spec.provider}/${spec.model}`)) &&
        exactUiName(modelValue.internal, spec.model);
      if (!modelMatches()) {
        if (!(await cdp.click("modelTrigger")))
          return result({
            hardFailure: true,
            error: "无法打开 ZCode 模型菜单",
            endReason: "setup_failed",
          });
        await deps.sleep(250);
        let model = await clickExactWhenReady(cdp, "modelOption", spec.model, deps);
        let provider: ZcodeClickExactResult = { clicked: false, count: 0, available: [] };
        if (!model.clicked) {
          // issue #27：模型项在 provider 分组的二级子菜单里，**hover 分组**才会渲染子项；
          // 用 click 会选中分组本身或收起菜单，这正是「两级模型菜单点击不稳」的根因。
          provider = await clickExactWhenReady(cdp, "providerOption", spec.provider, deps, "hover");
          if (provider.clicked) await deps.sleep(600);
          model = await clickExactWhenReady(cdp, "modelOption", spec.model, deps);
        }
        /**
         * issue #27 问题三：radix 子菜单由 hover 维持，press 时子菜单可能已收回——
         * 表现为「本轮候选为空」，而不是「模型真的不存在」。此时把菜单重开一次再试一轮，
         * 不要凭一轮空列表就把任务判死在 model_unavailable。
         */
        if (!model.clicked && !model.count && !provider.clicked) {
          logger.warn("[zcode] 模型项两轮均未命中且候选为空（菜单可能已收起）；重开模型菜单后再试一轮");
          await cdp.dismissMenus();
          if (await cdp.click("modelTrigger")) {
            await deps.sleep(250);
            model = await clickExactWhenReady(cdp, "modelOption", spec.model, deps);
          }
        }
        if (!model.clicked)
          return result({
            hardFailure: true,
            error: `模型不存在或同名歧义：${spec.provider}/${spec.model}（模型匹配 ${model.count}${model.available?.length ? `；模型候选=${model.available.slice(0, 20).join("、")}` : ""}${model.testids?.length ? `；模型 testid=${model.testids.slice(0, 20).join("、")}` : ""}；供应商匹配 ${provider.count}${provider.available?.length ? `；供应商候选=${provider.available.slice(0, 20).join("、")}` : ""}${provider.testids?.length ? `；供应商 testid=${provider.testids.slice(0, 20).join("、")}` : ""}）`,
            endReason: "model_unavailable",
          });
        await deps.sleep(300);
        modelValue = await readModel(true);
      } else logger.info(`[zcode] 模型回读已匹配，复用 ${spec.provider}/${spec.model}`);
      const displayMatches =
        exactUiName(modelValue.display, spec.model) ||
        exactUiName(modelValue.display, `${spec.provider}/${spec.model}`);
      const internalMatches = exactUiName(modelValue.internal, spec.model);
      if (!displayMatches || !internalMatches)
        return result({
          hardFailure: true,
          error: `模型切换回读不一致：display=${modelValue.display || "空"}，internal=${modelValue.internal || "空"}`,
          endReason: "model_mismatch",
        });
      /**
       * 思考档位（issue #27 问题三）：`reasoningLevel` 此前完全没有实现。
       *
       * 档位集合**随模型变化**（真机实测 3.14.3：当前模型只有 开启/关闭 二值），
       * 所以必须在模型确认之后才读界面；未指定档位时完全不碰界面（沿用当前值）。
       * 越权档位与「集合读不到」都在**发送前**报错，绝不静默沿用。
       */
      if (spec.unsupportedLevel !== undefined)
        return result({
          hardFailure: true,
          error:
            describeZcodeLevelValueError(spec) ??
            `ZCode 的思考档位不支持「${spec.unsupportedLevel}」`,
          endReason: "reasoning_level_invalid",
        });
      if (spec.level) {
        budget.setStage("确认思考档位");
        const snapshot = await cdp.thoughtLevelSnapshot();
        // 控件本身不存在（该版本/该模型不提供档位选择）与「控件存在但读不到选项」是两种失败，
        // 文案必须区分，否则用户会去翻一个根本不存在的菜单。
        if (!snapshot.triggerMounted)
          return result({
            hardFailure: true,
            endReason: "reasoning_level_unavailable",
            error:
              "ZCode 界面没有思考档位控件（该版本或该模型不提供档位选择）；请移除 reasoningLevel 后重试",
          });
        const tiers = thoughtTierSetOf(
          snapshot.options.map((option) => option.token || option.text),
        );
        assertZcodeLevelSupported(spec, tiers);
        const current = thoughtLevelOfToken(snapshot.triggerText);
        if (current === spec.level) {
          logger.info(`[zcode] 思考档位已是「${spec.level}」，无需切换`);
        } else {
          const target = snapshot.options.find(
            (option) => thoughtLevelOfToken(option.token || option.text) === spec.level,
          );
          if (!target)
            return result({
              hardFailure: true,
              endReason: "reasoning_level_unavailable",
              error: `ZCode 思考档位「${spec.level}」在界面上没有对应选项（界面档位=${snapshot.options.map((option) => option.token || option.text).join("、") || "空"}）`,
            });
          if (!(await cdp.clickThoughtLevelOption(target.id)))
            return result({
              hardFailure: true,
              endReason: "reasoning_level_unavailable",
              error: `无法点击 ZCode 思考档位选项：${target.id}（当前显示=${snapshot.triggerText || "空"}）`,
            });
          await deps.sleep(250);
          const applied = await cdp.thoughtLevelSnapshot();
          const readback = thoughtLevelOfToken(applied.triggerText);
          if (readback !== spec.level)
            return result({
              hardFailure: true,
              endReason: "reasoning_level_mismatch",
              error: `ZCode 思考档位回读不一致：期望「${spec.level}」，实际「${applied.triggerText || "空"}」`,
            });
          logger.info(`[zcode] 思考档位已切换为「${spec.level}」`);
        }
      }
      if (!exactUiName(await cdp.text("permissionValue"), permission)) {
        if (!(await cdp.click("permissionTrigger")))
          return result({
            hardFailure: true,
            error: "无法打开 ZCode 权限菜单",
            endReason: "permission_unknown",
          });
        const perm = await clickExactWhenReady(cdp, "permissionOption", permission, deps);
        if (!perm.clicked)
          return result({
            hardFailure: true,
            error: `无法唯一选择权限模式：${permission}（匹配 ${perm.count}${perm.available?.length ? `；可见候选=${perm.available.slice(0, 20).join("、")}` : ""}${perm.testids?.length ? `；可见 testid=${perm.testids.slice(0, 20).join("、")}` : ""}）`,
            endReason: "permission_unknown",
          });
        await deps.sleep(250);
      } else logger.info(`[zcode] 权限回读已匹配，复用 ${permission}`);
      if (!exactUiName(await cdp.text("permissionValue"), permission))
        return result({
          hardFailure: true,
          error: `权限模式回读与目标权限不一致：${permission}`,
          endReason: "permission_unknown",
        });

      // A fresh-task click can leave the previous session pane mounted and visible
      // until ZCode accepts the first message. Never carry that stale id into a
      // newly submitted task; identify the new session from the marker or the
      // post-send session-list delta instead.
      const message = prompt(ctx, refs, initialDispatch);
      {
        if (ctx.resume?.kind === "continue" && !ctx.resume.sendMessage) {
          logger.info("[zcode] 用户确认文本不发送给模型；环境复检通过后发送原始任务书");
        }
        const attempt =
          ctx.resume?.kind === "continue"
            ? `continue:${createHash("sha256")
                .update(ctx.resume.message ?? "confirmed")
                .digest("hex")
                .slice(0, 8)}`
            : (ctx.resume?.kind ?? "initial");
        const marker = `【tianshu:${ctx.taskId}:r${ctx.round}:${attempt}】`;
        await cdp.dismissMenus();
        const before = await cdp.conversationText();
        const beforePoll = await cdp.poll();
        const previousIds = new Set(
          initialDispatch ? (await cdp.sessions()).map((item) => item.id) : [],
        );
        if (opts.signal?.aborted) return result({ killed: true, endReason: "aborted" });
        if (Date.now() >= started + ctx.taskTimeoutMs)
          return result({
            timeout: true,
            endReason: "task_timeout",
            error: "ZCode 任务总时限已到，未发送任务",
          });
        await cdp.typeText(marker + message);
        const typed = await cdp.inputText();
        if (!typed.includes(marker))
          return result({
            hardFailure: true,
            error: "ZCode 输入框回读不一致，未发送",
            endReason: "input_mismatch",
          });
        if (opts.signal?.aborted) return result({ killed: true, endReason: "aborted" });
        await cdp.sendMessage();
        let seenMessage = before.includes(marker);
        // issue #31：发送确认阶段观测到的真实运行信号（stop/loading/activeTool），
        // 供观察循环种子 sawRunning —— 见下方 sawRunningAtSend 的说明。

        let seenStateChange = false;
        let seenRunning = false;
        let markedSession: Awaited<ReturnType<ZcodeCdpClient["sessionForMarker"]>> = undefined;
        const confirmationDeadline = Math.min(started + ctx.taskTimeoutMs, Date.now() + 60_000);
        const confirmationAttempts = Math.ceil(
          Math.max(0, confirmationDeadline - Date.now()) / 250,
        );
        for (
          let i = 0;
          i < confirmationAttempts &&
          Date.now() < confirmationDeadline &&
          !(session.id && seenMessage && (seenStateChange || seenRunning || markedSession));
          i++
        ) {
          // eslint-disable-next-line no-await-in-loop
          if (opts.signal?.aborted) return result({ killed: true, endReason: "aborted" });
          await deps.sleep(Math.min(250, Math.max(0, confirmationDeadline - Date.now())));
          // eslint-disable-next-line no-await-in-loop
          const [after, input, polled] = await Promise.all([
            cdp.conversationText(),
            cdp.inputText(),
            guardRuntimeCdp(() => cdp!.poll()),
          ]);
          seenMessage ||= after.includes(marker);
          seenStateChange ||= !input.includes(marker);
          seenRunning ||= polled.stopVisible || polled.loading || polled.activeTool;
          sawRunningAtSend = sawRunningAtSend || polled.stopVisible || polled.loading || polled.activeTool;
          if (polled.assistantText && polled.assistantText !== beforePoll.assistantText)
            seenRunning = true;
          // eslint-disable-next-line no-await-in-loop
          markedSession ||= await cdp.sessionForMarker(marker);
          if (markedSession) {
            if (!initialDispatch && markedSession.id !== activeSession.id)
              return result({
                hardFailure: true,
                endReason: "session_lost",
                error: "任务标记出现在其他 ZCode 会话；不重复发送",
              });
            session = markedSession;
          } else if (initialDispatch) {
            const added = (await cdp.sessions()).filter((item) => !previousIds.has(item.id));
            session = added.length === 1 ? added[0]! : {};
          }
        }
        if (Date.now() >= started + ctx.taskTimeoutMs)
          return result({
            timeout: true,
            endReason: "task_timeout",
            error: "ZCode 发送观察达到任务总时限；保留现场且不重复发送",
          });
        if (!(seenMessage && (seenStateChange || seenRunning || markedSession))) {
          return result({
            hardFailure: true,
            error: `发送结果无法确认（用户消息=${seenMessage}，输入状态变化=${seenStateChange}，运行信号=${seenRunning}，标记会话=${!!markedSession}）；不重复发送`,
            endReason: "send_unknown",
          });
        }
        if (!session.id)
          return result({
            hardFailure: true,
            error: "任务已发送，但无法唯一取得 ZCode 新会话 ID；已保留现场且不会重复发送",
            endReason: "session_lost",
          });
      }
    }

    budget.finishSetup();
    const deadline = started + ctx.taskTimeoutMs;
    let state: ZcodePollState = initialZcodeState(),
      lastProgress = 0;
    // issue #31：发送确认阶段（点击发送后的有界观察窗口）是「本轮任务确实已启动」最可靠的
    // 证据来源。选择器漂移、或 turn 在观察循环开始前就跑完时，观察循环可能整段都采不到运行
    // 信号 —— 若不把发送阶段的信号带过来，已启动的任务会被误落 idle_timeout。
    // 注意只认**真实运行信号**（stop/loading/activeTool），不含「文本发生变化」。
    if (sawRunningAtSend) state = { ...state, sawRunning: true };
    for (;;) {
      if (opts.signal?.aborted) return result({ killed: true, endReason: "aborted" });
      if (Date.now() >= deadline)
        return result({
          timeout: true,
          endReason: "task_timeout",
          error: "ZCode 任务总时限已到；已停止 MCP 等待并保留 ZCode 现场",
        });
      await deps.sleep(gui.pollIntervalMs);
      const poll = await guardRuntimeCdp(() => cdp!.poll());
      const verdict = judgeZcodePoll(poll, state, gui.stableRounds, gui.idleTimeoutMs);
      state = verdict.state;
      if (Date.now() - lastProgress >= gui.progressIntervalMs) {
        const note = `ZCode 进度：${verdict.kind}；运行证据=${verdict.evidence}；回复哈希=${state.hash}；稳定轮=${state.stable}`;
        await Promise.resolve(opts.onProgress?.(note)).catch(() => {});
        logger.info(note);
        lastProgress = Date.now();
      }
      if (verdict.kind === "needs_user")
        return result({
          endReason: "needs_user",
          needsUserKind: "agent_question",
          pendingQuestion: verdict.question,
          session: {
            id: session.id,
            title: session.title,
            boundProjectPath: ctx.projectPath,
            provider: spec.provider,
            model: spec.model,
            permissionMode: permission,
          },
          progressSummary: "ZCode 等待用户回答",
        });
      if (verdict.kind === "idle_timeout")
        return result({
          endReason: "idle_timeout",
          error: "ZCode 空闲超时；已停止 MCP 等待并保留现场",
        });
      if (verdict.kind === "finished")
        return {
          ok: true,
          exitCode: 0,
          timeout: false,
          killed: false,
          durationMs: Date.now() - started,
          logFile,
          endReason: "reply_stable",
          keptInstance: true,
          session: {
            id: session.id,
            title: session.title,
            boundProjectPath: ctx.projectPath,
            provider: spec.provider,
            model: spec.model,
            permissionMode: permission,
          },
          progressSummary: "ZCode 已完成回复",
        };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof ZcodeBudgetError) {
      if (e.reason === "aborted") return result({ killed: true, endReason: "aborted" });
      if (e.reason === "task_timeout")
        return result({ timeout: true, endReason: "task_timeout", error: msg });
    }
    if (e instanceof ZcodeSetupPause || (e instanceof ZcodeBudgetError && budget.settingUp))
      return result({
        endReason: "needs_user",
        needsUserKind:
          e instanceof ZcodeSetupPause && e.needsPermission
            ? "system_permission"
            : "setup_recovery",
        pendingQuestion: `${msg}。请在 ZCode 中确认目标项目 ${ctx.projectPath}，处理后调用 continue_task；原任务已保留。`,
        progressSummary: "自动恢复未能完成，等待处理后继续原任务",
      });
    if (e instanceof ZcodeBudgetError)
      return result({ hardFailure: true, endReason: "cdp_disconnected", error: msg });
    if (e instanceof ZcodeReasoningLevelError)
      return result({ hardFailure: true, error: msg, endReason: "reasoning_level_invalid" });
    if (e instanceof ZcodeModelReadbackError)
      return result({ hardFailure: true, error: msg, endReason: "model_mismatch" });
    if (e instanceof ZcodeRuntimeDisconnect) {
      const diagnosis = runtimeDiagnosis
        ? await runtimeDiagnosis().catch(() => "窗口状态不可读")
        : "无法读取 ZCode 窗口状态";
      // 任务已经发出：不再判死，交回用户处理现场（进程/窗口两侧事实随附），绝不重发。
      return result({
        endReason: "needs_user",
        needsUserKind: "setup_recovery",
        pendingQuestion: `${msg}。${diagnosis}。请检查 ZCode 客户端后调用 continue_task 继续观察原任务（不会重发任务）。`,
        session: e.session,
        progressSummary: "ZCode 运行期 CDP 断连，已保留现场并等待处理",
      });
    }
    if (e instanceof CdpDisconnectedError || e instanceof CdpUnavailableError)
      return result({ hardFailure: true, error: msg, endReason: "cdp_disconnected" });
    return result({ hardFailure: true, error: msg, endReason: "internal" });
  } finally {
    budget.close();
    cdp?.disconnect();
    await close();
  }
}
