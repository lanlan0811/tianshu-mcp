/**
 * R1 回归测试：运行中/验收中/自动返修中取消的状态机持久化。
 * 断言 cancel_requested → cancelled 事件流 + cancelReason/finishedAt/errorType 落盘；
 * 重启后仍查询到同一终态；重复 cancel 幂等。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  startTestServer,
  makeGitProject,
  writePlaybook,
  callTool,
  parseMeta,
  waitForTerminal,
  rmrf,
  type TestServer,
} from "../test-utils.js";

let ts: TestServer;
const tempDirs: string[] = [];

beforeAll(async () => {
  ts = await startTestServer();
}, 60_000);
afterAll(async () => {
  await ts?.close();
  for (const d of tempDirs) await rmrf(d).catch(() => {});
  if (ts) await rmrf(ts.home).catch(() => {});
});

async function freshProj(playbook = "sleep", sleepMs = 60_000): Promise<string> {
  const p = await makeGitProject("sleep", { sleepMs });
  await writePlaybook(p, { playbook, sleepMs });
  tempDirs.push(p);
  return p;
}

function eventStream(taskId: string): string[] {
  const p = path.join(ts.home, "tasks", taskId, "task.jsonl");
  return fs.readFileSync(p, "utf8").trim().split("\n");
}

describe("R1 运行中任务取消持久化", () => {
  it("运行中 agent 取消 → cancel_requested → cancelled，含 cancelReason/finishedAt", async () => {
    const proj = await freshProj("sleep", 60_000);
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "sleep 任务供取消测试",
      autoVerify: true,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    // 等进入 running
    await new Promise((r) => setTimeout(r, 1200));
    const c = await callTool(ts.client, "cancel_task", { taskId, reason: "R1 测试取消" });
    const cMeta = parseMeta(c.text).meta;
    // cancel_task 是异步：此刻可能是 running（进程将被杀），也可能已落 cancelled
    expect(["cancelled", "running", "fixing", "verify_start", "queued"]).toContain(cMeta?.status);

    const final = await waitForTerminal(ts.client, taskId, 15_000);
    expect(final.status).toBe("cancelled");
    expect(final.errorType).toBe("cancelled");
    expect(final.cancelReason).toBe("R1 测试取消");
    expect(final.finishedAt).toBeTruthy();

    const evts = eventStream(taskId);
    expect(evts.some((l) => l.includes('"cancel_requested"'))).toBe(true);
    expect(evts.some((l) => l.includes('"cancelled"'))).toBe(true);
    // 事件顺序：cancel_requested 在 cancelled 之前
    const iReq = evts.findIndex((l) => l.includes('"cancel_requested"'));
    const iCanc = evts.findIndex((l) => l.includes('"cancelled"'));
    expect(iReq).toBeGreaterThanOrEqual(0);
    expect(iCanc).toBeGreaterThan(iReq);
  }, 60_000);

  it("取消后重建 server 仍查询到 cancelled（持久化恢复）", async () => {
    const proj = await freshProj("sleep", 60_000);
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "持久化取消测试",
      autoVerify: false,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    await new Promise((r) => setTimeout(r, 1000));
    await callTool(ts.client, "cancel_task", { taskId, reason: "持久化" });
    await waitForTerminal(ts.client, taskId, 15_000);

    // 关掉旧 server，用同一数据目录重建
    await ts.close();
    const home = ts.home;
    ts = await startTestServer({ home });

    const q = await callTool(ts.client, "query_task", { taskId });
    const qMeta = parseMeta(q.text).meta;
    expect(qMeta?.status).toBe("cancelled");
    expect(qMeta?.cancelReason).toBe("持久化");
  }, 60_000);

  it("重复 cancel 幂等：终态任务再取消不抛错且状态不变", async () => {
    const proj = await freshProj("sleep", 10_000);
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "幂等取消测试",
      autoVerify: false,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    await new Promise((r) => setTimeout(r, 800));
    await callTool(ts.client, "cancel_task", { taskId, reason: "第一次" });
    await waitForTerminal(ts.client, taskId, 15_000);
    const again = await callTool(ts.client, "cancel_task", { taskId, reason: "第二次" });
    const q = await callTool(ts.client, "query_task", { taskId });
    expect(parseMeta(q.text).meta?.status).toBe("cancelled");
    void again;
  }, 60_000);
});

describe("R1 验收中 / 自动返修中取消", () => {
  it("自动返修等待间隙取消可安全落终态", async () => {
    // never 剧本 + 短超时下 autoFixRounds>0 的循环中触发取消
    const proj = await freshProj("never", 500);
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "验收后取消测试（never 剧本永不通过）",
      autoVerify: true,
      autoFixRounds: 3,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    // 轮询直到进入 fixing/running（非 queued）后取消
    const start = Date.now();
    for (;;) {
      const q = await callTool(ts.client, "query_task", { taskId });
      const st = parseMeta(q.text).meta?.status;
      if (st && ["running", "fixing", "verify_start"].includes(String(st))) break;
      if (Date.now() - start > 20_000) throw new Error("任务未进入活动态");
      await new Promise((r) => setTimeout(r, 200));
    }
    await callTool(ts.client, "cancel_task", { taskId, reason: "返修中取消" });
    const final = await waitForTerminal(ts.client, taskId, 20_000);
    expect(["cancelled", "interrupted"]).toContain(final.status);
    // 若进了 cancelled 则必须是 cancel_requested 驱动的终态；interrupted 仅在 server 关闭类场景
  }, 60_000);
});
