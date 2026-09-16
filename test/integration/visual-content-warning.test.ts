import { afterEach, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AcceptanceEngine } from "../../src/verify/acceptance.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { Logger } from "../../src/util/log.js";
import { loadSharp } from "../../src/visual/runtime.js";
import { renderRepairPlan } from "../../src/loop/repair-plan.js";
import type { VerifyReport } from "../../src/tasks/task.js";

/**
 * 告警可见性与返修隔离（issue #13 计划 §5 G 组 / P4、E 组）：
 * blocking=false 的内容告警（命令失败 blocked / 判定不确定 uncertain）不改变 verdict、
 * 不进 blockingIssues，但必须在整轮 message 可见，且**不得**被返修计划列为「必须修复」。
 * 同时锁定既有缺陷修复：optional 检查失败也不再被列为必须修复。
 */
const JUDGE = path.resolve("test/fixtures/content-judge.mjs");
const dirs: string[] = [];

async function run(mode: string): Promise<{ report: VerifyReport; passed: boolean }> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "视觉 告警-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "视觉 告警-home-"));
  dirs.push(project, home);
  await fs.mkdir(path.join(project, "assets"), { recursive: true });
  await fs.mkdir(path.join(project, ".tianshu-mcp"), { recursive: true });
  const sharp = await loadSharp();
  await sharp({ create: { width: 4, height: 4, channels: 3, background: "#3355aa" } })
    .png()
    .toFile(path.join(project, "assets", "logo.png"));
  await fs.writeFile(
    path.join(project, ".tianshu-mcp", "acceptance.json"),
    JSON.stringify({
      checks: [],
      requireChanges: false,
      visual: {
        enabled: true,
        content: {
          enabled: true,
          command: process.execPath,
          argsTemplate: [JUDGE, "--image", "<image:path>", "--expect-file", "<expect:file>"],
          samples: 2,
          timeoutMs: 30_000,
        },
        contents: [
          {
            id: "logo",
            files: ["assets/logo.png"],
            expect: "blue gear with TIANSHU text",
            blocking: false,
          },
        ],
      },
    }),
  );
  const saved = process.env.CONTENT_JUDGE_MODE;
  const savedCounter = process.env.CONTENT_JUDGE_COUNTER;
  process.env.CONTENT_JUDGE_MODE = mode;
  // flip 模式按累计调用次数交替：计数文件让两次采样一正一反（平票）
  process.env.CONTENT_JUDGE_COUNTER = path.join(project, ".tianshu-mcp", "judge-counter.txt");
  const logger = new Logger(null, "error");
  const store = new TaskStore(home, logger);
  const engine = new AcceptanceEngine(store, logger);
  try {
    return await engine.runVerify({
      taskId: `tsk_content_warning_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      projectPath: project,
      displayPath: project,
      round: 0,
      store,
      logger,
    });
  } finally {
    await engine.close();
    if (saved === undefined) delete process.env.CONTENT_JUDGE_MODE;
    else process.env.CONTENT_JUDGE_MODE = saved;
    if (savedCounter === undefined) delete process.env.CONTENT_JUDGE_COUNTER;
    else process.env.CONTENT_JUDGE_COUNTER = savedCounter;
  }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

it("a blocked warning item is visible in the round message but gates nothing", async () => {
  const { report, passed } = await run("exit");
  expect(passed).toBe(true);
  const result = report.visual!.results[0]!;
  expect(result.optional).toBe(true);
  expect(result.status).toBe("blocked");
  expect(report.blockingIssues ?? []).toEqual([]);
  expect(report.message).toContain(
    "AI 内容告警未通过（不影响结论）: logo [CONTENT_COMMAND_FAILED]",
  );
  // 告警项不进返修计划的「必须修复」
  const plan = renderRepairPlan({
    taskId: report.taskId,
    round: 0,
    projectPath: report.projectPath,
    displayPath: report.projectPath,
    taskText: "test",
    report,
    taskDir: "",
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  expect(plan).toContain("仅告警项（不必修复）");
  expect(plan).toContain("[WARN] logo");
  expect(plan).toContain("不得为消除告警而伪造产物");
  // 「必须修复」小节（第 2 节）不含该告警项
  const section2 = plan.split("## 2. 失败项（必须修复）")[1]!.split("## 3.")[0]!;
  expect(section2).not.toContain("logo");
});

it("uncertain items are visible as a warning line and never gate the round", async () => {
  const { report, passed } = await run("flip");
  expect(passed).toBe(true);
  const result = report.visual!.results[0]!;
  expect(result.status).toBe("uncertain");
  expect(report.blockingIssues ?? []).toEqual([]);
  expect(report.message).toContain("AI 内容判定不确定（仅告警）: logo");
  const plan = renderRepairPlan({
    taskId: report.taskId,
    round: 0,
    projectPath: report.projectPath,
    displayPath: report.projectPath,
    taskText: "test",
    report,
    taskDir: "",
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  });
  expect(plan).toContain("仅告警项（不必修复）");
  const section2 = plan.split("## 2. 失败项（必须修复）")[1]!.split("## 3.")[0]!;
  expect(section2).not.toContain("logo");
});
