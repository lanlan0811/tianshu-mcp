/**
 * 集成测试：TraeWork 适配器的细粒度事件上报（issue #18）。
 *
 * 用假 CDP 驱动真实 runTraeworkTask，断言四个发射点：
 * 派发、原生对话框类确认、等待人工授权（ask_user）、开始执行（运行信号首次出现）。
 * 另覆盖「未提供 onEvent」的可选能力语义。
 *
 * 采用 vi.resetModules() + 动态 import 的模式（与 traework-bind-fallback.test.ts 一致），
 * 以便按用例桩化 computeruse/dialog 模块。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import { makeTmpRoot } from "../test-utils.js";
import { FakeCdpClient, makeFakeState, type FakeDomState } from "../fake-cdp.js";
import type { TraeworkRunDeps } from "../../src/agents/traework/run.js";
import type { TaskContext, ResolvedAgent, AgentRunLogger, AgentRunOptions } from "../../src/agents/adapter.js";
import type { AgentEventName } from "../../src/agents/agent-events.js";

const silentLogger: AgentRunLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeResolved(): ResolvedAgent {
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
        pollIntervalMs: 1,
        stableRounds: 2,
        modelSwitch: true,
        modeSwitch: true,
        freshSession: true,
        selectors: {},
      },
    },
  } as unknown as ResolvedAgent;
}

function makeCtx(over: Partial<TaskContext> = {}): TaskContext {
  return {
    taskId: "tsk_traework_events",
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

function makeDeps(state: FakeDomState, over: Partial<TraeworkRunDeps> = {}): TraeworkRunDeps {
  return {
    createClient: () => new FakeCdpClient(9222, state) as never,
    probeReady: async (port) => ({ port, title: "TraeWork CN" }),
    launch: () => {
      throw new Error("测试应复用实例");
    },
    waitReady: async (port) => ({ port, title: "TraeWork CN" }),
    release: async () => ({ released: true, reason: "已终止" }),
    resolvePort: async (gui) => gui.cdpPort,
    // 钳到 2ms 真实 sleep：保留事件循环语义（纯微任务 no-op 会饿死 timers 阶段）
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
    dialogWaitTimeoutMs: 100,
    ...over,
  };
}

/** 收集事件名的 opts */
function optsWithEvents(sink: AgentEventName[]): AgentRunOptions {
  return {
    logger: silentLogger,
    onEvent: (ev) => {
      sink.push(ev.kind);
    },
  };
}

/** 收集完整事件的 opts（需要断言 detail / data 时用） */
function optsCapturing(sink: { kind: AgentEventName; detail?: string; data?: Record<string, unknown> }[]): AgentRunOptions {
  return {
    logger: silentLogger,
    onEvent: (ev) => {
      sink.push(ev);
    },
  };
}

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await makeTmpRoot("traework-events");
  vi.resetModules();
});

describe("TraeWork 适配器的细粒度事件（issue #18）", () => {
  it("派发上报一次；运行信号首次出现时上报 file_modification_started 一次", async () => {
    const { runTraeworkTask } = await import("../../src/agents/traework/run.js");
    const state = makeFakeState({
      projectItems: [{ name: "demo", subtitle: "d:\\Trae项目\\demo" }],
      // 第一次探针：运行中（触发 file_modification_started）；之后静止 → 进入完成判定
      livenessSequence: [
        { stopVisible: true, tailLoading: false, thinkingStream: false },
        { stopVisible: false, tailLoading: false, thinkingStream: false },
      ],
      autoReplyText: "已完成登录接口实现",
    });
    const kinds: AgentEventName[] = [];

    const r = await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir }),
      resolved: makeResolved(),
      opts: optsWithEvents(kinds),
      logFile: path.join(tmpDir, "agent-0.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });

    expect(r.ok).toBe(true);
    expect(kinds.filter((k) => k === "task_dispatched")).toHaveLength(1);
    // 多轮运行信号只在首次跃迁时上报一次
    expect(kinds.filter((k) => k === "file_modification_started")).toHaveLength(1);
    expect(kinds).not.toContain("awaiting_user_authorization");
  });

  it("模型发起原生提问（ask_user）→ 上报 awaiting_user_authorization", async () => {
    const { runTraeworkTask } = await import("../../src/agents/traework/run.js");
    const state = makeFakeState({
      projectItems: [{ name: "demo", subtitle: "" }],
      autoReplyText: "正在向用户提问：请确认使用哪个数据库？",
    });
    const kinds: AgentEventName[] = [];

    const r = await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir }),
      resolved: makeResolved(),
      opts: optsWithEvents(kinds),
      logFile: path.join(tmpDir, "agent-1.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });

    expect(r.endReason).toBe("ask_user");
    expect(kinds).toContain("awaiting_user_authorization");
    expect(kinds.filter((k) => k === "awaiting_user_authorization")).toHaveLength(1);
  });

  it("项目绑定经原生「选择文件夹」对话框 → 上报 confirmation_dialog_detected", async () => {
    // 桩化原生对话框模块：下拉未命中，走原生对话框并成功
    vi.doMock("../../src/agents/traework/computeruse/dialog.js", () => ({
      findFolderDialog: async () => ({ found: true, windowTitle: "选择文件夹", processName: "TraeWork", hwnd: 1 }),
      closeStaleFolderDialogs: async () => 0,
      pickFolderViaNativeDialog: async () => ({ ok: true, message: "已选择 demo" }),
      localizeDialogMessage: (m: string) => m,
      toNativeWindowsPath: (p: string) => p,
    }));

    const { runTraeworkTask } = await import("../../src/agents/traework/run.js");
    // 下拉里没有目标项目 → 必然落到原生对话框链路
    const state = makeFakeState({
      projectItems: [{ name: "other-project", subtitle: "" }],
      autoReplyText: "ok",
    });
    const events: { kind: AgentEventName; detail?: string; data?: Record<string, unknown> }[] = [];

    await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir }),
      resolved: makeResolved(),
      opts: optsCapturing(events),
      logFile: path.join(tmpDir, "agent-2.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });

    const dialogs = events.filter((e) => e.kind === "confirmation_dialog_detected");
    expect(dialogs).toHaveLength(1);
    // 事件带 dialog / bound 标识，便于调用方区分哪类原生弹窗以及绑定是否成功
    expect(dialogs[0]!.data).toEqual({ dialog: "source_folder", bound: true });
    expect(dialogs[0]!.detail).toContain("原生「选择文件夹」对话框");
  });

  it("未提供 onEvent 时全程正常（可选能力）", async () => {
    const { runTraeworkTask } = await import("../../src/agents/traework/run.js");
    const state = makeFakeState({
      projectItems: [{ name: "demo", subtitle: "" }],
      autoReplyText: "ok",
    });

    const r = await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-3.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });

    expect(r.ok).toBe(true);
  });

  it("上报钩子抛错不影响任务结果", async () => {
    const { runTraeworkTask } = await import("../../src/agents/traework/run.js");
    const state = makeFakeState({
      projectItems: [{ name: "demo", subtitle: "" }],
      autoReplyText: "ok",
    });

    const r = await runTraeworkTask({
      ctx: makeCtx({ taskDir: tmpDir }),
      resolved: makeResolved(),
      opts: {
        logger: silentLogger,
        onEvent: () => {
          throw new Error("模拟上报失败");
        },
      },
      logFile: path.join(tmpDir, "agent-4.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });

    expect(r.ok).toBe(true);
  });
});
