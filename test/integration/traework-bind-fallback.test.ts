/**
 * 集成测试：项目只在目标模式内绑定（issue #35）。
 *
 * Work/Code/Design 各自维护独立的项目绑定，目标模式绑定失败时应保留该模式，
 * 不再切到 Work 重复尝试。本测试用假 CDP + 桩化 dialog 验证模式与尝试次数；
 * 原生窗口的真实唤起行为仍需真机验证。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "node:path";
import { rm } from "node:fs/promises";
import { makeTmpRoot } from "../test-utils.js";
import { FakeCdpClient, makeFakeState, type FakeDomState } from "../fake-cdp.js";
import { type TraeworkRunDeps } from "../../src/agents/traework/run.js";
import type { TaskContext, ResolvedAgent, AgentRunLogger } from "../../src/agents/adapter.js";

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
    taskId: "tsk_bind_fallback",
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

/** 假 CDP：下拉始终未命中；footer 可点但原生对话框不出现（模拟 Code 模式故障） */
function makeDeps(state: FakeDomState): TraeworkRunDeps {
  return {
    createClient: () => new FakeCdpClient(9222, state) as never,
    probeReady: async (port) => ({ port, title: "TraeWork CN" }),
    launch: () => {
      throw new Error("测试应复用实例");
    },
    waitReady: async (port) => ({ port, title: "TraeWork CN" }),
    release: async () => ({ released: true, reason: "已终止" }),
    resolvePort: async (gui) => gui.cdpPort,
    // 钳到 2ms 的真实 sleep：保留事件循环语义（纯微任务 no-op 会饿死 timers 阶段）
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
    // findFolderDialog 桩恒为「未出现」时，waitDialogAppeared 的死线是 Date.now() 墙钟，
    // no-op sleep 压不动；把生产 20s 的出现等待钳到 100ms
    dialogWaitTimeoutMs: 100,
  };
}

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await makeTmpRoot("traework-bind-fallback");
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock("../../src/agents/traework/computeruse/dialog.js");
  await rm(tmpDir, { recursive: true, force: true });
});

