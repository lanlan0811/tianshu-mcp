import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MACOS_FOLDER_DIALOG_UNAVAILABLE,
  closeStrayDialogs,
  listOwnedDialogs,
  selectOpenDesignFolder,
  toNativeDialogPath,
} from "../../src/agents/opendesign/dialog.js";
import {
  buildOpenDesignFixPrompt,
  fixPlanFileName,
  renderOpenDesignFixPlan,
  resolvePlanDir,
  writeOpenDesignFixPlan,
} from "../../src/agents/opendesign/fixplan.js";
import type { VerifyReport } from "../../src/tasks/task.js";

const isWin = process.platform === "win32";

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("Open Design 原生对话框：路径归一", () => {
  it("盘符大写 + 反斜杠（原生选择器拒绝正斜杠）", () => {
    expect(toNativeDialogPath("d:/trae项目/tianshu-mcp")).toBe("D:\\trae项目\\tianshu-mcp");
    expect(toNativeDialogPath("D:\\Trae\\App\\")).toBe("D:\\Trae\\App");
    expect(toNativeDialogPath("c:\\a\\\\b")).toBe("C:\\a\\b");
  });

  it("仅盘符时补成盘根（win32.normalize 会补出 `d:.`）", () => {
    expect(toNativeDialogPath("d:")).toBe("D:\\");
    expect(toNativeDialogPath("D:\\")).toBe("D:\\");
  });

  it("相对路径按当前工作目录解析为绝对路径（对话框只接受绝对路径）", () => {
    const out = toNativeDialogPath("some/rel");
    expect(path.win32.isAbsolute(out)).toBe(true);
    expect(out.endsWith("some\\rel")).toBe(true);
  });

  it("空/空白路径返回空串（调用方据此 fail-closed，绝不把 `.` 塞进对话框）", () => {
    // 回归：win32.normalize('') 会返回 '.'，曾被当成有效路径送进对话框
    expect(toNativeDialogPath("")).toBe("");
    expect(toNativeDialogPath("   ")).toBe("");
  });
});

describe("Open Design 原生对话框：平台与空输入守卫", () => {
  it("无 pid 时不调用任何 PowerShell（返回空集/0）", async () => {
    expect(await listOwnedDialogs([])).toEqual([]);
    expect(await closeStrayDialogs([])).toBe(0);
  });

  it("非 Windows 平台 fail-closed，且错误信息可操作", async () => {
    if (isWin) {
      // Windows 上真实探测允许返回数组（不同机器残留不同），只断言形状
      expect(Array.isArray(await listOwnedDialogs([process.pid]))).toBe(true);
      return;
    }
    expect(await listOwnedDialogs([process.pid])).toEqual([]);
    const res = await selectOpenDesignFolder("D:\\x", [1], []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("platform");
  });

  it("macOS 有固定说法（不写未验证的 osascript 流程）", () => {
    expect(MACOS_FOLDER_DIALOG_UNAVAILABLE).toContain("macOS");
  });

  it("空路径直接拒绝，不启动脚本", async () => {
    const res = await selectOpenDesignFolder("", [1], []);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("error");
  });
});

/* ------------------------------ fixplan ------------------------------ */

function makeReport(over: Partial<VerifyReport> = {}): VerifyReport {
  return {
    round: 1,
    taskId: "tsk_od_1",
    projectPath: "D:\\proj",
    startedAt: "2026-09-26T00:00:00.000Z",
    finishedAt: "2026-09-26T00:01:00.000Z",
    passed: false,
    verdict: "failed",
    checks: [
      {
        name: "build",
        cmd: "npm run build",
        passed: false,
        durationMs: 1234,
        exitCode: 1,
        outputTail: "error TS2345: 参数类型不匹配",
        timeout: false,
      },
      {
        name: "lint",
        cmd: "npm run lint",
        passed: true,
        durationMs: 200,
        exitCode: 0,
        outputTail: "",
        timeout: false,
      },
      {
        name: "e2e",
        cmd: "npm run e2e",
        passed: false,
        skipped: true,
        reason: "缺浏览器",
        durationMs: 0,
        exitCode: null,
        outputTail: "",
        timeout: false,
      },
    ],
    analysis: {
      changedFiles: ["src/app.ts"],
      untrackedFiles: ["dist/index.html"],
      diffstat: { totalAdd: 10, totalDel: 2, perFile: [] },
      signals: { todo: 1, consoleDebug: 0, commentedBlock: 0, secretLike: 0 },
      bigFileChanges: [],
      warnings: ["未发现测试文件"],
      notes: ["建议补 README"],
    },
    files: {
      md: "D:\\proj\\.tianshu-mcp\\reports\\r1.md",
      json: "D:\\proj\\.tianshu-mcp\\reports\\r1.json",
    },
    message: "验收未通过",
    ...over,
  };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-od-fix-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响断言 */
  }
});

