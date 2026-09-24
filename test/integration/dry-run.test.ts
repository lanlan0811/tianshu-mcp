/**
 * 集成测试：run_task 的 dryRun 干跑模式（issue #21）。
 *
 * 用真实 buildServer + stub agent 走完整 MCP 层：
 * - 合规预演（只写计划）→ succeeded，且项目源码零改动（git status 里只有 .tianshu-mcp/ 产物）；
 * - 违规预演（偷改源码）→ needs_attention + dry_run_violation；
 * - 产物分离：dry-run 报告不消耗验收轮次、不与 report-<round>.* 撞车；
 * - 「先审后做」闭环：dryRun 产出的方案文档可作为后续正式任务的 planDoc 输入。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  startTestServer,
  makeGitProject,
  callTool,
  parseMeta,
  waitForTerminal,
  writePlaybook,
  rmrf,
  STUB_SCRIPT,
  type TestServer,
} from "../test-utils.js";

let ts: TestServer;
const projects: string[] = [];

beforeAll(async () => {
  ts = await startTestServer();
}, 60_000);

afterAll(async () => {
  await ts?.close();
  for (const p of projects) await rmrf(p).catch(() => {});
  if (ts) await rmrf(ts.home).catch(() => {});
});

async function newProject(playbook: "dry-run-plan" | "dry-run-edit" | "good"): Promise<string> {
  const p = await makeGitProject(playbook);
  projects.push(p);
  return p;
}

function gitStatus(projectPath: string): string[] {
  const out = execFileSync("git", ["status", "--porcelain"], {
    cwd: projectPath,
    encoding: "utf8",
  });
  return out.split(/\r?\n/).filter((l) => l.trim() !== "");
}

async function runDry(
  projectPath: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { text } = await callTool(ts.client, "run_task", {
    projectPath,
    agentId: "stub",
    task: "请先给出实现方案。",
    dryRun: true,
    ...extra,
  });
  const meta = parseMeta(text).meta;
  expect(meta, `run_task 未返回 meta：${text.slice(0, 400)}`).not.toBeNull();
  return waitForTerminal(ts.client, meta!.taskId as string, 90_000);
}

describe("dryRun 合规预演", () => {
  it("只写计划、不动源码 → succeeded，git status 里只有 .tianshu-mcp/ 产物", async () => {
    const project = await newProject("dry-run-plan");
    const before = gitStatus(project);

    const final = await runDry(project);
    expect(final.status).toBe("succeeded");
    expect(final.dryRun).toBe(true);
    // dryRun 报告与方案文档分开暴露
    const files = final.dryRunReportFiles as { md?: string; json?: string } | undefined;
    expect(files?.md).toContain("dry-run-report-0.md");
    expect(final.dryRunPlanDoc).toBe(`.tianshu-mcp/dry-run-plan-${final.taskId as string}.md`);

    // 源码零改动：所有变更都必须落在 MCP 自己的 .tianshu-mcp/ 目录下
    const after = gitStatus(project);
    const changed = after.filter((l) => !before.includes(l)).map((l) => l.slice(3).trim());
    expect(changed.length).toBeGreaterThan(0); // 计划与方案文档确实写出来了
    for (const f of changed) expect(f.startsWith(".tianshu-mcp/")).toBe(true);
    // 尤其：fixture 里的源码文件没被动过
    expect(changed).not.toContain("README.md");
    expect(changed).not.toContain("done.txt");
  }, 120_000);

  it("静态分析报告不消耗验收轮次：report-0.json 不存在，dry-run-report-0.json 才存在", async () => {
    const project = await newProject("dry-run-plan");
    const final = await runDry(project);
    const taskDir = path.join(ts.home, "tasks", final.taskId as string);
    const names = await fsp.readdir(taskDir);

    expect(names).toContain("dry-run-report-0.md");
    expect(names).toContain("dry-run-report-0.json");
    // 关键：dryRun 不产生常规验收产物（否则会污染轮次记账与报告列表）
    expect(names.filter((n) => /^report-\d+\./.test(n))).toEqual([]);

    const json = JSON.parse(await fsp.readFile(path.join(taskDir, "dry-run-report-0.json"), "utf8"));
    expect(json.kind).toBe("dry-run");
    expect(json.planExtracted).toBe(true);
    expect(json.passed).toBe(true);
  }, 120_000);

  it("dryRun 的只读约束进入任务书（agent 能看到「不得改动源码」）", async () => {
    const project = await newProject("dry-run-plan");
    const final = await runDry(project);
    const taskDir = path.join(ts.home, "tasks", final.taskId as string);
    const names = await fsp.readdir(taskDir);
    const logs = names.filter((n) => /^agent-\d+\.log$/.test(n));
    const text = (
      await Promise.all(logs.map((n) => fsp.readFile(path.join(taskDir, n), "utf8")))
    ).join("\n");

    expect(text).toContain("dryRun 只读预演");
    expect(text).toContain("不得创建、修改或删除任何源文件");
    expect(text).toContain("dry-run-plan.json");
    expect(text).toContain("不跑 typecheck / test / build");
  }, 120_000);
});

describe("dryRun 违规预演", () => {
  it("偷改源码 → needs_attention，且报告里是 dry_run_violation 阻断项", async () => {
    const project = await newProject("dry-run-edit");
    const final = await runDry(project);

    // 方案本身有问题属人工裁决，刻意不是 failed（并非代码缺陷）
    expect(final.status).toBe("needs_attention");

    const json = JSON.parse(
      await fsp.readFile(
        path.join(ts.home, "tasks", final.taskId as string, "dry-run-report-0.json"),
        "utf8",
      ),
    ) as { passed: boolean; findings: { code: string; severity: string }[] };
    expect(json.passed).toBe(false);
    const violation = json.findings.find((f) => f.code === "dry_run_violation")!;
    expect(violation.severity).toBe("error");
  }, 120_000);
});

describe("dryRun 开关语义", () => {
  it("默认关闭：不传 dryRun 时行为与既有版本一致（走常规验收）", async () => {
    const project = await newProject("good");
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: project,
      agentId: "stub",
      task: "请实现：让验收检查通过。",
      autoVerify: true,
      autoFixRounds: 0,
    });
    const taskId = parseMeta(text).meta!.taskId as string;
    const final = await waitForTerminal(ts.client, taskId);
    expect(final.status).toBe("succeeded");
    expect(final.dryRun).toBeUndefined();

    const names = await fsp.readdir(path.join(ts.home, "tasks", taskId));
    // 常规路径产出 report-0.*，而不是 dry-run-report-*
    expect(names.some((n) => /^report-\d+\.md$/.test(n))).toBe(true);
    expect(names.some((n) => n.startsWith("dry-run-report-"))).toBe(false);
  }, 120_000);

  it("dryRun 忽略 autoVerify（即便传 true 也走静态分析）", async () => {
    const project = await newProject("dry-run-plan");
    const final = await runDry(project, { autoVerify: true, autoFixRounds: 2 });
    expect(final.status).toBe("succeeded");
    const names = await fsp.readdir(path.join(ts.home, "tasks", final.taskId as string));
    expect(names.some((n) => /^report-\d+\./.test(n))).toBe(false);
  }, 120_000);

  it("无项目模式拒绝 dryRun（没有可静态分析的基线）", async () => {
    // 无项目模式要求 agentId=zcode；CI 上没装，故桩化 profile 使其可解析。
    // 注意：本文件是**共享** agent-profiles.json 的，重写时必须把 stub 一起写回去，
    // 否则后续用例连 stub 都解析不到（实测：会让「先审后做闭环」整条超时）。
    await fsp.writeFile(
      path.join(ts.home, "agent-profiles.json"),
      JSON.stringify(
        {
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
            zcode: {
              displayName: "ZCode (stubbed for portability)",
              type: "cli",
              driver: "spawn",
              status: "ready",
              command: process.execPath,
              argsTemplate: [STUB_SCRIPT, "<prompt:arg>"],
              promptMode: "arg",
              cwd: "task",
              env: {},
              timeoutMs: 120_000,
              killTree: "taskkill",
              authNote: "test-only stub override",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const res = await ts.client.callTool({
      name: "run_task",
      arguments: { agentId: "zcode", task: "无项目任务", dryRun: true },
    });
    const text = (res.content as { type?: string; text?: string }[])
      .map((c) => c.text ?? "")
      .join("\n");
    expect(text).toContain("无项目模式");
    expect(text).toContain("dryRun");
  }, 60_000);
});

describe("先审后做闭环", () => {
  it("dryRun 产出的方案文档可作为后续正式任务的 planDoc 输入", async () => {
    const project = await newProject("dry-run-plan");
    const dry = await runDry(project);
    const planDoc = dry.dryRunPlanDoc as string;
    expect(planDoc).toBeTruthy();

    // 方案文档确实落在项目内、且内容是可读的实现方案
    const abs = path.join(project, ...planDoc.split("/"));
    const doc = await fsp.readFile(abs, "utf8");
    expect(doc).toContain("dryRun 方案");
    expect(doc).toContain("README.md");
    expect(doc).toContain("尚未实施");

    // 把它作为 planDoc 派发正式任务：被接受并正常执行。
    // 换回 good 剧本——"dry-run-plan" 剧本刻意只产出计划不实施，正式任务需要真的干活。
    await writePlaybook(project, { playbook: "good" });
    const { text } = await callTool(ts.client, "run_task", {
      projectPath: project,
      agentId: "stub",
      task: "请按方案实施。",
      planDoc,
      autoVerify: true,
      autoFixRounds: 0,
    });
    const meta = parseMeta(text).meta;
    expect(meta, `正式派发失败：${text.slice(0, 400)}`).not.toBeNull();
    expect(meta!.dryRun).toBeUndefined();
    const final = await waitForTerminal(ts.client, meta!.taskId as string);
    expect(final.status).toBe("succeeded");
  }, 150_000);
});
