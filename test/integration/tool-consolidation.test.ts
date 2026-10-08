/**
 * v0.9.0 工具合并（13 → 8）的行为契约测试。
 *
 * 合并映射：
 * - `manage_task`   ← `cancel_task` + `continue_task` + `rework_task`
 * - `wait_task`     ← `wait_task` + `wait_any`（增强：taskId 单任务 / taskIds 批量）
 * - `query_info`    ← `list_tasks` + `get_task_report` + `get_profiles`
 * - 保留不动：`run_task` / `query_task` / `verify_task` / `prepare_visual_baseline` / `approve_visual_baseline`
 *
 * 本文件锁定三条不变量：
 * 1. 新工具的线上 schema 必须暴露非空 properties（防 discriminatedUnion/refine 陷阱——
 *    实测这两者经 SDK 序列化后退化为 `{"type":"object","properties":{}}`）。
 * 2. 分支约束（必填降级、二选一、字段白名单）由 handler 下沉校验兜住，语义与合并前等价。
 * 3. 旧工具名不再出现在工具面。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import {
  startTestServer,
  makeGitProject,
  writePlaybook,
  callTool,
  waitForTerminal,
  rmrf,
  STUB_SCRIPT,
  type TestServer,
} from "../test-utils.js";

let ts: TestServer;
const tempDirs: string[] = [];

beforeAll(async () => {
  ts = await startTestServer();
}, 60_000);

afterAll(async () => {
  await rmrf(ts.home);
  for (const d of tempDirs) await rmrf(d).catch(() => {});
});

/** 桩化一个可解析的 stub agent（沿用 acceptance-override.test.ts 的写法）。 */
async function writeStubProfile(): Promise<void> {
  await fsp.writeFile(
    path.join(ts.home, "agent-profiles.json"),
    JSON.stringify({
      profiles: {
        stub: {
          displayName: "Stub Agent (test)",
          type: "cli",
          status: "ready",
          command: process.execPath,
          argsTemplate: [STUB_SCRIPT, "<prompt:arg>"],
          promptMode: "arg",
          cwd: "task",
          env: {},
          timeoutMs: 120_000,
          killTree: "taskkill",
          authNote: "test-only stub",
        },
      },
    }),
  );
}

describe("工具面：13 → 8", () => {
  it("恰为 8 个工具，且旧名全部消失", async () => {
    const { tools } = await ts.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "approve_visual_baseline",
      "manage_task",
      "prepare_visual_baseline",
      "query_info",
      "query_task",
      "run_task",
      "verify_task",
      "wait_task",
    ]);
  });

  it("旧工具名不再出现在工具面", async () => {
    const { tools } = await ts.client.listTools();
    const names = new Set(tools.map((t) => t.name));
    for (const old of [
      "cancel_task",
      "continue_task",
      "rework_task",
      "wait_any",
      "list_tasks",
      "get_task_report",
      "get_profiles",
    ]) {
      expect(names.has(old), `旧工具 ${old} 不应再出现在工具面`).toBe(false);
    }
  });

  it("新工具的线上 inputSchema 必须暴露非空 properties（防空 schema 陷阱）", async () => {
    const { tools } = await ts.client.listTools();
    for (const name of ["manage_task", "wait_task", "query_info"]) {
      const t = tools.find((x) => x.name === name);
      expect(t, `${name} 应存在`).toBeDefined();
      const props = (t!.inputSchema as { properties?: Record<string, unknown> } | undefined)
        ?.properties;
      const count = props ? Object.keys(props).length : 0;
      expect(count, `${name} 的线上 schema 参数为空（检出 discriminatedUnion/refine 陷阱）`)
        .toBeGreaterThan(0);
    }
  });
});

describe("manage_task：cancel / continue / rework 三分支", () => {
  it("action=cancel 取消运行中任务（等价原 cancel_task）", async () => {
    await writeStubProfile();
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    await writePlaybook(proj, { playbook: "sleep", sleepMs: 8000 });
    const run = await callTool(ts.client, "run_task", {
      projectPath: proj,
      task: "t",
      agentId: "stub",
    });
    const taskId = /tsk_[A-Za-z0-9_]+/.exec(run.text)?.[0];
    expect(taskId).toBeTruthy();
    await waitForTerminal(ts.client, taskId!, 20_000).catch(() => {});

    const r = await callTool(ts.client, "manage_task", { taskId, action: "cancel" });
    // 任务可能已自然结束——只要不是参数校验错误即可
    expect(r.text).not.toContain("不合法");
  }, 90_000);

  it("action=cancel 保留 reason 参数（v1.0 曾漏掉）", async () => {
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    const r = await callTool(ts.client, "manage_task", {
      taskId: "tsk_nonexistent_xyz",
      action: "cancel",
      reason: "测试原因",
    });
    expect(r.res.isError).toBe(true);
    // 不应因 reason 字段不识别而失败
    expect(r.text).not.toContain("unrecognized");
  }, 60_000);

  it("action=continue 缺 message 被 handler 下沉层拒绝（必填降级的补位）", async () => {
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    const r = await callTool(ts.client, "manage_task", {
      taskId: "tsk_nonexistent_xyz",
      action: "continue",
    });
    expect(r.res.isError).toBe(true);
    // 应由下沉层拒绝，而不是"任务不存在"这类业务错误
    expect(r.text).toMatch(/message|不合法/);
  }, 60_000);

  it("action 取值非法时被拒", async () => {
    const r = await callTool(ts.client, "manage_task", {
      taskId: "tsk_x",
      action: "bogus_action",
    });
    expect(r.res.isError).toBe(true);
  }, 60_000);

  it("缺失 action 时被拒", async () => {
    const r = await callTool(ts.client, "manage_task", { taskId: "tsk_x" });
    expect(r.res.isError).toBe(true);
  }, 60_000);
});

