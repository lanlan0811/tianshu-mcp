/**
 * 等待原语端到端集成测试（issue #28 / 计划 §2.4 T2）。
 * 用真实 buildServer + 官方 SDK client（in-memory transport）+ stub `sleep` 剧本造长任务，
 * 证明 wait 等待的是**真实状态机推进**而非 mock。
 * RED 形态：`wait_task` / `wait_any` 未注册 → tools/call Method not found。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startTestServer, makeGitProject, callTool, parseMeta, rmrf, type TestServer } from "../test-utils.js";

let ts: TestServer;
const tempDirs: string[] = [];

/** 停点集合（终态 ∪ needs_user）——断言只要求落入停点，不锁定具体终态。 */
const STOP_POINTS = [
  "succeeded",
  "failed",
  "needs_attention",
  "cancelled",
  "interrupted",
  "needs_user",
];

async function dispatchSleep(sleepMs: number): Promise<{ taskId: string; project: string }> {
  const project = await makeGitProject("sleep", { sleepMs });
  tempDirs.push(project);
  const { text } = await callTool(ts.client, "run_task", {
    projectPath: project,
    agentId: "stub",
    task: `sleep 长任务（${sleepMs}ms）`,
    autoVerify: false,
  });
  const meta = parseMeta(text).meta;
  expect(meta).not.toBeNull();
  return { taskId: meta!.taskId as string, project };
}

beforeAll(async () => {
  ts = await startTestServer();
}, 60_000);

afterAll(async () => {
  await ts?.close();
  for (const d of tempDirs) await rmrf(d).catch(() => {});
  if (ts) await rmrf(ts.home).catch(() => {});
});

describe("wait_task 端到端", () => {
  it("I1 等待真实任务至停点（waitedMs 反映真实耗时）", async () => {
    const { taskId } = await dispatchSleep(1200);
    const { text } = await callTool(ts.client, "wait_task", { taskId, timeoutMs: 20_000 });
    const { meta } = parseMeta(text);
    expect(meta).not.toBeNull();
    expect(meta!.taskId).toBe(taskId);
    expect(meta!.waitSettled).toBe(true);
    expect(STOP_POINTS).toContain(meta!.status);
    // 任务确实跑了一会儿（不是立刻返回）
    expect(meta!.waitedMs as number).toBeGreaterThanOrEqual(500);
    expect(text).toMatch(/停点|状态:/);
  }, 60_000);

  it("I2 短超时返回 waitSettled=false，再次 wait 至停点", async () => {
    const { taskId } = await dispatchSleep(3000);
    const first = await callTool(ts.client, "wait_task", { taskId, timeoutMs: 500 });
    const firstMeta = parseMeta(first.text).meta;
    expect(firstMeta).not.toBeNull();
    expect(firstMeta!.waitSettled).toBe(false);
    expect(first.text).toMatch(/超时/);

    const second = await callTool(ts.client, "wait_task", { taskId, timeoutMs: 20_000 });
    const secondMeta = parseMeta(second.text).meta;
    expect(secondMeta!.waitSettled).toBe(true);
    expect(STOP_POINTS).toContain(secondMeta!.status);
  }, 60_000);

  it("I3 不存在的任务报错（对齐 query_task 文案）", async () => {
    const { res, text } = await callTool(ts.client, "wait_task", { taskId: "tsk_not_exist_xxx" });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/任务不存在/);
  });

  it("I4 等待期间 cancel_task 即时生效（SDK 请求互不阻塞）", async () => {
    const { taskId } = await dispatchSleep(8000);
    const waitP = callTool(ts.client, "wait_task", { taskId, timeoutMs: 20_000 });
    await new Promise((r) => setTimeout(r, 300));
    const cancelStarted = Date.now();
    const c = await callTool(ts.client, "manage_task", { action: "cancel", taskId, reason: "集成测试：等待中取消" });
    // cancel 本身不能在 wait 结束前被阻塞
    expect(Date.now() - cancelStarted).toBeLessThan(5_000);
    expect(parseMeta(c.text).meta?.status).toBe("cancelled");

    const w = await waitP;
    const wMeta = parseMeta(w.text).meta;
    expect(wMeta!.waitSettled).toBe(true);
    expect(wMeta!.status).toBe("cancelled");
  }, 60_000);
});

describe("wait_any 端到端", () => {
  it("I5 返回数组顺序首个到达停点的任务", async () => {
    const slow = await dispatchSleep(6000);
    const fast = await dispatchSleep(700);
    // 数组顺序把「慢的」放前面：结果必须是「快的」（数组里首个已停）
    const { text } = await callTool(ts.client, "wait_task", {
      taskIds: [slow.taskId, fast.taskId],
      timeoutMs: 20_000,
    });
    const { meta } = parseMeta(text);
    expect(meta).not.toBeNull();
    expect(meta!.waitSettled).toBe(true);
    expect(meta!.taskId).toBe(fast.taskId);
    // 正文列出全部任务当前状态
    expect(text).toContain(slow.taskId);
    expect(text).toContain(fast.taskId);
  }, 60_000);

  it("I6 缺一即报错（fail-closed，列出缺失 id）", async () => {
    const a = await dispatchSleep(700);
    const { res, text } = await callTool(ts.client, "wait_task", {
      taskIds: [a.taskId, "tsk_missing_yyy"],
      timeoutMs: 5_000,
    });
    expect(res.isError).toBe(true);
    expect(text).toMatch(/任务不存在/);
    expect(text).toContain("tsk_missing_yyy");
  }, 60_000);
});
