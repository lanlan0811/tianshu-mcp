/**
 * 集成测试：repairHint 贯通到下一轮 agent 任务书，且自动 repairDirectives 落进返修计划（issue #19）。
 *
 * 用真实 buildServer + stub agent：stub 把收到的 prompt 写进日志，因此可以直接断言
 * 「结构化修复提示」块确实进了任务书 —— 这是本 issue 的核心交付点，不能只测中间层。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
let project: string;

beforeAll(async () => {
  ts = await startTestServer();
  // fix-on-first：首轮验收失败、返修后通过 —— 必然生成返修计划与返修任务书
  project = await makeGitProject("fix-on-first");
}, 60_000);

afterAll(async () => {
  await ts?.close();
  if (project) await rmrf(project).catch(() => {});
  if (ts) await rmrf(ts.home).catch(() => {});
});

async function runFailingTask(): Promise<string> {
  const { text } = await callTool(ts.client, "run_task", {
    projectPath: project,
    agentId: "stub",
    task: "请实现：让验收检查通过。",
    autoVerify: true,
    // 0 = 不自动返修 → 任务落 failed，交给手动 rework_task 触发
    autoFixRounds: 0,
  });
  const taskId = parseMeta(text).meta!.taskId as string;
  const final = await waitForTerminal(ts.client, taskId);
  expect(final.status).toBe("failed");
  return taskId;
}

/** 读取任务目录下全部产物文件内容（返修计划、agent 日志） */
async function readTaskArtifacts(taskId: string): Promise<string> {
  const dir = path.join(ts.home, "tasks", taskId);
  const names = await fsp.readdir(dir);
  const parts: string[] = [];
  for (const n of names) {
    if (!/\.(md|log|txt)$/.test(n)) continue;
    parts.push(await fsp.readFile(path.join(dir, n), "utf8").catch(() => ""));
  }
  return parts.join("\n");
}

describe("rework_task 的 repairHint（issue #19）", () => {
  it("repairHint 以【结构化修复提示】块进入下一轮任务书", async () => {
    const taskId = await runFailingTask();

    const hint = "src/done.txt:1 — 内容应为 PASS 而非 TODO → 把该行改为 PASS";
    const { text } = await callTool(ts.client, "rework_task", {
      taskId,
      feedback: "请按提示修复后重跑验收。",
      repairHint: hint,
    });
    const meta = parseMeta(text).meta!;
    expect(meta.taskId).toBe(taskId);
    // 响应里明示携带了结构化提示
    expect(text).toContain("结构化修复提示");

    await waitForTerminal(ts.client, taskId);
    const artifacts = await readTaskArtifacts(taskId);
    expect(artifacts).toContain("【结构化修复提示】");
    expect(artifacts).toContain(hint);
    // 提示排在整段 feedback 之前
    const iHint = artifacts.indexOf("【结构化修复提示】");
    const iFeedback = artifacts.indexOf("请按提示修复后重跑验收。");
    expect(iHint).toBeGreaterThan(-1);
    expect(iFeedback).toBeGreaterThan(iHint);
  }, 60_000);

  it("不传 repairHint 时行为与既有版本一致（任务书里没有该块）", async () => {
    const taskId = await runFailingTask();

    await callTool(ts.client, "rework_task", {
      taskId,
      feedback: "请修复。",
    });
    await waitForTerminal(ts.client, taskId);

    const artifacts = await readTaskArtifacts(taskId);
    expect(artifacts).toContain("请修复。");
    expect(artifacts).not.toContain("【结构化修复提示】");
  }, 60_000);

  it("repairHint 超长（>4000 字符）被协议层拒绝", async () => {
    const taskId = await runFailingTask();
    const res = await ts.client.callTool({
      name: "rework_task",
      arguments: { taskId, repairHint: "x".repeat(4001) },
    });
    expect(res.isError).toBe(true);
  }, 60_000);
});

describe("自动返修计划中的结构化指令（issue #19）", () => {
  it("返修计划文件含 2.5 节（可用或有原因的回退段），且 report.json 持久化了 repairDirectives", async () => {
    const proj = await makeGitProject("fix-on-first");
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "请实现：让验收检查通过。",
      autoVerify: true,
      autoFixRounds: 2,
    });
    const taskId = parseMeta(text).meta!.taskId as string;
    await waitForTerminal(ts.client, taskId);
    await rmrf(proj).catch(() => {});

    // 第 0 轮失败 → 生成 rework-<taskId>-r0.md
    const md = await fsp.readFile(
      path.join(ts.home, "tasks", taskId, `rework-${taskId}-r0.md`),
      "utf8",
    );
    expect(md).toContain("## 2.5 结构化修复指令");
    // 要么给可执行指令，要么显式说明不可用 —— 不允许静默留空
    const usable = md.includes("## 2.5 结构化修复指令（可直接执行）");
    const fallback = md.includes("## 2.5 结构化修复指令（不可用，回退完整报告）");
    expect(usable || fallback).toBe(true);
    if (fallback) expect(md).toContain("阅读第 2 节的完整失败输出");

    // report.json 持久化（跨重启与手动返修路径依赖它）
    const json = JSON.parse(
      await fsp.readFile(path.join(ts.home, "tasks", taskId, "report-0.json"), "utf8"),
    ) as { repairDirectives?: unknown };
    expect(json.repairDirectives).toBeTruthy();
  }, 90_000);
});
