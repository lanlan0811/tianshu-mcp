/**
 * R4 回归测试：MCP 工具参数语义。
 * - get_task_report(round=0) 合法
 * - 手动 verify_task(taskId) 分配下一可用轮次，不覆盖 report-0
 * - extraChecks 追加（不替换基础门禁）；checksMode=replace 才替换
 * - optional:true 失败不影响 verdict；必选失败影响
 * - baselineRef：git ref 有效/无效
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
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

describe("R4 get_task_report round 语义", () => {
  it("round=0 显式读取合法；缺省返回最新", async () => {
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    await writePlaybook(proj, { playbook: "good" });
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "good 一次通过",
      autoVerify: true,
      autoFixRounds: 1,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    const final = await waitForTerminal(ts.client, taskId, 30_000);
    expect(final.status).toBe("succeeded");
    // round=0 显式读
    const r0 = await callTool(ts.client, "get_task_report", { taskId, round: 0 });
    expect(r0.text).toContain("第 0 轮");
    // 缺省读最新
    const latest = await callTool(ts.client, "get_task_report", { taskId });
    expect(latest.text).toContain("验收");
  }, 60_000);
});

describe("R4/S4 手动 verify_task 轮次与元数据", () => {
  it("verify_task(taskId) 写 report-1，返回 reportRound=1，query 指向 report-1，agentId 保留", async () => {
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    await writePlaybook(proj, { playbook: "good" });
    // 先跑一次任务产生 report-0（autoVerify succeeded）
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: proj,
      agentId: "stub",
      task: "产生 report-0",
      autoVerify: true,
    });
    const taskId = (parseMeta(text).meta!.taskId as string) ?? "";
    await waitForTerminal(ts.client, taskId, 30_000);
    const dir = path.join(ts.home, "tasks", taskId);
    expect(fs.existsSync(path.join(dir, "report-0.md"))).toBe(true);

    // 手动 verify_task(taskId) —— S4：返回 meta.reportRound=1 且不覆盖 report-0
    const v = await callTool(ts.client, "verify_task", { taskId });
    const vMeta = parseMeta(v.text).meta;
    expect(vMeta?.reportRound).toBe(1);
    expect(vMeta?.verificationSource).toBe("manual");
    expect(vMeta?.agentId).toBe("stub"); // 保留原 agentId，不得改成 manual-verify
    expect(fs.existsSync(path.join(dir, "report-0.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "report-1.md"))).toBe(true);

    // S4：后续 query_task 指向 report-1，lastMessage/diffstat 与手动验收一致
    const q = await callTool(ts.client, "query_task", { taskId });
    const qMeta = parseMeta(q.text).meta;
    expect(qMeta?.reportRound).toBe(1);
    expect((qMeta?.reportFiles as { md?: string } | undefined)?.md).toContain("report-1.md");
    expect(qMeta?.message).toContain("[PASS] 手动验收");

    // get_task_report() 缺省返回 report-1；round=0 返回 report-0
    const r0 = await callTool(ts.client, "get_task_report", { taskId, round: 0 });
    expect(r0.text).toContain("第 0 轮");
    const rLatest = await callTool(ts.client, "get_task_report", { taskId });
    expect(rLatest.text).toContain("第 1 轮");
  }, 60_000);
});

describe("R4 extraChecks / optional 语义", () => {
  it("extraChecks 追加：基础门禁仍执行", async () => {
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    await writePlaybook(proj, { playbook: "good" });
    await fsp.writeFile(path.join(proj, "done.txt"), "PASS\n", "utf8");
    const { text } = await callTool(ts.client, "verify_task", {
      projectPath: proj,
      extraChecks: [{ name: "extra-node", cmd: ["node", "--version"] }],
    });
    const { meta } = parseMeta(text);
    // 读取 report 文件确认各检查都执行了（追加）
    const reportPath = (meta?.reportFiles as { json: string } | undefined)?.json;
    expect(reportPath).toBeTruthy();
    const report = JSON.parse(await fsp.readFile(reportPath!, "utf8"));
    const names = report.checks.map((c: { name: string }) => c.name);
    expect(names).toContain("extra-node");
    expect(names).toContain("done-marker"); // 项目验收配置仍执行（追加）
    expect(names).toContain("git-diff-check"); // 内置检查
  }, 60_000);

  it("optional 检查失败不影响 verdict（passed=true）", async () => {
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    await fsp.writeFile(path.join(proj, "done.txt"), "PASS\n", "utf8");
    const { text } = await callTool(ts.client, "verify_task", {
      projectPath: proj,
      extraChecks: [
        { name: "opt-fail", cmd: ["node", "-e", "process.exit(1)"], optional: true },
        { name: "opt-pass", cmd: ["node", "-e", "process.exit(0)"], optional: true },
      ],
    });
    const { meta } = parseMeta(text);
    expect(meta?.ok).toBe(true);
    expect(meta?.status).toBe("succeeded");
    const reportPath = (meta?.reportFiles as { json: string } | undefined)?.json;
    const report = JSON.parse(await fsp.readFile(reportPath!, "utf8"));
    const optFail = report.checks.find((c: { name: string }) => c.name === "opt-fail");
    expect(optFail.passed).toBe(false);
    expect(optFail.optional).toBe(true);
    expect(report.message).toContain("optional 检查未通过");
  }, 60_000);
});

describe("R4 baselineRef", () => {
  it("无效 git ref 返回结构化错误；有效 ref 可用于独立项目验收", async () => {
    const proj = await makeGitProject("good");
    tempDirs.push(proj);
    // 无效 ref
    const bad = await callTool(ts.client, "verify_task", { projectPath: proj, baselineRef: "no-such-ref-xyz" });
    expect(bad.res.isError).toBe(true);
    expect(bad.text).toContain("baselineRef");
    // 有效 ref：当前 HEAD
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: proj, encoding: "utf8" }).trim();
    const ok = await callTool(ts.client, "verify_task", { projectPath: proj, baselineRef: head });
    expect(ok.res.isError).toBe(false);
  }, 60_000);
});
