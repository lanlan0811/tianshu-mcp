/**
 * Kimi Code 单轮任务编排（M3：模型 / 思考档位 / 执行模式 / 发送 / 运行检测 + 主链路接线）。
 *
 * 执行顺序（与 zcode/run.ts 同构，细节按 Kimi Code 实测语义重写）：
 *   预算与日志 → 实例接管 → 连接主窗口（要求 composer 就绪）→ 登录/引导页判定
 *   → 草稿与会话（初始派发新建草稿 / 返修唯一定位原会话）→ 工作区绑定（完整路径 + 回读）
 *   → 模型与思考档位（overlay 菜单直选 + 档位集合校验 + 回读）→ 执行模式（完全自动 + 回读）
 *   → 组装任务书 + 写标记 + 回读 + 点发送 → 60s 有界确认（绝不重发）→ 轮询判定 → 终态
 *
 * 贯穿全流程的两条纪律：
 * 1. 任何「点击成功」都不等于「状态已改变」——模型、档位、执行模式、工作区、草稿、发送
 *    一律回读确认，回读不一致 fail-closed；
 * 2. 所有等待都受「任务总时限 / setup 预算 / 阶段预算」的最小值夹住（KimicodeBudget），
 *    重试不重置预算。
 *
 * 本阶段刻意不实现（M4）：cancel_task 的 GUI 停止点击、needs_user 的完整恢复语义、
 * agent_question 的选项回答。相关接缝已留好（poll.question 字段 + needs_user 分支 +
 * 终态保留实例）。
 */
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
import { validateTaskReferences } from "../zcode/references.js";
import {
  KimicodeCdpClient,
  CdpDisconnectedError,
  CdpUnavailableError,
  type KimicodeOverlayItem,
} from "./cdp.js";
import {
  ensureKimicodeInstance,
  listKimicodeProcessesAsync,
  type KimicodeInstanceOptions,
  type KimicodeProcess,
  type KimicodeReady,
} from "./instance.js";
import { listOwnedDialogs, selectKimicodeFolder } from "./dialog.js";
import { ensureFreshDraft, locateSession } from "./session.js";
import { matchKimicodeWorkspace, normalizeWorkspacePath } from "./workspace.js";
import {
  assertLevelSupported,
  defaultLevelFor,
  exactUiName,
  levelOfToken,
  levelTokenMatches,
  parseKimicodeModel,
  parseTriggerValue,
  tierSetOf,
  type KimicodeLevel,
} from "./model.js";
import { judgeKimicodePoll, type KimicodePoll, type KimicodePollState } from "./liveness.js";
import {
  KimicodeBudget,
  KimicodeBudgetError,
  KimicodeSetupPause,
  permissionError,
  transientSetupError,
  workspaceTriggerBudgetMs,
} from "./recovery.js";

export interface RunKimicodeArgs {
  ctx: TaskContext;
  resolved: ResolvedAgent;
  opts: AgentRunOptions;
  logFile: string;
  deps?: Partial<KimicodeRunDeps>;
}

export interface KimicodeRunDeps {
  ensureInstance: typeof ensureKimicodeInstance;
  listProcesses: (
    options?: KimicodeInstanceOptions,
  ) => KimicodeProcess[] | Promise<KimicodeProcess[]>;
  createClient: (
    port: number,
    timeout: number,
    selectors: Record<string, string>,
  ) => KimicodeCdpClient;
  listDialogs: typeof listOwnedDialogs;
  selectFolder: typeof selectKimicodeFolder;
  sleep: (ms: number) => Promise<void>;
}

/** 工作区绑定的结构化结果（失败原因分类，便于终态文案区分「没点进去」与「回读不一致」） */
export interface KimicodeBindOutcome {
  ok: boolean;
  boundPath?: string;
  reason?: "draft" | "panel" | "ambiguous" | "click" | "permission" | "native" | "readback";
  candidates?: string[];
  message?: string;
}

