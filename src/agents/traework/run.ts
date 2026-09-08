/**
 * TraeWork 单轮任务执行（开发计划 §4.5）。
 *
 * 顺序：确保实例可用 → 新建会话 → 绑定项目文件夹 →（可选）切模型 →
 *       写入任务书并发送 → 轮询到完成 → 返回 AgentRunResult。
 *
 * 落盘：全过程写入任务目录的 agent-<round>.log（与 CLI agent 同构），
 * 供 query_task 的日志尾随与事后复盘。
 */
import fs from "node:fs";
import path from "node:path";
import { mkdirp } from "../../util/fs.js";
import type { AgentRunLogger, AgentRunOptions, AgentRunResult, ResolvedAgent, TaskContext } from "../adapter.js";
import type { GuiProfile } from "../../config/schema.js";
import { CdpDisconnectedError, CdpUnavailableError, interpretLiveness, TraeworkCdpClient } from "./cdp/client.js";
import {
  launchInstance,
  probeReady,
  releaseInstance,
  resolvePort,
  waitReady,
  type LaunchOptions,
  type ReadyInstance,
  type SpawnedInstance,
} from "./launcher.js";
import {
  bindProject,
  ensureMode,
  matchProjectItem,
  projectBasename,
  readBoundProject,
  readMode,
  resolveMode,
  startNewSession,
} from "./ui/session.js";
import { buildPromptText, typeAndSend } from "./ui/composer.js";
import { selectModel } from "./ui/model.js";
import { judgePoll, makeMarker, parseAdded, type CompletionState } from "./ui/reply.js";

export interface RunTraeworkArgs {
  ctx: TaskContext;
  resolved: ResolvedAgent;
  opts: AgentRunOptions;
  logFile: string;
  startedAt: number;
  logger: AgentRunLogger;
  /** 测试注入点：替换 CDP 客户端（假 DOM 桩） */
  deps?: Partial<TraeworkRunDeps>;
}

/** 可注入依赖（生产用真实实现；集成测试注入假 CDP） */
export interface TraeworkRunDeps {
  createClient: (port: number, sendTimeoutMs: number) => TraeworkCdpClient;
  probeReady: (port: number) => Promise<ReadyInstance | null>;
  launch: (opts: LaunchOptions) => SpawnedInstance;
  waitReady: (port: number, timeoutMs: number, logger: AgentRunLogger) => Promise<ReadyInstance>;
  release: (inst: SpawnedInstance, logger: AgentRunLogger) => { released: boolean; reason: string };
  resolvePort: (gui: GuiProfile, logger: AgentRunLogger) => Promise<number>;
}