describe("Open Design 修复计划：路径与文件名", () => {
  it("文件名含轮次号（每轮独立、不覆盖）", () => {
    expect(fixPlanFileName(1)).toBe("opendesign-fix-r1.md");
    expect(fixPlanFileName(3)).toBe("opendesign-fix-r3.md");
  });

  it("相对目录按项目根展开，且相对路径用正斜杠（要写进指令）", () => {
    const r = resolvePlanDir("D:\\proj");
    expect(r.rel).toBe(".opendesign/plans");
    expect(r.abs).toBe(path.join("D:\\proj", ".opendesign", "plans"));

    const custom = resolvePlanDir("D:\\proj", "design/plans/");
    expect(custom.rel).toBe("design/plans");
  });

  it("绝对目录原样使用（不拼项目前缀），并给出项目内相对形式", () => {
    const abs = path.join(tmpRoot, "plans");
    const r = resolvePlanDir(tmpRoot, abs);
    expect(r.abs).toBe(abs);
    expect(r.rel).toBe("plans");
  });

  it("绝对目录在项目外时，rel 用绝对路径转正斜杠（不谎称它是项目内相对路径）", () => {
    const outside = path.join(os.tmpdir(), "outside-plans");
    const r = resolvePlanDir(tmpRoot, outside);
    expect(r.abs).toBe(outside);
    expect(r.rel).not.toContain("..");
    expect(r.rel.includes("\\")).toBe(false);
  });
});

describe("Open Design 修复计划：正文渲染", () => {
  it("分节齐全：未通过项 / 视觉差异 / 通过项 / 跳过项 / 代码分析 / 修复要求", () => {
    const md = renderOpenDesignFixPlan({
      taskId: "tsk_od_1",
      round: 1,
      projectPath: "D:\\proj",
      displayPath: "D:\\proj",
      taskText: "做一个订单跟踪页面",
      report: makeReport(),
      logger,
    });
    expect(md).toContain("# Open Design 修复/优化计划（第 1 轮返修）");
    expect(md).toContain("做一个订单跟踪页面");
    expect(md).toContain("### 2.1 build");
    expect(md).toContain("error TS2345");
    expect(md).toContain("[PASS] lint");
    expect(md).toContain("[SKIP] e2e（缺浏览器）");
    expect(md).toContain("## 5. 代码分析结果");
    expect(md).toContain("## 6. 修复/优化要求");
    // 「不要伪造通过」这条纪律必须在计划里明写
    expect(md).toContain("不要伪造通过");
  });

  it("无视觉结果时如实写「没有视觉验收结果」，不编造差异", () => {
    const md = renderOpenDesignFixPlan({
      taskId: "t",
      round: 0,
      projectPath: "D:\\proj",
      displayPath: "D:\\proj",
      taskText: "x",
      report: makeReport({ visual: undefined }),
      logger,
    });
    expect(md).toContain("（本轮没有视觉验收结果）");
  });

  it("有视觉结果时给出可操作粒度：目标/视口/结论/差异/产物 + 逐条失败原因", () => {
    const md = renderOpenDesignFixPlan({
      taskId: "t",
      round: 2,
      projectPath: "D:\\proj",
      displayPath: "D:\\proj",
      taskText: "x",
      report: makeReport({
        visual: {
          artifactDirectory: "D:\\proj\\.tianshu-mcp\\visual\\r2",
          artifactBytes: 1024,
          results: [
            {
              id: "home-desktop",
              kind: "page",
              target: "/index.html",
              viewport: "desktop",
              status: "failed",
              optional: false,
              code: "diff_ratio_exceeded",
              message: "差异比例 0.021 超过阈值 0.001",
              durationMs: 500,
              repairable: true,
              metrics: { diffRatio: 0.021, diffPixels: 1234 },
              artifacts: { diff: "D:\\proj\\.tianshu-mcp\\visual\\r2\\home-diff.png" },
            },
            {
              id: "about-mobile",
              kind: "page",
              target: "/about.html",
              viewport: "mobile",
              status: "passed",
              optional: false,
              code: "ok",
              message: "一致",
              durationMs: 300,
              repairable: false,
              metrics: { diffRatio: 0 },
            },
          ],
        },
      }),
      logger,
    });
    expect(md).toContain("**未通过**（1 项失败 / 共 2 项）");
    expect(md).toContain("home-desktop");
    expect(md).toContain("desktop");
    expect(md).toContain("0.021000");
    expect(md).toContain("home-diff.png");
    expect(md).toContain("差异比例 0.021 超过阈值 0.001");
    expect(md).toContain("about-mobile");
  });
});

