/**
 * 集成测试：TraeWork GUI 驱动的完整单轮流程（假 CDP，不依赖真机）。
 *
 * 覆盖：复用已就绪实例 → 新建会话 → 绑定项目（下拉命中）→ 切模型 →
 *       写任务书发送 → 轮询到完成 → 返回成功；以及各类失败路径。
 */
import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { makeTmpRoot } from "../test-utils.js";
import { FakeCdpClient, makeFakeState, extractMarker, type FakeDomState } from "../fake-cdp.js";
import { runTraeworkTask, type TraeworkRunDeps } from "../../src/agents/traework/run.js";
import { CdpDisconnectedError } from "../../src/agents/traework/cdp/client.js";
import type { TaskContext, ResolvedAgent, AgentRunLogger } from "../../src/agents/adapter.js";

const silentLogger: AgentRunLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeResolved(over: Record<string, unknown> = {}, guiOver: Record<string, unknown> = {}): ResolvedAgent {
  return {
    id: "traework",
    displayName: "TraeWork",
    command: "D:\\TRAE Work CN\\TRAE SOLO CN.exe",
    argsTemplate: [],
    ok: true,
    message: "",
    profile: {
      displayName: "TraeWork",
      type: "cli",
      driver: "gui",
      status: "ready",
      argsTemplate: [],
      promptMode: "arg",
      cwd: "task",
      env: {},
      timeoutMs: 30_000,
      killTree: "taskkill",
      authNote: "",
      gui: {
        cdpPort: 9222,
        cdpPortAuto: true,
        cdpPortRange: 5,
        exeArgs: ["--remote-debugging-port=<port>"],
        windowMode: "reuse",
        launchTimeoutMs: 5_000,
        pollIntervalMs: 1, // 测试加速
        stableRounds: 2,
        modelSwitch: true,
        freshSession: true,
        selectors: {},
        ...guiOver,
      },
      ...over,
    },
  } as unknown as ResolvedAgent;
}

function makeCtx(over: Partial<TaskContext> = {}): TaskContext {
  return {
    taskId: "tsk_fake",
    projectPath: "d:/trae项目/demo",
    displayPath: "D:\\Trae项目\\demo",
    agentId: "traework",
    task: "实现登录接口",
    round: 0,
    taskDir: "",
    workDir: "d:/trae项目/demo",
    taskTimeoutMs: 20_000,
    ...over,
  };
}

/** 构造注入依赖：复用已就绪实例，不真启动 */
function makeDeps(state: FakeDomState, over: Partial<TraeworkRunDeps> = {}): TraeworkRunDeps {
  return {
    createClient: (port) => new FakeCdpClient(port, state) as never,
    probeReady: async (port) => ({ port, title: "TraeWork CN" }),
    launch: () => {
      throw new Error("测试不应启动新实例（应复用）");
    },
    waitReady: async (port) => ({ port, title: "TraeWork CN" }),
    release: () => ({ released: true, reason: "已终止" }),
    resolvePort: async (gui) => gui.cdpPort,
    ...over,
  };
}

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await makeTmpRoot("traework-run");
});

/**
 * 设置发送后立刻产生的助手回复（确定性）。
 * 不使用定时器：轮询间隔小、stableRounds 低时，异步定时器会与稳定兜底抢跑。
 */
function autoReply(state: FakeDomState, reply: string): void {
  state.autoReplyText = reply;
}