const DEFAULT_DEPS: TraeworkRunDeps = {
  createClient: (port, sendTimeoutMs) => new TraeworkCdpClient({ port, sendTimeoutMs }),
  probeReady,
  launch: launchInstance,
  waitReady,
  release: (inst, logger) => releaseInstance(inst, logger),
  resolvePort,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class PollGuardError extends Error {
  constructor(readonly reason: "aborted" | "timeout") {
    super(reason);
  }
}

/** 让等待/CDP 观测与取消、任务截止时间竞争；最长 1s 即响应取消。 */
async function guardPoll<T>(work: Promise<T>, signal: AbortSignal | undefined, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    const check = (): void => {
      if (signal?.aborted) {
        reject(new PollGuardError("aborted"));
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(new PollGuardError("timeout"));
        return;
      }
      timer = setTimeout(check, Math.min(1_000, remaining));
    };
    onAbort = () => reject(new PollGuardError("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    check();
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 等待渲染进程 DOM 就绪。
 * 实测（2026-09-08）：新启动实例时 CDP 端口可能先就绪，但聊天面板尚未渲染，
 * 此时「新建任务」「选择文件夹」等元素都不存在。以聊天输入框出现为就绪信号。
 */
async function waitForUi(
  cdp: TraeworkCdpClient,
  selectors: GuiProfile["selectors"],
  logger: AgentRunLogger,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let logged = false;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await cdp.exists("chatInput", selectors)) return;
    if (!logged) {
      logger.info("[traework] 等待聊天面板渲染完成…");
      logged = true;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(1_000);
  }
  throw new Error(`等待 TraeWork 聊天面板渲染超时（${timeoutMs}ms）——窗口可能仍在加载或未登录`);
}

/** 默认 GUI 配置（profile.gui 缺省时兜底，与 schema 默认值一致） */
function guiOf(resolved: ResolvedAgent): GuiProfile {
  const g = resolved.profile.gui;
  return {
    cdpPort: g?.cdpPort ?? 9222,
    cdpPortAuto: g?.cdpPortAuto ?? true,
    cdpPortRange: g?.cdpPortRange ?? 20,
    exePath: g?.exePath,
    exeArgs: g?.exeArgs ?? ["--remote-debugging-port=<port>"],
    windowMode: g?.windowMode ?? "reuse",
    launchTimeoutMs: g?.launchTimeoutMs ?? 60_000,
    pollIntervalMs: g?.pollIntervalMs ?? 3_000,
    stableRounds: g?.stableRounds ?? 12,
    idleTimeoutMs: g?.idleTimeoutMs ?? 10 * 60_000,
    cdpSendTimeoutMs: g?.cdpSendTimeoutMs ?? 15_000,
    progressIntervalMs: g?.progressIntervalMs ?? 30_000,
    modelSwitch: g?.modelSwitch ?? true,
    modeSwitch: g?.modeSwitch ?? true,
    freshSession: g?.freshSession ?? true,
    selectors: g?.selectors ?? {},
  };
}

/** 追加写日志文件（与 CLI agent 的 agent.log 同格式）；close() 确保落盘 */
function makeFileLogger(logFile: string, base: AgentRunLogger): { logger: AgentRunLogger; close: () => Promise<void> } {
  let stream: fs.WriteStream | null = null;
  const ensure = (): fs.WriteStream | null => {
    if (stream) return stream;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      stream = fs.createWriteStream(logFile, { flags: "a", encoding: "utf8" });
      stream.on("error", () => {
        stream = null;
      });
      stream.write(`\n===== traework-gui run @ ${new Date().toISOString()} =====\n`);
      return stream;
    } catch {
      return null;
    }
  };
  const write = (level: string, msg: string): void => {
    const line = `[${level}] ${msg}\n`;
    const s = ensure();
    if (s && s.writable) s.write(line);
  };
  const logger: AgentRunLogger = {
    info: (m) => {
      write("info", m);
      base.info(m);
    },
    warn: (m) => {
      write("warn", m);
      base.warn(m);
    },
    error: (m) => {
      write("error", m);
      base.error(m);
    },
    debug: (m) => {
      write("debug", m);
      base.debug(m);
    },
  };
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      if (!stream) {
        resolve();
        return;
      }
      const s = stream;
      stream = null;
      s.end(() => resolve());
    });
  return { logger, close };
}

