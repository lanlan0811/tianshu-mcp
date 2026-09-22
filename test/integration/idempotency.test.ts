/**
 * 幂等键集成测试（issue #15）：证明「宿主重试」不再产生重复副作用。
 *
 * 覆盖：
 * - run_task：同键重放（同 taskId / 不新建目录）、同键异参 fail-closed、终态也照实重放、未传 key 零回归、
 *   未传 key 时的「同工作区在途任务」提示
 * - verify_task：已完成重放（不新增报告、同轮次）、执行中重放（成功结果 + in_progress）、taskId 模式重放
 * - 跨重启：映射落盘后重建 server，同键仍能重放（派单与验收各一）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import {
  startTestServer,
  makeGitProject,
  callTool,
  parseMeta,
  waitForTerminal,
  rmrf,
  type TestServer,
} from "../test-utils.js";

let ts: TestServer;
const cleanup: string[] = [];

beforeAll(async () => {
  ts = await startTestServer();
}, 60_000);
afterAll(async () => {
  await ts?.close();
  for (const d of cleanup) await rmrf(d);
  if (ts) await rmrf(ts.home).catch(() => {});
});

async function listDir(p: string): Promise<string[]> {
  return fsp.readdir(p).catch(() => [] as string[]);
}

/** 数据目录里某一类记录目录（tsk_ / vfy_） */
async function recordDirs(home: string, prefix: string): Promise<string[]> {
  return (await listDir(path.join(home, "tasks"))).filter((d) => d.startsWith(prefix));
}

/** 某个记录目录内的验收报告文件（排序后便于比较） */
async function reportFiles(home: string, taskId: string): Promise<string[]> {
  return (await listDir(path.join(home, "tasks", taskId)))
    .filter((f) => /^report-\d+\.(md|json)$/.test(f))
    .sort();
}

function slowCheckScript(ms: number): string[] {
  return [process.execPath, "-e", `setTimeout(() => console.log("slow check done"), ${ms})`];
}

describe("run_task 幂等键（issue #15）", () => {
  it("同键重复提交返回原 taskId、不新建任务；终态也照实重放", async () => {
    const proj = await makeGitProject("good");
    cleanup.push(proj);
    const args = {
      projectPath: proj,
      agentId: "stub",
      task: "写 done.txt（同键重试用例）",
      autoVerify: true,
      autoFixRounds: 0,
      idempotencyKey: "it-run-replay",
    };
    const first = await callTool(ts.client, "run_task", args);
    const firstMeta = parseMeta(first.text).meta!;
    const taskId = firstMeta.taskId as string;
    expect(firstMeta.idempotencyKey).toBe("it-run-replay");
    expect(first.text).not.toContain("幂等重放：该 idempotencyKey");

    await waitForTerminal(ts.client, taskId, 60_000);
    // 重试（模拟 tools/call 超时后宿主重发）：必须重放，不得再排队一轮 agent
    const again = await callTool(ts.client, "run_task", args);
    const againMeta = parseMeta(again.text).meta!;
    expect(againMeta.taskId).toBe(taskId);
    expect(againMeta.idempotencyReplay).toBe("hit");
    expect(again.text).toContain("幂等重放");
    expect(again.text).toContain("rework_task");
    expect(await recordDirs(ts.home, "tsk_")).toHaveLength(1);
  }, 120_000);

  it("同键异参 fail-closed，且不新建任务", async () => {
    const proj = await makeGitProject("good");
    cleanup.push(proj);
    const key = "it-run-conflict";
    const first = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "原始任务",
      autoVerify: false,
      idempotencyKey: key,
    });
    const taskId = parseMeta(first.text).meta!.taskId as string;
    const before = await recordDirs(ts.home, "tsk_");

    const conflict = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "换了参数的任务",
      autoVerify: false,
      idempotencyKey: key,
    });
    expect(conflict.res.isError).toBe(true);
    expect(conflict.text).toContain("idempotencyKey");
    expect(conflict.text).toContain(taskId);
    expect(parseMeta(conflict.text).meta).toBeNull(); // 错误结果不带 meta 块
    expect(await recordDirs(ts.home, "tsk_")).toHaveLength(before.length);
  }, 60_000);

  it("不传幂等键时行为不变：两次派发得到两个不同 taskId", async () => {
    const proj = await makeGitProject("good");
    cleanup.push(proj);
    const base = { projectPath: proj, agentId: "stub", task: "两次无键派发", autoVerify: false };
    const a = await callTool(ts.client, "run_task", base);
    const b = await callTool(ts.client, "run_task", base);
    const idA = parseMeta(a.text).meta!.taskId as string;
    const idB = parseMeta(b.text).meta!.taskId as string;
    expect(idA).not.toBe(idB);
    expect(parseMeta(a.text).meta!.idempotencyKey).toBeUndefined();
    expect(parseMeta(a.text).meta!.idempotencyReplay).toBeUndefined();
  }, 60_000);

  it("不传幂等键且同工作区已有在途任务时点名提示", async () => {
    const proj = await makeGitProject("sleep", { sleepMs: 6000 });
    cleanup.push(proj);
    const first = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "长跑任务（重复派单提示用例）",
      autoVerify: false,
      idempotencyKey: "it-run-hint",
    });
    const firstId = parseMeta(first.text).meta!.taskId as string;

    const second = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "同一项目的第二次派单",
      autoVerify: false,
    });
    const hint = parseMeta(second.text).meta!.projectActiveTask as
      | { taskId: string; status: string }
      | undefined;
    expect(hint?.taskId).toBe(firstId);
    expect(second.text).toContain("已有未结束任务");
    await callTool(ts.client, "cancel_task", { taskId: firstId, reason: "用例收尾" });
    await callTool(ts.client, "cancel_task", {
      taskId: parseMeta(second.text).meta!.taskId as string,
      reason: "用例收尾",
    });
  }, 60_000);
});

