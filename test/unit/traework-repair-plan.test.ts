/**
 * 单元测试：返修计划生成（开发计划 §4.5 步骤 7 / 决策 17）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTmpRoot } from "../test-utils.js";
import { renderRepairPlan, writeRepairPlan } from "../../src/loop/repair-plan.js";
import type { VerifyReport } from "../../src/tasks/task.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function report(over: Partial<VerifyReport> = {}): VerifyReport {
  return {
    round: 0,
    taskId: "tsk_test",
    projectPath: "d:/trae项目/demo",
    startedAt: "2026-09-08T10:00:00.000Z",
    finishedAt: "2026-09-08T10:01:00.000Z",
    passed: false,
    verdict: "failed",
    checks: [
      {
        name: "typecheck",
        cmd: "npm run typecheck",
        passed: false,
        durationMs: 1200,
        exitCode: 2,
        outputTail: "src/a.ts(3,5): error TS2322",
        timeout: false,
      },
      {
        name: "lint",
        cmd: "npm run lint",
        passed: true,
        durationMs: 800,
        exitCode: 0,
        outputTail: "ok",
        timeout: false,
      },
      {
        name: "test",
        cmd: "npm run test",
        passed: false,
        durationMs: 300,
        exitCode: null,
        outputTail: "",
        timeout: false,
        skipped: true,
        reason: "脚本不存在",
      },
    ],
    analysis: {
      changedFiles: ["src/a.ts"],
      untrackedFiles: ["src/b.ts"],
      diffstat: { totalAdd: 12, totalDel: 3, perFile: [] },
      signals: { todo: 1, consoleDebug: 2, commentedBlock: 0, secretLike: 0 },
      bigFileChanges: [],
      warnings: ["检测到 console.log"],
      notes: ["package.json 缺少 build 脚本"],
    },
    files: { md: "/tmp/report-0.md", json: "/tmp/report-0.json" },
    message: "验收失败",
    ...over,
  };
}

const baseInput = () => ({
  taskId: "tsk_test",
  round: 0,
  projectPath: "d:/trae项目/demo",
  displayPath: "D:\\Trae项目\\demo",
  taskText: "实现用户登录接口",
  report: report(),
  taskDir: "",
  logger: silentLogger,
});

describe("renderRepairPlan", () => {
  it("包含失败项、命令与输出", () => {
    const md = renderRepairPlan(baseInput());
    expect(md).toContain("第 1 轮返修");
    expect(md).toContain("tsk_test");
    expect(md).toContain("typecheck");
    expect(md).toContain("npm run typecheck");
    expect(md).toContain("error TS2322");
  });

  it("列出已通过项（勿破坏）并标注跳过项", () => {
    const md = renderRepairPlan(baseInput());
    expect(md).toContain("[PASS] lint");
    expect(md).toContain("[SKIP] test");
    expect(md).toContain("脚本不存在");
  });

  it("包含代码分析：变更清单、diffstat、可疑标记", () => {
    const md = renderRepairPlan(baseInput());
    expect(md).toContain("src/a.ts");
    expect(md).toContain("src/b.ts");
    expect(md).toContain("+12 -3");
    expect(md).toContain("console.log");
  });

  it("包含修复要求（定向修复、不伪造通过）", () => {
    const md = renderRepairPlan(baseInput());
    expect(md).toContain("只针对第 2 节的失败项定向修复");
    expect(md).toContain("不要伪造通过");
  });

  it("无失败项时说明可能来自代码分析", () => {
    const md = renderRepairPlan({
      ...baseInput(),
      report: report({
        checks: [
          {
            name: "lint",
            cmd: "x",
            passed: true,
            durationMs: 1,
            exitCode: 0,
            outputTail: "",
            timeout: false,
          },
        ],
      }),
    });
    expect(md).toContain("无硬失败项");
  });
});

describe("writeRepairPlan", () => {
  it("只写入任务目录，不污染项目 .tianshu-mcp", async () => {
    const root = await makeTmpRoot("repair");
    const taskDir = path.join(root, "tasks", "tsk_test");
    const projectDir = path.join(root, "proj");
    fs.mkdirSync(projectDir, { recursive: true });
    const r = await writeRepairPlan({
      ...baseInput(),
      projectPath: projectDir,
      taskDir,
      logger: silentLogger,
    });
    expect(r.fileName).toBe("rework-tsk_test-r0.md");
    expect(fs.existsSync(r.taskPath)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, ".tianshu-mcp", r.fileName))).toBe(false);
    expect(fs.readFileSync(r.taskPath, "utf8")).toContain("修复计划");
  });

  it("项目目录不可写时不影响任务目录计划", async () => {
    const root = await makeTmpRoot("repair2");
    const taskDir = path.join(root, "tasks", "tsk_test");
    // projectPath 指向一个文件（不可作为目录写入）
    const bogus = path.join(root, "afile");
    fs.writeFileSync(bogus, "x");
    const r = await writeRepairPlan({
      ...baseInput(),
      projectPath: bogus,
      taskDir,
      logger: silentLogger,
    });
    expect(fs.existsSync(r.taskPath)).toBe(true);
  });
});