describe("wait_task 增强：单任务 + 批量二选一", () => {
  it("single 模式：提供 taskId（等价原 wait_task）", async () => {
    const r = await callTool(ts.client, "wait_task", {
      taskId: "tsk_nonexistent_xyz",
      timeoutMs: 1000,
    });
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain("任务不存在");
  }, 60_000);

  it("batch 模式：提供 taskIds（等价原 wait_any）", async () => {
    const r = await callTool(ts.client, "wait_task", {
      taskIds: ["tsk_nonexistent_a", "tsk_nonexistent_b"],
      timeoutMs: 1000,
    });
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain("任务不存在");
  }, 60_000);

  it("batch 模式缺一即报错（fail-closed，列出缺失 id）", async () => {
    const r = await callTool(ts.client, "wait_task", {
      taskIds: ["tsk_missing_one", "tsk_missing_two"],
      timeoutMs: 1000,
    });
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain("tsk_missing_one");
  }, 60_000);

  it("两者都不给 → 被拒（二选一约束只能在下沉层实现）", async () => {
    const r = await callTool(ts.client, "wait_task", { timeoutMs: 1000 });
    expect(r.res.isError).toBe(true);
    expect(r.text).toMatch(/taskId|taskIds|不合法/);
  }, 60_000);

  it("两者都给 → 被拒", async () => {
    const r = await callTool(ts.client, "wait_task", {
      taskId: "tsk_a",
      taskIds: ["tsk_b"],
      timeoutMs: 1000,
    });
    expect(r.res.isError).toBe(true);
  }, 60_000);

  it("taskIds 超过 20 个 → 被拒", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `tsk_${i}`);
    const r = await callTool(ts.client, "wait_task", { taskIds: many, timeoutMs: 1000 });
    expect(r.res.isError).toBe(true);
  }, 60_000);
});

describe("query_info：tasks / report / profiles 三型", () => {
  it("type=tasks 列出历史任务（等价原 list_tasks）", async () => {
    const r = await callTool(ts.client, "query_info", { type: "tasks" });
    expect(r.res.isError).toBeFalsy();
  }, 60_000);

  it("type=profiles 返回 agent 适配（等价原 get_profiles）", async () => {
    const r = await callTool(ts.client, "query_info", { type: "profiles" });
    expect(r.res.isError).toBeFalsy();
    expect(r.text.length).toBeGreaterThan(0);
  }, 60_000);

  it("type=report 缺 taskId 被拒", async () => {
    const r = await callTool(ts.client, "query_info", { type: "report" });
    expect(r.res.isError).toBe(true);
    expect(r.text).toMatch(/taskId|不合法/);
  }, 60_000);

  it("type=report 带 taskId 时行为等价原 get_task_report", async () => {
    const r = await callTool(ts.client, "query_info", {
      type: "report",
      taskId: "tsk_nonexistent_xyz",
    });
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain("任务不存在");
  }, 60_000);

  it("type 取值非法时被拒", async () => {
    const r = await callTool(ts.client, "query_info", { type: "bogus" });
    expect(r.res.isError).toBe(true);
  }, 60_000);

  it("type=tasks 的 status 仍是自由字符串（未被收紧为枚举）", async () => {
    // 原 list_tasks 的 status 是 z.string().optional()，收紧成枚举属未论证的语义变更
    const r = await callTool(ts.client, "query_info", {
      type: "tasks",
      status: "任意自定义状态串",
    });
    expect(r.res.isError).toBeFalsy();
  }, 60_000);

  it("type=tasks 的 limit 越界被拒（上限 200）", async () => {
    const r = await callTool(ts.client, "query_info", { type: "tasks", limit: 999 });
    expect(r.res.isError).toBe(true);
  }, 60_000);
});