describe("verify_task 幂等键（issue #15）", () => {
  it("独立路径已完成重放：同轮次、不新增报告、不重跑", async () => {
    const proj = await makeGitProject("good");
    cleanup.push(proj);
    const args = {
      projectPath: proj,
      // replace 让它只跑这一条：省时间且不依赖项目内配置
      extraChecks: [{ name: "noop", cmd: [process.execPath, "-c", "0"] }],
      checksMode: "replace" as const,
      idempotencyKey: "it-verify-replay",
    };
    const first = await callTool(ts.client, "verify_task", args);
    const firstMeta = parseMeta(first.text).meta!;
    const recordId = firstMeta.taskId as string;
    const round = firstMeta.reportRound;
    const filesAfterFirst = await reportFiles(ts.home, recordId);
    expect(filesAfterFirst.length).toBe(2); // report-<round>.md + .json

    const again = await callTool(ts.client, "verify_task", args);
    const againMeta = parseMeta(again.text).meta!;
    expect(again.res.isError).toBeFalsy();
    expect(againMeta.idempotencyReplay).toBe("hit");
    expect(againMeta.taskId).toBe(recordId);
    expect(againMeta.reportRound).toBe(round);
    expect(againMeta.latestVerificationVerdict).toBe(firstMeta.latestVerificationVerdict);
    expect(again.text).toContain("未重跑");
    expect(await reportFiles(ts.home, recordId)).toEqual(filesAfterFirst);
  }, 120_000);

  it("执行中重放：返回成功结果 + in_progress，且不并发执行第二遍", async () => {
    const proj = await makeGitProject("good");
    cleanup.push(proj);
    const key = "it-verify-inflight";
    const args = {
      projectPath: proj,
      extraChecks: [{ name: "slow", cmd: slowCheckScript(4000) }],
      checksMode: "replace" as const,
      idempotencyKey: key,
    };
    const [a, b] = await Promise.all([
      callTool(ts.client, "verify_task", args),
      callTool(ts.client, "verify_task", args),
    ]);
    const metas = [parseMeta(a.text).meta!, parseMeta(b.text).meta!];
    const inProgress = metas.filter((m) => m.idempotencyReplay === "in_progress");
    const executed = metas.filter((m) => m.idempotencyReplay === undefined);
    expect(inProgress).toHaveLength(1);
    expect(executed).toHaveLength(1);
    // 执行中命中必须是**成功结果**，不得是 isError（否则宿主会再重试放大）
    const inProgressRes = parseMeta(a.text).meta?.idempotencyReplay === "in_progress" ? a : b;
    expect(inProgressRes.res.isError).toBeFalsy();
    expect(inProgressRes.text).toContain("仍在执行中");

    const recordId = executed[0]!.taskId as string;
    // 执行完成后同一 key 变为已完成重放
    const after = await callTool(ts.client, "verify_task", args);
    const afterMeta = parseMeta(after.text).meta!;
    expect(afterMeta.idempotencyReplay).toBe("hit");
    expect(afterMeta.taskId).toBe(recordId);
    expect((await reportFiles(ts.home, recordId)).filter((f) => f.endsWith(".md"))).toHaveLength(1);
  }, 120_000);

  it("taskId 模式同键重放：同 reportRound、不新增报告", async () => {
    const proj = await makeGitProject("good");
    cleanup.push(proj);
    const run = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "任务验收幂等用例",
      autoVerify: true,
      autoFixRounds: 0,
    });
    const taskId = parseMeta(run.text).meta!.taskId as string;
    await waitForTerminal(ts.client, taskId, 60_000);
    const filesBefore = await reportFiles(ts.home, taskId);

    const args = { taskId, idempotencyKey: "it-verify-taskid" };
    const first = await callTool(ts.client, "verify_task", args);
    const firstMeta = parseMeta(first.text).meta!;
    const filesAfterFirst = await reportFiles(ts.home, taskId);
    expect(filesAfterFirst.length).toBeGreaterThan(filesBefore.length);

    const again = await callTool(ts.client, "verify_task", args);
    const againMeta = parseMeta(again.text).meta!;
    expect(againMeta.idempotencyReplay).toBe("hit");
    expect(againMeta.taskId).toBe(taskId);
    expect(againMeta.reportRound).toBe(firstMeta.reportRound);
    expect(await reportFiles(ts.home, taskId)).toEqual(filesAfterFirst);
  }, 120_000);
});

