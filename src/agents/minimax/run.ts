/**
 * MiniMax Code 单轮任务编排（第七个 GUI agent）。
 *
 * 执行顺序（与 kimicode/run.ts 同构，细节按 MiniMax Code 真机实测语义重写）：
 *   预算与日志 → 实例接管 → 连接主窗口（要求 composer 就绪）→ 登录/引导页判定
 *   → 重派护栏（实例上不得残留运行信号）→ 会话建立/恢复
 *   → 项目绑定（完整路径 + 回读）→ 模型与推理等级/上下文窗口（**二级子菜单** + fail-closed）
 *   → 权限模式回读 → 组装任务书 + 写标记 + 回读 + 点发送
 *   → 60s 有界确认（绝不重发）→ 轮询判定 → 终态
 *
 * **本适配器与其它 6 个最关键的三处差异**（都来自真机实测）：
 * 1) 「新建任务」的 testid 挂在 `<kbd>` 上，可点击的是祖先 button（见 cdp.newTask）；
 * 2) 推理等级/上下文窗口**不在平铺菜单里**，而在**悬停模型项后展开的二级子菜单**里
 *    （见 cdp.hoverModel / model.ts 的说明）；
 * 3) 项目绑定的权威判据是侧栏分组的 `data-workspace-dir`（完整绝对路径），
 *    不是导航栏的项目名。
 *
 * 恢复语义（按 ctx.resume 分派，与 kimicode/zcode 同构）：
 * - continue + sendMessage（agent_question）：定位原会话 → 把回答写进输入框发送（**不重发任务书**）；
 * - continue + reobserve（user_confirmation）：重连观察，不发送任何消息；
 * - rework：定位原会话 → 回读项目/模型 → 发送返修消息；
 * - 定位不到原会话 → session_lost 硬失败，**绝不退化打开最近会话**。
 *
 * 贯穿全流程的两条纪律：
 * 1. 任何「点击成功」都不等于「状态已改变」——模型、档位、窗口、权限、项目、发送
 *    一律回读确认，回读不一致 fail-closed；
 * 2. 所有等待都受「任务总时限 / setup 预算 / 阶段预算」的最小值夹住（MinimaxBudget），
 *    重试不重置预算。
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
import { MINIMAX_DEFAULTS, ZCODE_SETUP_DEFAULTS, type GuiProfile } from "../../config/schema.js";
import { mkdirp } from "../../util/fs.js";
import { validateTaskReferences } from "../zcode/references.js";
import { MinimaxCdpClient, CdpDisconnectedError, CdpUnavailableError } from "./cdp.js";
import {
  ensureMinimaxInstance,
  listMinimaxProcessesAsync,
  type MinimaxInstanceOptions,
  type MinimaxProcess,
  type MinimaxReady,
} from "./instance.js";
import { listOwnedDialogs, selectMinimaxFolder, closeStrayDialogs } from "./dialog.js";
import { ensureFreshDraft, locateSessionProject } from "./session.js";
import { clickModalChooseFolder, dismissProjectModal, openProjectModal, submitProjectModal } from "./project-modal.js";
import { matchMinimaxProject, normalizeProjectPath } from "./workspace.js";
import { describeLevelValueError, exactUiName, parseMinimaxModel } from "./model.js";
import {
  initialMinimaxState,
  judgeMinimaxPoll,
  withDetectedQuestion,
} from "./liveness.js";
import { selectModel } from "./model-select.js";
import {
  MinimaxBudget,
  MinimaxBudgetError,
  MinimaxSetupPause,
  permissionError,
  transientSetupError,
  draftReadyBudgetMs,
} from "./recovery.js";

export interface RunMinimaxArgs {
  ctx: TaskContext;
  resolved: ResolvedAgent;
  opts: AgentRunOptions;
  logFile: string;
  deps?: Partial<MinimaxRunDeps>;
}

export interface MinimaxRunDeps {
  ensureInstance: typeof ensureMinimaxInstance;
  listProcesses: (
    options?: MinimaxInstanceOptions,
  ) => MinimaxProcess[] | Promise<MinimaxProcess[]>;
  createClient: (
    port: number,
    timeout: number,
    selectors: Record<string, string>,
  ) => MinimaxCdpClient;
  listDialogs: typeof listOwnedDialogs;
  selectFolder: typeof selectMinimaxFolder;
  /** 启动时清理残留原生对话框（模态框会吞掉主窗口点击） */
  closeDialogs: typeof closeStrayDialogs;
  sleep: (ms: number) => Promise<void>;
}

/** 项目绑定的结构化结果（失败原因分类，便于终态文案区分「没点进去」与「回读不一致」） */
export interface MinimaxBindOutcome {
  ok: boolean;
  boundPath?: string;
  reason?: "draft" | "project" | "ambiguous" | "click" | "permission" | "native" | "readback";
  candidates?: string[];
  message?: string;
}