describe("bindProject 的目标模式内绑定（issue #35）", () => {
  it.each(["Code", "Design"] as const)("%s 目标项目未命中且原生对话框未弹出 → 保留目标模式，只尝试一次", async (mode) => {
    const findDialog = vi.fn(async () => ({ found: false, windowTitle: "", processName: "", hwnd: 0 }));
    const closeDialogs = vi.fn(async () => 0);
    const pickFolder = vi.fn(async () => ({ ok: false, message: "未检测到原生对话框" }));
    vi.doMock("../../src/agents/traework/computeruse/dialog.js", () => ({
      findFolderDialog: findDialog,
      closeStaleFolderDialogs: closeDialogs,
      pickFolderViaNativeDialog: pickFolder,
      localizeDialogMessage: (m: string) => m,
      toNativeWindowsPath: (p: string) => p,
    }));

    const { runTraeworkTask: run } = await import("../../src/agents/traework/run.js");
    // 保持下拉可展开，但不包含目标项目，确保实际走到原生对话框唤起阶段。
    const state = makeFakeState({ mode, projectItems: [{ name: "other-project", subtitle: "" }] });
    const r = await run({
      ctx: makeCtx({ taskDir: tmpDir, mode }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-0.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });

    expect(r.ok).toBe(false);
    expect(r.hardFailure).toBe(true);
    // 绑定是 mode-scoped：失败即在目标模式内如实失败，不再回落 Work（issue #35）
    expect(r.error).toContain("项目文件夹绑定失败");
    expect(state.mode).toBe(mode);
    expect(state.boundProject).toBeNull();
    expect(closeDialogs).toHaveBeenCalledTimes(1);
    expect(state.clicked.filter((key) => key === "cascadeMenuFooter")).toHaveLength(1);
    expect(findDialog).toHaveBeenCalled();
    expect(pickFolder).not.toHaveBeenCalled();
    expect(r.error).not.toContain("Work 模式亦失败");
  });

  it("仅在下拉未命中、真正要走原生对话框时才清理遗留对话框", async () => {
    const closeCalls: number[] = [];
    vi.doMock("../../src/agents/traework/computeruse/dialog.js", () => ({
      findFolderDialog: async () => ({ found: false, windowTitle: "", processName: "", hwnd: 0 }),
      closeStaleFolderDialogs: async () => {
        closeCalls.push(Date.now());
        return 0;
      },
      pickFolderViaNativeDialog: async () => ({ ok: false, message: "未检测到原生对话框" }),
      localizeDialogMessage: (m: string) => m,
      toNativeWindowsPath: (p: string) => p,
    }));
    const { runTraeworkTask: run } = await import("../../src/agents/traework/run.js");
    // 下拉能展开但**不含目标项目** → 未命中 → 应触发清理
    const state = makeFakeState({ projectItems: [{ name: "other-project", subtitle: "" }] });
    const r = await run({
      ctx: makeCtx({ taskDir: tmpDir, mode: "Work" }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-2.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });
    expect(r.ok).toBe(false);
    expect(closeCalls.length).toBe(1);
  });

  it("Work 目标绑定失败时不重复尝试，保留 Work 模式", async () => {
    const closeDialogs = vi.fn(async () => 0);
    vi.doMock("../../src/agents/traework/computeruse/dialog.js", () => ({
      findFolderDialog: async () => ({ found: false, windowTitle: "", processName: "", hwnd: 0 }),
      closeStaleFolderDialogs: closeDialogs,
      pickFolderViaNativeDialog: async () => ({ ok: false, message: "未检测到原生对话框" }),
      localizeDialogMessage: (m: string) => m,
      toNativeWindowsPath: (p: string) => p,
    }));
    const { runTraeworkTask: run } = await import("../../src/agents/traework/run.js");
    const state = makeFakeState({ projectItems: [{ name: "other-project", subtitle: "" }] });
    const r = await run({
      ctx: makeCtx({ taskDir: tmpDir, mode: "Work" }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-1.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state),
    });
    expect(r.ok).toBe(false);
    // 只报一次失败，不应出现「Work 模式亦失败」的双重措辞
    expect(r.error).not.toContain("Work 模式亦失败");
    expect(state.mode).toBe("Work");
    expect(closeDialogs).toHaveBeenCalledTimes(1);
    expect(state.clicked.filter((key) => key === "cascadeMenuFooter")).toHaveLength(1);
  });

  it("下拉命中目标项目 → 在目标模式内直接绑定成功（无需跨模式兜底）", async () => {
    const closeDialogs = vi.fn(async () => 0);
    const pickFolder = vi.fn(async () => ({ ok: false, message: "不应走原生对话框" }));
    vi.doMock("../../src/agents/traework/computeruse/dialog.js", () => ({
      findFolderDialog: vi.fn(async () => ({ found: false, windowTitle: "", processName: "", hwnd: 0 })),
      closeStaleFolderDialogs: closeDialogs,
      pickFolderViaNativeDialog: pickFolder,
    }));
    const { bindProject } = await import("../../src/agents/traework/ui/session.js");
    const state = makeFakeState({
      projectItems: [{ name: "demo", subtitle: "d:/trae项目/demo" }],
      mode: "Code",
    });
    const cdp = new FakeCdpClient(9222, state) as never;
    const r = await bindProject(cdp as never, "d:/trae项目/demo", {
      logger: silentLogger,
      mode: "Code",
      sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 2))),
    });
    expect(r.bound).toBe(true);
    expect(r.method).toBe("dropdown");
    expect(state.mode).toBe("Code");
    expect(state.boundProject).toBe("demo");
    expect(state.clicked).not.toContain("cascadeMenuFooter");
    expect(closeDialogs).not.toHaveBeenCalled();
    expect(pickFolder).not.toHaveBeenCalled();
  });
});