export async function runTraeworkTask(args: RunTraeworkArgs): Promise<AgentRunResult> {
  const { ctx, resolved, opts, logFile, startedAt } = args;
  const deps: TraeworkRunDeps = { ...DEFAULT_DEPS, ...args.deps };
  const gui = guiOf(resolved);
  const { logger, close: closeLog } = makeFileLogger(logFile, args.logger);
  let endReason: string | undefined;
  let keptInstance = false;
  const fail = (error: string, extra: Partial<AgentRunResult> = {}): AgentRunResult => ({
    ok: false,
    exitCode: null,
    timeout: false,
    killed: false,
    error,
    durationMs: Date.now() - startedAt,
    logFile,
    endReason,
    keptInstance,
    ...extra,
  });
  const stop = (reason: string, error: string, extra: Partial<AgentRunResult> = {}): AgentRunResult => {
    endReason = reason;
    keptInstance = true;
    return fail(error, extra);
  };

  await mkdirp(path.dirname(logFile));

  let spawned: SpawnedInstance | null = null;
  let cdp: TraeworkCdpClient | null = null;
  let activePort: number | null = null;
  try {
    // ---- 1. 确保实例可用（复用优先，绝不误杀用户实例）----
    const port = await deps.resolvePort(gui, logger);
    activePort = port;
    let ready = await deps.probeReady(port);
    if (!ready) {
      if (!resolved.command) {
        return stop("setup_failed", `未找到 TraeWork 可执行文件（profile.executableDiscovery 未探测到）。请在 agent-profiles.json 配置 gui.exePath`, {
          hardFailure: true,
        });
      }
      logger.info(`[traework] 端口 ${port} 无就绪实例，启动新实例：${resolved.command}`);
      spawned = deps.launch({ exePath: resolved.command, port, gui, logger });
      ready = await deps.waitReady(port, gui.launchTimeoutMs, logger);
    } else {
      logger.info(`[traework] 复用已就绪实例（端口 ${port}，${ready.title ?? "page"}）`);
    }

    cdp = deps.createClient(port, gui.cdpSendTimeoutMs);
    await cdp.connect();
    logger.info(`[traework] CDP 已连接（端口 ${port}）`);

    // CDP 端口就绪 ≠ 渲染进程 DOM 就绪（新实例首启需数秒渲染）。
    // 必须等到聊天输入框出现，否则后续「新建任务/选择文件夹」都会找不到。
    await waitForUi(cdp, gui.selectors, logger);

    // ---- 2. 新建会话（每任务一个干净会话）----
    if (gui.freshSession) {
      const ok = await startNewSession(cdp, { selectors: gui.selectors, logger });
      if (!ok) logger.warn("[traework] 未能新建会话，将在当前会话继续（fail-open）");
    }

    // ---- 3. 确定并切换面板模式（用户指定 / 任务书识别）----
    // 实测（2026-09-08）：TraeWork 的 Work/Code/Design **各自维护独立的项目绑定**，
    // 切换模式会把输入栏的项目换成该模式上次使用的项目。因此顺序必须是
    // 「新建会话 → 切到目标模式 → 在目标模式里绑定项目」。
    const target = gui.modeSwitch ? resolveMode(ctx.mode, ctx.task) : { mode: "Work" as const, source: "default" as const };
    if (!gui.modeSwitch && ctx.mode) {
      logger.info(`[traework] profile.gui.modeSwitch=false，忽略指定模式「${ctx.mode}」`);
    }
    if (target.mode !== "Work" || (gui.modeSwitch && ctx.mode)) {
      logger.info(`[traework] 目标模式 ${target.mode}（来源：${target.source}），切换中…`);
      const modeOk = await ensureMode(cdp, target.mode, { selectors: gui.selectors, logger });
      if (!modeOk) {
        return stop("setup_failed", `模式切换失败：无法切换到 ${target.mode} 模式（当前面板可能不可用）`, { hardFailure: true });
      }
    }

    // ---- 4. 在目标模式下绑定项目文件夹 ----
    const bound = await bindProject(cdp, ctx.projectPath, { selectors: gui.selectors, logger, mode: target.mode });
    if (!bound.bound) {
      return stop("setup_failed", `项目文件夹绑定失败（${bound.method}）：${bound.message}`, { hardFailure: true });
    }
    logger.info(`[traework] 项目已绑定（模式 ${target.mode}）：${bound.message}`);

    // 复核：绑定后模式与项目都应就位
    const afterMode = await readMode(cdp, gui.selectors);
    const afterBound = await readBoundProject(cdp, gui.selectors);
    if (afterMode && afterMode.toLowerCase() !== target.mode.toLowerCase()) {
      return stop("setup_failed", `绑定项目后面板模式变为 ${afterMode}（期望 ${target.mode}），已中止以免在错误模式下开发`, { hardFailure: true });
    }
    if (!afterBound || !matchProjectItem({ name: afterBound, subtitle: "" }, ctx.projectPath)) {
      return stop("setup_failed", `项目绑定校验失败（输入栏：${afterBound || "空"}，期望 ${projectBasename(ctx.projectPath)}）`, { hardFailure: true });
    }

    // ---- 5. 切模型（用户指定时）----
    if (ctx.model && gui.modelSwitch) {
      const sw = await selectModel(cdp, ctx.model, { selectors: gui.selectors, logger });
      if (!sw.ok) {
        const detail =
          sw.reason === "restricted"
            ? `模型「${sw.model}」需解锁权益，当前账号不可用`
            : sw.reason === "not_found"
              ? `下拉中未找到模型「${ctx.model}」${sw.available?.length ? `（可用：${sw.available.join("、")}）` : ""}`
              : `模型切换后验证不一致（${sw.model}）`;
        return stop("setup_failed", `模型切换失败：${detail}`, { hardFailure: true });
      }
    } else if (ctx.model) {
      logger.info(`[traework] profile.gui.modelSwitch=false，忽略指定模型「${ctx.model}」`);
    }

    // ---- 6. 写入任务书并发送 ----
    const promptText = buildPromptText(ctx.task, ctx.context, ctx.feedback);
    const marker = makeMarker();
    await typeAndSend(cdp, marker + promptText, { selectors: gui.selectors, logger });

    // ---- 7. 轮询到完成 ----
    const base = await cdp.text("messageContainer", gui.selectors);
    let state: CompletionState = { prev: "", stable: 0, idleSince: 0 };
    const deadline = Date.now() + (ctx.taskTimeoutMs > 0 ? ctx.taskTimeoutMs : 30 * 60_000);
    let replyText = "";
    let lastProgressAt = Date.now();
    let runningSince = 0;
    let runningWarned = false;

    for (;;) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await guardPoll(sleep(gui.pollIntervalMs), opts.signal, deadline);
      } catch (e) {
        if (e instanceof PollGuardError && e.reason === "aborted") return stop("aborted", "已取消", { killed: true });
        if (e instanceof PollGuardError && e.reason === "timeout") {
          return stop("timeout", `等待 TraeWork 开发完成超时（${Math.round((ctx.taskTimeoutMs || 0) / 1000)}s）`, { timeout: true });
        }
        throw e;
      }

      let current: string;
      let liveness;
      try {
        // 单轮 DOM 文本与运行探针并行，并与 abort/deadline 竞争。
        // eslint-disable-next-line no-await-in-loop
        [current, liveness] = await guardPoll(
          Promise.all([cdp.text("messageContainer", gui.selectors), cdp.probeLiveness(gui.selectors)]),
          opts.signal,
          deadline,
        );
      } catch (e) {
        if (e instanceof PollGuardError && e.reason === "aborted") return stop("aborted", "已取消", { killed: true });
        if (e instanceof PollGuardError && e.reason === "timeout") {
          return stop("timeout", `等待 TraeWork 开发完成超时（${Math.round((ctx.taskTimeoutMs || 0) / 1000)}s）`, { timeout: true });
        }
        throw e;
      }

      const live = interpretLiveness(liveness);
      const now = Date.now();
      if (live.running) {
        if (runningSince === 0) runningSince = now;
        if (!runningWarned && now - runningSince >= gui.idleTimeoutMs) {
          logger.warn(`[traework] 运行信号已持续 ${Math.round((now - runningSince) / 1000)}s（${live.evidence}），仅记录诊断，继续等待`);
          runningWarned = true;
        }
      } else {
        runningSince = 0;
        runningWarned = false;
      }

      if (now - lastProgressAt >= gui.progressIntervalMs) {
        const note = live.running
          ? `TraeWork 仍在生成（运行信号：${live.evidence}）`
          : `TraeWork 等待完成（稳定轮数 ${state.stable}/${gui.stableRounds}；诊断：${live.evidence}）`;
        logger.info(`[traework] ${note}`);
        // 进度事件写入失败不能中断任务。
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve(opts.onProgress?.(note)).catch((e: unknown) => logger.warn(`[traework] 写入进度事件失败：${e instanceof Error ? e.message : String(e)}`));
        lastProgressAt = now;
      }

      const verdict = judgePoll(current, marker, base, state, gui.stableRounds, {
        liveness,
        now,
        idleTimeoutMs: gui.idleTimeoutMs,
      });
      if (verdict.kind === "finished") {
        endReason = "completion_mark";
        replyText = verdict.added;
        break;
      }
      if (verdict.kind === "ask_user") {
        endReason = "ask_user";
        logger.warn("[traework] 模型发起原生提问（ask_user），会话被阻塞，按本轮结束处理");
        replyText = verdict.added;
        await cdp.pressEscape().catch(() => undefined);
        break;
      }
      if (verdict.kind === "idle") {
        logger.warn(`[traework] 无完成标志且无运行信号，静态持续 ${gui.idleTimeoutMs}ms，本轮按 idle 结束并保留实例`);
        return stop("idle_no_completion", "TraeWork 长时间静态且未出现完成标志；已保留实例供继续检查");
      }
      state = verdict.state;
    }

    const parsed = parseAdded(replyText);
    logger.info(`[traework] 本轮结束，回复 ${parsed.content.length} 字符（推理 ${parsed.reasoning.length} 字符）`);
    if (parsed.content) {
      logger.info(`--- 回复正文（截断 4000 字符）---\n${parsed.content.slice(0, 4000)}`);
    }

    // GUI 侧正常完成 = 成功（真正通过与否由后续验收引擎判定）
    return {
      ok: true,
      exitCode: 0,
      timeout: false,
      killed: false,
      durationMs: Date.now() - startedAt,
      logFile,
      endReason,
      keptInstance: false,
    };
  } catch (e) {
    if (e instanceof CdpDisconnectedError || e instanceof CdpUnavailableError) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`[traework] CDP 连接失效：${msg}`);
      return stop("cdp_lost", msg, { hardFailure: true });
    }
    throw e;
  } finally {
    cdp?.disconnect();
    // 只在本轮真正完成/ask_user 时释放本模块创建的实例；其余结果保留现场。
    if (spawned && (endReason === "completion_mark" || endReason === "ask_user")) {
      const r = deps.release(spawned, logger);
      logger.info(`[traework] 实例释放：${r.reason}`);
    } else if (keptInstance) {
      logger.info(`[traework] 保留实例（endReason=${endReason ?? "unknown"}，pid=${spawned?.pid ?? "existing"}，port=${activePort ?? "unknown"}）`);
    }
    await closeLog();
  }
}
