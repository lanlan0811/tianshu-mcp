/**
 * 用户级验收（issue #38 问题 B）：端到端跑一次「setup 阶段失败」的任务，
 * 断言**实际落盘的 task.json**（用户用 query_task / GUI 看到的就是这份文件）。
 *
 * 链路：TaskManager.submit → TaskOrchestrator → AgentAdapter.run（真实编排层）
 *       → 适配器声明 hardFailure + errorType="setup_failed"
 *       → fix-loop 映射 → task.json 落盘。
 *
 * 本用例考的是**失败性质归类与验收跳过**，与具体 agent 无关：适配器用一个只实现
 * `run()` 的桩替代（历史上的实现是某个 GUI 适配器的 `bindProject` 失败路径，
 * 该 agent 移除后改由桩直接声明同样的失败形态）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTmpRoot, rmrf, gitInitAndCommit } from "../test-utils.js";
import { DataHome } from "../../src/config/store.js";
import { AgentProfileSchema } from "../../src/config/schema.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { AgentAdapterRegistry } from "../../src/agents/registry.js";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { normPath } from "../../src/util/path.js";
import { makeBuildCtx } from "../../src/mcp/context.js";
import { Logger } from "../../src/util/log.js";
import type {
  AgentAdapter,
  AgentRunResult,
  ResolvedAgent,
  SpawnInvocation,
  TaskContext,
} from "../../src/agents/adapter.js";
import type { SpawnResult } from "../../src/agents/spawn.js";

const silentLogger = new Logger(null, "error");
const cleanup: string[] = [];

/**
 * 只实现 `run()` 的桩适配器：直接声明「setup 阶段逻辑性失败」。
 *
 * 与真实 GUI 适配器一致的两点：① `buildInvocation()` 直接抛错（不走 spawn）；
 * ② `hardFailure: true` + `errorType: "setup_failed"` —— 编排层据此归类，
 * 不进验收、不进返修。
 */
class SetupFailedAdapter implements AgentAdapter {
  constructor(readonly id: string) {}

  buildInvocation(): SpawnInvocation {
    throw new Error("测试桩不通过 spawn 执行");
  }

  parseExit(res: SpawnResult): AgentRunResult {
    return { ...res, hardFailure: Boolean(res.error && res.exitCode === null) };
  }

  async run(ctx: TaskContext, _resolved: ResolvedAgent): Promise<AgentRunResult> {
    return {
      ok: false,
      exitCode: null,
      timeout: false,
      killed: false,
      durationMs: 1,
      logFile: path.join(ctx.taskDir, `agent-${ctx.round}.log`),
      hardFailure: true,
      errorType: "setup_failed",
      error: "项目文件夹绑定失败：下拉未命中且原生对话框未弹出",
      keptInstance: true,
    };
  }
}

/**
 * 桩用的 profile：`driver="spawn"` 且 `command` 指向当前 Node 可执行文件——
 * 这样 `registry.resolve()` 无需任何真机安装即可通过。适配器由 `register()` 直接注入，
 * 不经过 profile 的 adapter 分支（本用例考的不是适配器选择）。
 */
function makeStubProfile() {
  return AgentProfileSchema.parse({
    displayName: "Codex (acceptance stub)",
    type: "cli",
    driver: "spawn",
    status: "ready",
    command: process.execPath,
  });
}

let projectPath: string;
let home: string;
let manager: TaskManager;
let store: TaskStore;

beforeAll(async () => {
  projectPath = await makeTmpRoot("issue38-acceptance-proj");
  cleanup.push(projectPath);
  fs.writeFileSync(path.join(projectPath, "README.md"), "# demo\n", "utf8");
  await gitInitAndCommit(projectPath);

  home = await makeTmpRoot("issue38-acceptance-home");
  cleanup.push(home);
  const dataHome = new DataHome(home, silentLogger, { codex: makeStubProfile() });
  await dataHome.init();
  store = new TaskStore(home, silentLogger);
  const registry = new AgentAdapterRegistry(() => dataHome.loadProfiles(), silentLogger);
  manager = new TaskManager(
    store,
    dataHome,
    registry,
    new AcceptanceEngine(store, silentLogger),
    silentLogger,
    makeBuildCtx({ store, dataHome }),
  );
  await manager.initialize(2);
  registry.register("codex", new SetupFailedAdapter("codex"));
}, 60_000);

afterAll(async () => {
  await Promise.all(cleanup.splice(0).map((d) => rmrf(d)));
});

describe("用户级验收：setup 阶段失败的任务落盘形态（issue #38 问题 B）", () => {
  it("派发 → task.json 的 errorType 为 setup_failed 且文案点明 setup 阶段失败", async () => {
    const meta = await manager.submit({
      projectPath: normPath(projectPath),
      displayPath: projectPath,
      agentId: "codex",
      task: "在空项目里生成 result.txt",
      autoVerify: true,
      autoFixRounds: 0,
      taskTimeoutMs: 30_000,
    });

    // 轮询到终态
    let final = await manager.getMeta(meta.taskId);
    const deadline = Date.now() + 30_000;
    while (final && !["succeeded", "failed", "needs_attention", "cancelled", "interrupted"].includes(final.status)) {
      if (Date.now() > deadline) throw new Error(`等待终态超时；最近状态=${final.status}`);
      await new Promise((r) => setTimeout(r, 100));
      final = await manager.getMeta(meta.taskId);
    }

    // ---- 读**实际落盘**的 task.json（用户可见的那份）----
    const snapPath = path.join(store.dir(meta.taskId), "task.json");
    const snap = JSON.parse(fs.readFileSync(snapPath, "utf8")) as {
      status: string;
      errorType: string | null;
      lastMessage?: string;
      agentId: string;
    };

    expect(snap.status).toBe("failed");
    expect(snap.agentId).toBe("codex");
    // 核心断言：不再是 spawn
    expect(snap.errorType).toBe("setup_failed");
    expect(snap.errorType).not.toBe("spawn");
    // 文案让读者无需读日志即可判断性质
    expect(snap.lastMessage).toContain("setup 阶段失败");
    expect(snap.lastMessage).not.toContain("agent 基础设施失败");
    // 原始错因保留，便于定位
    expect(snap.lastMessage).toContain("项目文件夹绑定失败");
  }, 60_000);
});
