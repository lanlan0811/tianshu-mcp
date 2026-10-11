/**
 * Open Design 任务执行面（计划 §3.4 的 12 步时序）。
 *
 * 时序（每步都 fail-closed，且「点中 ≠ 生效」一律靠回读确认）：
 *   1–2 接管/启动实例 → 连接主窗口（要求输入框真正就绪）→ 版本门禁 → 选择器守卫/布局盘点
 *   3   绑定工作目录：展开触发区 → 点「选择目录」→ 原生对话框填绝对路径 → 回读显示值
 *   4   模型：精确匹配菜单项 + 回读触发区文本，写入 `actualModel`
 *   5   设计系统：搜索过滤 → 精确点选 → 回读
 *   6   设计方向：归一为 prototype/document/clone（非法值入口即拒）
 *   7–8 输入任务书（可信输入 + 回读含标记）→ 点发送 → 有界确认（**绝不重发**）
 *   9   三信号轮询（停止按钮 / 对话文本哈希 / 产物指纹）→ 终态
 *   10–12 终态交编排器；验收与返修由编排器（`loop/fix-loop.ts`）驱动，本文件不越权
 *
 * 恢复语义按 `ctx.resume` 分派（与 kimicode 同构）：
 * - `reobserve`（user_confirmation）：重连后只观察，**不发送任何消息**；
 * - `agent_question`（sendMessage=true）：把回答发进**当前会话**（会话不在会话页即 `session_lost`）；
 * - `rework`：把返修指令发进当前会话；
 * - 环境类 needs_user 恢复：走全新派发（重绑目录并补发完整任务书）。
 *
 * 取消：abort 后尽力点停止按钮并在 `gui.cancelWaitMs` 内有界等待界面空闲；未确认停止时
 * 终态文案必须明示「GUI 内运行可能仍在继续」，并保留实例（`keptInstance`）。
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type {
  AgentRunOptions,
  AgentRunLogger,
  AgentRunResult,
  ResolvedAgent,
  TaskContext,
} from "../adapter.js";
import type { GuiProfile, OpenDesignProfile } from "../../config/schema.js";
import { OPEN_DESIGN_DEFAULTS, ZCODE_SETUP_DEFAULTS } from "../../config/schema.js";
import { makeEmitter } from "../agent-events.js";
import { fetchArtifactForSummary } from "./artifact.js";
import { validateTaskReferences } from "../zcode/references.js";
import {
  ensureOpenDesignInstance,
  listOpenDesignProcessesAsync,
  probeOpenDesignPort,
  readAppConfig,
  rootOpenDesignProcesses,
  versionGateError,
  waitForDaemonReady,
  type OpenDesignInstanceOptions,
  type OpenDesignProcess,
  type OpenDesignReady,
} from "./instance.js";
import { closeStrayDialogs, listOwnedDialogs, selectOpenDesignFolder } from "./dialog.js";
import {
  readInstallInfo,
  openDesignNamespaceRoot,
  openDesignAppConfigPath,
} from "./discovery.js";
import {
  OpenDesignCdpClient,
  openDesignMainTargetRank,
  type OpenDesignDocumentProbe,
} from "./cdp.js";
import { OpenDesignTransport } from "./transport.js";
import type { KimicodePageClient } from "../kimicode/cdp.js";
import { missingSelectorKeys } from "./selectors.js";
import { bindWorkspace } from "./workspace.js";
import { chooseExportKind, exportArtifact } from "./export.js";
import { selectMenuItem } from "./menu.js";
import { dispatchTask } from "./send.js";
import { normalizeOpenDesignDirection, directionLabel } from "./model.js";
import {
  artifactSignatureOf,
  initialOpenDesignState,
  judgeOpenDesignPoll,
  type OpenDesignPoll,
  type OpenDesignPollState,
} from "./liveness.js";
import {
  OpenDesignBudget,
  OpenDesignBudgetError,
  OpenDesignSetupPause,
  permissionError,
  transientSetupError,
} from "./recovery.js";
import { suggestVisualPages } from "./visual.js";

export interface RunOpenDesignArgs {
  ctx: TaskContext;
  resolved: ResolvedAgent;
  opts: AgentRunOptions;
  logFile: string;
  deps?: Partial<OpenDesignRunDeps>;
}

export interface OpenDesignRunDeps {
  ensureInstance: typeof ensureOpenDesignInstance;
  listProcesses: (options?: OpenDesignInstanceOptions) => Promise<OpenDesignProcess[]>;
  /** CDP 端口产品校验（单测注入即不必真的起服务） */
  probePort: typeof probeOpenDesignPort;
  /** 页面级传输（真实实现为 TraeworkCdpClient 注入主窗口排序；单测注入内存桩） */
  createPage: (port: number, sendTimeoutMs: number, overrides: Record<string, string>) => KimicodePageClient;
  /** 语义操作层（单测可替换，默认用真实 OpenDesignCdpClient 包住 createPage 的结果） */
  makeClient: (page: KimicodePageClient, overrides: Record<string, string>) => OpenDesignCdpClient;
  listDialogs: typeof listOwnedDialogs;
  selectFolder: typeof selectOpenDesignFolder;
  closeDialogs: typeof closeStrayDialogs;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_DEPS: OpenDesignRunDeps = {
  ensureInstance: ensureOpenDesignInstance,
  listProcesses: listOpenDesignProcessesAsync,
  probePort: probeOpenDesignPort,
  // 传输层用本产品专用实现：既有 GUI 传输在 connect 里走 HTTP /json，
  // 而真机实测本产品的 /json 会挂起（详见 transport.ts 的文件头说明）。
  createPage: (port, sendTimeoutMs) =>
    new OpenDesignTransport({
      port,
      sendTimeoutMs,
      targetRank: openDesignMainTargetRank,
    }) as unknown as KimicodePageClient,
  makeClient: (page, overrides) => new OpenDesignCdpClient(page, overrides),
  listDialogs: listOwnedDialogs,
  selectFolder: selectOpenDesignFolder,
  closeDialogs: closeStrayDialogs,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * 首页入口（首页 hero 不在前台时用它切回首页；产品自己的导航钩子）。
 *
 * 真机取证（2026-10-11，0.24.1）：`entry-view-home` / `entry-nav-home` **均已不存在**
 * （实测命中 0）。当前页面若停在会话/文件页，`tryReturnHome` 会点空气 → 切不回 →
 * 布局守卫报 `selector_drift`（真机任务 tsk_20261011081412_a43de4 即此）。
 *
 * 0.24.1 实测存在的入口候选：`workspace-home-chrome`（左上角 chrome，1 命中且可见）。
 * 旧钩子保留为 fallback（兼容旧版本）。
 *
 * 刻意**不**把 `chat-log` / `chat-composer` 列进来：它们是会话区容器，点击不会切回首页。
 */
export const OPEN_DESIGN_HOME_ENTRY_SELECTOR =
  '[data-testid="entry-view-home"], [data-testid="entry-nav-home"], [data-testid="workspace-home-chrome"]';

/** profile 缺省值兜底（与 kimicodeGuiOf 同构：profile 是数据，默认值只在读取点提供） */
export function openDesignGuiOf(resolved: ResolvedAgent): GuiProfile {
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
    cdpPort: g?.cdpPort ?? 9889,
    cdpPortAuto: g?.cdpPortAuto ?? true,
    cdpPortRange: g?.cdpPortRange ?? 10,
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
    modeSwitch: g?.modeSwitch ?? true,
    freshSession: g?.freshSession ?? true,
    selectors: g?.selectors ?? {},
    modelRequired: g?.modelRequired ?? true,
    activation: g?.activation ?? "spawn",
    defaultAutoFixRounds: g?.defaultAutoFixRounds ?? 2,
  };
}

