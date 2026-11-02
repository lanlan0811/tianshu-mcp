/**
 * 集成测试（0.9.10 显式验收项）：数据目录里遗留的 `agentId: "qoder"` 任务，
 * 在 Qoder CN 适配器移除后必须**硬失败 `agent_unresolved`**，绝不被 CLI adapter 兜底误跑。
 *
 * 背景：`fix-loop` 曾有一条 `meta.agentId === "qoder"` 的专用返修分支；删除该分支后，
 * 历史 Qoder 任务的重跑会落到**通用路径**。本用例锁死「通用路径对未知 agentId fail-closed」
 * 这一行为——否则一个已删除的产品会被当成 CLI agent 跑一遍，产生无法归因的半成品。
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AgentProfileSchema } from "../../src/config/schema.js";
import { AgentAdapterRegistry } from "../../src/agents/registry.js";
import { CliAdapter } from "../../src/agents/cli.js";
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

/** 一个仍然存在的 spawn agent（stub），用来证明「未知 agent 不会被别的 adapter 接走」 */
function stubProfile() {
  return AgentProfileSchema.parse({
    displayName: "Stub (test)",
    driver: "spawn",
    status: "ready",
    command: process.execPath,
  });
}

async function harness() {
  const home = await makeTmpRoot("legacy-qoder-home");
  cleanup.push(home);
  const data = new DataHome(home, logger, { stub: stubProfile() });
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
  await manager.initialize(1);
  return { manager, store, registry, home };
}

async function waitTerminal(manager: TaskManager, taskId: string, timeoutMs = 30_000) {
  const start = Date.now();
  for (;;) {
    const meta = await manager.getMeta(taskId);
    if (meta && ["succeeded", "failed", "needs_attention"].includes(meta.status))
      return meta;
    if (Date.now() - start > timeoutMs)
      throw new Error(`等待终态超时（${timeoutMs}ms，最近状态=${meta?.status ?? "无"}）`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("遗留 agentId=qoder 任务的重跑（0.9.10）", () => {
  it("rework 一个历史 qoder 任务 → failed + agent_unresolved，且绝不被 CLI adapter 兜底", async () => {
    const projectPath = await makeTmpRoot("legacy-qoder-proj");
    cleanup.push(projectPath);
    fs.writeFileSync(path.join(projectPath, "README.md"), "# demo\n", "utf8");
    await gitInitAndCommit(projectPath);

    const { manager, store, registry } = await harness();

    // 手工造一个历史 qoder 任务（终态 failed），模拟升级前遗留的快照。
    const taskId = "tsk_legacy_qoder";
    const now = new Date().toISOString();
    const meta = {
      taskId,
      projectPath: normPath(projectPath),
      displayPath: projectPath,
      agentId: "qoder",
      task: "历史 Qoder 任务",
      autoVerify: false,
      autoFixRounds: 0,
      taskTimeoutMs: 30 * 60_000,
      round: 0,
      roundsUsed: 1,
      status: "failed" as const,
      createdAt: now,
      updatedAt: now,
    };
    await store.appendEvent(taskId, "created", "queued", "历史任务");
    await store.writeSnapshot(meta as never);

    // 直接调 registry 解析：qoder 既无 profile 也无 adapter，必须 fail-closed。
    const resolved = await registry.resolve("qoder", true);
    expect(resolved.ok).toBe(false);
    expect(resolved.message).toMatch(/未配置 agent 'qoder'|不可用/);

    // 关键反向锁：registry 里**不得**存在任何会被误当成 qoder 的 adapter。
    // 旧实现会为未知 id 预注册一个 CliAdapter 基座；qoder 从默认列表移除后应彻底不存在。
    expect(registry.getAdapter("qoder")).toBeUndefined();

    // 再走真实 rework 路径：必须落 failed(agent_unresolved)。
    const res = await manager.rework(taskId, "重试历史任务");
    if (res.found) {
      const final = await waitTerminal(manager, taskId);
      expect(final.status).toBe("failed");
      expect(final.errorType).toBe("agent_unresolved");
      expect(final.lastMessage ?? "").toMatch(/不可用|未配置/);
    } else {
      // 也允许在 rework 入口就明确拒绝（fail-closed 的另一种落点）
      expect(res.reason ?? "").toMatch(/qoder|不可用|未配置/i);
    }
  });

  it("默认注册表不再预置 qoder 的 CLI 基座（避免兜底误跑）", () => {
    const reg = new AgentAdapterRegistry(async () => ({}), logger);
    expect(reg.getAdapter("qoder")).toBeUndefined();
    // 仍在的 agent 保持 CLI 基座（对照，证明上一条不是「全都为空」）
    expect(reg.getAdapter("codex")).toBeInstanceOf(CliAdapter);
  });
});
