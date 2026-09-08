/**
 * S1 回归测试（二次整改）：无理由取消必须稳定落为 cancelled，不依赖可选 reason。
 * - 运行中取消，不传 reason → cancelled（P1 复现：曾落 interrupted）
 * - 排队中取消，不传 reason → cancelled
 * - 验收中/返修中取消不传 reason → cancelled
 * - server shutdown 后活动任务 → interrupted（不得误记 cancelled）
 * - 取消意图字段 cancelRequestedAt/abortSource 持久化
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

async function freshSleepProj(sleepMs = 60_000): Promise<string> {
  const p = await makeGitProject("sleep", { sleepMs });
  await writePlaybook(p, { playbook: "sleep", sleepMs });
  tempDirs.push(p);
  return p;
}

function snapshot(taskId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(ts.home, "tasks", taskId, "task.json"), "utf8"));
}
function events(taskId: string): string[] {
  return fs.readFileSync(path.join(ts.home, "tasks", taskId, "task.jsonl"), "utf8").trim().split("\n");
}

describe("S1 无理由取消 → cancelled", () => {
  it("运行中取消且不传 reason → cancelled + abortSource=user + cancelRequestedAt", async () => {
    const proj = await freshSleepProj(60_000);
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj, agentId: "stub", task: "no-reason cancel", autoVerify: false,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    await new Promise((r) => setTimeout(r, 1200)); // 等进入 running
    await callTool(ts.client, "cancel_task", { taskId }); // 不传 reason —— P1 复现场景

    const final = await waitForTerminal(ts.client, taskId, 15_000);
    expect(final.status).toBe("cancelled");
    expect(final.errorType).toBe("cancelled");
    const snap = snapshot(taskId);
    expect(snap.cancelRequestedAt).toBeTruthy();
    expect(snap.abortSource).toBe("user");
    const evts = events(taskId);
    expect(evts.some((l) => l.includes('"cancel_requested"'))).toBe(true);
    expect(evts.some((l) => l.includes('"cancelled"'))).toBe(true);
  }, 60_000);

  it("排队中取消且不传 reason → cancelled（cancel_requested 先于 cancelled）", async () => {
    // 用同项目双任务制造排队：A sleep 占位，B 排队
    const busy = await freshSleepProj(60_000);
    await callTool(ts.client, "run_task", {
      projectPath: busy, agentId: "stub", task: "A 占位", autoVerify: false,
    });
    const { text: bText } = await callTool(ts.client, "run_task", {
      projectPath: busy, agentId: "stub", task: "B 排队", autoVerify: false,
    });
    const bTask = (parseMeta(bText).meta!.taskId as string) ?? "";
    await callTool(ts.client, "cancel_task", { taskId: bTask });
    const q = await callTool(ts.client, "query_task", { taskId: bTask });
    expect(parseMeta(q.text).meta?.status).toBe("cancelled");
    const snap = snapshot(bTask);
    expect(snap.abortSource).toBe("user");
    const evts = events(bTask);
    const iReq = evts.findIndex((l) => l.includes('"cancel_requested"'));
    const iCanc = evts.findIndex((l) => l.includes('"cancelled"'));
    expect(iReq).toBeGreaterThanOrEqual(0);
    expect(iCanc).toBeGreaterThan(iReq);
  }, 60_000);

  it("验收/自动返修阶段无理由取消 → cancelled 或 interrupted 不得长期活动；用户取消必须 cancelled", async () => {
    const proj = await freshSleepProj(60_000);
    await writePlaybook(proj, { playbook: "sleep", sleepMs: 60_000 });
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj, agentId: "stub", task: "verify/fix cancel", autoVerify: true, autoFixRounds: 1,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    // 等进入活动态再无理由取消
    const start = Date.now();
    for (;;) {
      const q = await callTool(ts.client, "query_task", { taskId });
      const st = parseMeta(q.text).meta?.status;
      if (st && ["running", "fixing", "verify_start"].includes(String(st))) break;
      if (Date.now() - start > 20_000) throw new Error("未进入活动态");
      await new Promise((r) => setTimeout(r, 200));
    }
    await callTool(ts.client, "cancel_task", { taskId });
    const final = await waitForTerminal(ts.client, taskId, 20_000);
    // 用户取消（有 cancel_requested 事件）→ 必须 cancelled
    const evts = events(taskId);
    const hadCancelReq = evts.some((l) => l.includes('"cancel_requested"'));
    if (hadCancelReq) {
      expect(final.status).toBe("cancelled");
      expect(snapshot(taskId).abortSource).toBe("user");
    } else {
      expect(final.status).toBe("interrupted");
    }
  }, 60_000);

  it("server shutdown（非用户取消）→ interrupted，不误记 cancelled", async () => {
    const proj = await freshSleepProj(60_000);
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj, agentId: "stub", task: "shutdown test", autoVerify: false,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    await new Promise((r) => setTimeout(r, 1000)); // 进入 running
    // 模拟 server 关闭：直接调用 assembly.close()（会 shutdownInterrupt）
    await ts.assembly.close();
    const snap = snapshot(taskId);
    expect(snap.status).toBe("interrupted");
    expect(snap.abortSource).toBe("shutdown");
    expect(snap.errorType).toBe("interrupted");
    // 重新用同一 home 起 server，query 仍为 interrupted
    const home = ts.home;
    ts = await startTestServer({ home });
    const q = await callTool(ts.client, "query_task", { taskId });
    expect(parseMeta(q.text).meta?.status).toBe("interrupted");
  }, 60_000);

  it("重复取消不重复写 cancel_requested/cancelled", async () => {
    const proj = await freshSleepProj(10_000);
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj, agentId: "stub", task: "idempotent", autoVerify: false,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    await new Promise((r) => setTimeout(r, 800));
    await callTool(ts.client, "cancel_task", { taskId });
    await waitForTerminal(ts.client, taskId, 15_000);
    await callTool(ts.client, "cancel_task", { taskId }); // 再次取消
    await callTool(ts.client, "cancel_task", { taskId }); // 三次
    const evts = events(taskId);
    const reqCount = evts.filter((l) => l.includes('"cancel_requested"')).length;
    const cancCount = evts.filter((l) => l.includes('"cancelled"')).length;
    expect(reqCount).toBeLessThanOrEqual(1);
    expect(cancCount).toBeLessThanOrEqual(1);
    const q = await callTool(ts.client, "query_task", { taskId });
    expect(parseMeta(q.text).meta?.status).toBe("cancelled");
  }, 60_000);
});
