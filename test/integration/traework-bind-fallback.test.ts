/**
 * 集成测试：项目绑定的 Code→Work 兜底（开发计划 M5+ 修复）。
 *
 * 背景（实测 2026-09-08）：`mode=Code` 时「选择文件夹」链路可能失败（下拉未命中 +
 * 原生对话框未弹出）。修复后 bindProject 会回落 Work 模式重试一次，成功后再切回 Code。
 * 本测试用假 CDP + 桩化 dialog 模块验证该兜底路径，不依赖真机。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
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
function makeDeps(state: FakeDomState, dialogFound: () => boolean): TraeworkRunDeps {
  return {
    createClient: () => new FakeCdpClient(9222, state) as never,
    probeReady: async (port) => ({ port, title: "TraeWork CN" }),
    launch: () => {
      throw new Error("测试应复用实例");
    },
    waitReady: async (port) => ({ port, title: "TraeWork CN" }),
    release: () => ({ released: true, reason: "已终止" }),
    resolvePort: async (gui) => gui.cdpPort,
  };
  void dialogFound;
}

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await makeTmpRoot("traework-bind-fallback");
  vi.resetModules();
});

describe("bindProject 的 Code→Work 兜底", () => {
  it("下拉未命中且原生对话框未弹出 → 明确失败，且错误信息含两种模式的失败原因", async () => {
    // 桩化 dialog 模块：findFolderDialog 恒为「未出现」，pickFolderViaNativeDialog 走真实逻辑
    vi.doMock("../../src/agents/traework/computeruse/dialog.js", () => ({
      findFolderDialog: async () => ({ found: false, windowTitle: "", processName: "", hwnd: 0 }),
      closeStaleFolderDialogs: async () => 0,
      pickFolderViaNativeDialog: async () => ({ ok: false, message: "未检测到原生「选择文件夹」对话框（TraeWork 未弹出或已关闭；请检查下拉底部按钮是否被点到）" }),
      localizeDialogMessage: (m: string) => m,
      toNativeWindowsPath: (p: string) => p,
    }));

    const { runTraeworkTask: run } = await import("../../src/agents/traework/run.js");
    const state = makeFakeState({ projectItems: [] }); // 下拉为空 → 必然未命中
    const r = await run({
      ctx: makeCtx({ taskDir: tmpDir, mode: "Code" }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-0.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state, () => false),
    });

    expect(r.ok).toBe(false);
    expect(r.hardFailure).toBe(true);
    // 应体现「Code 模式失败 + Work 模式亦失败」的兜底信息
    expect(r.error).toContain("项目文件夹绑定失败");
    expect(r.error).toContain("Work");
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
      deps: makeDeps(state, () => false),
    });
    expect(r.ok).toBe(false);
    expect(closeCalls.length).toBe(1);
  });

  it("Work 模式兜底不适用于 Work 目标（不重复尝试）", async () => {
    vi.doMock("../../src/agents/traework/computeruse/dialog.js", () => ({
      findFolderDialog: async () => ({ found: false, windowTitle: "", processName: "", hwnd: 0 }),
      closeStaleFolderDialogs: async () => 0,
      pickFolderViaNativeDialog: async () => ({ ok: false, message: "未检测到原生对话框" }),
      localizeDialogMessage: (m: string) => m,
      toNativeWindowsPath: (p: string) => p,
    }));
    const { runTraeworkTask: run } = await import("../../src/agents/traework/run.js");
    const state = makeFakeState({ projectItems: [] });
    const r = await run({
      ctx: makeCtx({ taskDir: tmpDir, mode: "Work" }),
      resolved: makeResolved(),
      opts: { logger: silentLogger },
      logFile: path.join(tmpDir, "agent-1.log"),
      startedAt: Date.now(),
      logger: silentLogger,
      deps: makeDeps(state, () => false),
    });
    expect(r.ok).toBe(false);
    // 只报一次失败，不应出现「Work 模式亦失败」的双重措辞
    expect(r.error).not.toContain("Work 模式亦失败");
  });
});