describe("Open Design 修复计划：落盘", () => {
  it("写到项目根下 .opendesign/plans，返回相对 + 绝对路径", async () => {
    const projectPath = path.join(tmpRoot, "proj");
    fs.mkdirSync(projectPath, { recursive: true });
    const res = await writeOpenDesignFixPlan({
      taskId: "tsk_od_1",
      round: 1,
      projectPath,
      displayPath: projectPath,
      taskText: "做一个落地页",
      report: makeReport(),
      logger,
    });
    expect(res.relPath).toBe(".opendesign/plans/opendesign-fix-r1.md");
    expect(fs.existsSync(res.absPath)).toBe(true);
    expect(fs.readFileSync(res.absPath, "utf8")).toContain("落地页");
  });

  it("多轮各自独立、绝不覆盖历史", async () => {
    const projectPath = path.join(tmpRoot, "proj2");
    fs.mkdirSync(projectPath, { recursive: true });
    const r1 = await writeOpenDesignFixPlan({
      taskId: "t",
      round: 1,
      projectPath,
      displayPath: projectPath,
      taskText: "第一轮目标",
      report: makeReport(),
      logger,
    });
    const r2 = await writeOpenDesignFixPlan({
      taskId: "t",
      round: 2,
      projectPath,
      displayPath: projectPath,
      taskText: "第二轮目标",
      report: makeReport(),
      logger,
    });
    expect(r1.absPath).not.toBe(r2.absPath);
    expect(fs.readFileSync(r1.absPath, "utf8")).toContain("第一轮目标");
    expect(fs.readFileSync(r2.absPath, "utf8")).toContain("第二轮目标");
  });
});

describe("Open Design 返修指令", () => {
  it("含未通过说明 + 计划文档相对路径 + 报告路径", () => {
    const prompt = buildOpenDesignFixPrompt({
      summary: "视觉验收 2 项未通过",
      planRelPath: ".opendesign/plans/opendesign-fix-r1.md",
      reportPath: "D:\\proj\\.tianshu-mcp\\reports\\r1.md",
      evidence: "diff 0.021",
    });
    expect(prompt).toContain("上一轮验收未通过");
    expect(prompt).toContain(".opendesign/plans/opendesign-fix-r1.md");
    expect(prompt).toContain("视觉验收 2 项未通过");
    expect(prompt).toContain("diff 0.021");
    expect(prompt).toContain("r1.md");
    expect(prompt).toContain("不要大范围重做");
  });

  it("无证据/无报告路径时不留空块", () => {
    const prompt = buildOpenDesignFixPrompt({ summary: "失败", planRelPath: "p.md" });
    expect(prompt).not.toContain("关键证据");
    expect(prompt).not.toContain("完整验收报告");
  });
});