const DEFAULT_DEPS: KimicodeRunDeps = {
  ensureInstance: ensureKimicodeInstance,
  listProcesses: listKimicodeProcessesAsync,
  createClient: (port, timeout, selectors) => new KimicodeCdpClient(port, timeout, selectors),
  listDialogs: listOwnedDialogs,
  selectFolder: selectKimicodeFolder,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function kimicodeGuiOf(resolved: ResolvedAgent): GuiProfile {
  const g = resolved.profile.gui;
  return {
    setupRecoveryTimeoutMs:
      g?.setupRecoveryTimeoutMs ?? ZCODE_SETUP_DEFAULTS.setupRecoveryTimeoutMs,
    projectTriggerTimeoutMs:
      g?.projectTriggerTimeoutMs ?? ZCODE_SETUP_DEFAULTS.projectTriggerTimeoutMs,
    workspaceTriggerTimeoutMs: g?.workspaceTriggerTimeoutMs,
    dialogProbeTimeoutMs: g?.dialogProbeTimeoutMs ?? ZCODE_SETUP_DEFAULTS.dialogProbeTimeoutMs,
    dialogOperationTimeoutMs:
      g?.dialogOperationTimeoutMs ?? ZCODE_SETUP_DEFAULTS.dialogOperationTimeoutMs,
    setupRecoveryMaxRetries:
      g?.setupRecoveryMaxRetries ?? ZCODE_SETUP_DEFAULTS.setupRecoveryMaxRetries,
    cdpPort: g?.cdpPort ?? 9666,
    cdpPortAuto: g?.cdpPortAuto ?? true,
    cdpPortRange: g?.cdpPortRange ?? 20,
    exePath: g?.exePath,
    exeArgs: g?.exeArgs ?? ["--remote-debugging-port=<port>"],
    windowMode: g?.windowMode ?? "reuse",
    launchTimeoutMs: g?.launchTimeoutMs ?? 90_000,
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
    permissionMode: g?.permissionMode ?? "完全自动",
    defaultPermissionMode: g?.defaultPermissionMode ?? "完全自动",
    defaultAutoFixRounds: g?.defaultAutoFixRounds ?? 2,
  };
}

function fileLogger(
  file: string,
  base: AgentRunLogger,
): { logger: AgentRunLogger; close: () => Promise<void> } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
  stream.write(`\n===== kimicode-gui run @ ${new Date().toISOString()} =====\n`);
  const wrap = (level: string) => (m: string) => {
    stream.write(`[${level}] ${m}\n`);
    base[level as "info"](m);
  };
  return {
    logger: { info: wrap("info"), warn: wrap("warn"), error: wrap("error"), debug: wrap("debug") },
    close: () => new Promise((r) => stream.end(r)),
  };
}

