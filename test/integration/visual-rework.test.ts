import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
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
import { makeTmpRoot, rmrf } from "../test-utils.js";
import { loadSharp } from "../../src/visual/runtime.js";
import { reviewRules, approveRules } from "../../src/visual/manage.js";

const cleanup: string[] = [];
const managers: TaskManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdownInterrupt();
  for (const d of cleanup.splice(0)) await rmrf(d);
});
const logger = new Logger(null, "error");
class ImageAdapter extends ZcodeGuiAdapter {
  calls: TaskContext[] = [];
  constructor() {
    super("zcode");
  }
  override async run(
    ctx: TaskContext,
    _resolved: ResolvedAgent,
    _opts: AgentRunOptions,
  ): Promise<AgentRunResult> {
    this.calls.push(structuredClone(ctx));
    const sharp = await loadSharp();
    await sharp({
      create: { width: ctx.round === 0 ? 2 : 4, height: 4, channels: 3, background: "red" },
    })
      .png()
      .toFile(path.join(ctx.projectPath, "image.png"));
    return {
      ok: true,
      exitCode: 0,
      timeout: false,
      killed: false,
      durationMs: 1,
      logFile: path.join(ctx.taskDir, `agent-${ctx.round}.log`),
      session: { id: "visual-session", title: "Visual test", boundProjectPath: ctx.projectPath },
    };
  }
}
async function harness(blocked: boolean) {
  const project = await makeTmpRoot("visual-rework-project"),
    home = await makeTmpRoot("visual-rework-home");
  cleanup.push(project, home);
  await fs.mkdir(path.join(project, ".tianshu-mcp"));
  const config = {
    checks: [],
    requireChanges: false,
    visual: {
      enabled: true,
      limits: { decodedPixels: blocked ? 1 : 100 },
      images: [{ id: "cover", files: ["image.png"], width: { exact: blocked ? 2 : 4 } }],
    },
  };
  await fs.writeFile(path.join(project, ".tianshu-mcp", "acceptance.json"), JSON.stringify(config));
  const data = new DataHome(home, logger, {
    zcode: AgentProfileSchema.parse({
      displayName: "Visual test",
      driver: "gui",
      adapter: "zcode-gui",
      command: process.execPath,
      status: "ready",
    }),
  });
  await data.init();
  const store = new TaskStore(home, logger),
    registry = new AgentAdapterRegistry(() => data.loadProfiles(), logger),
    adapter = new ImageAdapter();
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
  managers.push(manager);
  return { project, home, config, manager, adapter, store };
}
async function terminal(manager: TaskManager, id: string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const meta = await manager.getMeta(id);
    if (
      meta &&
      ["succeeded", "failed", "needs_attention"].includes(meta.status) &&
      !manager.activeCount
    )
      return meta;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Visual task did not finish");
}
it("repairs real image defects with visual evidence", async () => {
  const h = await harness(false);
  const meta = await h.manager.submit({
    projectPath: h.project,
    displayPath: h.project,
    task: "Create image",
    agentId: "zcode",
    autoVerify: true,
    autoFixRounds: 1,
    taskTimeoutMs: 60_000,
  });
  const done = await terminal(h.manager, meta.taskId);
  expect(done.status).toBe("succeeded");
  expect(h.adapter.calls).toHaveLength(2);
  const repair = await fs.readFile(
    path.join(h.store.dir(meta.taskId), `rework-${meta.taskId}-r0.md`),
    "utf8",
  );
  expect(repair).toContain("cover");
  expect(repair).toContain("不得通过修改基准");
});
it("resolves a blocker by approved rule review and re-verifies without another agent call", async () => {
  const h = await harness(true);
  const meta = await h.manager.submit({
    projectPath: h.project,
    displayPath: h.project,
    task: "Create image",
    agentId: "zcode",
    autoVerify: true,
    autoFixRounds: 1,
    taskTimeoutMs: 60_000,
  });
  const blocked = await terminal(h.manager, meta.taskId);
  expect(blocked.status).toBe("needs_attention");
  expect(blocked.pendingVisualVerification).toBe(true);
  expect(h.adapter.calls).toHaveLength(1);
  h.config.visual.limits.decodedPixels = 100;
  await fs.writeFile(
    path.join(h.project, ".tianshu-mcp", "acceptance.json"),
    JSON.stringify(h.config),
  );
  const review = await reviewRules(h.home, meta.taskId);
  await approveRules(
    h.home,
    meta.taskId,
    review.reviewId,
    review.digest,
    "Explicit test user approval of resource limit",
  );
  await h.manager.rework(meta.taskId);
  const done = await terminal(h.manager, meta.taskId);
  expect(done.status).toBe("succeeded");
  expect(h.adapter.calls).toHaveLength(1);
  expect(done.roundsUsed).toBe(1);
  expect(done.reportRound).toBe(1);
});