/** Open Design 专属配置兜底 */
export function openDesignProfileOf(
  profile: OpenDesignProfile | undefined,
): Required<
  Pick<
    OpenDesignProfile,
    | "supportedVersions"
    | "workingDirPanelTimeoutMs"
    | "nativeDialogTimeoutMs"
    | "exportTimeoutMs"
    | "modelMenuTimeoutMs"
    | "designSystemTimeoutMs"
    | "designDirectionTimeoutMs"
    | "sendReadyTimeoutMs"
    | "planDir"
    | "directionLabels"
  >
> {
  return {
    supportedVersions: profile?.supportedVersions ?? {},
    workingDirPanelTimeoutMs:
      profile?.workingDirPanelTimeoutMs ?? OPEN_DESIGN_DEFAULTS.workingDirPanelTimeoutMs,
    nativeDialogTimeoutMs:
      profile?.nativeDialogTimeoutMs ?? OPEN_DESIGN_DEFAULTS.nativeDialogTimeoutMs,
    exportTimeoutMs: profile?.exportTimeoutMs ?? OPEN_DESIGN_DEFAULTS.exportTimeoutMs,
    modelMenuTimeoutMs: profile?.modelMenuTimeoutMs ?? OPEN_DESIGN_DEFAULTS.modelMenuTimeoutMs,
    designSystemTimeoutMs:
      profile?.designSystemTimeoutMs ?? OPEN_DESIGN_DEFAULTS.designSystemTimeoutMs,
    designDirectionTimeoutMs:
      profile?.designDirectionTimeoutMs ?? OPEN_DESIGN_DEFAULTS.designDirectionTimeoutMs,
    sendReadyTimeoutMs: profile?.sendReadyTimeoutMs ?? OPEN_DESIGN_DEFAULTS.sendReadyTimeoutMs,
    planDir: profile?.planDir ?? OPEN_DESIGN_DEFAULTS.planDir,
    directionLabels: profile?.directionLabels ?? {},
  };
}

/** 把 adapter 日志同时写进任务日志文件（与 kimi/zcode 同构） */
function fileLogger(
  file: string,
  base: AgentRunLogger,
): { logger: AgentRunLogger; close: () => Promise<void> } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
  stream.write(`\n===== opendesign-gui run @ ${new Date().toISOString()} =====\n`);
  const wrap = (level: string) => (m: string) => {
    stream.write(`[${level}] ${m}\n`);
    base[level as "info"](m);
  };
  return {
    logger: { info: wrap("info"), warn: wrap("warn"), error: wrap("error"), debug: wrap("debug") },
    close: () => new Promise((r) => stream.end(r)),
  };
}

/** 任务书组装：与 zcode/kimicode 同构（task + 上下文 + 已验证引用 + 返修反馈） */
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
    out += `\n\n【已验证项目引用】\n${refs
      .map((r) => `- ${r.directory ? "目录" : "文件"}: ${r.source} => ${r.absolutePath}`)
      .join("\n")}`;
  if (ctx.feedback?.trim()) out += `\n\n【自动验收返修】\n${ctx.feedback}`;
  return out;
}

/** 扫描深度上限（设计稿产物通常很浅；深挖只会拖慢轮询） */
const ARTIFACT_MAX_DEPTH = 3;
/** 单次扫描的文件数上限（防御性：异常工程结构不应把轮询拖死） */
const ARTIFACT_MAX_FILES = 400;
const ARTIFACT_SKIP_DIRS = new Set(["node_modules", ".git", ".tianshu-mcp", ".opendesign"]);

/**
 * 产物指纹：项目根内文件的「相对路径:大小:mtimeMs」串接。
 *
 * 为什么需要第三路信号：Open Design 生成设计稿时会**长时间不刷对话**却持续写文件，
 * 只看对话文本会把这类正常工作判成「空闲完成」。扫描有界（深度 3 / 400 文件），
 * 失败一律退化为空指纹（= 该轮不参与判定），绝不让扫描把轮询拖死。
 */