describe("runTraeworkTask 全链路（假 CDP）", () => {
  it("复用实例 → 新建会话 → 下拉命中项目 → 切模型 → 发送 → 完成", async () => {
    const state = makeFakeState({ projectItems: [{ name: "demo", subtitle: "d:\\Trae项目\\demo" }] });
    autoReply(state, "已完成登录接口实现");
    const r = await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-0.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.hardFailure).toBeUndefined();
    expect(state.sessionStarted).toBe(true);
    expect(state.boundProject).toBe("demo");
    expect(state.sent).toBe(true);
    // 未指定 model 时不切模型，沿用面板当前值
    expect(state.model).toBe("Auto Mode");
    // 日志落盘且含回复正文
    const log = fs.readFileSync(path.join(tmpDir, "agent-0.log"), "utf8");
    expect(log).toContain("复用已就绪实例");
    expect(log).toContain("已完成登录接口实现");
  });

  it("任务书带 marker 且拼接 context / 返修反馈", async () => {
    const state = makeFakeState({ projectItems: [{ name: "demo", subtitle: "" }] });
    autoReply(state, "ok");
    await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir, context: "约束：不要改样式", feedback: "上一轮 typecheck 失败" }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-1.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });
    expect(state.messages).toContain("【附加上下文 / 约束】");
    expect(state.messages).toContain("不要改样式");
    expect(state.messages).toContain("上一轮验收未通过");
    expect(extractMarker(state.messages)).not.toBe("");
  });

  it("模式切换：mode=Code 生效，且项目绑定仍保留", async () => {
    const state = makeFakeState({ projectItems: [{ name: "demo", subtitle: "" }] });
    autoReply(state, "ok");
    await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir, mode: "Code" }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-mode-code.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });
    expect(state.mode).toBe("Code");
    expect(state.boundProject).toBe("demo");
    expect(state.sent).toBe(true);
  });

  it("模式切换：mode=Design 生效", async () => {
    const state = makeFakeState({ projectItems: [{ name: "demo", subtitle: "" }] });
    autoReply(state, "ok");
    await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir, mode: "Design" }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-mode-design.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });
    expect(state.mode).toBe("Design");
  });

  it("模式切换：任务书文本兜底识别（无 mode 参数）", async () => {
    const state = makeFakeState({ projectItems: [{ name: "demo", subtitle: "" }] });
    autoReply(state, "ok");
    await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir, task: "请切换到 Code 模式，实现登录接口" }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-mode-text.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });
    expect(state.mode).toBe("Code");
  });

  it("mode 缺省且任务书未提模式 → 保持 Work", async () => {
    const state = makeFakeState({ projectItems: [{ name: "demo", subtitle: "" }] });
    autoReply(state, "ok");
    await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir, task: "实现登录接口" }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-mode-default.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });
    expect(state.mode).toBe("Work");
  });

  it("modeSwitch=false 时忽略指定模式", async () => {
    const state = makeFakeState({ projectItems: [{ name: "demo", subtitle: "" }] });
    autoReply(state, "ok");
    await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir, mode: "Code" }),
      resolved: makeResolved({}, { modeSwitch: false }),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-mode-off.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });
    expect(state.mode).toBe("Work");
  });

  it("指定模型时切换并严格验证", async () => {
    const state = makeFakeState({ projectItems: [{ name: "demo", subtitle: "" }], models: ["GLM-5.3", "DeepSeek-V4-Flash"] });
    autoReply(state, "ok");
    await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir, model: "DeepSeek-V4-Flash" }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-2.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });
    expect(state.model).toBe("DeepSeek-V4-Flash");
  });

  it("模型不在下拉中 → 基础设施失败（不进入验收）", async () => {
    const state = makeFakeState({ projectItems: [{ name: "demo", subtitle: "" }], models: ["GLM-5.3"] });
    const r = await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir, model: "不存在的模型" }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-3.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });
    expect(r.ok).toBe(false);
    expect(r.hardFailure).toBe(true);
    expect(r.error).toContain("模型切换失败");
  });

  it("下拉未命中且无 footer → 项目绑定失败（基础设施）", async () => {
    const state = makeFakeState({ projectItems: [] });
    const r = await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-4.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state, {
        // 模拟：聊天面板已就绪（chatInput 存在），但项目按钮点不动、下拉展不开
        createClient: () =>
          ({
            connect: async () => {},
            disconnect: () => {},
            exists: async (k: string) => k === "chatInput",
            text: async (k: string) => (k === "projectButton" ? "选择文件夹（可选）" : ""),
            click: async () => false,
            evaluate: async () => false,
            evaluateString: async () => "",
            center: async () => null,
          }) as never,
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.hardFailure).toBe(true);
    expect(r.error).toContain("项目文件夹绑定失败");
  });

  it("等待完成超时 → timeout=true", async () => {
    const state = makeFakeState({ projectItems: [{ name: "demo", subtitle: "" }] });
    // 不自动回复；把稳定兜底轮数设得远大于超时窗口，确保走超时分支
    const r = await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir, taskTimeoutMs: 300 }),
      resolved: makeResolved({}, { stableRounds: 100_000 }),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-5.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });
    expect(r.ok).toBe(false);
    expect(r.timeout).toBe(true);
  });

  it("停止按钮可见时即使已有完成标志也不结束，信号消失后正常完成", async () => {
    const state = makeFakeState({
      projectItems: [{ name: "demo", subtitle: "" }],
      livenessSequence: [
        { stopVisible: true, tailLoading: false, thinkingStream: false },
        { stopVisible: false, tailLoading: false, thinkingStream: false },
      ],
    });
    autoReply(state, "回复已写完但仍在生成");
    let probeCount = 0;
    const client = new FakeCdpClient(9222, state);
    const originalProbe = client.probeLiveness.bind(client);
    client.probeLiveness = async () => {
      probeCount += 1;
      return originalProbe();
    };
    const r = await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-running-priority.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state, { createClient: () => client as never }),
    });
    expect(r.ok).toBe(true);
    expect(r.endReason).toBe("completion_mark");
    expect(probeCount).toBeGreaterThanOrEqual(2);
  });

  it("静态空闲结束：ok=false、保留实例且不调用 release", async () => {
    const state = makeFakeState({ projectItems: [{ name: "demo", subtitle: "" }] });
    let released = false;
    const r = await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir }),
      resolved: makeResolved({}, { stableRounds: 1, idleTimeoutMs: 0 }),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-idle.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state, {
        probeReady: async () => null,
        launch: () => ({ pid: 1234, port: 9222, exePath: "x.exe", commandLine: "x.exe --remote-debugging-port=9222" }),
        release: () => {
          released = true;
          return { released: true, reason: "不应调用" };
        },
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.hardFailure).toBeUndefined();
    expect(r.endReason).toBe("idle_no_completion");
    expect(r.keptInstance).toBe(true);
    expect(released).toBe(false);
  });

  it("超时保留新启动实例，不调用 release", async () => {
    const state = makeFakeState({ projectItems: [{ name: "demo", subtitle: "" }] });
    let released = false;
    const r = await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir, taskTimeoutMs: 30 }),
      resolved: makeResolved({}, { stableRounds: 100_000, idleTimeoutMs: 60_000 }),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-timeout-kept.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state, {
        probeReady: async () => null,
        launch: () => ({ pid: 2345, port: 9222, exePath: "x.exe", commandLine: "x.exe --remote-debugging-port=9222" }),
        release: () => {
          released = true;
          return { released: true, reason: "不应调用" };
        },
      }),
    });
    expect(r.timeout).toBe(true);
    expect(r.endReason).toBe("timeout");
    expect(r.keptInstance).toBe(true);
    expect(released).toBe(false);
  });

  it("CDP 断开 → hardFailure 且保留实例", async () => {
    const state = makeFakeState({
      projectItems: [{ name: "demo", subtitle: "" }],
      livenessError: new CdpDisconnectedError("测试断开"),
    });
    let released = false;
    const r = await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-cdp-lost.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state, {
        probeReady: async () => null,
        launch: () => ({ pid: 3456, port: 9222, exePath: "x.exe", commandLine: "x.exe --remote-debugging-port=9222" }),
        release: () => {
          released = true;
          return { released: true, reason: "不应调用" };
        },
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.hardFailure).toBe(true);
    expect(r.endReason).toBe("cdp_lost");
    expect(r.keptInstance).toBe(true);
    expect(released).toBe(false);
  });

  it("取消信号 → killed=true", async () => {
    const state = makeFakeState({ projectItems: [{ name: "demo", subtitle: "" }] });
    const ac = new AbortController();
    ac.abort();
    const r = await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir }),
      resolved: makeResolved(),
      opts: { signal: ac.signal, logger: silentLogger },
      logFile: path.join(tmpDir, "agent-6.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });
    expect(r.killed).toBe(true);
  });

  it("无可执行文件且无就绪实例 → 基础设施失败", async () => {
    const state = makeFakeState();
    const resolved = makeResolved();
    (resolved as { command: string | null }).command = null;
    const r = await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir }),
      resolved,
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-7.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state, { probeReady: async () => null }),
    });
    expect(r.hardFailure).toBe(true);
    expect(r.error).toContain("未找到 TraeWork 可执行文件");
  });

  it("需启动新实例时创建并在结束后释放", async () => {
    const state = makeFakeState({ projectItems: [{ name: "demo", subtitle: "" }] });
    autoReply(state, "ok");
    let launched = false;
    let released = false;
    const r = await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-8.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state, {
        probeReady: async () => null,
        launch: () => {
          launched = true;
          return { pid: 1234, port: 9222, exePath: "x.exe", commandLine: "x.exe --remote-debugging-port=9222" };
        },
        release: () => {
          released = true;
          return { released: true, reason: "已终止" };
        },
      }),
    });
    expect(r.ok).toBe(true);
    expect(launched).toBe(true);
    expect(released).toBe(true);
  });

  it("freshSession=false 时不点新建任务", async () => {
    const state = makeFakeState({ projectItems: [{ name: "demo", subtitle: "" }] });
    autoReply(state, "ok");
    const resolved = makeResolved();
    (resolved.profile.gui as { freshSession: boolean }).freshSession = false;
    await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir }),
      resolved,
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-9.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });
    expect(state.clicked).not.toContain("newTask");
  });
});
