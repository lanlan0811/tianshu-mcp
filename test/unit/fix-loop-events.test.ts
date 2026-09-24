/**
 * 单元测试：编排器把适配器的 onEvent 上报落进任务事件流（issue #18）。
 *
 * 用一个只实现 run() 的假 GUI 适配器替换真实 agent：适配器内部按真实 codex/traework 的
 * 位置调用 opts.onEvent，验证编排器「只落盘、不解释」的接线以及快照同步。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../../src/tasks/task-store.js";
import { TaskOrchestrator } from "../../src/loop/fix-loop.js";
import { AgentAdapterRegistry } from "../../src/agents/registry.js";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { DataHome } from "../../src/config/store.js";
import { AgentProfileSchema, type AgentProfile } from "../../src/config/schema.js";
import { Logger } from "../../src/util/log.js";
import type {
  AgentAdapter,
  AgentRunOptions,
  AgentRunResult,
  ResolvedAgent,
  SpawnInvocation,
  TaskContext,
} from "../../src/agents/adapter.js";
import type { TaskMeta } from "../../src/tasks/task.js";
import { makeEmitter } from "../../src/agents/agent-events.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rmrf(root)));
});

const FAKE_ID = "fake-gui";

/** 只实现 run() 的假适配器：模拟 codex/traework 在关键节点上报事件 */
class FakeEventAdapter implements AgentAdapter {
  readonly id = FAKE_ID;
  constructor(private readonly emitKinds: string[]) {}

  buildInvocation(): SpawnInvocation {
    throw new Error("fake-gui 不通过 spawn 执行");
  }
  parseExit(res: { ok: boolean; exitCode: number | null; timeout: boolean; killed: boolean; durationMs: number; logFile: string }): AgentRunResult {
    return { ...res };
  }

  async run(ctx: TaskContext, _resolved: ResolvedAgent, opts: AgentRunOptions): Promise<AgentRunResult> {
    // 与真实 codex/traework 适配器一致：经 makeEmitter 上报，上报失败被隔离在本行内。
    const emit = makeEmitter(opts.onEvent);
    for (const kind of this.emitKinds) {
      await emit(kind as never, `detail:${kind}`, { round: ctx.round });
    }
    return {
      ok: true,
      exitCode: 0,
      timeout: false,
      killed: false,
      durationMs: 1,
      logFile: ctx.taskDir + "/agent-0.log",
      endReason: "reply_stable",
      keptInstance: true,
    };
  }
}

async function fixture(emitKinds: string[]) {
  const home = await makeTmpRoot("fix-loop-events");
  roots.push(home);
  const logger = new Logger(null, "error");
  const store = new TaskStore(home, logger);
  const dataHome = new DataHome(home, logger);

  const profile: AgentProfile = AgentProfileSchema.parse({
    displayName: "Fake GUI",
    command: process.execPath,
    driver: "spawn",
  });
  const registry = new AgentAdapterRegistry(async () => ({ [FAKE_ID]: profile }), logger);
  // 先注册自定义适配器：ensureAdapterFor 对「非内置 GUI 类」的既有实例不做替换，
  // 因此自定义 run() 执行面会被保留下来。
  registry.register(FAKE_ID, new FakeEventAdapter(emitKinds));

  const meta: TaskMeta = {
    taskId: "tsk_fake_events",
    status: "queued",
    // 无项目模式：跳过 Git 基线/项目锁/验收，把测试聚焦在事件接线上
    workspaceMode: "default",
    projectPath: "",
    displayPath: "",
    agentId: FAKE_ID,
    task: "事件接线回归",
    autoVerify: false,
    autoFixRounds: 0,
    taskTimeoutMs: 60_000,
    round: 0,
    roundsUsed: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const orchestrator = new TaskOrchestrator(
    {
      store,
      dataHome,
      registry,
      engine: new AcceptanceEngine(store, logger),
      logger,
      buildCtx: (m, round, feedback) => ({
        taskId: m.taskId,
        workspaceMode: m.workspaceMode,
        projectPath: m.projectPath,
        displayPath: m.displayPath,
        agentId: m.agentId,
        task: m.task,
        round,
        feedback,
        taskDir: store.dir(m.taskId),
        workDir: m.projectPath,
        taskTimeoutMs: m.taskTimeoutMs,
      }),
    },
    meta,
  );

  return { store, meta, orchestrator };
}

describe("TaskOrchestrator 的 onEvent 接线（issue #18）", () => {
  it("适配器上报的事件按原样落进 task.jsonl，并可被 query 侧读取", async () => {
    const kinds = [
      "task_dispatched",
      "confirmation_dialog_detected",
      "file_modification_started",
    ];
    const { store, meta, orchestrator } = await fixture(kinds);

    const res = await orchestrator.run();
    expect(res.status).toBe("succeeded");

    const recent = await store.readRecentAgentEvents(meta.taskId, 10);
    expect(recent.map((e) => e.event)).toEqual(kinds);
    // detail/data 原样透传，编排器不做任何改写
    expect(recent.map((e) => e.detail)).toEqual(kinds.map((k) => `detail:${k}`));
    expect(recent[0]!.data).toEqual({ round: 0 });
  });

  it("事件的状态字段取上报时的任务状态（running）", async () => {
    const { store, meta, orchestrator } = await fixture(["task_dispatched"]);
    await orchestrator.run();

    const recent = await store.readRecentAgentEvents(meta.taskId, 5);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.state).toBe("running");
  });

  it("适配器不上报事件时行为不变：事件流里没有细粒度事件", async () => {
    const { store, meta, orchestrator } = await fixture([]);
    const res = await orchestrator.run();

    expect(res.status).toBe("succeeded");
    expect(await store.readRecentAgentEvents(meta.taskId, 10)).toEqual([]);
    // 既有状态事件仍然照常写入——本能力是纯增量
    const all = await store.readEvents(meta.taskId);
    expect(all.some((e) => e.event === "succeeded")).toBe(true);
  });

  it("上报失败不影响任务终态（落盘异常被隔离在 emit 内部）", async () => {
    const { store, orchestrator } = await fixture(["task_dispatched"]);
    // 让 appendEvent 在写细粒度事件时抛错
    const original = store.appendEvent.bind(store);
    vi.spyOn(store, "appendEvent").mockImplementation(async (taskId, event, state, detail, data) => {
      if (event === "task_dispatched") throw new Error("模拟磁盘故障");
      return original(taskId, event, state, detail, data);
    });

    const res = await orchestrator.run();
    expect(res.status).toBe("succeeded");
  });
});
