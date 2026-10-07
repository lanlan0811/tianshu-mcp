/**
 * 用户级验收（issue #38 问题 B）：端到端跑一次「绑定失败」的 traework 任务，
 * 断言**实际落盘的 task.json**（用户用 query_task / GUI 看到的就是这份文件）。
 *
 * 链路：TaskManager.submit → TaskOrchestrator → TraeworkGuiAdapter（真实）→
 *       runTraeworkTask（真实）→ bindProject 失败 → hardFailure + errorType
 *       → fix-loop 映射 → task.json 落盘。
 *
 * 假 CDP 模拟「下拉不含目标项目 + footer 点不出原生对话框」这一 #35 记录的失败场景。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTmpRoot, rmrf, gitInitAndCommit } from "../test-utils.js";
import { FakeCdpClient, makeFakeState, type FakeDomState } from "../fake-cdp.js";
import { DataHome } from "../../src/config/store.js";
import { AgentProfileSchema } from "../../src/config/schema.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { TaskManager } from "../../src/tasks/task-manager.js";
import { AgentAdapterRegistry } from "../../src/agents/registry.js";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { TraeworkGuiAdapter } from "../../src/agents/traework/adapter.js";
import { type TraeworkRunDeps } from "../../src/agents/traework/run.js";
import { normPath } from "../../src/util/path.js";
import { makeBuildCtx } from "../../src/mcp/context.js";
import { Logger } from "../../src/util/log.js";
import type { AgentRunResult, ResolvedAgent, TaskContext } from "../../src/agents/adapter.js";

const silentLogger = new Logger(null, "error");
const cleanup: string[] = [];

function makeGuiProfile() {
  return AgentProfileSchema.parse({
    displayName: "TraeWork (acceptance)",
    type: "cli",
    driver: "gui",
    status: "ready",
    command: process.execPath,
    gui: { cdpPort: 9222, pollIntervalMs: 1, stableRounds: 2, freshSession: true, modelSwitch: true, selectors: {} },
  });
}

/**
 * 真实 TraeworkGuiAdapter 子类：run() 调真实 runTraeworkTask，只把 CDP/原生对话框换成桩。
 * 剧本：下拉存在「另一个项目」但**不含目标项目** → 走原生对话框 → footer 点不出弹窗 → 绑定失败。
 */
class UnboundProjectAdapter extends TraeworkGuiAdapter {
  constructor(private readonly projectPath: string) {
    super("traework");
  }

  override async run(
    ctx: TaskContext,
    resolved: ResolvedAgent,
    opts: Parameters<NonNullable<TraeworkGuiAdapter["run"]>>[2],
  ): Promise<AgentRunResult> {
    const { runTraeworkTask } = await import("../../src/agents/traework/run.js");
    const state: FakeDomState = makeFakeState({
      projectItems: [{ name: "some-other-project", subtitle: "" }], // 目标项目不在下拉
      footerDialogOpensOn: "never", // footer 点不出原生对话框
    });
    const deps: Partial<TraeworkRunDeps> = {
      createClient: () => new FakeCdpClient(9222, state) as never,
      probeReady: async (port) => ({ port, title: "TraeWork CN" }),
      launch: () => {
        throw new Error("测试应复用实例");
      },
      waitReady: async (port) => ({ port, title: "TraeWork CN" }),
      release: async () => ({ released: true, reason: "已终止" }),
      resolvePort: async (gui) => gui.cdpPort,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
      dialogWaitTimeoutMs: 100,
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

let projectPath: string;
let home: string;
let manager: TaskManager;
let store: TaskStore;

beforeAll(async () => {
  vi.doMock("../../src/agents/traework/computeruse/dialog.js", () => ({
    findFolderDialog: async () => ({ found: false, windowTitle: "", processName: "", hwnd: 0 }),
    closeStaleFolderDialogs: async () => 0,
    pickFolderViaNativeDialog: async () => ({ ok: false, message: "未检测到原生对话框" }),
    localizeDialogMessage: (m: string) => m,
    toNativeWindowsPath: (p: string) => p,
  }));

  // 项目目录：存在但未在 Code 模式下绑定过（模拟 issue #35 的前提）
  projectPath = await makeTmpRoot("issue38-acceptance-proj");
  cleanup.push(projectPath);
  fs.writeFileSync(path.join(projectPath, "README.md"), "# demo\n", "utf8");
  await gitInitAndCommit(projectPath);

  home = await makeTmpRoot("issue38-acceptance-home");
  cleanup.push(home);
  const dataHome = new DataHome(home, silentLogger, { traework: makeGuiProfile() });
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
  registry.register("traework", new UnboundProjectAdapter(projectPath));
}, 60_000);

afterAll(async () => {
  vi.doUnmock("../../src/agents/traework/computeruse/dialog.js");
  await Promise.all(cleanup.splice(0).map((d) => rmrf(d)));
});

describe("用户级验收：绑定失败的 traework 任务落盘形态（issue #38 问题 B）", () => {
  it("派发到未绑定目录 → task.json 的 errorType 为 setup_failed 且文案点明 setup 阶段失败", async () => {
    const meta = await manager.submit({
      projectPath: normPath(projectPath),
      displayPath: projectPath,
      agentId: "traework",
      mode: "Code",
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
      mode?: string;
    };

    console.log("[验收] task.json 落盘内容:");
    console.log("  status     =", snap.status);
    console.log("  errorType  =", snap.errorType);
    console.log("  mode       =", snap.mode);
    console.log("  lastMessage=", (snap.lastMessage ?? "").slice(0, 160));

    expect(snap.status).toBe("failed");
    expect(snap.agentId).toBe("traework");
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