/** 任务书组装：与 zcode/run.ts 完全同构（task + 上下文 + 已验证引用 + 返修反馈） */
function taskText(
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

/** 可见候选列表（选择器漂移时的诊断依据，最多 20 项） */
function candidatesOf(items: KimicodeOverlayItem[]): string {
  return items
    .map((item) => item.label)
    .filter(Boolean)
    .slice(0, 20)
    .join("、");
}

/**
 * 连接主窗口并要求 composer 真正挂载（只列到 target 不代表页面已可交互）。
 * 观察期内 composer 始终缺席但页面可读 → 判定为登录/引导页。Kimi Code 的登录页选择器未实测，
 * 所以这里只用「页面可读 + composer 缺席」这一可观测事实，不猜具体页面元素。
 */
async function connectStableKimicode(
  ready: KimicodeReady,
  gui: GuiProfile,
  deps: KimicodeRunDeps,
): Promise<{ cdp: KimicodeCdpClient; loginRequired: boolean }> {
  const attempts = Math.max(1, Math.ceil(gui.launchTimeoutMs / 500));
  let lastError: unknown;
  let pageReachable = false;
  for (let i = 0; i < attempts; i++) {
    const candidate = deps.createClient(ready.port, gui.cdpSendTimeoutMs, gui.selectors);
    try {
      // eslint-disable-next-line no-await-in-loop
      await candidate.connect();
      // eslint-disable-next-line no-await-in-loop
      const href = await candidate.evaluate<string>("location.href");
      if (href) pageReachable = true;
      // eslint-disable-next-line no-await-in-loop
      if (await candidate.exists("chatInput")) return { cdp: candidate, loginRequired: false };
      lastError = new Error("Kimi Code 消息输入框尚未就绪");
    } catch (error) {
      lastError = error;
    }
    candidate.disconnect();
    // eslint-disable-next-line no-await-in-loop
    await deps.sleep(500);
  }
  if (pageReachable) {
    const candidate = deps.createClient(ready.port, gui.cdpSendTimeoutMs, gui.selectors);
    await candidate.connect();
    return { cdp: candidate, loginRequired: true };
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Kimi Code CDP 未在 ${gui.launchTimeoutMs}ms 内恢复`);
}

interface BindWorkspaceArgs {
  cdp: KimicodeCdpClient;
  ctx: TaskContext;
  gui: GuiProfile;
  deps: KimicodeRunDeps;
  budget: KimicodeBudget;
  logger: AgentRunLogger;
  ready: KimicodeReady;
  /** 与 projectTrigger 同义的共享截止时间：重试不重置预算 */
  deadlineMs: () => number;
}

/**
 * 初始派发的绑定流程：新建草稿 → 打开工作区面板 → 完整路径命中则直接点选，
 * 否则走原生「添加工作区」对话框 → 回读面板选中项 + ws-chip 文本。
 *
 * 判据是**归一化后的完整路径**（面板 `span.ws-path` 实测回读原生形式 `D:\a\b`），
 * 基名仅作回退；同名不同目录一律 fail-closed，绝不猜一个点把任务派到别的目录。
 */
async function bindWorkspace(args: BindWorkspaceArgs): Promise<KimicodeBindOutcome> {
  const { cdp, ctx, gui, deps, budget, logger, ready, deadlineMs } = args;
  const panelBudget = (): number => Math.min(5_000, Math.max(1, deadlineMs() - Date.now()));
  if (!(await ensureFreshDraft(cdp, deadlineMs(), { sleep: deps.sleep })))
    return { ok: false, reason: "draft" };
  if (!(await cdp.openWorkspacePanel(panelBudget()))) return { ok: false, reason: "panel" };
  const items = await cdp.workspaceItems();
  const matched = matchKimicodeWorkspace(items, ctx.projectPath);
  if (matched.ambiguous) return { ok: false, reason: "ambiguous", candidates: matched.candidates };
  if (matched.item) {
    const clicked = await cdp.clickWorkspaceByPath(matched.item.path ?? "");
    if (!clicked.clicked) return { ok: false, reason: "click" };
  } else {
    // 目标工作区不在「最近的文件夹」里：先采样对话框基线，再点「选择文件夹…」，
    // 只操作**新出现**的窗口（绝不盲点用户既有窗口）。
    const pids = ready.pid
      ? [ready.pid]
      : await budget.run(
          async (signal, timeoutMs) =>
            (
              await deps.listProcesses({ signal, deadline: Date.now() + timeoutMs })
            ).map((proc) => proc.pid),
          gui.dialogProbeTimeoutMs,
        );
    if (!pids.length)
      throw new KimicodeSetupPause("无法确认目标 Kimi Code 进程，拒绝操作原生对话框");
    const baseline = await budget.run(
      (signal, timeoutMs) => deps.listDialogs(pids, { signal, timeoutMs }),
      gui.dialogProbeTimeoutMs,
    );
    await cdp.dismissMenus();
    if (!(await cdp.openWorkspacePanel(panelBudget()))) return { ok: false, reason: "panel" };
    if (!(await cdp.clickChooseFolder())) return { ok: false, reason: "click" };
    let selected: Awaited<ReturnType<typeof selectKimicodeFolder>>;
    try {
      selected = await budget.run(
        (signal, timeoutMs) =>
          deps.selectFolder(ctx.projectPath, pids, baseline, {
            signal,
            timeoutMs,
            onProgress: (stage) => logger.info(`[kimicode] ${stage}`),
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
    if (!selected.ok)
      return {
        ok: false,
        reason: selected.needsPermission ? "permission" : "native",
        message: selected.message,
      };
  }
  if (!(await cdp.openWorkspacePanel(panelBudget()))) return { ok: false, reason: "panel" };
  const after = await cdp.workspaceItems();
  const active = after.filter((item) => item.active);
  if (active.length !== 1) return { ok: false, reason: "readback" };
  const bound = active[0]!;
  if (
    !bound.path ||
    normalizeWorkspacePath(bound.path) !== normalizeWorkspacePath(ctx.projectPath)
  )
    return { ok: false, reason: "readback", candidates: bound.path ? [bound.path] : undefined };
  // ws-chip 是否存在即「是否仍在草稿页」：发送后它会从 composer 消失。
  const chip = await cdp.workspaceChipText();
  if (!chip) return { ok: false, reason: "readback" };
  return { ok: true, boundPath: bound.path };
}

export async function runKimicodeTask(args: RunKimicodeArgs): Promise<AgentRunResult> {
  const started = Date.now();
  const { ctx, resolved, opts, logFile } = args;
  const baseDeps = { ...DEFAULT_DEPS, ...args.deps };
  const gui = kimicodeGuiOf(resolved);
  const { logger, close } = fileLogger(logFile, opts.logger);
  const budget = new KimicodeBudget(
    started + ctx.taskTimeoutMs,
    started + gui.setupRecoveryTimeoutMs,
    { ...opts, logger },
    gui.progressIntervalMs,
  );
  const deps: KimicodeRunDeps = {
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
                logger.debug(
                  `[kimicode] CDP ${String(key)} elapsed=${Date.now() - methodStarted}ms`,
                );
              }
            });
        },
      });
    },
  };
  let connectedCdp: KimicodeCdpClient | undefined;
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
  let permission = ctx.resume?.permissionMode ?? gui.defaultPermissionMode ?? "完全自动";
  const sessionMeta = (
    extra: Partial<NonNullable<AgentRunResult["session"]>> = {},
  ): NonNullable<AgentRunResult["session"]> => ({
    boundProjectPath: ctx.projectPath,
    model: ctx.model,
    permissionMode: permission,
    ...extra,
  });
  try {
    await mkdirp(path.dirname(logFile));
    const spec = parseKimicodeModel(ctx.model, ctx.reasoningLevel);
    // Kimi Code 无法在「无项目工作区」派发：任务必须绑定到某个工作区文件夹，
    // 而绑定判据就是 projectPath 的完整路径。这里显式拒绝，不做半个绑定。
    if (ctx.workspaceMode === "default" || !ctx.projectPath.trim())
      return result({
        hardFailure: true,
        endReason: "setup_failed",
        error:
          "Kimi Code 不支持无项目模式（default 工作区）：任务必须绑定到工作区文件夹，请提供 projectPath",
      });
    const refs = validateTaskReferences(ctx.task, ctx.context, ctx.projectPath);
    if (!resolved.command)
      return result({
        hardFailure: true,
        error: "未找到 Kimi Code 可执行文件",
        endReason: "setup_failed",
      });

    budget.setStage("接管 Kimi Code 实例");
    let inst: Awaited<ReturnType<typeof ensureKimicodeInstance>> = {};
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
          throw new KimicodeSetupPause("Kimi Code 实例连接尚未恢复，请检查应用状态后继续");
        logger.warn(
          `[kimicode] 实例接管暂时失败；attempt=${attempt + 1}；${error instanceof Error ? error.message : String(error)}`,
        );
        await deps.sleep(500 * (attempt + 1));
      }
    }
    if (inst.needsClose)
      return result({
        endReason: "needs_user",
        needsUserKind: "close_existing_instance",
        pendingQuestion:
          "检测到未开启 CDP 的 Kimi Code 实例。请保存工作并手动关闭所有 Kimi Code 窗口，然后调用 continue_task 确认（不会自动结束你的进程）。",
        progressSummary: "等待用户关闭既有 Kimi Code 实例",
      });
    if (!inst.ready)
      return result({ hardFailure: true, error: "Kimi Code 实例未就绪", endReason: "setup_failed" });
    const ready: KimicodeReady = inst.ready;
    const connected = await connectStableKimicode(ready, gui, deps);
    const cdp = connected.cdp;
    connectedCdp = cdp;
    if (connected.loginRequired)
      return result({
        endReason: "needs_user",
        needsUserKind: "login_required",
        pendingQuestion:
          "Kimi Code 主窗口已连接，但消息输入框在观察期内始终未出现（通常意味着停在登录/引导页）。请在 Kimi Code 中完成登录或引导，然后调用 continue_task 确认。",
        session: sessionMeta(),
        progressSummary: "等待 Kimi Code 登录/引导完成",
      });
    logger.info("[kimicode] Kimi Code CDP 主窗口与 composer 已就绪");
    await cdp.dismissMenus();

    budget.setStage("准备会话");
    /**
     * 阶段截止时间：调用方的预算上限一律被「任务总时限 / setup 预算」夹住，
     * 且整段流程共用（重试不重置预算）。工作区阶段取 workspaceTriggerBudgetMs
     * （Kimi Code 判定草稿页是否真的建立），浮层菜单阶段取 projectTriggerTimeoutMs
     * （点击触发器后确认菜单打开的预算，与 ZCode 同义）。
     */
    const stageDeadline = (budgetMs: number): number =>
      Math.min(
        Date.now() + budgetMs,
        started + ctx.taskTimeoutMs,
        started + gui.setupRecoveryTimeoutMs,
      );
    const menuBudget = (): number => Math.max(1, stageDeadline(gui.projectTriggerTimeoutMs) - Date.now());
    /**
     * 初始派发 = 不带原会话锚点的新任务。返修/continue 走「唯一定位原会话」，
     * 定位不到一律 session_lost，绝不打开「最近会话」。
     */
    const initialDispatch =
      !ctx.resume ||
      (ctx.resume.kind === "continue" &&
        !ctx.resume.sendMessage &&
        !ctx.resume.sessionId &&
        !ctx.resume.sessionTitle);
    if (!initialDispatch && ctx.resume) {
      budget.setStage("定位原 Kimi Code 会话");
      if (!ctx.resume.sessionId && !ctx.resume.sessionTitle)
        return result({
          hardFailure: true,
          error: "缺少原 Kimi Code 会话定位信息，拒绝打开最近会话",
          endReason: "session_lost",
        });
      const located = await locateSession(cdp, ctx.resume.sessionId, ctx.resume.sessionTitle);
      if (!located.found)
        return result({
          hardFailure: true,
          error: `无法唯一定位原 Kimi Code 会话（原因=${located.reason ?? "unknown"}），已 fail-closed 且不发送`,
          endReason: "session_lost",
        });
      logger.info(
        `[kimicode] 已定位原会话 ${located.id ?? ""}（来源=${located.source ?? "n/a"}）`,
      );
    } else {
      budget.setStage("建立新草稿并绑定工作区");
      const bound = await bindWorkspace({
        cdp,
        ctx,
        gui,
        deps,
        budget,
        logger,
        ready,
        deadlineMs: () => stageDeadline(workspaceTriggerBudgetMs(gui)),
      });
      if (!bound.ok) {
        const describe: Record<string, string> = {
          draft:
            "无法进入新的 Kimi Code 草稿页：点击新建会话后工作区触发器（ws-chip）始终未挂载",
          panel: "无法打开 Kimi Code 工作区下拉面板（点击被吞或面板未出现）",
          ambiguous: `工作区同名或路径重复，无法消歧：${bound.candidates?.join("、") ?? ""}`,
          click: "工作区面板里命中条目但点击未生效",
          permission: "原生「添加工作区」对话框需要系统辅助功能权限",
          native: `原生「添加工作区」对话框未完成路径提交：${bound.message ?? ""}`,
          readback: `工作区绑定回读不一致（期望 ${ctx.projectPath}${bound.candidates?.length ? `，实际 ${bound.candidates.join("、")}` : ""}）`,
        };
        const reason = bound.reason ?? "native";
        const needsPermission = reason === "permission";
        logger.warn(
          `[kimicode] 工作区绑定失败：reason=${reason}；${describe[reason] ?? "未知原因"}${bound.message ? `；${bound.message}` : ""}`,
        );
        return result({
          hardFailure: !needsPermission,
          endReason: needsPermission ? "needs_user" : "setup_failed",
          needsUserKind: needsPermission ? "system_permission" : "setup_recovery",
          error: needsPermission ? undefined : (describe[reason] ?? "工作区绑定失败"),
          pendingQuestion: needsPermission
            ? "请为 Kimi Code/System Events 授予 Accessibility 权限后调用 continue_task 确认。"
            : `${describe[reason] ?? "工作区绑定失败"}。请在 Kimi Code 中确认目标工作区后调用 continue_task；不会向其它工作区发送任务。`,
          session: sessionMeta(),
          progressSummary: "等待 Kimi Code 工作区绑定",
        });
      }
      logger.info(`[kimicode] 工作区绑定回读通过：${bound.boundPath}`);
      await cdp.dismissMenus();
    }

    // ---------------- 模型与思考档位 ----------------

    /** 读触发器文本；waitForModel 时等到模型名回读一致（限定观察期，不无限等） */
    const readPill = async (waitForModel = false): Promise<string> => {
      const until = Math.min(started + ctx.taskTimeoutMs, Date.now() + 5_000);
      let last = "";
      for (let attempt = 0; attempt < 25 && Date.now() < until; attempt++) {
        // eslint-disable-next-line no-await-in-loop
        last = await cdp.modelTriggerText();
        if (!waitForModel || exactUiName(parseTriggerValue(last).model, spec.model)) return last;
        // eslint-disable-next-line no-await-in-loop
        await deps.sleep(Math.min(200, Math.max(0, until - Date.now())));
      }
      return last;
    };
    budget.setStage("确认模型");
    const modelMatches = (text: string): boolean =>
      exactUiName(parseTriggerValue(text).model, spec.model);
    let pill = await readPill();
    /** 诊断用：快捷菜单与对话框各自可见的候选（UI 漂移时的定位依据） */
    let menuCandidates: string[] = [];
    let dialogCandidates: string[] = [];
    /** 是否真的点中过某个候选行——决定了失败是「没有这个模型」还是「点了但没生效」 */
    let pickedAnywhere = false;
    if (!modelMatches(pill)) {
      // 二级：overlay 快捷菜单直选（官方模型通常在这里）。
      if (await cdp.openModelMenu(menuBudget())) {
        const models = await cdp.overlayModels();
        const clicked = await cdp.clickOverlayExact("modelOption", spec.model);
        menuCandidates = clicked.available.length
          ? clicked.available
          : models.map((item) => item.label).filter(Boolean);
        pickedAnywhere ||= clicked.clicked;
        if (clicked.clicked) {
          await deps.sleep(300);
          pill = await readPill(true);
        } else
          logger.info(
            `[kimicode] 快捷菜单未命中 ${spec.model}（匹配 ${clicked.count}；可见候选=${menuCandidates.join("、") || "无"}）；转「更多模型…」对话框`,
          );
      } else
        logger.warn(
          "[kimicode] 无法打开模型菜单（浮层未出现或点击被吞），直接尝试「更多模型…」对话框",
        );
    } else logger.info(`[kimicode] 模型回读已匹配，复用 ${spec.model}`);

    /**
     * 三级：overlay「更多模型…」→ 主窗口「切换模型」对话框搜索 + 精确选行。
     * 这条路径是**非官方模型的唯一入口**：它们不在快捷菜单里（用户官方额度用尽时就只剩它）。
     * 搜索词策略：完整模型名优先；含 `/` 的名字在 0 命中时再按 provider（`/` 前半段）搜一次，
     * 但**命中判定始终用完整名精确比较**——搜索只负责把行渲染出来，不参与身份判定。
     */
    if (!modelMatches(pill)) {
      if (!(await cdp.openModelPicker(menuBudget())))
        logger.warn("[kimicode] 未能点开「更多模型…」入口（浮层未出现或该行未渲染）");
      else {
        let dialogOpened = false;
        for (let attempt = 0; attempt < 25 && Date.now() < started + ctx.taskTimeoutMs; attempt++) {
          // eslint-disable-next-line no-await-in-loop
          if (await cdp.modelDialogOpen()) {
            dialogOpened = true;
            break;
          }
          // eslint-disable-next-line no-await-in-loop
          await deps.sleep(200);
        }
        if (!dialogOpened) logger.warn("[kimicode] 「切换模型」对话框未在观察期内出现");
        else {
          const queries = spec.model.includes("/")
            ? [spec.model, spec.model.slice(0, spec.model.indexOf("/"))]
            : [spec.model];
          for (const query of queries) {
            // eslint-disable-next-line no-await-in-loop
            const searched = await cdp.searchModelDialog(query, menuBudget());
            if (searched.rowNames.length) dialogCandidates = searched.rowNames;
            // eslint-disable-next-line no-await-in-loop
            const picked = await cdp.clickModelDialogRowByName(spec.model);
            if (picked.available.length) dialogCandidates = picked.available;
            if (picked.clicked) {
              pickedAnywhere = true;
              break;
            }
            logger.warn(
              `[kimicode] 对话框搜索「${query}」后未命中 ${spec.model}（可见候选=${dialogCandidates.join("、") || "无"}）`,
            );
          }
          // 实测点击候选后对话框自动关闭；等它真的关掉再回读，避免读到切换中的中间态。
          for (let attempt = 0; attempt < 25 && Date.now() < started + ctx.taskTimeoutMs; attempt++) {
            // eslint-disable-next-line no-await-in-loop
            if (!(await cdp.modelDialogOpen())) break;
            // eslint-disable-next-line no-await-in-loop
            await deps.sleep(200);
          }
          await deps.sleep(300);
          pill = await readPill(true);
        }
      }
    }

    if (!modelMatches(pill)) {
      // 三级都没让界面切到目标模型：先收尾关闭对话框（残留对话框会吞掉后续键盘注入），
      // 再按「是否点中过候选行」区分 model_mismatch（点了没生效）与 model_unavailable（没这个模型）。
      await cdp.closeModelDialog();
      const describe = `快捷菜单候选=${menuCandidates.join("、") || "无"}；对话框候选=${dialogCandidates.join("、") || "无"}`;
      if (pickedAnywhere)
        return result({
          hardFailure: true,
          error: `模型切换回读不一致：触发器文本=${pill || "空"}，期望模型=${spec.model}（${describe}）`,
          endReason: "model_mismatch",
        });
      return result({
        hardFailure: true,
        error: `模型不存在或同名歧义：${spec.model}（${describe}）`,
        endReason: "model_unavailable",
      });
    }

    /**
     * 回读一致但对话框可能仍开着（点击被吞/未自动关闭）：显式收尾。
     * 不这样做时后续「档位」「执行模式」的点击会被残留对话框吞掉，报错会指向错误的方向。
     */
    await cdp.closeModelDialog();
    const parsedPill = parseTriggerValue(pill);
    if (!exactUiName(parsedPill.model, spec.model))
      return result({
        hardFailure: true,
        error: `模型切换回读不一致：触发器文本=${pill || "空"}，期望模型=${spec.model}`,
        endReason: "model_mismatch",
      });

    budget.setStage("确认思考档位");
    if (!(await cdp.openModelMenu(menuBudget())))
      return result({
        hardFailure: true,
        error: "无法打开 Kimi Code 模型菜单以读取思考档位标签",
        endReason: "model_mismatch",
      });
    // 档位集合的唯一来源是界面实际渲染的档位标签（不内置模型名单，见 model.ts 说明）。
    const tierItems = await cdp.reasoningTiers();
    const tiers = tierSetOf(tierItems.map((item) => item.label));
    const currentTierToken =
      tierItems.find((item) => item.current)?.label ?? parsedPill.levelToken ?? "";
    try {
      assertLevelSupported(spec, tiers);
    } catch (e) {
      return result({
        hardFailure: true,
        error: e instanceof Error ? e.message : String(e),
        endReason: "model_mismatch",
      });
    }
    const targetLevel: KimicodeLevel | undefined =
      spec.level ??
      (tiers.kind === "unknown"
        ? undefined
        : defaultLevelFor(tiers.kind, levelOfToken(currentTierToken)));
    if (targetLevel && !levelTokenMatches(currentTierToken, targetLevel)) {
      const target = tierItems.find((item) => levelTokenMatches(item.label, targetLevel));
      if (!target)
        return result({
          hardFailure: true,
          error: `界面档位集合里没有目标档位 ${targetLevel}（可见=${candidatesOf(tierItems) || "空"}）`,
          endReason: "model_mismatch",
        });
      const clickedTier = await cdp.clickOverlayExact("thinkingSegment", target.label);
      if (!clickedTier.clicked)
        return result({
          hardFailure: true,
          error: `无法唯一点击思考档位 ${target.label}（匹配 ${clickedTier.count}${clickedTier.available.length ? `；可见候选=${clickedTier.available.slice(0, 20).join("、")}` : ""}）`,
          endReason: "model_mismatch",
        });
      await deps.sleep(250);
      const afterToken = (await cdp.reasoningTiers()).find((item) => item.current)?.label ?? "";
      if (!levelTokenMatches(afterToken, targetLevel))
        return result({
          hardFailure: true,
          error: `思考档位回读不一致：期望 ${target.label}，实际 ${afterToken || "空"}`,
          endReason: "model_mismatch",
        });
      logger.info(`[kimicode] 思考档位已切换并回读：${afterToken}`);
    } else logger.info(`[kimicode] 思考档位回读已匹配，沿用 ${currentTierToken || "界面当前值"}`);

    // ---------------- 执行模式（完全自动） ----------------

    budget.setStage("确认执行模式");
    permission = ctx.resume?.permissionMode ?? gui.defaultPermissionMode ?? "完全自动";
    await cdp.dismissMenus();
    if (!exactUiName(await cdp.permissionText(), permission)) {
      if (!(await cdp.openPermissionMenu(menuBudget())))
        return result({
          hardFailure: true,
          error: "无法打开 Kimi Code 执行模式菜单（浮层窗口未出现或触发器点击被吞）",
          endReason: "permission_unknown",
        });
      const permissions = await cdp.overlayPermissions();
      const clicked = await cdp.clickOverlayExact("permissionOption", permission);
      if (!clicked.clicked)
        return result({
          hardFailure: true,
          error: `无法唯一选择执行模式：${permission}（匹配 ${clicked.count}${clicked.available.length ? `；可见候选=${clicked.available.slice(0, 20).join("、")}` : `；可见候选=${candidatesOf(permissions)}`}）`,
          endReason: "permission_unknown",
        });
      await deps.sleep(250);
    } else logger.info(`[kimicode] 执行模式回读已匹配，复用 ${permission}`);
    const permissionAfter = await cdp.permissionText();
    if (!exactUiName(permissionAfter, permission))
      return result({
        hardFailure: true,
        error: `执行模式回读不一致：期望 ${permission}，实际 ${permissionAfter || "空"}`,
        endReason: "permission_unknown",
      });

    // ---------------- 组装任务书并发送 ----------------

    budget.setStage("发送任务书");
    const message = taskText(ctx, refs, initialDispatch);
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
    /**
     * 发送前基线：失败文案的「本轮新增」判据。
     * 返修轮的原会话里可能残留上一轮的「模型请求失败，本轮对话已中断」，不设基线就会把
     * 陈旧文案当成新一轮失败（或反之）。「继续」按钮属于当前失败态的强信号，不做基线过滤。
     */
    const baselineError = (await cdp.poll()).errorText ?? "";
    if (opts.signal?.aborted) return result({ killed: true, endReason: "aborted" });
    if (Date.now() >= started + ctx.taskTimeoutMs)
      return result({
        timeout: true,
        endReason: "task_timeout",
        error: "Kimi Code 任务总时限已到，未发送任务",
      });
    await cdp.typeText(marker + message);
    const typed = await cdp.inputText();
    if (!typed.includes(marker))
      return result({
        hardFailure: true,
        error: "Kimi Code 输入框回读不一致，未发送",
        endReason: "input_mismatch",
      });
    if (opts.signal?.aborted) return result({ killed: true, endReason: "aborted" });
    try {
      await cdp.sendMessage();
    } catch (e) {
      // 发送按钮点不到：窗口被遮挡/节流或按钮未启用。没有确认证据，与「发送结果无法确认」
      // 同一归类，且绝不重发。
      return result({
        hardFailure: true,
        endReason: "send_unknown",
        error: `${e instanceof Error ? e.message : String(e)}；未确认发送，不重复发送`,
      });
    }
    // 发送确认：会话 id（URL）+ 用户消息落地为必需锚点，输入框清空/运行信号/用户消息复制按钮
    // 任一成立即算确认。60s 有界，且一旦进入本段就**只点击一次**发送（绝不重发）。
    let seenMessage = before.includes(marker);
    let seenStateChange = false;
    let seenRunning = false;
    let seenUserCopy = false;
    let sessionId = initialDispatch ? "" : (ctx.resume?.sessionId ?? "");
    let sessionTitle = initialDispatch ? undefined : ctx.resume?.sessionTitle;
    const confirmationDeadline = Math.min(started + ctx.taskTimeoutMs, Date.now() + 60_000);
    const confirmationAttempts = Math.ceil(Math.max(0, confirmationDeadline - Date.now()) / 250);
    for (
      let i = 0;
      i < confirmationAttempts &&
      Date.now() < confirmationDeadline &&
      !(sessionId && seenMessage && (seenStateChange || seenRunning || seenUserCopy));
      i++
    ) {
      // eslint-disable-next-line no-await-in-loop
      if (opts.signal?.aborted) return result({ killed: true, endReason: "aborted" });
      // eslint-disable-next-line no-await-in-loop
      await deps.sleep(Math.min(250, Math.max(0, confirmationDeadline - Date.now())));
      // eslint-disable-next-line no-await-in-loop
      const [text, input, polled, current, userCopy] = await Promise.all([
        cdp.conversationText(),
        cdp.inputText(),
        cdp.poll(),
        cdp.currentSessionId(),
        cdp.exists("userCopyButton"),
      ]);
      seenMessage ||= text.includes(marker);
      // 输入框清空是 ProseMirror 侧的可观测事实：归一化后为空串（清空后保留的空 <p> 不算内容）。
      seenStateChange ||= !input.normalize("NFKC").trim();
      seenRunning ||= polled.stopVisible || polled.sendStarting;
      seenUserCopy ||= userCopy;
      if (!sessionId && current.id) {
        sessionId = current.id;
        // 会话标题只作辅助锚点（侧栏可能尚未登记新会话）：以侧栏实际标题为准，
        // 绝不拿对话正文冒充标题——返修定位时标题会被用于唯一定位。
        sessionTitle = (await cdp.sessions()).find((item) => item.id === sessionId)?.title;
      }
    }
    if (Date.now() >= started + ctx.taskTimeoutMs)
      return result({
        timeout: true,
        endReason: "task_timeout",
        error: "Kimi Code 发送观察达到任务总时限；保留现场且不重复发送",
      });
    if (!(sessionId && seenMessage && (seenStateChange || seenRunning || seenUserCopy)))
      return result({
        hardFailure: true,
        error: `发送结果无法确认（用户消息=${seenMessage}，输入框已清空=${seenStateChange}，运行信号=${seenRunning}，用户消息复制按钮=${seenUserCopy}，会话 id=${sessionId || "空"}）；不重复发送`,
        endReason: "send_unknown",
      });
    logger.info(
      `[kimicode] 发送已确认：会话=${sessionId}；用户消息=${seenMessage}；输入框已清空=${seenStateChange}；运行信号=${seenRunning}；用户消息复制按钮=${seenUserCopy}`,
    );

    // ---------------- 轮询运行判定 ----------------

    budget.finishSetup();
    budget.setStage("等待 Kimi Code 回复");
    const deadline = started + ctx.taskTimeoutMs;
    let state: KimicodePollState = { hash: "", stable: 0, idleSince: 0 };
    const stallSince = { since: 0 };
    let lastProgress = 0;
    for (;;) {
      if (opts.signal?.aborted) return result({ killed: true, endReason: "aborted" });
      if (Date.now() >= deadline)
        return result({
          timeout: true,
          endReason: "task_timeout",
          error: "Kimi Code 任务总时限已到；已停止 MCP 等待并保留 Kimi Code 现场",
          session: sessionMeta({ id: sessionId, title: sessionTitle }),
        });
      await deps.sleep(gui.pollIntervalMs);
      const raw = await cdp.poll();
      const poll: KimicodePoll =
        raw.errorText && raw.errorText === baselineError ? { ...raw, errorText: undefined } : raw;
      const verdict = judgeKimicodePoll(
        poll,
        state,
        gui.stableRounds,
        gui.idleTimeoutMs,
        gui.stallTimeoutMs,
        stallSince,
      );
      state = verdict.state;
      if (Date.now() - lastProgress >= gui.progressIntervalMs) {
        const note = `Kimi Code 进度：${verdict.kind}；运行证据=${verdict.evidence}；回复哈希=${state.hash}；稳定轮=${state.stable}；窗口前台=${!poll.pageHidden}`;
        await Promise.resolve(opts.onProgress?.(note)).catch(() => {});
        logger.info(note);
        lastProgress = Date.now();
      }
      if (verdict.kind === "needs_user")
        return result({
          endReason: "needs_user",
          // stall 判定（停止按钮恒可见 + 文本停滞）是「等用户确认」，与模型提问的恢复语义不同
          // （前者重连观察、后者要精确提交回答），所以在这里就分开标注。
          needsUserKind: verdict.evidence.includes("stall")
            ? "user_confirmation"
            : "agent_question",
          pendingQuestion:
            verdict.question ?? "Kimi Code 正在等待用户输入，请处理后调用 continue_task。",
          session: sessionMeta({ id: sessionId, title: sessionTitle }),
          progressSummary: "Kimi Code 等待用户处理",
        });
      if (verdict.kind === "idle_timeout")
        return result({
          endReason: "idle_timeout",
          error: `Kimi Code 空闲超时（连续 ${gui.stableRounds} 轮无变化）；已停止 MCP 等待并保留现场${poll.pageHidden ? "；Kimi Code 窗口不在前台，点击可能被吞" : ""}`,
          session: sessionMeta({ id: sessionId, title: sessionTitle }),
        });
      if (verdict.kind === "failed")
        return result({
          hardFailure: true,
          endReason: "agent_error",
          error: `Kimi Code 本轮对话判定失败：${poll.errorText || "界面出现「继续」按钮（模型请求失败，本轮对话已中断）"}${poll.pageHidden ? "；Kimi Code 窗口不在前台，点击可能被吞" : ""}`,
          session: sessionMeta({ id: sessionId, title: sessionTitle }),
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
          session: sessionMeta({ id: sessionId, title: sessionTitle }),
          progressSummary: "Kimi Code 已完成回复",
        };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof KimicodeBudgetError) {
      if (e.reason === "aborted") return result({ killed: true, endReason: "aborted" });
      if (e.reason === "task_timeout")
        return result({ timeout: true, endReason: "task_timeout", error: msg });
    }
    if (e instanceof KimicodeSetupPause || (e instanceof KimicodeBudgetError && budget.settingUp))
      return result({
        endReason: "needs_user",
        needsUserKind:
          e instanceof KimicodeSetupPause && e.needsPermission
            ? "system_permission"
            : "setup_recovery",
        pendingQuestion: `${msg}。请在 Kimi Code 中确认工作区 ${ctx.projectPath} 与模型 ${ctx.model ?? ""}，处理后调用 continue_task；原任务已保留。`,
        progressSummary: "自动恢复未能完成，等待处理后继续原任务",
      });
    if (e instanceof KimicodeBudgetError)
      return result({ hardFailure: true, endReason: "cdp_disconnected", error: msg });
    if (e instanceof CdpDisconnectedError || e instanceof CdpUnavailableError)
      return result({ hardFailure: true, error: msg, endReason: "cdp_disconnected" });
    return result({ hardFailure: true, error: msg, endReason: "internal" });
  } finally {
    budget.close();
    connectedCdp?.disconnect();
    await close();
  }
}