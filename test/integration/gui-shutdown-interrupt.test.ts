/**
 * 集成测试（issue #14）：server 退出 / 重启归档路径对 GUI agent 的终态如实化。
 *
 * 立论：`driver="gui"` 的 agent 是外部桌面应用，server 对其进程没有所有权，abort 后至多
 * "尽力点击界面停止"。因此 interrupted 终态必须如实说明是否**已确认**停止：
 *  - 已确认空闲 → 可以说"已确认 … 内运行停止"；
 *  - 未确认 / 无停止结果（ZCode、TraeWork 无停止能力）→ 必须明示"窗口中的任务可能仍在继续"，
 *    且绝不出现只对 spawn 子进程成立的"进程已终止"。
 * 重启归档额外置 `guiResidualUnconfirmed`（此刻无任何连接可确认），并由 cancel_task 确认清除。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DataHome } from "../../src/config/store.js";
import { BUILTIN_PROFILES } from "../../src/agents/builtin.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { AgentAdapterRegistry } from "../../src/agents/registry.js";
import { CodexGuiAdapter } from "../../src/agents/codex/adapter.js";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { makeBuildCtx } from "../../src/mcp/context.js";
import { Logger } from "../../src/util/log.js";
import { normPath } from "../../src/util/path.js";
import { makeGitProject, rmrf } from "../test-utils.js";
import type { AgentAdapter, AgentRunResult } from "../../src/agents/adapter.js";
import type { TaskMeta } from "../../src/tasks/task.js";

type AbortScript = { kind: "noResult" } | { kind: "idle"; idle: boolean };

/**
 * 受控 GUI adapter：只在收到 abort 时按剧本返回 guiStop，模拟适配器的停止结果（或缺失）。
 * 必须**继承真实 CodexGuiAdapter**：`AgentAdapterRegistry.ensureAdapterFor()` 按实现类判定，
 * 非本类的注册会被 GUI adapter 重建覆盖（见 registry.ts:52），注入就失效了。
 */
class ScriptedCodexAdapter extends CodexGuiAdapter {
  constructor(private readonly script: AbortScript) {
    super("codex");
  }