export function scanArtifactSignature(projectPath: string, budgetMs = 1_500): string {
  const root = projectPath.trim();
  if (!root) return "";
  const deadline = Date.now() + budgetMs;
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  try {
    while (queue.length && files.length < ARTIFACT_MAX_FILES) {
      if (Date.now() >= deadline) break;
      const current = queue.shift()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (files.length >= ARTIFACT_MAX_FILES) break;
        if (entry.name.startsWith(".") || ARTIFACT_SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(current.dir, entry.name);
        if (entry.isDirectory()) {
          if (current.depth + 1 <= ARTIFACT_MAX_DEPTH)
            queue.push({ dir: full, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const stat = fs.statSync(full);
          files.push({
            path: path.relative(root, full).split(path.sep).join("/"),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
          });
        } catch {
          /* 竞态删除不影响指纹 */
        }
      }
    }
  } catch {
    return "";
  }
  return artifactSignatureOf(files);
}

/** 尽力停止 GUI 内正在运行的 turn（照 codex M14 语义） */
async function stopGuiTurn(
  client: OpenDesignCdpClient,
  gui: GuiProfile,
  sleep: (ms: number) => Promise<void>,
  logger: AgentRunLogger,
  purpose: "取消" | "重派护栏",
): Promise<{ clicked: boolean; idle: boolean }> {
  try {
    const first = await client.poll();
    if (!first.stopVisible && !first.sendStarting) return { clicked: false, idle: true };
    const clicked = await client.clickKey("stopButton");
    logger.info(
      `[opendesign] ${purpose}：${clicked.clicked ? "已点击" : "未能点击"} GUI 停止按钮，等待界面空闲（≤${gui.cancelWaitMs}ms）`,
    );
    const attempts = Math.max(1, Math.ceil(gui.cancelWaitMs / 500));
    for (let i = 0; i < attempts; i++) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(Math.min(500, gui.cancelWaitMs));
      // eslint-disable-next-line no-await-in-loop
      const poll = await client.poll();
      if (!poll.stopVisible && !poll.sendStarting) return { clicked: clicked.clicked, idle: true };
    }
    return { clicked: clicked.clicked, idle: false };
  } catch (e) {
    logger.warn(
      `[opendesign] ${purpose}时停止 GUI 运行失败：${e instanceof Error ? e.message : String(e)}`,
    );
    return { clicked: false, idle: false };
  }
}

export async function runOpenDesignTask(args: RunOpenDesignArgs): Promise<AgentRunResult> {
  const started = Date.now();
  const { ctx, resolved, opts, logFile } = args;
  const baseDeps: OpenDesignRunDeps = { ...DEFAULT_DEPS, ...args.deps };
  const gui = openDesignGuiOf(resolved);
  const od = openDesignProfileOf(resolved.profile.opendesign);
  const { logger, close } = fileLogger(logFile, opts.logger);
  const emit = makeEmitter(opts.onEvent);
  const budget = new OpenDesignBudget(
    started + ctx.taskTimeoutMs,
    started + gui.setupRecoveryTimeoutMs,
    { ...opts, logger },
    gui.progressIntervalMs,
  );
  /** 导出段要用的 Open Design 进程 pid 列表（在绑定工作目录时赋值；两个 observe 调用点共用） */
  let ownerPids: number[] = [];
  const deps: OpenDesignRunDeps = {
    ...baseDeps,
    sleep: (ms) => baseDeps.sleep(Math.min(ms, Math.max(1, budget.remaining()))),
  };
  let rawClient: OpenDesignCdpClient | undefined;
  let connected: OpenDesignCdpClient | undefined;
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
  const hardFail = (error: string, endReason: string): AgentRunResult =>
    result({ hardFailure: true, error, endReason });

  const abortResult = async (): Promise<AgentRunResult> => {
    const client = rawClient ?? connected;
    const guiStop = client
      ? await stopGuiTurn(client, gui, baseDeps.sleep, logger, "取消")
      : undefined;
    const progressSummary = guiStop
      ? guiStop.idle
        ? "Open Design 取消：GUI 内运行已停止"
        : "Open Design 取消：GUI 内运行未确认停止，Open Design 窗口中的任务可能仍在继续"
      : "Open Design 取消：未连接 CDP，无法确认界面停止";
    return result({ killed: true, endReason: "aborted", guiStop, progressSummary });
  };

  try {
    // ---- 入口校验：能在参数层判定的，绝不拖到 GUI 里才发现 ----
    const direction = normalizeOpenDesignDirection(ctx.designDirection);
    if (!direction.ok) return hardFail(direction.error, "setup_failed");
    const isReobserve = ctx.resume?.kind === "continue" && ctx.resume?.reobserve === true;
    const initialDispatch =
      !ctx.resume ||
      (ctx.resume.kind === "continue" &&
        !ctx.resume.sendMessage &&
        !ctx.resume.sessionId &&
        !ctx.resume.sessionTitle);
    if (initialDispatch && !ctx.task.trim())
      return hardFail("Open Design 任务书（task）不能为空", "setup_failed");
    if (!resolved.command) return hardFail("未找到 Open Design 可执行文件", "setup_failed");
    // 静态守卫：注册表里关键锚点必须有值（缺一个即拒绝派发，绝不用猜的选择器去点）
    const missing = missingSelectorKeys(gui.selectors);
    if (missing.length)
      return hardFail(
        `Open Design 适配器缺少关键选择器：${missing.join(", ")}（共 ${missing.length} 个）。` +
          `请执行 \`npm run probe:opendesign -- anchors\` 复核，或在 profile.gui.selectors 里按语义键覆盖。`,
        "selector_drift",
      );

    const refs = validateTaskReferences(ctx.task, ctx.context, ctx.projectPath);

    // ---- 步 1：接管或启动实例 ----
    budget.setStage("接管 Open Design 实例");
    let inst: Awaited<ReturnType<typeof ensureOpenDesignInstance>> = {};
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
          throw new OpenDesignSetupPause("Open Design 实例连接尚未恢复，请检查应用状态后继续");
        logger.warn(
          `[opendesign] 实例接管暂时失败；attempt=${attempt + 1}；${error instanceof Error ? error.message : String(error)}`,
        );
        await deps.sleep(500 * (attempt + 1));
      }
    }
    if (inst.needsClose) {
      await emit(
        "awaiting_user_authorization",
        "既有 Open Design 实例未开启 CDP 调试端口，等待用户关闭该实例后继续",
        { round: ctx.round },
      );
      return result({
        endReason: "needs_user",
        needsUserKind: "close_existing_instance",
        pendingQuestion:
          "检测到本机已有 Open Design 实例在运行，但它没有开启 CDP 调试端口，无法接管。" +
          "请先手动关闭该 Open Design 窗口（不要 kill 其他无关进程），然后调用 manage_task 继续。",
        progressSummary: "Open Design 已在运行但未开启调试端口，等待用户关闭后重试",
      });
    }
    if (!inst.ready) return hardFail("Open Design 实例未就绪", "setup_failed");
    const ready: OpenDesignReady = inst.ready;
    logger.info(`[opendesign] 已接管实例：port=${ready.port} title=${ready.title ?? "(未知)"}`);

    // ---- 残留原生对话框清理（模态框会吞掉主窗口的合成点击） ----
    try {
      const roots = rootOpenDesignProcesses(await deps.listProcesses({ signal: opts.signal }));
      const pids = roots.map((p) => p.pid);
      if (pids.length) {
        const strays = await deps.listDialogs(pids, { signal: opts.signal });
        if (strays.length) {
          const closed = await deps.closeDialogs(pids);
          logger.warn(
            `[opendesign] 清理残留原生对话框 ${closed}/${strays.length} 个：${strays.join("；")}`,
          );
          // 事件流（issue #18 词表）：残留模态框属于「需要人工知情的确认类对话框」——它会吞掉主窗口点击
          await emit(
            "confirmation_dialog_detected",
            `清理了 ${closed}/${strays.length} 个残留原生对话框（模态框会吞掉主窗口合成点击）`,
            { round: ctx.round },
          );
        }
      }
    } catch (error) {
      logger.warn(`[opendesign] 残留对话框探测失败（不影响后续步骤）：${String(error)}`);
    }

    // ---- 版本门禁（fail-closed）：判据是**产品版本**（安装目录安装配置的 appVersion） ----
    const probe = await deps.probePort(ready.port);
    const info = readInstallInfo(resolved.command);
    const namespaceRoot = info ? openDesignNamespaceRoot(info) : null;
    const appConfigPath = openDesignAppConfigPath(namespaceRoot);
    const appConfig = readAppConfig(namespaceRoot);
    logger.info(
      `[opendesign] 安装信息：appVersion=${info?.appVersion ?? "?"} namespace=${info?.namespace ?? "?"}` +
        ` electron=${probe.version ?? "?"} appConfig=${appConfigPath ?? "(不可定位)"}` +
        `${appConfig ? ` recentLinkedDirs=${JSON.stringify(appConfig.recentLinkedDirs ?? [])}` : ""}`,
    );
    const gate = versionGateError(od.supportedVersions, info?.appVersion);
    if (gate) return hardFail(gate, "version_mismatch");

    // ---- 步 2：连接主窗口（要求输入框真正就绪，只列到 target 不算） ----
    budget.setStage("连接 Open Design 主窗口");
    const page = deps.createPage(ready.port, gui.cdpSendTimeoutMs, gui.selectors);
    const client = deps.makeClient(page, gui.selectors);
    rawClient = client;
    const conn = await connectStable(client, gui, baseDeps.sleep);
    if (!conn.ok) {
      await emit(
        "awaiting_user_authorization",
        "Open Design 主窗口可读但任务输入框始终未出现（通常停在登录/引导页），等待用户完成登录",
        { round: ctx.round },
      );
      return result({
        endReason: "needs_user",
        needsUserKind: "login_required",
        pendingQuestion:
          "已连上 Open Design 主窗口，但任务输入框在观察期内始终未出现（通常意味着停在登录/引导页）。" +
          "请在 Open Design 中完成登录或引导，然后调用 manage_task 确认。",
        progressSummary: "等待 Open Design 登录/引导完成",
      });
    }
    connected = client;
    await client.bringToFront();

    // ---- 首页锚点 + 布局守卫（只读，不点任何东西） ----
    if (initialDispatch) {
      const onHome = await ensureHomePage(client, logger, deps.sleep);
      let document: OpenDesignDocumentProbe | undefined;
      try {
        document = await client.probe();
      } catch (error) {
        logger.warn(`[opendesign] 页面盘点失败：${String(error)}`);
      }
      logger.info(
        `[opendesign] 页面盘点：${document ? `${document.title} ${document.url}` : "(失败)"}` +
          ` 首页锚点=${onHome ? "已就位" : "未就位（已尝试切回首页）"}`,
      );
      if (document) {
        const dead = document.anchors.filter((a) => a.count <= 0).map((a) => a.key);
        if (dead.length)
          return hardFail(
            `Open Design 页面结构已漂移（布局守卫未命中：${dead.join(", ")}）；已跳过全部点击。` +
              `请用 \`npm run probe:opendesign -- anchors\` 重新采集选择器。` +
              `当前页面：${document.title} ${document.url}（可见文本 ${document.bodyTextLength} 字）` +
              `${document.bodyText?.trim() ? `\n页面文本片段：${document.bodyText.replace(/\s+/g, " ").trim().slice(0, 300)}` : ""}`,
            "selector_drift",
          );
      }
    }

    // ---- 设计方向与目标模型（进入 GUI 前先如实记录，便于终态文案） ----
    logger.info(
      `[opendesign] 设计方向=${direction.direction}（菜单文本「${directionLabel(direction.direction, od.directionLabels)}」）` +
        ` 模型=${ctx.model ?? "(沿用当前)"} 设计系统=${ctx.designSystem ?? "(不指定)"}`,
    );

    // ---- 视觉验收页面来源的**建议**（只推导不落盘，绝不静默改项目配置） ----
    if (ctx.projectPath.trim()) {
      try {
        logger.info(`[opendesign] 视觉验收页面来源建议：${suggestVisualPages(ctx.projectPath).message}`);
      } catch (error) {
        logger.warn(`[opendesign] 视觉页面来源推导失败（不阻塞本轮）：${String(error)}`);
      }
    }

    // ---- 重观察恢复（user_confirmation）：不发送任何消息，仅观察至终态 ----
    if (isReobserve) {
      budget.finishSetup();
      budget.setStage("重连观察 Open Design 会话");
      logger.info("[opendesign] 重观察恢复：不发送任何消息，仅观察至终态");
      return await observe(client, {
        ctx,
        deps,
        gui,
        opts,
        logger,
        emit,
        startedAt: started,
        logFile,
        result,
        onAbort: abortResult,
        noProject: !ctx.projectPath.trim(),
        budget,
        ownerPids,
        // issue #31：重观察轮的被观察 turn 此前已确认在运行，种子 sawRunning
        sawRunningSeed: true,
      });
    }

    // ---- 非首次派发（agent_question / rework）：必须落在会话页，把消息发进当前会话 ----
    const inConversation = !initialDispatch;
    if (inConversation && !(await client.exists("conversationText"))) {
      return hardFail(
        "无法确认当前处于 Open Design 会话页（对话容器缺失），拒绝发送返修/回答（绝不退化到首页重新派发）",
        "session_lost",
      );
    }

    // ---- 步 3：绑定工作目录（首次派发且给了项目路径时） ----
    if (initialDispatch && ctx.projectPath.trim()) {
      // 真机取证（2026-09-28）：产品打开「文件夹选择器」前必须先与 **daemon sidecar** 完成鉴权握手。
      // daemon 未就绪时它只显示自己的守卫文案
      //   「Couldn't open the folder picker (desktop auth handshake with the daemon failed; please retry)」
      // 并且**根本不弹对话框** —— 适配器若照常点「选择目录」，那就是一次空操作，
      // 表现为「原生对话框流程走完、工作目录却没变」（此前多次复现且时好时坏）。
      // 实测 daemon 在应用启动后约 30s 才驻留（0 → 2 个进程），所以这里必须先等它，而不是抢跑。
      budget.setStage("等待 Open Design daemon 就绪");
      const daemonReady = await waitForDaemonReady(
        {
          signal: opts.signal,
          deadline: started + ctx.taskTimeoutMs,
          // 走注入的进程枚举（否则测试会读本机真实进程，导致用例随「本机是否开着 Open Design」飘）
          listProcesses: deps.listProcesses,
        },
        90_000,
      );
      if (!daemonReady) {
        await emit(
          "awaiting_user_authorization",
          "Open Design daemon 未就绪（工作目录选择器依赖 desktop↔daemon 鉴权握手），等待人工处理",
          { round: ctx.round },
        );
        return result({
          endReason: "needs_user",
          needsUserKind: "setup_recovery",
          pendingQuestion:
            "Open Design 的后台 daemon 尚未就绪，工作目录选择器现在还打不开" +
            "（产品会提示 desktop 与 daemon 的鉴权握手失败）。请确认 Open Design 已正常联网并保持在运行中，" +
            "随后调用 manage_task 继续。",
          progressSummary: "等待 Open Design daemon 就绪",
        });
      }
      logger.info("[opendesign] daemon 已就绪，开始绑定工作目录");
      budget.setStage("绑定工作目录");
      const rootPids = rootOpenDesignProcesses(
        await deps.listProcesses({ signal: opts.signal }),
      ).map((p) => p.pid);
      ownerPids = ready.pid ? [ready.pid, ...rootPids] : rootPids;
      const bound = await budget.run(
        (signal, timeoutMs) =>
          bindWorkspace({
            page: client,
            targetPath: ctx.projectPath,
            ownerPids,
            gui: { ...gui, projectTriggerTimeoutMs: timeoutMs },
            logger,
            overrides: gui.selectors,
            signal,
            deps: {
              listDialogs: (pids, o) => deps.listDialogs(pids, o),
              selectFolder: (target, pids, baseline, o) =>
                deps.selectFolder(target, pids, baseline, o),
              sleep: (ms) => deps.sleep(ms),
              // 每轮重读：绑定成功后产品才会把目标目录写进 recentLinkedDirs（首位 = 最近一次绑定）。
              // 触发区只显示末段目录名时，靠这条独立旁证区分「绑对了」与「绑到了同名目录」。
              readRecentLinkedDirs: async () => {
                const cfg = readAppConfig(namespaceRoot);
                const dirs = cfg?.recentLinkedDirs;
                return Array.isArray(dirs)
                  ? dirs.filter((d): d is string => typeof d === "string")
                  : [];
              },
            },
          }),
        od.workingDirPanelTimeoutMs + od.nativeDialogTimeoutMs,
      );
      if (!bound.ok) {
        // 工作目录绑定失败一律转 `needs_user`（计划决策 12：失败重试一次后交用户），
        // **不能**落成「非硬失败的 setup_failed」——那种结果会被编排器当成 agent 普通失败，
        // 用户既看不到可操作提示，也没法用 manage_task 续跑。
        const needsPermission = bound.reason === "native" && permissionError(bound.message);
        logger.warn(
          `[opendesign] 工作目录绑定失败：reason=${bound.reason ?? "unknown"}；${bound.message ?? ""}`,
        );
        // 事件流：需要人工介入（授权/环境）——任务卡在这里等人处理
        await emit(
          "awaiting_user_authorization",
          `工作目录绑定失败（${bound.reason ?? "unknown"}）：${bound.message ?? ""}`,
          { round: ctx.round },
        );
        return result({
          endReason: "needs_user",
          needsUserKind: needsPermission ? "system_permission" : "setup_recovery",
          pendingQuestion:
            `Open Design 工作目录绑定失败（${bound.reason ?? "unknown"}）：${bound.message ?? ""}\n` +
            (needsPermission
              ? "请在系统里为 Open Design 授予辅助功能/文件访问权限后调用 manage_task 确认。"
              : `请在 Open Design 中确认「工作目录」可正常选择 ${ctx.projectPath} 后调用 manage_task 继续；` +
                "MCP 不会向其它目录发送任务。"),
          progressSummary: "等待 Open Design 工作目录绑定",
        });
      }
      logger.info(`[opendesign] 工作目录绑定回读通过：${bound.shown ?? ctx.projectPath}`);
      if (bound.native) {
        // 事件流（issue #18 词表）：本次经 Windows 原生「选择文件夹」对话框完成绑定
        await emit(
          "confirmation_dialog_detected",
          `经原生「选择文件夹」对话框绑定工作目录：${bound.shown ?? ctx.projectPath}`,
          { round: ctx.round },
        );
      }
    } else if (initialDispatch) {
      logger.info("[opendesign] 未提供 projectPath：跳过工作目录绑定（沿用当前目录）");
    }

    // ---- 步 4：模型（精确匹配 + 回读） ----
    let actualModel = ctx.model ?? "";
    if (initialDispatch) {
      budget.setStage("确认模型");
      const wanted = ctx.model?.trim();
      if (!wanted) {
        actualModel = (await client.triggerText("modelTrigger")).trim();
        logger.info(`[opendesign] 未指定模型：沿用界面当前值「${actualModel || "(读取不到)"}」`);
      } else if (!gui.modelSwitch) {
        logger.warn("[opendesign] profile 关闭了 modelSwitch，未切换模型");
      } else {
        const picked = await selectMenuItem({
          page: client,
          triggerKey: "modelTrigger",
          itemKey: "modelMenuItem",
          target: wanted,
          budgetMs: od.modelMenuTimeoutMs,
          what: "模型",
          logger,
        });
        if (!picked.ok)
          return hardFail(
            `${picked.message ?? "模型选择失败"}（模型名必须与界面完全一致；不做模糊匹配）`,
            picked.reason === "readback" ? "model_mismatch" : "model_unavailable",
          );
        actualModel = picked.shown ?? wanted;
      }
    }

    // ---- 步 5：设计系统（可选：搜索过滤 → 精确点选 → 回读） ----
    if (initialDispatch && ctx.designSystem?.trim()) {
      budget.setStage("确认设计系统");
      const picked = await selectMenuItem({
        page: client,
        triggerKey: "designSystemTrigger",
        itemKey: "designSystemItem",
        searchKey: "designSystemSearch",
        target: ctx.designSystem.trim(),
        budgetMs: od.designSystemTimeoutMs,
        dismissBeforeReadback: true,
        what: "设计系统",
        logger,
      });
      if (!picked.ok) {
        logger.warn(`[opendesign] 设计系统未应用：${picked.message ?? picked.reason}`);
        return hardFail(
          `设计系统选择失败：${picked.message ?? picked.reason ?? "未知原因"}`,
          "design_system_mismatch",
        );
      }
    }

    // ---- 步 6：设计方向（界面「创建类型」；非法值已在入口拒绝） ----
    if (initialDispatch) {
      budget.setStage("确认设计方向");
      const label = directionLabel(direction.direction, od.directionLabels);
      const picked = await selectMenuItem({
        page: client,
        triggerKey: "designDirectionTrigger",
        itemKey: "designDirectionItem",
        target: label,
        budgetMs: od.designDirectionTimeoutMs,
        dismissBeforeReadback: true,
        what: "设计方向",
        logger,
      });
      if (!picked.ok)
        return hardFail(`设计方向应用失败：${picked.message ?? picked.reason ?? "未知原因"}`, "selector_drift");
    }

    // ---- 步 7–8：输入任务书并发送（只点一次，绝不重发） ----
    budget.setStage("发送任务书");
    await client.dismissMenus();
    const attempt =
      ctx.resume?.kind === "continue"
        ? `continue:${createHash("sha256").update(ctx.resume.message ?? "confirmed").digest("hex").slice(0, 8)}`
        : ctx.resume?.kind === "rework"
          ? `rework:r${ctx.round}`
          : "initial";
    const marker = `【tianshu:${ctx.taskId}:r${ctx.round}:${attempt}】`;
    const message = taskText(ctx, refs, initialDispatch);
    await client.bringToFront();
    const sent = await dispatchTask({
      page: client,
      text: `${marker}\n${message}`,
      marker,
      confirmBudgetMs: Math.max(5_000, Math.min(60_000, od.sendReadyTimeoutMs)),
      pollIntervalMs: 300,
    });
    if (!sent.ok)
      return hardFail(
        sent.message ?? "Open Design 发送失败",
        sent.reason === "input_mismatch" ? "input_mismatch" : "send_unknown",
      );
    await emit(
      "task_dispatched",
      `第 ${ctx.round} 轮任务书已发送（标记 ${marker}；模型=${actualModel || "沿用界面当前值"}）`,
      { round: ctx.round, attempt, model: actualModel || undefined },
    );
    logger.info(
      `[opendesign] 发送已确认：对话出现任务标记=${sent.evidence?.seenMessage}；运行信号=${sent.evidence?.seenRunning}；输入框已清空=${sent.evidence?.inputCleared}`,
    );

    // ---- 步 9：轮询运行判定至终态 ----
    budget.finishSetup();
    budget.setStage("等待 Open Design 完成");
    return await observe(client, {
      ctx,
      deps,
      gui,
      opts,
      logger,
      emit,
      startedAt: started,
      logFile,
      result,
      onAbort: abortResult,
      actualModel,
      noProject: !ctx.projectPath.trim(),
      budget,
      ownerPids,
      // issue #31：发送确认阶段观测到的运行信号（stop/sendStarting）是「本轮确实已启动」最可靠
      // 的证据。观察循环可能因选择器漂移或 turn 已跑完而整段采不到信号，不带过来的话会把已启动
      // 的任务误落 idle_timeout。
      sawRunningSeed: Boolean(sent.evidence?.seenRunning),
      // 产物数据根：<namespaceRoot>/data（产物存储为 <dataRoot>/projects/<projectId>/）
      artifactDataRoot: namespaceRoot ? path.join(namespaceRoot, "data") : null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof OpenDesignBudgetError) {
      if (e.reason === "aborted") return await abortResult();
      if (e.reason === "task_timeout")
        return result({ timeout: true, endReason: "task_timeout", error: msg });
    }
    if (e instanceof OpenDesignSetupPause || (e instanceof OpenDesignBudgetError && budget.settingUp)) {
      // 事件流（issue #18 词表）：环境/权限类等待同样是「卡在等人」，要让 query_task 看得见
      await emit("awaiting_user_authorization", `Open Design 初始化阶段等待人工介入：${msg}`, {
        round: ctx.round,
      });
      return result({
        endReason: "needs_user",
        needsUserKind: e instanceof OpenDesignSetupPause && e.needsPermission ? "system_permission" : "setup_recovery",
        pendingQuestion: `${msg}。请在 Open Design 中确认环境后调用 manage_task 继续。`,
        progressSummary: "等待 Open Design 环境恢复",
      });
    }
    logger.error(`[opendesign] 执行失败：${msg}`);
    return hardFail(msg, "setup_failed");
  } finally {
    try {
      connected?.disconnect();
      if (connected !== rawClient) rawClient?.disconnect();
    } catch {
      /* 断开失败不影响终态 */
    }
    budget.close();
    await close();
  }
}

