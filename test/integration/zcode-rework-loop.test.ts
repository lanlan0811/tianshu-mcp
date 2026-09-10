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
  gui: { defaultAutoFixRounds: 2 },
});

async function project(): Promise<string> {
  const dir = await makeTmpRoot("zcode-rework-project");
  cleanup.push(dir);
  fs.mkdirSync(path.join(dir, ".tianshu-mcp"));
  fs.writeFileSync(
    path.join(dir, "check.mjs"),
    "import fs from 'node:fs'; if(!fs.existsSync('done.txt')||fs.readFileSync('done.txt','utf8').trim()!=='PASS')process.exit(1);",
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, ".tianshu-mcp", "acceptance.json"),
    JSON.stringify({ checks: [{ name: "done", cmd: ["node", "check.mjs"] }] }),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "README.md"), "baseline", "utf8");
  await gitInitAndCommit(dir);
  return dir;
}

class RepairAdapter extends ZcodeGuiAdapter {
  calls: TaskContext[] = [];
  constructor(
    private readonly projectPath: string,
    private readonly passOnRepair: boolean,
  ) {
    super("zcode");
  }
  override async run(
    ctx: TaskContext,
    _resolved: ResolvedAgent,
    _opts: AgentRunOptions,
  ): Promise<AgentRunResult> {
    this.calls.push(structuredClone(ctx));
    if (ctx.round > 0 && this.passOnRepair)
      fs.writeFileSync(path.join(this.projectPath, "done.txt"), "PASS", "utf8");
    return {
      ok: true,
      exitCode: 0,
      timeout: false,
      killed: false,
      durationMs: 1,
      logFile: path.join(ctx.taskDir, `agent-${ctx.round}.log`),
      keptInstance: true,
      session: {
        id: "repair-session",
        title: "原任务",
        boundProjectPath: ctx.projectPath,
        provider: "DeepSeek",
        model: "deepseek-flash",
        permissionMode: "完全访问",
      },
    };
  }
}

async function harness(projectPath: string, passOnRepair: boolean) {
  const home = await makeTmpRoot("zcode-rework-home");
  cleanup.push(home);
  const data = new DataHome(home, logger, { zcode: profile });
  await data.init();
  const store = new TaskStore(home, logger);
  const registry = new AgentAdapterRegistry(() => data.loadProfiles(), logger);
  const adapter = new RepairAdapter(projectPath, passOnRepair);
  registry.register("zcode", adapter);
  const manager = new TaskManager(
    store,
    data,
    registry,
    new AcceptanceEngine(store, logger),
    logger,
    makeBuildCtx({ store, dataHome: data }),
  );
  await manager.initialize(1);
  return { manager, store, adapter };
}

async function waitTerminal(manager: TaskManager, taskId: string) {
  for (let i = 0; i < 500; i++) {
    const meta = await manager.getMeta(taskId);
    if (
      meta &&
      ["succeeded", "failed", "needs_attention"].includes(meta.status) &&
      manager.activeCount === 0
    )
      return meta;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待终态超时");
}

describe("ZCode 自动验收返修", () => {
  it("失败后生成任务目录计划并在原会话返修通过", async () => {
    const dir = await project();
    const h = await harness(dir, true);
    const task = await h.manager.submit({
      projectPath: normPath(dir),
      displayPath: dir,
      agentId: "zcode",
      task: "生成 done.txt",
      model: "DeepSeek/deepseek-flash",
      autoVerify: true,
      autoFixRounds: 2,
      taskTimeoutMs: 30_000,
    });
    const final = await waitTerminal(h.manager, task.taskId);
    expect(final.status).toBe("succeeded");
    expect(h.adapter.calls).toHaveLength(2);
    expect(h.adapter.calls[1]?.resume).toMatchObject({
      kind: "rework",
      sessionId: "repair-session",
      boundProjectPath: normPath(dir),
    });
    const plan = path.join(h.store.dir(task.taskId), `rework-${task.taskId}-r0.md`);
    expect(fs.existsSync(plan)).toBe(true);
    expect(h.adapter.calls[1]?.feedback).toContain(plan);
    expect(h.adapter.calls[1]?.feedback).toContain(h.store.reportMdPath(task.taskId, 0));
    expect(fs.existsSync(path.join(dir, ".tianshu-mcp", path.basename(plan)))).toBe(false);
  });

  it("两轮自动返修耗尽后进入 needs_attention", async () => {
    const dir = await project();
    const h = await harness(dir, false);
    const task = await h.manager.submit({
      projectPath: normPath(dir),
      displayPath: dir,
      agentId: "zcode",
      task: "生成 done.txt",
      model: "DeepSeek/deepseek-flash",
      autoVerify: true,
      autoFixRounds: 2,
      taskTimeoutMs: 30_000,
    });
    const final = await waitTerminal(h.manager, task.taskId);
    expect(final.status).toBe("needs_attention");
    expect(h.adapter.calls).toHaveLength(3);
    expect(final.roundsUsed).toBe(3);
    expect(fs.existsSync(path.join(h.store.dir(task.taskId), `rework-${task.taskId}-r1.md`))).toBe(
      true,
    );
  });

  it("手动返修缺少原会话时 fail-closed", async () => {
    const dir = await project();
    const h = await harness(dir, false);
    const task = await h.manager.submit({
      projectPath: normPath(dir),
      displayPath: dir,
      agentId: "zcode",
      task: "开发",
      model: "DeepSeek/deepseek-flash",
      autoVerify: true,
      autoFixRounds: 0,
      taskTimeoutMs: 30_000,
    });
    await waitTerminal(h.manager, task.taskId);
    const meta = await h.manager.getMeta(task.taskId);
    delete meta!.zcodeSessionId;
    delete meta!.zcodeSessionTitle;
    await h.manager.persistMetaUpdate(meta!);
    expect(await h.manager.rework(task.taskId, "继续")).toMatchObject({ found: false });
  });
});
