/**
 * 集成测试：三级验收配置继承（issue #20）。
 *
 * 用真实 buildServer + stub agent 走完整 MCP 层，验证：
 * - 任务级 acceptanceOverride 生效（判定结果随之改变），且**只影响当次任务**；
 * - 全局 acceptance.default.json 参与合并，且优先级低于项目层；
 * - 全局文件缺失时不报错，行为与引入本能力前一致；
 * - 全局文件写坏时 fail-closed（needs_attention），而不是静默忽略。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import {
  startTestServer,
  makeGitProject,
  callTool,
  parseMeta,
  waitForTerminal,
  gitInitAndCommit,
  rmrf,
  type TestServer,
} from "../test-utils.js";

let ts: TestServer;
const tempProjects: string[] = [];
const GLOBAL_FILE = (): string => path.join(ts.home, "acceptance.default.json");

const PASS_CHECK = { name: "always-pass", cmd: ["node", "-e", "process.exit(0)"] };

beforeAll(async () => {
  ts = await startTestServer();
}, 60_000);

afterEach(async () => {
  // 全局层是跨测试共享的：每个用例后必须清掉，避免污染后续用例
  await fsp.rm(GLOBAL_FILE(), { force: true }).catch(() => {});
});

afterAll(async () => {
  await fsp.rm(GLOBAL_FILE(), { force: true }).catch(() => {});
  await ts?.close();
  for (const p of tempProjects) await rmrf(p).catch(() => {});
  if (ts) await rmrf(ts.home).catch(() => {});
});

/** never 剧本：done.txt 写 FAIL → 项目自带的 done-marker 检查必然失败 */
async function newFailingProject(playbook: "never" | "good" = "never"): Promise<string> {
  const p = await makeGitProject(playbook);
  tempProjects.push(p);
  return p;
}

async function writeGlobal(config: unknown): Promise<void> {
  await fsp.writeFile(GLOBAL_FILE(), JSON.stringify(config, null, 2), "utf8");
}

async function overwriteProjectAcceptance(projectPath: string, config: unknown): Promise<void> {
  await fsp.writeFile(
    path.join(projectPath, ".tianshu-mcp", "acceptance.json"),
    JSON.stringify(config, null, 2),
    "utf8",
  );
  await gitInitAndCommit(projectPath);
}

async function runTask(
  projectPath: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { text } = await callTool(ts.client, "run_task", {
    projectPath,
    agentId: "stub",
    task: "请实现：让验收检查通过。",
    autoVerify: true,
    autoFixRounds: 0,
    ...extra,
  });
  const meta = parseMeta(text).meta;
  expect(meta, `run_task 未返回 meta：${text.slice(0, 400)}`).not.toBeNull();
  const taskId = meta!.taskId as string;
  return waitForTerminal(ts.client, taskId);
}

async function readReport(taskId: string, round = 0): Promise<{ checks: { name: string }[] }> {
  const json = await fsp.readFile(
    path.join(ts.home, "tasks", taskId, `report-${round}.json`),
    "utf8",
  );
  return JSON.parse(json) as { checks: { name: string }[] };
}

