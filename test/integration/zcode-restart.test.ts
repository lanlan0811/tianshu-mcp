import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AgentProfileSchema } from "../../src/config/schema.js";
import { ZcodeGuiAdapter } from "../../src/agents/zcode/adapter.js";
import type {
  AgentRunOptions,
  AgentRunResult,
  ResolvedAgent,
  TaskContext,
} from "../../src/agents/adapter.js";
import { AgentAdapterRegistry } from "../../src/agents/registry.js";
import { DataHome } from "../../src/config/store.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { makeBuildCtx } from "../../src/mcp/context.js";
import { Logger } from "../../src/util/log.js";
import { gitInitAndCommit, makeTmpRoot, rmrf } from "../test-utils.js";
import { normPath } from "../../src/util/path.js";

const logger = new Logger(null, "error");
const cleanup: string[] = [];
afterAll(async () => {
  for (const dir of cleanup) await rmrf(dir);
});

const profile = AgentProfileSchema.parse({
  displayName: "ZCode test",
  driver: "gui",
  adapter: "zcode-gui",
  status: "ready",
  command: process.execPath,
});
const common = (ctx: TaskContext) => ({
  exitCode: 0,
  timeout: false,
  killed: false,
  durationMs: 1,
  logFile: path.join(ctx.taskDir, `agent-${ctx.round}.log`),
  keptInstance: true,
});

class AskAdapter extends ZcodeGuiAdapter {
  override async run(
    ctx: TaskContext,
    _resolved: ResolvedAgent,
    _opts: AgentRunOptions,
  ): Promise<AgentRunResult> {
    return {
      ok: false,
      ...common(ctx),
      needsUserKind: "agent_question",
      pendingQuestion: "继续使用 SQLite 吗？",
      session: {
        id: "session-restart",
        title: "原始任务",
        boundProjectPath: ctx.projectPath,
        provider: "DeepSeek",
        model: "deepseek-flash",
        permissionMode: "完全访问",
      },
    };
  }
}

class FinishAdapter extends ZcodeGuiAdapter {
  context?: TaskContext;
  override async run(
    ctx: TaskContext,
    _resolved: ResolvedAgent,
    _opts: AgentRunOptions,
  ): Promise<AgentRunResult> {
    this.context = structuredClone(ctx);
    return { ok: true, ...common(ctx) };
  }
}

async function waitStatus(manager: TaskManager, taskId: string, status: string) {
  for (let i = 0; i < 200; i++) {
    const meta = await manager.getMeta(taskId);
    if (meta?.status === status && manager.activeCount === 0) return meta;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`任务 ${taskId} 未到 ${status}`);
}

describe("ZCode needs_user 重启恢复", () => {
  it("服务重启后保留暂停状态、Git 基线与原会话路由", async () => {
    const project = await makeTmpRoot("zcode-restart-project");
    cleanup.push(project);
    fs.writeFileSync(path.join(project, "README.md"), "baseline");
    await gitInitAndCommit(project);
    const home = await makeTmpRoot("zcode-restart-home");
    cleanup.push(home);
    const data = new DataHome(home, logger, { zcode: profile });
    await data.init();
    const store = new TaskStore(home, logger);
    const registry1 = new AgentAdapterRegistry(() => data.loadProfiles(), logger);
    registry1.register("zcode", new AskAdapter("zcode"));
    const manager1 = new TaskManager(
      store,
      data,
      registry1,
      new AcceptanceEngine(store, logger),
      logger,
      makeBuildCtx({ store, dataHome: data }),
    );
    await manager1.initialize(1);
    const task = await manager1.submit({
      projectPath: normPath(project),
      displayPath: project,
      agentId: "zcode",
      task: "开发",
      model: "DeepSeek/deepseek-flash",
      autoVerify: false,
      autoFixRounds: 2,
      taskTimeoutMs: 10_000,
    });
    await waitStatus(manager1, task.taskId, "needs_user");
    const baselineBefore = fs.readFileSync(store.baselinePath(task.taskId), "utf8");
    await manager1.shutdownInterrupt();

    const registry2 = new AgentAdapterRegistry(() => data.loadProfiles(), logger);
    const finish = new FinishAdapter("zcode");
    registry2.register("zcode", finish);
    const manager2 = new TaskManager(
      store,
      data,
      registry2,
      new AcceptanceEngine(store, logger),
      logger,
      makeBuildCtx({ store, dataHome: data }),
    );
    await manager2.initialize(1);
    expect((await manager2.getMeta(task.taskId))?.status).toBe("needs_user");
    expect((await manager2.continueTask(task.taskId, "是，继续 SQLite")).found).toBe(true);
    await waitStatus(manager2, task.taskId, "succeeded");
    expect(finish.context?.resume).toMatchObject({
      kind: "continue",
      sendMessage: true,
      message: "是，继续 SQLite",
      sessionId: "session-restart",
      boundProjectPath: normPath(project),
      provider: "DeepSeek",
      model: "DeepSeek/deepseek-flash",
      permissionMode: "完全访问",
    });
    expect(fs.readFileSync(store.baselinePath(task.taskId), "utf8")).toBe(baselineBefore);
  });
});
