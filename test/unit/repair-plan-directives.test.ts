/**
 * 单元测试：结构化修复指令在各类报告/计划渲染中的呈现与回退（issue #19）。
 *
 * 覆盖三处消费方：report.json（持久化）、report.md、返修计划（通用 + Codex 两套），
 * 以及「提取不可用 ⇒ 显式回退」这一鲁棒性要求。
 */
import { describe, it, expect } from "vitest";
import { renderRepairPlan } from "../../src/loop/repair-plan.js";
import { renderCodexFixPlan } from "../../src/agents/codex/fixplan.js";
import { reportToJsonable, reportToMd } from "../../src/verify/report.js";
import { renderDirectiveSection, renderDirectiveLines } from "../../src/verify/directives.js";
import type { RepairDirectives } from "../../src/verify/directives.js";
import type { AnalysisResult, CheckResult, VerifyReport } from "../../src/tasks/task.js";

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const okCheck: CheckResult = {
  name: "lint",
  cmd: "npm run lint",
  passed: true,
  durationMs: 50,
  exitCode: 0,
  outputTail: "ok",
  timeout: false,
};

const faileCheck: CheckResult = {
  name: "typecheck",
  cmd: "npm run typecheck",
  passed: false,
  durationMs: 80,
  exitCode: 2,
  outputTail: "src/foo.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  timeout: false,
};

const analysis: AnalysisResult = {
  changedFiles: ["src/foo.ts"],
  untrackedFiles: [],
  diffstat: { totalAdd: 4, totalDel: 1, perFile: [] },
  signals: { todo: 1, consoleDebug: 0, commentedBlock: 0, secretLike: 0 },
  bigFileChanges: [],
  warnings: [],
  notes: [],
};

const withDirectives: RepairDirectives = {
  items: [
    {
      file: "src/foo.ts",
      line: 42,
      issue: "TS2322: Type 'string' is not assignable to type 'number'.",
      action: "修正该处类型错误（依据 TS2322 提示）",
      source: "typecheck",
    },
  ],
  sources: ["typecheck"],
};

const unavailable: RepairDirectives = {
  items: [],
  sources: [],
  fallbackReason: "本轮失败原因无法解析为可直接执行的指令（如测试类失败无稳定的文件/行号）",
};

function report(over: Partial<VerifyReport> = {}): VerifyReport {
  return {
    round: 0,
    taskId: "tsk_directives",
    projectPath: "/home/dev/proj",
    displayPath: "/home/dev/proj",
    startedAt: "2026-09-24T00:00:00.000Z",
    finishedAt: "2026-09-24T00:01:00.000Z",
    passed: false,
    verdict: "failed",
    checks: [faileCheck, okCheck],
    analysis,
    files: { md: "/tmp/report-0.md", json: "/tmp/report-0.json" },
    message: "验收失败",
    ...over,
  } as VerifyReport;
}

function planInput(r: VerifyReport) {
  return {
    taskId: r.taskId,
    round: 0,
    projectPath: r.projectPath,
    displayPath: "/home/dev/proj",
    taskText: "实现登录接口",
    report: r,
    taskDir: "/tmp/taskdir",
    logger: silentLogger,
  };
}

function codexInput(r: VerifyReport) {
  return {
    taskId: r.taskId,
    round: 0,
    projectPath: r.projectPath,
    displayPath: "/home/dev/proj",
    taskText: "实现登录接口",
    report: r,
    logger: silentLogger,
  };
}

describe("renderDirectiveSection", () => {
  it("有指令时逐条列出「位置 — 问题 → 动作」", () => {
    const s = renderDirectiveSection(report({ repairDirectives: withDirectives }));
    expect(s).toContain("## 2.5 结构化修复指令（可直接执行）");
    expect(s).toContain("`src/foo.ts:42`");
    expect(s).toContain("TS2322: Type 'string' is not assignable to type 'number'.");
    expect(s).toContain("**修正该处类型错误（依据 TS2322 提示）**");
    expect(s).not.toContain("回退完整报告");
  });

  it("无具体文件的指令不伪造位置", () => {
    const s = renderDirectiveSection(
      report({
        repairDirectives: {
          items: [{ issue: "含 TODO 标记", action: "实现或移除", source: "diffstat" }],
          sources: ["diffstat"],
        },
      }),
    );
    expect(s).toContain("- （无具体文件） — 含 TODO 标记 → **实现或移除**");
  });

  it("提取不可用时显式回退，并写明原因与「阅读完整失败输出」的指引", () => {
    const s = renderDirectiveSection(report({ repairDirectives: unavailable }));
    expect(s).toContain("## 2.5 结构化修复指令（不可用，回退完整报告）");
    expect(s).toContain(unavailable.fallbackReason!);
    expect(s).toContain("阅读第 2 节的完整失败输出");
  });

  it("报告连 repairDirectives 字段都没有时同样走回退分支", () => {
    const s = renderDirectiveSection(report());
    expect(s).toContain("（不可用，回退完整报告）");
    expect(s).toContain("本轮报告未生成结构化指令");
  });
});