describe("任务级 acceptanceOverride（issue #20）", () => {
  it("覆盖 checks 后判定结果随之改变，且只影响当次任务", async () => {
    const project = await newFailingProject("never");

    // ① 不传覆盖：项目自带 done-marker 检查失败 → failed
    const base = await runTask(project);
    expect(base.status).toBe("failed");

    // ② 传覆盖：checks 整体替换为必然通过的检查 → succeeded
    const overridden = await runTask(project, {
      acceptanceOverride: { checks: [PASS_CHECK], requireChanges: false },
    });
    expect(overridden.status).toBe("succeeded");
    const overriddenReport = await readReport(overridden.taskId as string);
    expect(overriddenReport.checks.map((c) => c.name)).toContain("always-pass");
    expect(overriddenReport.checks.map((c) => c.name)).not.toContain("done-marker");

    // ③ 兄弟任务（同项目、不传覆盖）：回到项目自己的配置 → 仍 failed
    const sibling = await runTask(project);
    expect(sibling.status).toBe("failed");
    const siblingReport = await readReport(sibling.taskId as string);
    expect(siblingReport.checks.map((c) => c.name)).toContain("done-marker");
  }, 120_000);

  it("verify_task 也接受 acceptanceOverride（仅本次验收生效）", async () => {
    const project = await newFailingProject("never");
    const task = await runTask(project);
    expect(task.status).toBe("failed");

    // 注意：verify_task 只产出报告，不改写任务状态（任务仍停在 failed），
    // 因此判定要看**验收结论**而不是 meta.status。
    const withOverride = await callTool(ts.client, "verify_task", {
      taskId: task.taskId as string,
      acceptanceOverride: { checks: [PASS_CHECK], requireChanges: false },
    });
    expect(withOverride.text).toContain("[PASS] 手动验收通过");
    const roundWithOverride = parseMeta(withOverride.text).meta!.reportRound as number;

    // 不带覆盖再验一次：同项目配置重新生效 → 失败（证明覆盖没有粘在这次验收上）
    const plain = await callTool(ts.client, "verify_task", { taskId: task.taskId as string });
    expect(plain.text).toContain("[FAIL] 手动验收失败");
    const roundPlain = parseMeta(plain.text).meta!.reportRound as number;
    expect(roundPlain).toBeGreaterThan(roundWithOverride);
  }, 120_000);

  it("无项目模式拒绝 acceptanceOverride（没有项目验收可覆盖）", async () => {
    const res = await ts.client.callTool({
      name: "run_task",
      arguments: {
        agentId: "zcode",
        task: "无项目任务",
        acceptanceOverride: { requireChanges: false },
      },
    });
    const text = (res.content as { type?: string; text?: string }[])
      .map((c) => c.text ?? "")
      .join("\n");
    expect(text).toContain("acceptanceOverride");
    expect(text).toContain("无项目模式");
  }, 60_000);
});

describe("全局层 acceptance.default.json（issue #20）", () => {
  it("全局层参与合并；缺失时该层为空、行为与既有版本一致", async () => {
    const project = await newFailingProject("good");
    // 项目层不声明 checks（只关掉 requireChanges），让基础集空出来以观察全局层
    await overwriteProjectAcceptance(project, { requireChanges: false });

    // ① 全局缺失：无检查项 → 通过，且报告里没有全局层的检查
    const withoutGlobal = await runTask(project);
    expect(withoutGlobal.status).toBe("succeeded");
    const r1 = await readReport(withoutGlobal.taskId as string);
    expect(r1.checks.map((c) => c.name)).not.toContain("global-check");

    // ② 写入全局层：其 checks 被采用
    await writeGlobal({ checks: [PASS_CHECK] });
    const withGlobal = await runTask(project);
    expect(withGlobal.status).toBe("succeeded");
    const r2 = await readReport(withGlobal.taskId as string);
    expect(r2.checks.map((c) => c.name)).toContain("always-pass");
  }, 120_000);

  it("项目层优先于全局层（同名字段以项目为准）", async () => {
    const project = await newFailingProject("never");
    await overwriteProjectAcceptance(project, {
      checks: [{ name: "project-check", cmd: ["node", "-e", "process.exit(0)"] }],
    });
    await writeGlobal({ checks: [PASS_CHECK] });

    const final = await runTask(project);
    expect(final.status).toBe("succeeded");
    const report = await readReport(final.taskId as string);
    expect(report.checks.map((c) => c.name)).toContain("project-check");
    expect(report.checks.map((c) => c.name)).not.toContain("always-pass");
  }, 120_000);

  it("全局文件写坏 → fail-closed（needs_attention，消息指明该层）", async () => {
    const project = await newFailingProject("good");
    await fsp.writeFile(GLOBAL_FILE(), "{ 这不是合法 JSON", "utf8");

    const final = await runTask(project);
    expect(final.status).toBe("needs_attention");
    expect(String(final.message ?? "")).toMatch(/global/);
  }, 120_000);
});
