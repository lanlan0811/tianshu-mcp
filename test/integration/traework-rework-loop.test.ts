/**
 * 集成测试：TraeWork GUI 驱动的「派活 → 验收失败 → 自动生成修复计划 → 返修 → 再验收通过」闭环。
 *
 * 与 traework-fake-cdp.test.ts 的区别：那条测的是单轮 runTraeworkTask；
 * 这条测的是**编排层与 GUI adapter 的接缝**——真实 TaskManager/TaskOrchestrator/
 * AcceptanceEngine 驱动一个 driver=gui 的 adapter，验证修复计划落盘与 feedback 回填。
 *
 * 全程假 CDP + 本地 git 项目，不依赖真机、平台中立。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTmpRoot, rmrf, gitInitAndCommit } from "../test-utils.js";
import { FakeCdpClient, makeFakeState, type FakeDomState } from "../fake-cdp.js";
import { TraeworkGuiAdapter } from "../../src/agents/traework/adapter.js";
import { runTraeworkTask, type TraeworkRunDeps } from "../../src/agents/traework/run.js";
import type { AgentRunResult, ResolvedAgent, TaskContext } from "../../src/agents/adapter.js";
import { AgentAdapterRegistry } from "../../src/agents/registry.js";
import { AgentProfileSchema } from "../../src/config/schema.js";
import { DataHome } from "../../src/config/store.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { makeBuildCtx } from "../../src/mcp/context.js";
import { Logger } from "../../src/util/log.js";
import { normPath } from "../../src/util/path.js";

const silentLogger = new Logger(null, "error");

const cleanup: string[] = [];
afterAll(async () => {
  for (const p of cleanup) await rmrf(p).catch(() => {});
});

/** 造一个带 git 基线与验收脚本的示例项目 */
async function makeProject(): Promise<string> {
  const dir = await makeTmpRoot("traework-rework-proj");
  cleanup.push(dir);
  fs.mkdirSync(path.join(dir, ".tianshu-mcp"), { recursive: true });
  // 验收：done.txt 内容必须是 PASS，否则失败
  fs.writeFileSync(
    path.join(dir, "check.mjs"),
    [
      'import fs from "node:fs";',
      'if (!fs.existsSync("done.txt")) { console.error("done.txt 不存在"); process.exit(1); }',
      'const s = fs.readFileSync("done.txt", "utf8").trim();',
      'if (s !== "PASS") { console.error("内容不是 PASS: " + s); process.exit(1); }',
      'console.log("OK");',
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, ".tianshu-mcp", "acceptance.json"),
    JSON.stringify({ checks: [{ name: "done-marker", cmd: ["node", "check.mjs"], timeoutMs: 20000 }] }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n", "utf8");
  await gitInitAndCommit(dir);
  return dir;
}

function makeGuiProfile() {
  return AgentProfileSchema.parse({
    displayName: "TraeWork (test)",
    type: "cli",
    driver: "gui",
    status: "ready",
    command: process.execPath, // 让 resolve 通过（gui 驱动不使用它做 spawn）
    gui: {
      cdpPort: 9222,
      pollIntervalMs: 1, // 测试加速
      stableRounds: 2,
      freshSession: true,
      modelSwitch: true,
      selectors: {},
    },
  });
}

/**
 * 受控 adapter：真实 TraeworkGuiAdapter 子类，把 run() 接到真实 runTraeworkTask + 假 CDP。
 * 剧本：round 0 不写 done.txt（验收失败）；round ≥ 1 写 done.txt=PASS（验收通过）。
 */
class ScriptedTraeworkAdapter extends TraeworkGuiAdapter {
  readonly rounds: { round: number; feedback?: string }[] = [];

  constructor(private readonly projectPath: string) {
    super("traework");
  }

  override async run(ctx: TaskContext, resolved: ResolvedAgent, opts: Parameters<NonNullable<TraeworkGuiAdapter["run"]>>[2]): Promise<AgentRunResult> {
    this.rounds.push({ round: ctx.round, feedback: ctx.feedback });

    // 剧本：第一轮故意不满足验收；返修轮才写正确产物
    if (ctx.round >= 1) {
      fs.writeFileSync(path.join(this.projectPath, "done.txt"), "PASS", "utf8");
    }

    const state: FakeDomState = makeFakeState({
      projectItems: [{ name: path.basename(this.projectPath), subtitle: this.projectPath }],
    });
    // 发送后自动产生完成标志（模拟 TraeWork 回复结束）
    const timer = setInterval(() => {
      if (state.sent && !state.messages.includes("由AI生成")) {
        state.messages = `${state.messages}TraeWork已完成本轮任务由AI生成12:30`;
        clearInterval(timer);
      }
    }, 2);
    timer.unref?.();

    const deps: Partial<TraeworkRunDeps> = {
      createClient: () => new FakeCdpClient(9222, state) as never,
      probeReady: async (port) => ({ port, title: "TraeWork CN" }),
      launch: () => {
        throw new Error("测试应复用实例，不应启动新实例");
      },
      waitReady: async (port) => ({ port, title: "TraeWork CN" }),
      release: () => ({ released: true, reason: "已终止" }),
      resolvePort: async (gui) => gui.cdpPort,
    };

    return runTraeworkTask({
      ctx,
      resolved,
      opts,
      logFile: path.join(ctx.taskDir, `agent-${ctx.round}.log`),
      startedAt: Date.now(),
      logger: opts.logger,
      deps,
    });
  }
}

interface Harness {
  manager: TaskManager;
  store: TaskStore;
  home: string;
  adapter: ScriptedTraeworkAdapter;
}

async function makeHarness(projectPath: string): Promise<Harness> {
  const home = await makeTmpRoot("traework-rework-home");
  cleanup.push(home);
  const dataHome = new DataHome(home, silentLogger, { traework: makeGuiProfile() });
  await dataHome.init();

  const store = new TaskStore(home, silentLogger);
  const registry = new AgentAdapterRegistry(() => dataHome.loadProfiles(), silentLogger);
  const engine = new AcceptanceEngine(store, silentLogger);
  const manager = new TaskManager(store, dataHome, registry, engine, silentLogger, makeBuildCtx({ store, dataHome }));
  await manager.initialize(2);

  // 注册受控 adapter（是 TraeworkGuiAdapter 子类，registry.ensureAdapterFor 不会覆盖）
  const adapter = new ScriptedTraeworkAdapter(projectPath);
  registry.register("traework", adapter);

  return { manager, store, home, adapter };
}

/** 轮询到任务终态 */
async function waitTerminal(manager: TaskManager, taskId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const meta = await manager.getMeta(taskId);
    if (meta && ["succeeded", "failed", "needs_attention", "cancelled", "interrupted"].includes(meta.status)) return meta;
    if (Date.now() > deadline) throw new Error(`等待任务终态超时；最近状态=${meta?.status}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("TraeWork 返修闭环（假 CDP + 真实编排层）", () => {
  let projectPath: string;
  let h: Harness;

  beforeAll(async () => {
    projectPath = await makeProject();
    h = await makeHarness(projectPath);
  }, 60_000);

  it("验收失败 → 生成修复计划 → 返修轮带回文件名 → 再验收通过", async () => {
    const meta = await h.manager.submit({
      projectPath: normPath(projectPath),
      displayPath: projectPath,
      agentId: "traework",
      task: "生成 done.txt（内容 PASS）",
      autoVerify: true,
      autoFixRounds: 1,
      taskTimeoutMs: 60_000,
    });
    const final = await waitTerminal(h.manager, meta.taskId);

    // 终态应为成功（返修后通过）
    expect(final.status).toBe("succeeded");
    expect(final.roundsUsed).toBe(2);

    // adapter 被调用两轮，且第二轮带返修反馈
    expect(h.adapter.rounds.map((r) => r.round)).toEqual([0, 1]);
    const second = h.adapter.rounds[1]!;
    expect(second.feedback).toBeTruthy();
    expect(second.feedback).toContain(`rework-${meta.taskId}-r0.md`);
    expect(second.feedback).toContain("定向修复");

    // 修复计划文件：任务目录 + 项目 .tianshu-mcp 两处都应有
    const fileName = `rework-${meta.taskId}-r0.md`;
    const inTaskDir = path.join(h.store.dir(meta.taskId), fileName);
    const inProject = path.join(projectPath, ".tianshu-mcp", fileName);
    expect(fs.existsSync(inTaskDir)).toBe(true);
    expect(fs.existsSync(inProject)).toBe(true);
    const planText = fs.readFileSync(inTaskDir, "utf8");
    expect(planText).toContain("修复计划");
    expect(planText).toContain("done-marker"); // 失败项被写入计划
    expect(planText).toContain("定向修复");

    // 两轮验收报告都落盘（round 0 失败、round 1 通过）
    expect(fs.existsSync(h.store.reportJsonPath(meta.taskId, 0))).toBe(true);
    expect(fs.existsSync(h.store.reportJsonPath(meta.taskId, 1))).toBe(true);
    const r0 = JSON.parse(fs.readFileSync(h.store.reportJsonPath(meta.taskId, 0), "utf8")) as { passed: boolean };
    const r1 = JSON.parse(fs.readFileSync(h.store.reportJsonPath(meta.taskId, 1), "utf8")) as { passed: boolean };
    expect(r0.passed).toBe(false);
    expect(r1.passed).toBe(true);

    // 事件流：经历 fixing（自动返修）后成功
    const events = fs.readFileSync(h.store.jsonlPath(meta.taskId), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string });
    const names = events.map((e) => e.event);
    expect(names).toContain("fix_start");
    expect(names).toContain("succeeded");
  }, 90_000);

  it("未开启自动返修时验收失败 → 终态 failed（不生成返修轮）", async () => {
    // 新项目避免 done.txt 残留
    const proj2 = await makeProject();
    const h2 = await makeHarness(proj2);
    const meta = await h2.manager.submit({
      projectPath: normPath(proj2),
      displayPath: proj2,
      agentId: "traework",
      task: "生成 done.txt（内容 PASS）",
      autoVerify: true,
      autoFixRounds: 0,
      taskTimeoutMs: 60_000,
    });
    const final = await waitTerminal(h2.manager, meta.taskId);
    expect(final.status).toBe("failed");
    expect(final.errorType).toBe("verify_failed");
    expect(h2.adapter.rounds.length).toBe(1);
    expect(h2.adapter.rounds[0]!.feedback).toBeUndefined();
  }, 90_000);
});