  override async run(
    _ctx: unknown,
    _resolved: unknown,
    opts: { signal?: AbortSignal },
  ): Promise<AgentRunResult> {
    const signal = opts.signal;
    if (!signal) throw new Error("GUI adapter 需要 abort signal");
    if (!signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    const base: Partial<AgentRunResult> = {
      ok: false,
      exitCode: null,
      timeout: false,
      killed: true,
      endReason: "aborted",
      durationMs: 1,
      logFile: "",
    };
    if (this.script.kind === "idle") {
      return { ...base, guiStop: { clicked: true, idle: this.script.idle } } as AgentRunResult;
    }
    return base as AgentRunResult;
  }
}

/**
 * 受控 spawn adapter：用于验证 spawn 路径文案零回归（仍断言"进程已终止"）。
 * 走通用 CliAdapter 实现（非 GUI 类），注册后不会被 ensureAdapterFor 重建。
 */
class HangingCliAdapter implements AgentAdapter {
  readonly id = "stub";
  buildInvocation(): never {
    throw new Error("测试走自定义 run 执行面，不构造命令");
  }
  parseExit(): never {
    throw new Error("测试走自定义 run 执行面，不解析退出码");
  }
  async run(
    _ctx: unknown,
    _resolved: unknown,
    opts: { signal?: AbortSignal },
  ): Promise<AgentRunResult> {
    if (opts.signal && !opts.signal.aborted) {
      await new Promise<void>((resolve) => {
        opts.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    return {
      ok: false,
      exitCode: null,
      timeout: false,
      killed: true,
      endReason: "aborted",
      durationMs: 1,
      logFile: "",
    };
  }
}

let logger: Logger;
let home: string;
const cleanup: string[] = [];

beforeAll(async () => {
  home = path.join(process.env.TEMP ?? "/tmp", `tianshu-issue14-${Date.now()}`);
  fs.mkdirSync(home, { recursive: true });
  logger = await Logger.create(path.join(home, "logs"));
});

afterAll(async () => {
  await rmrf(home).catch(() => {});
  for (const d of cleanup) await rmrf(d).catch(() => {});
});

async function makeManager(
  adapter: CodexGuiAdapter,
  guiStopWaitMs: number,
): Promise<{ manager: TaskManager; project: string }> {
  const data = new DataHome(home, logger, BUILTIN_PROFILES);
  await data.init();
  const store = new TaskStore(home, logger);
  const registry = new AgentAdapterRegistry(() => data.loadProfiles(), logger);
  const manager = new TaskManager(
    store,
    data,
    registry,
    new AcceptanceEngine(store, logger),
    logger,
    makeBuildCtx({ store, dataHome: data }),
  );
  await manager.initialize({ maxRunning: 1, guiStopWaitMs });
  // 注册脚本 adapter 覆盖内置实现（ScriptedCodexAdapter 继承 CodexGuiAdapter，
  // 因此 ensureAdapterFor 不会再重建替换它）
  registry.register("codex", adapter);
  const project = await makeGitProject("good");
  cleanup.push(project);
  return { manager, project };
}

async function submitGuiTask(manager: TaskManager, project: string): Promise<TaskMeta> {
  return manager.submit({
    projectPath: normPath(project),
    displayPath: project,
    agentId: "codex",
    task: "GUI 停止语义验证（issue #14）",
    autoVerify: false,
    autoFixRounds: 0,
    taskTimeoutMs: 60_000,
  });
}

async function waitFor(
  manager: TaskManager,
  taskId: string,
  predicate: (m: TaskMeta | null) => boolean,
  timeoutMs = 10_000,
): Promise<TaskMeta> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const meta = await manager.getMeta(taskId);
    if (meta && predicate(meta)) return meta;
    if (Date.now() > deadline) throw new Error(`等待条件超时（taskId=${taskId}）`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("issue #14：GUI 任务的 shutdown/重启终态不得谎报已停止", () => {
  it("shutdown：适配器回报 idle=true → 明示已确认停止，且 interruptedCleanStop=true", async () => {
    const { manager, project } = await makeManager(
      new ScriptedCodexAdapter({ kind: "idle", idle: true }),
      5_000,
    );
    const task = await submitGuiTask(manager, project);
    await waitFor(manager, task.taskId, (m) => m?.status === "running");
    await manager.shutdownInterrupt();

    const meta = await manager.getMeta(task.taskId);
    expect(meta?.status).toBe("interrupted");
    expect(meta?.errorType).toBe("interrupted");
    expect(meta?.abortSource).toBe("shutdown");
    expect(meta?.interruptedCleanStop).toBe(true);
    expect(meta?.guiStop).toEqual({ clicked: true, idle: true });
    expect(meta?.lastMessage).toContain("已确认 Codex 内运行停止");
    expect(meta?.lastMessage).not.toContain("进程已终止");
    expect(meta?.lastMessage).not.toContain("可能仍在继续");
  }, 30_000);

  it("shutdown：适配器点击过但未确认空闲 → 明示未确认停止 + 请人工检查", async () => {
    const { manager, project } = await makeManager(
      new ScriptedCodexAdapter({ kind: "idle", idle: false }),
      5_000,
    );
    const task = await submitGuiTask(manager, project);
    await waitFor(manager, task.taskId, (m) => m?.status === "running");
    await manager.shutdownInterrupt();

    const meta = await manager.getMeta(task.taskId);
    expect(meta?.status).toBe("interrupted");
    expect(meta?.interruptedCleanStop).toBe(false);
    expect(meta?.lastMessage).toContain("未确认停止");
    expect(meta?.lastMessage).toContain("窗口中的任务可能仍在继续");
    expect(meta?.lastMessage).toContain("请人工打开 Codex 确认无残留运行");
    expect(meta?.lastMessage).not.toContain("进程已终止");
  }, 30_000);

  it("shutdown：适配器未回报停止结果（无停止能力/未及尝试）→ 不得声称已停止", async () => {
    const { manager, project } = await makeManager(
      new ScriptedCodexAdapter({ kind: "noResult" }),
      5_000,
    );
    const task = await submitGuiTask(manager, project);
    await waitFor(manager, task.taskId, (m) => m?.status === "running");
    await manager.shutdownInterrupt();

    const meta = await manager.getMeta(task.taskId);
    expect(meta?.status).toBe("interrupted");
    expect(meta?.interruptedCleanStop).toBe(false);
    expect(meta?.lastMessage).toContain("无停止结果可确认");
    expect(meta?.lastMessage).toContain("窗口中的任务可能仍在继续");
    expect(meta?.lastMessage).not.toContain("已确认");
    expect(meta?.lastMessage).not.toContain("进程已终止");
  }, 30_000);

  it("重启归档：遗留 GUI 任务置 guiResidualUnconfirmed + 人工检查文案，并以 cancel_task 确认清除", async () => {
    // 手工造遗留 running 快照（真实重启场景：上一进程被 kill，来不及落终态）
    const data = new DataHome(home, logger, BUILTIN_PROFILES);
    await data.init();
    const store = new TaskStore(home, logger);
    const taskId = `tsk_issue14_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const legacy: TaskMeta = {
      taskId,
      projectPath: "",
      displayPath: "",
      workspaceMode: "default",
      agentId: "codex",
      task: "遗留 GUI 任务",
      autoVerify: false,
      autoFixRounds: 0,
      taskTimeoutMs: 60_000,
      round: 0,
      roundsUsed: 0,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.writeSnapshot(legacy);

    const manager = new TaskManager(
      store,
      data,
      new AgentAdapterRegistry(() => data.loadProfiles(), logger),
      new AcceptanceEngine(store, logger),
      logger,
      makeBuildCtx({ store, dataHome: data }),
    );
    await manager.initialize({ maxRunning: 1, guiStopWaitMs: 200 });

    const archived = await manager.getMeta(taskId);
    expect(archived?.status).toBe("interrupted");
    expect(archived?.errorType).toBe("interrupted");
    expect(archived?.guiResidualUnconfirmed).toBe(true);
    expect(archived?.interruptedCleanStop).toBe(false);
    expect(archived?.lastMessage).toContain("server 重启遗留");
    expect(archived?.lastMessage).toContain("请人工打开 Codex 确认无残留运行");
    expect(archived?.lastMessage).not.toContain("进程已终止");

    // 人工确认：cancel_task 清除待确认标记，但绝不改写终态
    const res = await manager.cancel(taskId, "已人工核对 Codex 窗口无残留运行");
    expect(res.cleared).toBe(true);
    const acked = await manager.getMeta(taskId);
    expect(acked?.status).toBe("interrupted");
    expect(acked?.errorType).toBe("interrupted");
    expect(acked?.guiResidualUnconfirmed).toBe(false);
    expect(acked?.lastMessage).toContain("已确认人工核查（Codex）无残留运行");
    const events = await store.readEvents(taskId);
    expect(events.some((e) => e.event === "gui_residual_acknowledged")).toBe(true);
  }, 30_000);

  it("spawn 类任务不受 GUI 分流影响：interrupted 且不出现 GUI 文案/待确认字段", async () => {
    // 独立 home：避免与其它用例的 agent-profiles/task 目录互相干扰
    const spawnHome = path.join(home, `spawn-${Date.now()}`);
    fs.mkdirSync(spawnHome, { recursive: true });
    const data = new DataHome(spawnHome, logger, BUILTIN_PROFILES);
    await data.init();
    // 写一个最小 spawn profile：orchestrator 在调用 adapter.run 之前先 registry.resolve()，
    // 未配置的 agentId 会以 agent_unresolved 失败（本用例要验证的是中断文案，不是探测）。
    fs.writeFileSync(
      path.join(spawnHome, "agent-profiles.json"),
      JSON.stringify({
        profiles: {
          stub: {
            displayName: "Stub Agent (test)",
            type: "cli",
            driver: "spawn",
            status: "ready",
            command: process.execPath,
            argsTemplate: [],
            promptMode: "arg",
            cwd: "task",
            env: {},
            timeoutMs: 120_000,
            killTree: "taskkill",
          },
        },
      }),
      "utf8",
    );
    const store = new TaskStore(spawnHome, logger);
    const registry = new AgentAdapterRegistry(() => data.loadProfiles(), logger);
    const manager = new TaskManager(
      store,
      data,
      registry,
      new AcceptanceEngine(store, logger),
      logger,
      makeBuildCtx({ store, dataHome: data }),
    );
    await manager.initialize({ maxRunning: 1, guiStopWaitMs: 5_000 });
    registry.register("stub", new HangingCliAdapter());
    const project = await makeGitProject("good");
    cleanup.push(project, spawnHome);
    const task = await manager.submit({
      projectPath: normPath(project),
      displayPath: project,
      agentId: "stub",
      task: "spawn 中断文案回归",
      autoVerify: false,
      autoFixRounds: 0,
      taskTimeoutMs: 60_000,
    });
    await waitFor(manager, task.taskId, (m) => m?.status === "running");
    await manager.shutdownInterrupt();

    const meta = await manager.getMeta(task.taskId);
    expect(meta?.status).toBe("interrupted");
    expect(meta?.errorType).toBe("interrupted");
    // spawn 类任务不参与 GUI 分流：既不写「窗口中的任务可能仍在继续」，
    // 也不置 GUI 待确认字段。（文案由 manager 的 spawn 分支或 orchestrator 的通用中断
    // 文案二选一，取决于 2s 预算内的写入竞态——两者都不含 GUI 断言。）
    expect(meta?.lastMessage).not.toContain("可能仍在继续");
    expect(meta?.lastMessage).not.toContain("GUI");
    expect(meta?.guiResidualUnconfirmed).toBeFalsy();
  }, 30_000);
});