/**
 * 连接主窗口并要求任务输入框真正就绪（只列到 target 不代表页面可交互）。
 *
 * 三种结果必须分清（混在一起会把「连不上」误报成「要登录」）：
 * - `ok`：已连接且输入框可见；
 * - `loginRequired`：**页面能读**但输入框在观察期内始终不出现（停在登录/引导页）；
 * - 抛错：CDP 始终连不上（端口/目标/WebSocket 问题），由上层落 `setup_failed`。
 */
async function connectStable(
  client: OpenDesignCdpClient,
  gui: GuiProfile,
  sleep: (ms: number) => Promise<void>,
): Promise<{ ok: boolean; loginRequired: boolean }> {
  const attempts = Math.max(1, Math.ceil(gui.launchTimeoutMs / 500));
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    if (!client.connected) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await client.connect();
      } catch (error) {
        lastError = error;
        // eslint-disable-next-line no-await-in-loop
        await sleep(500);
        continue;
      }
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await client.inputReady()) return { ok: true, loginRequired: false };
    } catch (error) {
      lastError = error;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(500);
  }
  // 连上了但输入框一直不出现 → 判登录/引导页（只用「页面可读 + 输入框缺席」这一可观测事实）
  if (client.connected) return { ok: false, loginRequired: true };
  throw lastError instanceof Error
    ? lastError
    : new Error(`Open Design CDP 未在 ${gui.launchTimeoutMs}ms 内恢复`);
}

