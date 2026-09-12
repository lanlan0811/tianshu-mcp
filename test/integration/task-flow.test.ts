/**
 * M1 集成测试：stub-agent 三剧本全链路（开发计划 §14）。
 * 用真实 buildServer + 官方 SDK client（in-memory transport），
 * stub 作为外部 agent 子进程被 spawn，验收引擎真实跑命令与 git 分析。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import {
  startTestServer,
  makeGitProject,
  callTool,
  parseMeta,
  waitForTerminal,
  rmrf,
  type TestServer,
} from "../test-utils.js";
import type { Playbook } from "../test-utils.js";

let ts: TestServer;
const projectCache = new Map<Playbook, string>();
const tempDirs: string[] = [];

async function projectFor(playbook: Playbook): Promise<string> {
  if (projectCache.has(playbook)) return projectCache.get(playbook)!;
  const p = await makeGitProject(playbook);
  projectCache.set(playbook, p);
  tempDirs.push(p);
  return p;
}

async function disableRequireChanges(projectPath: string): Promise<void> {
  const acceptancePath = path.join(projectPath, ".tianshu-mcp", "acceptance.json");
  const acceptance = JSON.parse(await fs.readFile(acceptancePath, "utf8"));
  acceptance.requireChanges = false;
  await fs.writeFile(acceptancePath, JSON.stringify(acceptance, null, 2), "utf8");
}

beforeAll(async () => {
  ts = await startTestServer();
}, 60_000);

afterAll(async () => {
  await ts?.close();
  for (const d of tempDirs) await rmrf(d).catch(() => {});
  if (ts) await rmrf(ts.home).catch(() => {});
});

describe("run_task → 自动验收（good 剧本）", () => {
  it("一次通过，报告与 changedFiles 就绪", async () => {
    const proj = await projectFor("good");
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "请实现：新建 done.txt，内容为 PASS，确保验收检查通过。",
      autoVerify: true,
      autoFixRounds: 0,
    });
    const { meta } = parseMeta(text);
    expect(meta).not.toBeNull();
    const taskId = meta!.taskId as string;
    expect(taskId).toMatch(/^tsk_/);

    const final = await waitForTerminal(ts.client, taskId);
    expect(final.status).toBe("succeeded");
    expect(final.agentId).toBe("stub");
    expect((final.changedFiles as string[]) ?? []).toContain("done.txt");

    // 报告可读
    const report = await callTool(ts.client, "get_task_report", { taskId });
    expect(report.text).toContain("done-marker");
    expect(report.text).toContain("验收");
  }, 60_000);
});

describe("自动返修（fix-on-first 剧本）", () => {
  it("第一轮写坏 → 验收失败 → 自动返修 → 第二轮通过", async () => {
    const proj = await projectFor("fix-on-first");
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "新建 done.txt 内容为 PASS，让验收检查通过。",
      autoVerify: true,
      autoFixRounds: 1,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    const final = await waitForTerminal(ts.client, taskId);
    expect(final.status).toBe("succeeded");
    expect(final.round).toBe(2); // 2 轮 agent + 2 次验收

    // done.txt 最终应为 PASS
    const content = await fs.readFile(path.join(proj, "done.txt"), "utf8");
    expect(content.trim()).toBe("PASS");

    // fixing 事件存在
    const list = await callTool(ts.client, "list_tasks", { projectPath: proj });
    expect(list.text).toContain(taskId);
  }, 90_000);
});

describe("needs_attention（never 剧本）", () => {
  it("返修轮次用尽 → needs_attention，保留报告可回溯", async () => {
    const proj = await projectFor("never");
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "新建 done.txt 内容为 PASS，让验收检查通过。",
      autoVerify: true,
      autoFixRounds: 2,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    const final = await waitForTerminal(ts.client, taskId);
    expect(final.status).toBe("needs_attention");
    expect(final.round).toBe(3); // 初跑 + 2 轮返修

    // 可读报告
    const report = await callTool(ts.client, "get_task_report", { taskId });
    expect(report.text).toContain("done-marker");
    const content = await fs.readFile(path.join(proj, "done.txt"), "utf8");
    expect(content.trim()).toBe("FAIL");
  }, 120_000);
});

describe("手动 rework_task（入口 B）", () => {
  it("验收失败(failed) → rework_task 带反馈 → 再次验收通过", async () => {
    const proj = await makeGitProject("fix-on-first");
    tempDirs.push(proj);
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "新建 done.txt 内容为 PASS，让验收检查通过。",
      autoVerify: true,
      autoFixRounds: 0,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    const failed = await waitForTerminal(ts.client, taskId);
    expect(failed.status).toBe("failed"); // 未开自动返修 → failed

    // 手动返修：把失败摘要作为 feedback
    const rw = await callTool(ts.client, "rework_task", {
      taskId,
      feedback: "上一轮验收失败：done.txt 内容必须是 PASS。请修复。",
    });
    const rwMeta = parseMeta(rw.text).meta;
    expect(rwMeta?.status).toBe("queued");

    const final = await waitForTerminal(ts.client, taskId);
    expect(final.status).toBe("succeeded");
  }, 120_000);
});

describe("verify_task 手动验收（独立工具）", () => {
  it("对已完成项目做验收：PASS → succeeded", async () => {
    const proj = await projectFor("good");
    await disableRequireChanges(proj);
    // 先让 stub 产出 PASS
    await fs.writeFile(path.join(proj, "done.txt"), "PASS\n", "utf8");
    const { text } = await callTool(ts.client, "verify_task", {
      projectPath: proj,
    });
    const { meta } = parseMeta(text);
    expect(meta?.ok).toBe(true);
    expect(meta?.status).toBe("succeeded");
  }, 60_000);

  it("对不满足条件的项目：验收失败", async () => {
    const proj = await projectFor("never");
    await fs.writeFile(path.join(proj, "done.txt"), "FAIL\n", "utf8");
    const { text } = await callTool(ts.client, "verify_task", { projectPath: proj });
    const { meta } = parseMeta(text);
    expect(meta?.ok).toBe(false);
    expect(meta?.status).toBe("failed");
  }, 60_000);
});

describe("cancel_task", () => {
  it("排队中任务可取消（同项目串行队列队尾）", async () => {
    // 全新项目：A 占用串行队列，B 排队，取消 B
    const busy = await makeGitProject("good");
    tempDirs.push(busy);
    await callTool(ts.client, "run_task", {
      projectPath: busy,
      agentId: "stub",
      task: "占用任务：新建 done.txt 为 PASS。",
      autoVerify: false,
    });
    const { text: bText } = await callTool(ts.client, "run_task", {
      projectPath: busy,
      agentId: "stub",
      task: "排队取消对象：新建 done.txt 为 PASS。",
      autoVerify: false,
    });
    const taskId = (parseMeta(bText).meta!.taskId as string) ?? "";
    // B 此刻应 queued；取消
    const c = await callTool(ts.client, "cancel_task", { taskId, reason: "测试取消排队任务" });
    const cMeta = parseMeta(c.text).meta;
    expect(cMeta?.status).toBe("cancelled");
    const q = await callTool(ts.client, "query_task", { taskId });
    expect(parseMeta(q.text).meta?.status).toBe("cancelled");
  }, 60_000);
});