const DEFAULT_DEPS: MinimaxRunDeps = {
  ensureInstance: ensureMinimaxInstance,
  listProcesses: listMinimaxProcessesAsync,
  createClient: (port, timeout, selectors) => new MinimaxCdpClient(port, timeout, selectors),
  listDialogs: listOwnedDialogs,
  selectFolder: selectMinimaxFolder,
  closeDialogs: closeStrayDialogs,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function minimaxGuiOf(resolved: ResolvedAgent): GuiProfile {
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
    cdpPort: g?.cdpPort ?? 9999,
    cdpPortAuto: g?.cdpPortAuto ?? true,
    cdpPortRange: g?.cdpPortRange ?? 10,
    exePath: g?.exePath,
    exeArgs: g?.exeArgs ?? ["--remote-debugging-port=<port>"],
    windowMode: g?.windowMode ?? "reuse",
    launchTimeoutMs: g?.launchTimeoutMs ?? 120_000,
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
    permissionMode: g?.permissionMode ?? "始终授权",
    defaultPermissionMode: g?.defaultPermissionMode ?? "始终授权",
    defaultAutoFixRounds: g?.defaultAutoFixRounds ?? 2,
  };
}

function fileLogger(
  file: string,
  base: AgentRunLogger,
): { logger: AgentRunLogger; close: () => Promise<void> } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
  stream.write(`\n===== minimax-gui run @ ${new Date().toISOString()} =====\n`);
  const wrap = (level: string) => (m: string) => {
    stream.write(`[${level}] ${m}\n`);
    base[level as "info"](m);
  };
  return {
    logger: { info: wrap("info"), warn: wrap("warn"), error: wrap("error"), debug: wrap("debug") },
    close: () => new Promise((r) => stream.end(r)),
  };
}

/** 任务书组装：与 zcode/kimicode/run.ts 完全同构（task + 上下文 + 已验证引用 + 返修反馈） */
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

/**
 * 连接主窗口并要求 composer 真正挂载（只列到 target 不代表页面已可交互）。
 * 观察期内 composer 始终缺席但页面可读 → 判定为登录/引导页。
 */
async function connectStableMinimax(
  ready: MinimaxReady,
  gui: GuiProfile,
  deps: MinimaxRunDeps,
): Promise<{ cdp: MinimaxCdpClient; loginRequired: boolean }> {
  const attempts = Math.max(1, Math.ceil(gui.launchTimeoutMs / 500));
  let lastError: unknown;
  let pageReachable = false;
  for (let i = 0; i < attempts; i++) {
    const candidate = deps.createClient(ready.port, gui.cdpSendTimeoutMs, gui.selectors);
    try {
      await candidate.connect();
      const href = await candidate.evaluate<string>("location.href");
      if (href) pageReachable = true;
      if (await candidate.exists("chatInput")) return { cdp: candidate, loginRequired: false };
      lastError = new Error("MiniMax Code 消息输入框尚未就绪");
    } catch (error) {
      lastError = error;
    }
    candidate.disconnect();
    await deps.sleep(500);
  }
  if (pageReachable) {
    const candidate = deps.createClient(ready.port, gui.cdpSendTimeoutMs, gui.selectors);
    await candidate.connect();
    return { cdp: candidate, loginRequired: true };
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`MiniMax Code CDP 未在 ${gui.launchTimeoutMs}ms 内恢复`);
}

interface BindProjectArgs {
  cdp: MinimaxCdpClient;
  ctx: TaskContext;
  gui: GuiProfile;
  deps: MinimaxRunDeps;
  budget: MinimaxBudget;
  logger: AgentRunLogger;
  ready: MinimaxReady;
  /** 与 projectTrigger 同义的共享截止时间：重试不重置预算 */
  deadlineMs: () => number;
}

/**
 * 初始派发的项目绑定流程：新建会话 → 读侧栏项目分组 → 完整路径命中则点选，
 * 否则走原生「Select Directory」对话框 → 回读分组 + 项目触发器文本。
 *
 * 判据是**归一化后的完整路径**（分组 `data-workspace-dir` 实测回读原生形式 `D:\a\b`），
 * 名称仅作回退；同名不同目录一律 fail-closed，绝不猜一个点把任务派到别的目录。
 */