describe("renderDirectiveLines（返修消息里的摘要，最多 10 条）", () => {
  it("超过上限时截断", () => {
    const many: RepairDirectives = {
      items: Array.from({ length: 25 }, (_, i) => ({
        file: `src/f${i}.ts`,
        line: i + 1,
        issue: `问题 ${i}`,
        action: `动作 ${i}`,
        source: "typecheck",
      })),
      sources: ["typecheck"],
    };
    const lines = renderDirectiveLines(many, 10);
    expect(lines).toHaveLength(10);
    expect(lines[0]).toContain("src/f0.ts:1");
    expect(lines.at(-1)).toContain("src/f9.ts:10");
    expect(lines.join("\n")).not.toContain("src/f10.ts");
  });
});

describe("返修计划渲染（通用 + Codex）", () => {
  it("通用 renderRepairPlan 插入 2.5 节且位于第 2 节与第 3 节之间", () => {
    const md = renderRepairPlan(planInput(report({ repairDirectives: withDirectives })));
    const i2 = md.indexOf("## 2. 失败项（必须修复）");
    const i25 = md.indexOf("## 2.5 结构化修复指令（可直接执行）");
    const i3 = md.indexOf("## 3. 通过的项（勿破坏）");
    expect(i2).toBeGreaterThan(-1);
    expect(i25).toBeGreaterThan(i2);
    expect(i3).toBeGreaterThan(i25);
    expect(md).toContain("`src/foo.ts:42`");
  });

  it("通用 renderRepairPlan 在提取不可用时给出回退说明", () => {
    const md = renderRepairPlan(planInput(report({ repairDirectives: unavailable })));
    expect(md).toContain("## 2.5 结构化修复指令（不可用，回退完整报告）");
    expect(md).toContain("阅读第 2 节的完整失败输出");
  });

  it("renderCodexFixPlan 同样插入 2.5 节", () => {
    const md = renderCodexFixPlan(codexInput(report({ repairDirectives: withDirectives })));
    const i2 = md.indexOf("## 2. 失败项（必须修复）");
    const i25 = md.indexOf("## 2.5 结构化修复指令（可直接执行）");
    const i3 = md.indexOf("## 3. 通过的项（勿破坏）");
    expect(i25).toBeGreaterThan(i2);
    expect(i3).toBeGreaterThan(i25);
    expect(md).toContain("`src/foo.ts:42`");
  });

  it("renderCodexFixPlan 在提取不可用时给出回退说明", () => {
    const md = renderCodexFixPlan(codexInput(report({ repairDirectives: unavailable })));
    expect(md).toContain("## 2.5 结构化修复指令（不可用，回退完整报告）");
  });
});

describe("report.json / report.md 持久化（跨重启与手动返修路径需要）", () => {
  it("reportToJsonable 带 repairDirectives 时写出该字段", () => {
    const j = reportToJsonable(report({ repairDirectives: withDirectives }));
    expect(j.repairDirectives).toEqual(withDirectives);
  });

  it("reportToJsonable 不带时不产生该键（向后兼容：旧读方无感知）", () => {
    const j = reportToJsonable(report());
    expect("repairDirectives" in j).toBe(false);
  });

  it("reportToJsonable 保留回退原因（提取失败也要落盘，重启后仍能如实说明）", () => {
    const j = reportToJsonable(report({ repairDirectives: unavailable }));
    expect((j.repairDirectives as RepairDirectives).fallbackReason).toBeTruthy();
  });

  it("reportToMd 渲染结构化修复指令小节", () => {
    const md = reportToMd(report({ repairDirectives: withDirectives }));
    expect(md).toContain("## 结构化修复指令");
    expect(md).toContain("`src/foo.ts:42`");
    expect(md).toContain("（来源 typecheck）");
  });

  it("reportToMd 在不可用时写明原因并要求看输出尾部", () => {
    const md = reportToMd(report({ repairDirectives: unavailable }));
    expect(md).toContain("## 结构化修复指令");
    expect(md).toContain("不可用，请改看上方各检查项的输出尾部");
  });
});

describe("端到端：从失败报告提取到渲染的连贯性", () => {
  it("typecheck 失败报告经提取后，计划文档里能看到可执行动作", async () => {
    const { extractRepairDirectives } = await import("../../src/verify/directives.js");
    const r = report();
    r.repairDirectives = extractRepairDirectives(r);

    const md = renderRepairPlan(planInput(r));
    expect(md).toContain("## 2.5 结构化修复指令（可直接执行）");
    expect(md).toContain("`src/foo.ts:42`");
    expect(md).toContain("**修正该处类型错误（依据 TS2322 提示）**");
    // TODO 信号同样进入指令
    expect(md).toContain("TODO/FIXME/HACK 共 1 处");
  });

  it("计划文档同时引用任务 ID 与结构化指令，便于人工核对", () => {
    const r = report({ taskId: "tsk_other", repairDirectives: withDirectives });
    const md = renderRepairPlan({ ...planInput(r), taskId: "tsk_other" });
    expect(md).toContain("`tsk_other`");
    expect(md).toContain("`src/foo.ts:42`");
  });
});
