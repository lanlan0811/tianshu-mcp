/**
 * issue #12：无项目（default 工作区）任务的编排分流。
 *
 * 用「失败即报错」的验收替身 + 文件系统证据，证明 default 模式**没有**进入项目基础设施
 * （Git 基线 / 项目快照 / 项目锁 / 项目验收），并用真实临时项目做对照，防止「按模式分流」
 * 被写成「所有模式都跳过」。
 */
import { afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { TaskOrchestrator } from "../../src/loop/fix-loop.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { Logger } from "../../src/util/log.js";
import type { TaskMeta } from "../../src/tasks/task.js";
import type { TaskContext } from "../../src/agents/adapter.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

const logger = new Logger(null, "error");
const cleanup: string[] = [];
afterAll(async () => {
  for (const dir of cleanup) await rmrf(dir);
});

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function makeOrchestrator(workspaceMode: "project" | "default") {
  const home = await makeTmpRoot(`ws-home-${workspaceMode}`);
  const project = await makeTmpRoot(`ws-project-${workspaceMode}`);
  cleanup.push(home, project);
  const store = new TaskStore(home, logger);
  const now = new Date().toISOString();
  const meta: TaskMeta = {
    taskId: "tsk_ws_mode",
    workspaceMode,
    projectPath: workspaceMode === "project" ? project : "",
    displayPath: workspaceMode === "project" ? project : "",
    agentId: "zcode",
    task: "做点事",
    autoVerify: false,
    autoFixRounds: 0,
    taskTimeoutMs: 30_000,
    round: 0,
    roundsUsed: 0,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  const calls: string[] = [];
  const engine = {
    runVerify: async () => {
      calls.push("runVerify");
      throw new Error("无项目模式不得进入项目验收");
    },
  };
  const adapter = {
    id: "zcode",
    buildInvocation: () => {
      throw new Error("GUI adapter 不走 spawn");
    },
    parseExit: () => ({
      ok: true,
      exitCode: 0,
      timeout: false,
      killed: false,
      durationMs: 1,
      logFile: "x",
    }),
    run: async (ctx: TaskContext) => {
      calls.push("agentRun");
      return {
        ok: true,
        exitCode: 0,
        timeout: false,
        killed: false,
        durationMs: 5,
        logFile: path.join(ctx.taskDir, "agent-0.log"),
        endReason: "reply_stable",
        keptInstance: true,
      };
    },
  };
  const registry = {
    resolve: async (id: string) => ({
      id,
      displayName: "stub",
      profile: {},
      command: "stub",
      argsTemplate: [],
      ok: true,
      message: "test",
    }),
    getAdapter: () => adapter,
  };
  const dataHome = {
    projectByPath: async () => ({ record: undefined }),
    loadConfig: async () => ({}),
  };
  const buildCtx = (m: TaskMeta, round: number): TaskContext => ({
    taskId: m.taskId,
    workspaceMode: m.workspaceMode,
    projectPath: m.projectPath,
    displayPath: m.displayPath,
    agentId: m.agentId,
    task: m.task,
    round,
    taskDir: store.dir(m.taskId),
    workDir: m.projectPath,
    taskTimeoutMs: m.taskTimeoutMs,
  });
  const orchestrator = new TaskOrchestrator(
    { store, dataHome, registry, engine, logger, buildCtx } as never,
    meta,
  );
  return { orchestrator, meta, store, calls };
}

describe("无项目任务编排分流（issue #12）", () => {
  it("default 模式跳过 Git 基线与项目验收，成功且明示未验收", async () => {
    const { orchestrator, meta, store, calls } = await makeOrchestrator("default");
    const res = await orchestrator.run();
    expect(res.status).toBe("succeeded");
    expect(res.summary).toMatch(/未进行项目验收/);
    // 失败即报错的替身：runVerify 一次都没被调用。
    expect(calls).toEqual(["agentRun"]);
    const dir = store.dir(meta.taskId);
    expect(await exists(path.join(dir, "baseline.json"))).toBe(false);
    expect(await exists(path.join(dir, "visual-snapshot.json"))).toBe(false);
    const files = await fsp.readdir(dir);
    expect(files.some((f) => f.startsWith("report-"))).toBe(false);
  });

  it("default 模式携带 pendingVisualVerification 时报告不一致，不进入视觉返修", async () => {
    const { orchestrator, meta, store, calls } = await makeOrchestrator("default");
    meta.pendingVisualVerification = true;
    const res = await orchestrator.run();
    expect(res.status).toBe("needs_attention");
    expect(res.summary).toMatch(/不一致/);
    expect(calls).not.toContain("runVerify");
    expect(await exists(path.join(store.dir(meta.taskId), "report-0.md"))).toBe(false);
  });

  it("有项目模式仍然采集基线并进入验收（对照：分流不等于全都跳过）", async () => {
    const { orchestrator, meta, store, calls } = await makeOrchestrator("project");
    meta.autoVerify = true;
    await orchestrator.run();
    expect(calls).toContain("agentRun");
    expect(calls).toContain("runVerify");
    expect(await exists(path.join(store.dir(meta.taskId), "baseline.json"))).toBe(true);
    expect(await exists(path.join(store.dir(meta.taskId), "visual-snapshot.json"))).toBe(true);
  });
});