async function bindProject(args: BindProjectArgs): Promise<MinimaxBindOutcome> {
  const { cdp, ctx, gui, deps, budget, logger, ready, deadlineMs } = args;
  const stageBudget = (): number => Math.min(20_000, Math.max(1, deadlineMs() - Date.now()));
  if (!(await ensureFreshDraft(cdp, deadlineMs(), { sleep: deps.sleep })))
    return { ok: false, reason: "draft" };

  // 新建会话后项目可能仍停在上一次的值（实测：新建任务不会清空项目）——必须先显式比对。
  const groups = await cdp.projectGroups();
  const matched = matchMinimaxProject(groups, ctx.projectPath);
  if (matched.ambiguous) return { ok: false, reason: "ambiguous", candidates: matched.candidates };

  if (matched.item) {
    const clicked = await cdp.clickProjectByPath(matched.item.dir);
    if (!clicked.clicked) return { ok: false, reason: "click" };
    logger.info(`[minimax] 已点选既有项目分组：${matched.item.dir}`);
  } else {
    // 目标项目不在侧栏里：走「新建项目」触发原生「Select Directory」对话框。
    // 先采样对话框基线，只操作**新出现**的窗口（绝不盲点用户既有窗口）。
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
      throw new MinimaxSetupPause("无法确认目标 MiniMax Code 进程，拒绝操作原生对话框");
    const baseline = await budget.run(
      (signal, timeoutMs) => deps.listDialogs(pids, { signal, timeoutMs }),
      gui.dialogProbeTimeoutMs,
    );
    await cdp.dismissMenus();
    // **两步**：点「新建项目」先弹**应用内模态框**，模态框里再点「选择文件夹」才弹原生对话框。
    // 只走一步会把「原生对话框始终不出现」误判成选择器失效（真机踩到）。
    const modal = await openProjectModal(cdp, Math.min(15_000, Math.max(1, deadlineMs() - Date.now())), deps.sleep);
    if (!modal.opened) return { ok: false, reason: "project" };
    if (!(await clickModalChooseFolder(cdp))) {
      await dismissProjectModal(cdp);
      return { ok: false, reason: "click" };
    }
    let selected: Awaited<ReturnType<typeof selectMinimaxFolder>>;
    try {
      selected = await budget.run(
        (signal, timeoutMs) =>
          deps.selectFolder(ctx.projectPath, pids, baseline, {
            signal,
            timeoutMs,
            onProgress: (stage) => logger.info(`[minimax] ${stage}`),
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
    if (!selected.ok) {
      await dismissProjectModal(cdp).catch(() => {});
      return {
        ok: false,
        reason: selected.needsPermission ? "permission" : "native",
        message: selected.message,
      };
    }
    // 原生对话框确认后：模态框的「文件夹」行应已回填，点「创建项目」提交。
    await deps.sleep(600);
    if (!(await submitProjectModal(cdp))) {
      await dismissProjectModal(cdp).catch(() => {});
      return { ok: false, reason: "click" };
    }
    logger.info("[minimax] 已提交「创建项目」模态框");
  }

  // 回读：项目分组（权威）+ 触发器文本（辅助）都要与目标路径对得上。
  await deps.sleep(Math.min(800, Math.max(0, stageBudget())));
  const after = await cdp.projectGroups();
  const hit = after.filter(
    (g) => g.dir && normalizeProjectPath(g.dir) === normalizeProjectPath(ctx.projectPath),
  );
  if (hit.length !== 1) {
    const trigger = await cdp.projectTriggerText().catch(() => "");
    const base = ctx.projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
    // 分组尚未登记（刚导入的新项目可能延迟出现在侧栏）时，允许用项目触发器文本兜底，
    // 但必须与目录基名严格相等——否则一律 fail-closed。
    if (!base || !exactUiName(trigger, base))
      return {
        ok: false,
        reason: "readback",
        candidates: after.map((g) => g.dir || g.title).filter(Boolean),
      };
  }
  return { ok: true, boundPath: ctx.projectPath };
}

/**
 * 尽力停止 GUI 内正在运行的 turn。
 *
 * 点击界面停止按钮（`cdp.click` 先 trusted 坐标点击、失败回退 DOM click），并在
 * `gui.cancelWaitMs` 内有界等待「停止按钮消失」（GUI 空闲）。
 * 不抛异常：CDP 不可用等情况下返回 clicked=false/idle=false，由调用方如实落文案——
 * **idle=false 时不得谎报已停止**。
 *
 * 这里的 sleep 用**未被预算包裹**的原始等待：取消发生在预算已耗尽/已 abort 之后，
 * 预算内的 sleep 会立刻抛错，连一次点击都发不出去。
 */
async function stopGuiTurn(
  cdp: MinimaxCdpClient,
  gui: GuiProfile,
  sleep: (ms: number) => Promise<void>,
  logger: AgentRunLogger,
  purpose: "取消" | "重派护栏",
): Promise<{ clicked: boolean; idle: boolean }> {
  try {
    const first = await cdp.poll();
    if (!first.stopVisible) return { clicked: false, idle: true };
    const clicked = await cdp.click("stopButton");
    logger.info(
      `[minimax] ${purpose}：${clicked ? "已点击" : "未能点击"} GUI 停止按钮，等待界面空闲（≤${gui.cancelWaitMs}ms）`,
    );
    const attempts = Math.max(1, Math.ceil(gui.cancelWaitMs / 500));
    for (let i = 0; i < attempts; i++) {
      await sleep(Math.min(500, gui.cancelWaitMs));
      const poll = await cdp.poll();
      if (!poll.stopVisible) return { clicked, idle: true };
    }
    return { clicked, idle: false };
  } catch (e) {
    logger.warn(
      `[minimax] ${purpose}时停止 GUI 运行失败：${e instanceof Error ? e.message : String(e)}`,
    );
    return { clicked: false, idle: false };
  }
}

interface MinimaxObserveArgs {
  cdp: MinimaxCdpClient;
  deps: MinimaxRunDeps;
  gui: GuiProfile;
  opts: AgentRunOptions;
  logger: AgentRunLogger;
  startedAt: number;
  /** 任务总时限截止点（超时后停止 MCP 等待并保留现场） */
  deadline: number;
  logFile: string;
  result: (extra: Partial<AgentRunResult>) => AgentRunResult;
  /** 当前会话定位信息：供 task-manager/fix-loop 落盘，也是恢复时唯一定位的锚点 */
  session: () => NonNullable<AgentRunResult["session"]>;
  /** 发送前基线：失败文案的「本轮新增」判据（返修轮必须带，否则会读到上一轮的陈旧失败文案） */
  baselineError: string;
  /**
   * 重观察轮种子（issue #31）：被观察的 turn 在恢复**之前**就已确认在运行。
   * 不种 sawRunning 的话，「恢复后 turn 恰好已完成 → 观察期内从未见运行信号 → 判不了 finished
   * → 白等 idleTimeoutMs 误落 idle_timeout」。与 codex/run.ts 的重观察种子同一理由。
   */
  sawRunningSeed?: boolean;
  onAbort: () => Promise<AgentRunResult>;
}

/** 轮询运行判定至终态。 */
async function observeMinimax(args: MinimaxObserveArgs): Promise<AgentRunResult> {
  const { cdp, deps, gui, opts, logger, deadline, result, session } = args;
  let state = initialMinimaxState();
  if (args.sawRunningSeed) {
    // issue #31：重观察轮的 turn 此前已确认在运行 —— 种子 sawRunning 规避
    // 「turn 在恢复前已完成 → 从未见运行信号 → 判不了 finished → 误落 idle_timeout」。
    state = { ...state, sawRunning: true };
  }
  const stallSince = { since: 0 };
  let lastProgress = 0;
  for (;;) {
    if (opts.signal?.aborted) return args.onAbort();
    if (Date.now() >= deadline)
      return result({
        timeout: true,
        endReason: "task_timeout",
        error: "MiniMax Code 任务总时限已到；已停止 MCP 等待并保留 MiniMax Code 现场",
        session: session(),
      });
    await deps.sleep(gui.pollIntervalMs);
    const raw = await cdp.poll();
    const poll = withDetectedQuestion(
      raw.errorText && raw.errorText === args.baselineError
        ? { ...raw, errorText: undefined }
        : raw,
      state,
      gui.selectors,
    );
    const verdict = judgeMinimaxPoll(
      poll,
      state,
      gui.stableRounds,
      gui.idleTimeoutMs,
      gui.stallTimeoutMs,
      stallSince,
    );
    state = verdict.state;
    if (Date.now() - lastProgress >= gui.progressIntervalMs) {
      const note = `MiniMax Code 进度：${verdict.kind}；运行证据=${verdict.evidence}；回复哈希=${state.hash}；稳定轮=${state.stable}；窗口前台=${!poll.pageHidden}`;
      await Promise.resolve(opts.onProgress?.(note)).catch(() => {});
      logger.info(note);
      lastProgress = Date.now();
    }
    if (verdict.kind === "needs_user") {
      const question = verdict.question?.trim();
      const userConfirmation = Boolean(poll.userGateVisible) || verdict.evidence.includes("stall");
      return result({
        endReason: "needs_user",
        needsUserKind: userConfirmation ? "user_confirmation" : "agent_question",
        pendingQuestion: userConfirmation
          ? `${question ? `${question}\n` : ""}请在 MiniMax Code 窗口中处理该等待项后调用 manage_task(taskId, action='continue', message=已处理说明) 恢复；恢复后仅重新接入观察，不会发送消息。`
          : `${question ?? "MiniMax Code 正在等待用户输入"}。请调用 manage_task(taskId, action='continue', message=回答内容) 提交回答：MCP 会把回答写进原会话，不会重发任务书。`,
        session: session(),
        progressSummary: "MiniMax Code 等待用户处理",
      });
    }
    if (verdict.kind === "idle_timeout")
      return result({
        endReason: "idle_timeout",
        error: `MiniMax Code 空闲超时（连续 ${gui.stableRounds} 轮无变化）；已停止 MCP 等待并保留现场${poll.pageHidden ? "；MiniMax Code 窗口不在前台，点击可能被吞" : ""}`,
        session: session(),
      });
    if (verdict.kind === "failed")
      return result({
        hardFailure: true,
        endReason: "agent_error",
        error: `MiniMax Code 本轮对话判定失败：${poll.errorText || "界面出现失败迹象"}${poll.pageHidden ? "；MiniMax Code 窗口不在前台，点击可能被吞" : ""}`,
        session: session(),
      });
    if (verdict.kind === "finished")
      return {
        ok: true,
        exitCode: 0,
        timeout: false,
        killed: false,
        durationMs: Date.now() - args.startedAt,
        logFile: args.logFile,
        endReason: "reply_stable",
        keptInstance: true,
        session: session(),
        progressSummary: "MiniMax Code 已完成回复",
      };
  }
}

export async function runMinimaxTask(args: RunMinimaxArgs): Promise<AgentRunResult> {
  const started = Date.now();
  const { ctx, resolved, opts, logFile } = args;
  const baseDeps = { ...DEFAULT_DEPS, ...args.deps };
  const gui = minimaxGuiOf(resolved);
  const minimax = resolved.profile.minimax;
  const submenuTimeoutMs = minimax?.submenuOpenTimeoutMs ?? MINIMAX_DEFAULTS.submenuOpenTimeoutMs;
  const { logger, close } = fileLogger(logFile, opts.logger);
  const budget = new MinimaxBudget(
    started + ctx.taskTimeoutMs,
    started + gui.setupRecoveryTimeoutMs,
    { ...opts, logger },
    gui.progressIntervalMs,
  );
  const deps: MinimaxRunDeps = {
    ...baseDeps,
    sleep: (ms) => budget.run(() => baseDeps.sleep(Math.min(ms, budget.remaining()))),
    createClient: (port, timeout, selectors) => {
      const client = baseDeps.createClient(port, timeout, selectors);
      rawCdp = client;
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
                  `[minimax] CDP ${String(key)} elapsed=${Date.now() - methodStarted}ms`,
                );
              }
            });
        },
      });
    },
  };
  /** 与受管实例直连的原始 CDP 客户端（取消/护栏必需，绕过预算 abort） */
  let rawCdp: MinimaxCdpClient | undefined;
  let connectedCdp: MinimaxCdpClient | undefined;
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
  const abortResult = async (
    session?: NonNullable<AgentRunResult["session"]>,
  ): Promise<AgentRunResult> => {
    const stopClient = rawCdp ?? connectedCdp;
    const guiStop = stopClient
      ? await stopGuiTurn(stopClient, gui, baseDeps.sleep, logger, "取消")
      : undefined;
    const progressSummary = guiStop
      ? guiStop.idle
        ? "MiniMax Code 取消：GUI 内运行已停止"
        : "MiniMax Code 取消：GUI 内运行未确认停止，MiniMax Code 窗口中的任务可能仍在继续"
      : "MiniMax Code 取消：未连接 CDP，无法确认界面停止";
    return result({
      killed: true,
      endReason: "aborted",
      guiStop,
      progressSummary,
      ...(session ? { session } : {}),
    });
  };
  let permission = ctx.resume?.permissionMode ?? gui.defaultPermissionMode ?? "始终授权";
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
    const spec = parseMinimaxModel(ctx.model, ctx.reasoningLevel, ctx.contextWindow);
    const valueError = describeLevelValueError(spec);
    if (valueError)
      return result({ hardFailure: true, endReason: "setup_failed", error: valueError });
    // MiniMax Code 与 Kimi Code 同构：无法在「无项目」派发（项目绑定是任务语义的一部分）。
    if (ctx.workspaceMode === "default" || !ctx.projectPath.trim())
      return result({
        hardFailure: true,
        endReason: "setup_failed",
        error:
          "MiniMax Code 不支持无项目模式（default 工作区）：任务必须绑定到项目文件夹，请提供 projectPath",
      });
    const refs = validateTaskReferences(ctx.task, ctx.context, ctx.projectPath);
    if (!resolved.command)
      return result({
        hardFailure: true,
        error: "未找到 MiniMax Code 可执行文件",
        endReason: "setup_failed",
      });

    budget.setStage("接管 MiniMax Code 实例");
    let inst: Awaited<ReturnType<typeof ensureMinimaxInstance>> = {};
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
          throw new MinimaxSetupPause("MiniMax Code 实例连接尚未恢复，请检查应用状态后继续");
        logger.warn(
          `[minimax] 实例接管暂时失败；attempt=${attempt + 1}；${error instanceof Error ? error.message : String(error)}`,
        );
        await deps.sleep(500 * (attempt + 1));
      }
    }
    if (inst.needsClose)
      return result({
        endReason: "needs_user",
        needsUserKind: "close_existing_instance",
        pendingQuestion:
          "检测到未开启 CDP 的 MiniMax Code 实例。请保存工作并手动关闭所有 MiniMax Code 窗口，然后调用 manage_task 确认（不会自动结束你的进程）。",
        session: sessionMeta(),
        progressSummary: "等待用户关闭既有 MiniMax Code 实例",
      });
    if (!inst.ready)
      return result({
        hardFailure: true,
        error: "MiniMax Code 实例未就绪",
        endReason: "setup_failed",
      });
    const ready: MinimaxReady = inst.ready;
    const connected = await connectStableMinimax(ready, gui, deps);
    const cdp = connected.cdp;
    connectedCdp = cdp;
    if (connected.loginRequired)
      return result({
        endReason: "needs_user",
        needsUserKind: "login_required",
        pendingQuestion:
          "MiniMax Code 主窗口已连接，但消息输入框在观察期内始终未出现（通常意味着停在登录/引导页）。请在 MiniMax Code 中完成登录或引导，然后调用 manage_task 确认。",
        session: sessionMeta(),
        progressSummary: "等待 MiniMax Code 登录/引导完成",
      });
    logger.info("[minimax] MiniMax Code CDP 主窗口与 composer 已就绪");

    /**
     * 启动清理：关掉本进程残留的原生对话框（Codex/Kimi Code 同款教训）。
     * 上一轮失败/取消留下的「Select Directory」模态框会吞掉主窗口点击。
     */
    if (ready.pid) {
      const closed = await deps.closeDialogs([ready.pid]);
      if (closed > 0)
        logger.warn(`[minimax] 已关闭 ${closed} 个残留原生对话框（会阻塞主窗口点击）`);
    }

    const resumeKind = ctx.resume?.kind;
    const isReobserve = resumeKind === "continue" && ctx.resume?.reobserve === true;

    // 重派护栏（防 turn 交叠）：派发前若受管实例上仍有运行信号，先尽力停止；
    // 仍不空闲则硬失败拒绝派发。重观察轮例外——停止按钮可见正是被观察 turn 暂停的表现。
    if (!isReobserve) {
      const probe = await cdp.poll();
      if (probe.stopVisible) {
        const stopped = await stopGuiTurn(rawCdp ?? cdp, gui, baseDeps.sleep, logger, "重派护栏");
        if (!stopped.idle)
          return result({
            hardFailure: true,
            endReason: "instance_busy",
            error:
              "受管 MiniMax Code 实例上存在未停止的运行（已尝试点击停止未果）；请在 MiniMax Code 窗口人工处理后重试，避免新旧任务交叠",
          });
      }
    }
    await cdp.dismissMenus();

    budget.setStage("准备会话");
    const stageDeadline = (budgetMs: number): number =>
      Math.min(
        Date.now() + budgetMs,
        started + ctx.taskTimeoutMs,
        started + gui.setupRecoveryTimeoutMs,
      );
    const menuBudget = (): number =>
      Math.max(1, stageDeadline(gui.projectTriggerTimeoutMs) - Date.now());
    const initialDispatch =
      !ctx.resume ||
      (ctx.resume.kind === "continue" &&
        !ctx.resume.sendMessage &&
        !ctx.resume.sessionId &&
        !ctx.resume.sessionTitle);
    let sessionId = initialDispatch ? "" : (ctx.resume?.sessionId ?? "");
    let sessionTitle = initialDispatch ? undefined : ctx.resume?.sessionTitle;
    if (!initialDispatch && ctx.resume) {
      budget.setStage("定位原 MiniMax Code 会话");
      if (!ctx.resume.sessionId && !ctx.resume.sessionTitle)
        return result({
          hardFailure: true,
          error: "缺少原 MiniMax Code 会话定位信息，拒绝打开最近会话",
          endReason: "session_lost",
        });
      const located = await locateSessionProject(
        cdp,
        ctx.resume.boundProjectPath ?? ctx.projectPath,
        ctx.resume.sessionTitle,
      );
      if (!located.found)
        return result({
          hardFailure: true,
          error: `无法唯一定位原 MiniMax Code 会话（原因=${located.reason ?? "unknown"}），已 fail-closed 且不发送`,
          endReason: "session_lost",
        });
      sessionTitle = located.title ?? sessionTitle;
      logger.info(
        `[minimax] 已定位原会话所属项目（来源=${located.source ?? "n/a"}）`,
      );
    } else {
      budget.setStage("建立新会话并绑定项目");
      const bound = await bindProject({
        cdp,
        ctx,
        gui,
        deps,
        budget,
        logger,
        ready,
        deadlineMs: () => stageDeadline(draftReadyBudgetMs(gui)),
      });
      if (!bound.ok) {
        let draftHint = "";
        if (bound.reason === "draft") {
          const [href, hidden] = await Promise.all([
            cdp.evaluate<string>("location.href").catch(() => ""),
            cdp.pageHidden().catch(() => false),
          ]);
          draftHint = `（当前页面=${href || "未知"}；窗口前台=${hidden ? "否" : "是"}）`;
        }
        const describe: Record<string, string> = {
          draft: `无法进入新的 MiniMax Code 会话：点击「新建任务」后输入框始终未挂载${draftHint}`,
          project: "无法打开 MiniMax Code 项目选择面板",
          ambiguous: `项目同名或路径重复，无法消歧：${bound.candidates?.join("、") ?? ""}`,
          click: "项目面板里命中条目但点击未生效",
          permission: "原生「Select Directory」对话框需要系统权限",
          native: `原生「Select Directory」对话框未完成路径提交：${bound.message ?? ""}`,
          readback: `项目绑定回读不一致（期望 ${ctx.projectPath}${bound.candidates?.length ? `，实际 ${bound.candidates.join("、")}` : ""}）`,
        };
        const reason = bound.reason ?? "native";
        const needsPermission = reason === "permission";
        logger.warn(
          `[minimax] 项目绑定失败：reason=${reason}；${describe[reason] ?? "未知原因"}${bound.message ? `；${bound.message}` : ""}`,
        );
        return result({
          hardFailure: !needsPermission,
          endReason: needsPermission ? "needs_user" : "setup_failed",
          needsUserKind: needsPermission ? "system_permission" : "setup_recovery",
          error: needsPermission ? undefined : (describe[reason] ?? "项目绑定失败"),
          pendingQuestion: needsPermission
            ? "请为 MiniMax Code 授予系统权限后调用 manage_task 确认。"
            : `${describe[reason] ?? "项目绑定失败"}。请在 MiniMax Code 中确认目标项目后调用 manage_task；不会向其它项目发送任务。`,
          session: sessionMeta(),
          progressSummary: "等待 MiniMax Code 项目绑定",
        });
      }
      logger.info(`[minimax] 项目绑定回读通过：${bound.boundPath}`);
      await cdp.dismissMenus();
    }

    if (isReobserve) {
      // 重观察恢复（user_confirmation）：用户在 GUI 处理完等待项后 turn 自行继续，
      // 本轮**不发送任何消息**（用户确认文本绝不发给模型），也不改模型/权限
      // （正在进行的 turn 不允许被打断），只重连观察至终态。
      budget.finishSetup();
      budget.setStage("重连观察 MiniMax Code 会话");
      logger.info(`[minimax] 重观察恢复：会话=${sessionId}；不发送任何消息，仅观察至终态`);
      return await observeMinimax({
        cdp,
        deps,
        gui,
        opts,
        logger,
        startedAt: started,
        deadline: started + ctx.taskTimeoutMs,
        logFile,
        result,
        session: () => sessionMeta({ id: sessionId, title: sessionTitle }),
        baselineError: "",
        // issue #31：重观察轮的被观察 turn 此前已确认在运行，种子 sawRunning
        sawRunningSeed: true,
        onAbort: () => abortResult(sessionMeta({ id: sessionId, title: sessionTitle })),
      });
    }

    // ---------------- 模型 / 推理等级 / 上下文窗口（二级子菜单） ----------------

    budget.setStage("确认模型");
    const selection = await selectModel({
      cdp,
      spec,
      submenuTimeoutMs,
      menuBudget,
      sleep: deps.sleep,
      logger,
    });
    if (!selection.ok)
      return result({
        hardFailure: true,
        error: selection.error ?? "模型选择失败",
        endReason: selection.endReason ?? "model_mismatch",
        session: sessionMeta({ id: sessionId, title: sessionTitle }),
      });


    // ---------------- 权限模式 ----------------

    budget.setStage("确认权限模式");
    permission = ctx.resume?.permissionMode ?? gui.defaultPermissionMode ?? "始终授权";
    if (gui.permissionMode) {
      const current = await cdp.permissionText();
      if (!exactUiName(current, permission)) {
        // 权限菜单是主窗口内的 ant-dropdown（与模型弹层不同），但**其候选项未真机取证**，
        // 所以这里不猜选择器：如实报出当前值与期望值，交由用户处理（fail-closed）。
        logger.warn(
          `[minimax] 权限模式与期望不一致：当前=${current || "空"}，期望=${permission}（权限菜单候选项未取证，不自动切换）`,
        );
      } else {
        logger.info(`[minimax] 权限模式回读已匹配，复用 ${permission}`);
      }
    }

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
    const baselineError = (await cdp.poll()).errorText ?? "";
    if (opts.signal?.aborted)
      return await abortResult(sessionMeta({ id: sessionId, title: sessionTitle }));
    if (Date.now() >= started + ctx.taskTimeoutMs)
      return result({
        timeout: true,
        endReason: "task_timeout",
        error: "MiniMax Code 任务总时限已到，未发送任务",
      });
    await cdp.typeText(marker + message);
    const typed = await cdp.inputText();
    if (!typed.includes(marker))
      return result({
        hardFailure: true,
        error: "MiniMax Code 输入框回读不一致，未发送",
        endReason: "input_mismatch",
      });
    if (opts.signal?.aborted)
      return await abortResult(sessionMeta({ id: sessionId, title: sessionTitle }));
    try {
      await cdp.sendMessage();
    } catch (e) {
      return result({
        hardFailure: true,
        endReason: "send_unknown",
        error: `${e instanceof Error ? e.message : String(e)}；未确认发送，不重复发送`,
      });
    }
    // 发送确认：消息落地为必需锚点，输入框清空/运行信号任一成立即算确认。
    // 60s 有界，且一旦进入本段就**只点击一次**发送（绝不重发）。
    let seenMessage = before.includes(marker);
    let seenStateChange = false;
    let seenRunning = false;
    const confirmationDeadline = Math.min(started + ctx.taskTimeoutMs, Date.now() + 60_000);
    const confirmationAttempts = Math.ceil(Math.max(0, confirmationDeadline - Date.now()) / 250);
    for (
      let i = 0;
      i < confirmationAttempts && Date.now() < confirmationDeadline && !(seenMessage && (seenStateChange || seenRunning));
      i++
    ) {
      if (opts.signal?.aborted)
        return await abortResult(sessionMeta({ id: sessionId, title: sessionTitle }));
      await deps.sleep(Math.min(250, Math.max(0, confirmationDeadline - Date.now())));
      const [text, input, polled] = await Promise.all([
        cdp.conversationText(),
        cdp.inputText(),
        cdp.poll(),
      ]);
      seenMessage ||= text.includes(marker);
      // 输入框清空是 tiptap 侧的可观测事实：归一化后为空串（清空后保留的空段落不算内容）。
      seenStateChange ||= !input.normalize("NFKC").trim();
      seenRunning ||= polled.stopVisible;
    }
    if (Date.now() >= started + ctx.taskTimeoutMs)
      return result({
        timeout: true,
        endReason: "task_timeout",
        error: "MiniMax Code 发送观察达到任务总时限；保留现场且不重复发送",
      });
    if (!(seenMessage && (seenStateChange || seenRunning)))
      return result({
        hardFailure: true,
        error: `发送结果无法确认（消息落地=${seenMessage}，输入框已清空=${seenStateChange}，运行信号=${seenRunning}）；不重复发送`,
        endReason: "send_unknown",
      });
    logger.info(
      `[minimax] 发送已确认：消息落地=${seenMessage}；输入框已清空=${seenStateChange}；运行信号=${seenRunning}`,
    );

    budget.finishSetup();
    budget.setStage("等待 MiniMax Code 回复");
    return await observeMinimax({
      cdp,
      deps,
      gui,
      opts,
      logger,
      startedAt: started,
      deadline: started + ctx.taskTimeoutMs,
      logFile,
      result,
      session: () => sessionMeta({ id: sessionId, title: sessionTitle }),
      baselineError,
      // issue #31：发送确认阶段观测到的运行信号（stop-button）是「本轮确实已启动」最可靠的
      // 证据。观察循环可能因选择器漂移或 turn 已跑完而整段采不到信号，不带过来的话会把已启动
      // 的任务误落 idle_timeout。
      sawRunningSeed: seenRunning,
      onAbort: () => abortResult(sessionMeta({ id: sessionId, title: sessionTitle })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof MinimaxBudgetError) {
      if (e.reason === "aborted") return await abortResult();
      if (e.reason === "task_timeout")
        return result({ timeout: true, endReason: "task_timeout", error: msg });
    }
    if (e instanceof MinimaxSetupPause || (e instanceof MinimaxBudgetError && budget.settingUp))
      return result({
        endReason: "needs_user",
        needsUserKind:
          e instanceof MinimaxSetupPause && e.needsPermission
            ? "system_permission"
            : "setup_recovery",
        pendingQuestion: `${msg}。请在 MiniMax Code 中确认项目 ${ctx.projectPath} 与模型 ${ctx.model ?? ""}，处理后调用 manage_task；原任务已保留。`,
        progressSummary: "自动恢复未能完成，等待处理后继续原任务",
      });
    if (e instanceof MinimaxBudgetError)
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