/** 首页锚点就位检查；不在首页时尝试点一次产品自己的首页入口，再看一次 */
async function ensureHomePage(
  client: OpenDesignCdpClient,
  logger: AgentRunLogger,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  if (await client.exists("title")) return true;
  logger.info("[opendesign] 当前不在首页：尝试点击首页入口");
  const clicked = await client.clickSelector(OPEN_DESIGN_HOME_ENTRY_SELECTOR);
  if (!clicked.clicked) return false;
  await sleep(500);
  return client.waitFor(() => client.exists("title"), 5_000);
}

interface ObserveArgs {
  ctx: TaskContext;
  deps: OpenDesignRunDeps;
  gui: GuiProfile;
  opts: AgentRunOptions;
  logger: AgentRunLogger;
  emit: ReturnType<typeof makeEmitter>;
  startedAt: number;
  logFile: string;
  result: (extra: Partial<AgentRunResult>) => AgentRunResult;
  onAbort: () => Promise<AgentRunResult>;
  actualModel?: string;
  /** 无 projectPath：终态文案必须**如实**说明已跳过目录绑定与视觉验收（计划 §4） */
  noProject?: boolean;
  /** 阶段预算（导出段要 setStage 上报进度） */
  budget: OpenDesignBudget;
  /** Open Design 进程 pid 列表（导出段用它定位原生窗口；无则为空数组） */
  ownerPids: number[];
  /** 产物数据根（<namespaceRoot>/data）：终态后据此把设计稿取回项目目录，供视觉验收 */
  artifactDataRoot?: string | null;
  /**
   * 重观察轮种子（issue #31）：被观察的 turn 在恢复**之前**就已确认在运行。
   * 不种 sawRunning 的话，「恢复后 turn 恰好已完成 → 观察期内从未见运行信号 → 判不了 finished
   * → 白等 idleTimeoutMs 误落 idle_timeout」。与 codex/run.ts 的重观察种子同一理由。
   */
  sawRunningSeed?: boolean;
}