describe("幂等映射跨 server 重启（issue #15）", () => {
  it("重启后同键的派单与验收都仍能重放", async () => {
    const proj = await makeGitProject("good");
    cleanup.push(proj);
    const first = await startTestServer();
    const home = first.home;
    try {
      const runArgs = {
        projectPath: proj,
        agentId: "stub",
        task: "跨重启幂等用例",
        autoVerify: false,
        idempotencyKey: "it-restart-run",
      };
      const planned = await callTool(first.client, "run_task", runArgs);
      const taskId = parseMeta(planned.text).meta!.taskId as string;
      await waitForTerminal(first.client, taskId, 60_000);

      const verifyArgs = {
        projectPath: proj,
        extraChecks: [{ name: "noop", cmd: [process.execPath, "-c", "0"] }],
        checksMode: "replace" as const,
        idempotencyKey: "it-restart-verify",
      };
      const verified = await callTool(first.client, "verify_task", verifyArgs);
      const recordId = parseMeta(verified.text).meta!.taskId as string;
      await first.close();

      // 同一数据目录重建 server：映射文件必须已落盘
      const second = await startTestServer({ home });
      try {
        const replayRun = await callTool(second.client, "run_task", runArgs);
        const replayRunMeta = parseMeta(replayRun.text).meta!;
        expect(replayRunMeta.taskId).toBe(taskId);
        expect(replayRunMeta.idempotencyReplay).toBe("hit");

        const replayVerify = await callTool(second.client, "verify_task", verifyArgs);
        const replayVerifyMeta = parseMeta(replayVerify.text).meta!;
        expect(replayVerifyMeta.taskId).toBe(recordId);
        expect(replayVerifyMeta.idempotencyReplay).toBe("hit");
      } finally {
        await second.close();
      }
    } finally {
      await rmrf(home).catch(() => {});
    }
  }, 180_000);
});
