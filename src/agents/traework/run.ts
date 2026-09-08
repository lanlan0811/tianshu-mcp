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
import { TraeworkCdpClient } from "./cdp/client.js";
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
import { bindProject, startNewSession } from "./ui/session.js";
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
  createClient: (port: number) => TraeworkCdpClient;
  probeReady: (port: number) => Promise<ReadyInstance | null>;
  launch: (opts: LaunchOptions) => SpawnedInstance;
  waitReady: (port: number, timeoutMs: number, logger: AgentRunLogger) => Promise<ReadyInstance>;
  release: (inst: SpawnedInstance, logger: AgentRunLogger) => { released: boolean; reason: string };
  resolvePort: (gui: GuiProfile, logger: AgentRunLogger) => Promise<number>;
}

const DEFAULT_DEPS: TraeworkRunDeps = {
  createClient: (port) => new TraeworkCdpClient({ port }),
  probeReady,
  launch: launchInstance,
  waitReady,
  release: (inst, logger) => releaseInstance(inst, logger),
  resolvePort,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
    modelSwitch: g?.modelSwitch ?? true,
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
  const fail = (error: string, extra: Partial<AgentRunResult> = {}): AgentRunResult => ({
    ok: false,
    exitCode: null,
    timeout: false,
    killed: false,
    error,
    durationMs: Date.now() - startedAt,
    logFile,
    ...extra,
  });

  await mkdirp(path.dirname(logFile));

  let spawned: SpawnedInstance | null = null;
  let cdp: TraeworkCdpClient | null = null;
  try {
    // ---- 1. 确保实例可用（复用优先，绝不误杀用户实例）----
    const port = await deps.resolvePort(gui, logger);
    let ready = await deps.probeReady(port);
    if (!ready) {
      if (!resolved.command) {
        return fail(`未找到 TraeWork 可执行文件（profile.executableDiscovery 未探测到）。请在 agent-profiles.json 配置 gui.exePath`, {
          hardFailure: true,
        });
      }
      logger.info(`[traework] 端口 ${port} 无就绪实例，启动新实例：${resolved.command}`);
      spawned = deps.launch({ exePath: resolved.command, port, gui, logger });
      ready = await deps.waitReady(port, gui.launchTimeoutMs, logger);
    } else {
      logger.info(`[traework] 复用已就绪实例（端口 ${port}，${ready.title ?? "page"}）`);
    }

    cdp = deps.createClient(port);
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

    // ---- 3. 绑定项目文件夹 ----
    const bound = await bindProject(cdp, ctx.projectPath, { selectors: gui.selectors, logger });
    if (!bound.bound) {
      return fail(`项目文件夹绑定失败（${bound.method}）：${bound.message}`, { hardFailure: true });
    }
    logger.info(`[traework] 项目已绑定：${bound.message}`);

    // ---- 4. 切模型（用户指定时）----
    if (ctx.model && gui.modelSwitch) {
      const sw = await selectModel(cdp, ctx.model, { selectors: gui.selectors, logger });
      if (!sw.ok) {
        const detail =
          sw.reason === "restricted"
            ? `模型「${sw.model}」需解锁权益，当前账号不可用`
            : sw.reason === "not_found"
              ? `下拉中未找到模型「${ctx.model}」${sw.available?.length ? `（可用：${sw.available.join("、")}）` : ""}`
              : `模型切换后验证不一致（${sw.model}）`;
        return fail(`模型切换失败：${detail}`, { hardFailure: true });
      }
    } else if (ctx.model) {
      logger.info(`[traework] profile.gui.modelSwitch=false，忽略指定模型「${ctx.model}」`);
    }

    // ---- 5. 写入任务书并发送 ----
    const promptText = buildPromptText(ctx.task, ctx.context, ctx.feedback);
    const marker = makeMarker();
    await typeAndSend(cdp, marker + promptText, { selectors: gui.selectors, logger });

    // ---- 6. 轮询到完成 ----
    const base = await cdp.text("messageContainer", gui.selectors);
    let state: CompletionState = { prev: "", stable: 0 };
    const deadline = Date.now() + (ctx.taskTimeoutMs > 0 ? ctx.taskTimeoutMs : 30 * 60_000);
    let replyText = "";

    for (;;) {
      if (opts.signal?.aborted) {
        return fail("已取消", { killed: true });
      }
      if (Date.now() > deadline) {
        return fail(`等待 TraeWork 开发完成超时（${Math.round((ctx.taskTimeoutMs || 0) / 1000)}s）`, { timeout: true });
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(gui.pollIntervalMs);
      // eslint-disable-next-line no-await-in-loop
      const current = await cdp.text("messageContainer", gui.selectors);
      const verdict = judgePoll(current, marker, base, state, gui.stableRounds);
      if (verdict.kind === "finished") {
        replyText = verdict.added;
        break;
      }
      if (verdict.kind === "ask_user") {
        logger.warn("[traework] 模型发起原生提问（ask_user），会话被阻塞，按本轮结束处理");
        replyText = verdict.added;
        await cdp.pressEscape().catch(() => undefined);
        break;
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
    };
  } finally {
    cdp?.disconnect();
    // 只释放本模块创建的实例；用户已有实例永不终止
    if (spawned) {
      const r = deps.release(spawned, logger);
      logger.info(`[traework] 实例释放：${r.reason}`);
    }
    await closeLog();
  }
}