/**
 * 三信号轮询至终态（步 9）。
 * 判定优先级由 `judgeOpenDesignPoll` 决定；本函数只负责采集信号、上报事件与落终态文案。
 */
async function observe(client: OpenDesignCdpClient, args: ObserveArgs): Promise<AgentRunResult> {
  const { ctx, deps, gui, opts, logger, startedAt, logFile, result, budget, ownerPids } = args;
  let state: OpenDesignPollState = initialOpenDesignState();
  if (args.sawRunningSeed) {
    // issue #31：重观察轮的 turn 此前已确认在运行 —— 种子 sawRunning 规避
    // 「turn 在恢复前已完成 → 从未见运行信号 → 判不了 finished → 误落 idle_timeout」。
    state = { ...state, sawRunning: true };
  }
  const stallSince = { since: 0 };
  let lastProgress = 0;
  let runningReported = false;
  const deadline = startedAt + ctx.taskTimeoutMs;
  /** 无 projectPath 的如实说明：这类轮次没做目录绑定，也**不会**有视觉验收（计划 §4） */
  const noProjectNote = args.noProject ? "（无 projectPath：已跳过目录绑定与视觉验收）" : "";
  for (;;) {
    if (opts.signal?.aborted) return args.onAbort();
    if (Date.now() >= deadline)
      return result({
        timeout: true,
        endReason: "task_timeout",
        error: `Open Design 任务总时限已到；已停止 MCP 等待并保留 Open Design 现场${noProjectNote}`,
      });
    // eslint-disable-next-line no-await-in-loop
    await deps.sleep(gui.pollIntervalMs);
    // eslint-disable-next-line no-await-in-loop
    const snapshot = await client.poll();
    const artifactSignature = ctx.projectPath.trim()
      ? scanArtifactSignature(ctx.projectPath)
      : "";
    const poll: OpenDesignPoll = {
      stopVisible: snapshot.stopVisible,
      sendStarting: snapshot.sendStarting,
      conversationText: snapshot.conversationText,
      inputText: snapshot.inputText,
      // 失败终态：少这一跳，判定层的 failed 分支永远收不到信号（真机 2026-10-11 空等到超时）
      errorText: snapshot.errorText,
      artifactSignature,
      pageHidden: snapshot.pageHidden,
    };
    if (!runningReported && (poll.stopVisible || poll.sendStarting)) {
      runningReported = true;
      // 启发式：GUI 侧观测到「运行中」信号，只声称「可能开始改动文件」（不观测文件系统）
      await args.emit("file_modification_started", "Open Design 出现运行中信号（可能开始改动文件）", {
        round: ctx.round,
      });
    }
    const verdict = judgeOpenDesignPoll(
      poll,
      state,
      gui.stableRounds,
      gui.idleTimeoutMs,
      gui.stallTimeoutMs,
      stallSince,
      Date.now(),
      deadline,
    );
    state = verdict.state;
    if (Date.now() - lastProgress >= gui.progressIntervalMs) {
      const note = `Open Design 进度：${verdict.kind}；运行证据=${verdict.evidence}；回复哈希=${state.hash}；稳定轮=${state.stable}；窗口前台=${!poll.pageHidden}`;
      await Promise.resolve(opts.onProgress?.(note)).catch(() => {});
      logger.info(note);
      lastProgress = Date.now();
    }
    if (verdict.kind === "needs_user") {
      const question = verdict.question?.trim();
      // stall 判定 = turn 仍在跑但全静止 → 转 needs_user，交用户确认后重连观察
      // 事件流（issue #18 词表）：这是「卡在等人」，必须让 query_task 看得见
      await args.emit(
        "awaiting_user_authorization",
        `Open Design 停止按钮持续可见且对话与产物静止（${verdict.evidence}），转人工确认`,
        { round: ctx.round },
      );
      return result({
        endReason: "needs_user",
        needsUserKind: "user_confirmation",
        pendingQuestion:
          `${question ?? "Open Design 正在等待用户处理"}\n` +
          "请在 Open Design 窗口中处理该等待项后调用 manage_task(taskId, action='continue', message=已处理说明) 恢复；恢复后仅重新接入观察，不会发送消息。" +
          noProjectNote,
        actualModel: args.actualModel,
        progressSummary: `Open Design 等待用户处理${noProjectNote}`,
      });
    }
    if (verdict.kind === "idle_timeout")
      return result({
        endReason: "idle_timeout",
        error: `Open Design 空闲超时（连续 ${gui.stableRounds} 轮对话与产物均无变化）；已停止 MCP 等待并保留现场${noProjectNote}`,
        actualModel: args.actualModel,
      });
    if (verdict.kind === "failed")
      return result({
        hardFailure: true,
        endReason: "agent_error",
        error: `Open Design 本轮对话判定失败（界面出现错误态）${noProjectNote}`,
        actualModel: args.actualModel,
      });
    if (verdict.kind === "timeout")
      return result({
        timeout: true,
        endReason: "task_timeout",
        error: `Open Design 任务总时限已到（轮询判定）${noProjectNote}`,
        actualModel: args.actualModel,
      });
    if (verdict.kind === "finished") {
      // 终态后把设计稿从产品存储取回项目目录（视觉验收的数据来源）。
      // 取回失败**不改终态**，只如实写进 summary —— 它是增值步骤，不是成败判据。
      const fetched = await fetchArtifactForSummary({
        page: client,
        dataRoot: args.artifactDataRoot ?? null,
        targetDir: ctx.projectPath,
        logger,
      });
      // 显式要过导出格式时，再走一遍产品的导出链路（真机取证 2026-10-11：
      // 0.24.1 是**浏览器式下载**，靠 CDP 指下载目录落盘，不弹保存对话框）。
      // 同样**不改终态**：导出失败只在 summary 里如实写明，任务本身已完成。
      let exported = "";
      if (ctx.exportKind?.trim() && ctx.projectPath.trim()) {
        const kind = chooseExportKind(ctx.exportKind);
        try {
          budget.setStage("导出产物");
          const out = await exportArtifact({
            page: client,
            kind,
            targetDir: ctx.projectPath,
            ownerPids,
            budgetMs: ctx.exportTimeoutMs ?? OPEN_DESIGN_DEFAULTS.exportTimeoutMs,
            logger,
          });
          exported = out.ok
            ? `；已导出 ${kind}：${out.artifact ?? ""}`
            : `；导出 ${kind} 未完成：${out.message ?? "未知原因"}`;
          if (!out.ok) logger.warn(`[opendesign] 导出未完成：${out.message ?? ""}`);
        } catch (error) {
          exported = `；导出 ${kind} 抛错：${String(error)}`;
          logger.warn(`[opendesign] 导出抛错：${String(error)}`);
        }
      }
      return {
        ok: true,
        exitCode: 0,
        timeout: false,
        killed: false,
        durationMs: Date.now() - startedAt,
        logFile,
        endReason: "reply_stable",
        keptInstance: true,
        actualModel: args.actualModel,
        progressSummary: `Open Design 已完成本轮（对话与产物均静止）${fetched}${exported}${noProjectNote}`,
      };
    }
  }
}