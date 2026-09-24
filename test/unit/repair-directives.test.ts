/**
 * 单元测试：结构化修复指令提取（issue #19）。
 *
 * 提取器只依赖报告内的结构化数据（CheckResult.outputTail / AnalysisResult），
 * 因此可以完全离线单测，不需要真的跑命令 —— 这是把提取器做成纯函数的主要收益。
 */
import { describe, it, expect } from "vitest";
import { extractRepairDirectives } from "../../src/verify/directives.js";
import type { AnalysisResult, CheckResult, VerifyReport } from "../../src/tasks/task.js";

function makeCheck(over: Partial<CheckResult> = {}): CheckResult {
  return {
    name: "typecheck",
    cmd: "npm run typecheck",
    passed: false,
    durationMs: 100,
    exitCode: 2,
    outputTail: "",
    timeout: false,
    ...over,
  };
}

function makeAnalysis(over: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    changedFiles: [],
    untrackedFiles: [],
    diffstat: { totalAdd: 0, totalDel: 0, perFile: [] },
    signals: { todo: 0, consoleDebug: 0, commentedBlock: 0, secretLike: 0 },
    bigFileChanges: [],
    warnings: [],
    notes: [],
    ...over,
  };
}

function makeReport(over: Partial<VerifyReport> = {}): VerifyReport {
  return {
    round: 0,
    taskId: "tsk_directives",
    projectPath: "/home/dev/proj",
    startedAt: "2026-09-24T00:00:00.000Z",
    finishedAt: "2026-09-24T00:01:00.000Z",
    passed: false,
    verdict: "failed",
    checks: [],
    analysis: makeAnalysis(),
    files: { md: "/tmp/report-0.md", json: "/tmp/report-0.json" },
    message: "验收失败",
    ...over,
  };
}

describe("typecheck source", () => {
  it("解析 tsc 人性化输出（file(line,col): error TSxxxx）", () => {
    const report = makeReport({
      checks: [
        makeCheck({
          outputTail: [
            "src/foo.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'.",
            "src/bar.ts(7,1): error TS2304: Cannot find name 'Baz'.",
          ].join("\n"),
        }),
      ],
    });

    const d = extractRepairDirectives(report);
    expect(d.fallbackReason).toBeUndefined();
    expect(d.sources).toEqual(["typecheck"]);
    expect(d.items).toEqual([
      {
        file: "src/foo.ts",
        line: 42,
        issue: "TS2322: Type 'string' is not assignable to type 'number'.",
        action: "修正该处类型错误（依据 TS2322 提示）",
        source: "typecheck",
      },
      {
        file: "src/bar.ts",
        line: 7,
        issue: "TS2304: Cannot find name 'Baz'.",
        action: "修正该处类型错误（依据 TS2304 提示）",
        source: "typecheck",
      },
    ]);
  });

  it("解析 tsc --pretty false 输出（file:line:col - error TSxxxx）", () => {
    const report = makeReport({
      checks: [
        makeCheck({
          name: "tsc-noemit",
          cmd: "tsc --noEmit",
          outputTail: "src/baz.ts:12:9 - error TS7006: Parameter 'x' implicitly has an 'any' type.",
        }),
      ],
    });

    const d = extractRepairDirectives(report);
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({
      file: "src/baz.ts",
      line: 12,
      issue: "TS7006: Parameter 'x' implicitly has an 'any' type.",
    });
  });

  it("按 name/cmd 启发式识别 mypy / pyright 等类型检查器", () => {
    const report = makeReport({
      checks: [
        makeCheck({
          name: "py-types",
          cmd: "mypy src",
          outputTail: "src/app.py:3:1 - error TS0000: 占位（本用例只验证选中该检查项）",
        }),
      ],
    });
    expect(extractRepairDirectives(report).sources).toEqual(["typecheck"]);
  });

  it("绝对路径被归一化为项目相对 posix 路径", () => {
    const projectPath = "/home/dev/proj";
    const report = makeReport({
      projectPath,
      checks: [
        makeCheck({
          outputTail: `${projectPath}/src/deep/file.ts(5,1): error TS1005: ';' expected.`,
        }),
      ],
    });
    expect(extractRepairDirectives(report).items[0]!.file).toBe("src/deep/file.ts");
  });

  it("项目外的绝对路径保留原样，不做无法验证的裁剪", () => {
    const report = makeReport({
      checks: [makeCheck({ outputTail: "/etc/other/x.ts(1,1): error TS1005: oops." })],
    });
    expect(extractRepairDirectives(report).items[0]!.file).toBe("/etc/other/x.ts");
  });

  it("重复的同一处报错被去重", () => {
    const line = "src/dup.ts(1,1): error TS2322: Type 'a' is not assignable to type 'b'.";
    const report = makeReport({
      checks: [makeCheck({ outputTail: `${line}\n${line}` })],
    });
    expect(extractRepairDirectives(report).items).toHaveLength(1);
  });

  it("已通过或被跳过的检查项不参与提取", () => {
    const line = "src/x.ts(1,1): error TS2322: x";
    const d = extractRepairDirectives(
      makeReport({
        checks: [
          makeCheck({ passed: true, outputTail: line }),
          makeCheck({ skipped: true, reason: "脚本不存在", outputTail: line }),
        ],
      }),
    );
    expect(d.items).toEqual([]);
    expect(d.fallbackReason).toBeTruthy();
  });

  it("检查项不是类型检查时忽略（即便是失败项、输出形状相同）", () => {
    const report = makeReport({
      checks: [
        makeCheck({
          name: "test",
          cmd: "npm test",
          outputTail: "src/a.ts(1,1): error TS2322: 形状像 tsc 但该检查项不是类型检查",
        }),
      ],
    });
    const d = extractRepairDirectives(report);
    expect(d.sources).toEqual([]);
    expect(d.fallbackReason).toBeTruthy();
  });
});

describe("diffstat source", () => {
  it("超大改动 / 锁文件 / TODO / 调试输出 / 疑似密钥各产出指令", () => {
    const report = makeReport({
      analysis: makeAnalysis({
        changedFiles: ["src/a.ts", "package-lock.json"],
        diffstat: { totalAdd: 600, totalDel: 10, perFile: [] },
        signals: { todo: 3, consoleDebug: 2, commentedBlock: 0, secretLike: 1 },
        bigFileChanges: ["src/huge.ts"],
      }),
    });

    const d = extractRepairDirectives(report);
    expect(d.sources).toEqual(["diffstat"]);
    const issues = d.items.map((i) => i.issue);
    expect(issues).toContain("单文件改动过大（>500 行）");
    expect(issues).toContain("锁文件被修改");
    expect(issues).toContain("新增/变更行含 TODO/FIXME/HACK 共 3 处");
    expect(issues).toContain("新增/变更行含 console.log/debugger 共 2 处");
    expect(issues).toContain("新增/变更行含疑似密钥/令牌形态 1 处");

    // 有文件的两条带 file；行级信号无法定位到文件，不伪造 file 字段
    expect(d.items.find((i) => i.issue.includes("单文件改动过大"))!.file).toBe("src/huge.ts");
    expect(d.items.find((i) => i.issue.includes("锁文件"))!.file).toBe("package-lock.json");
    const todo = d.items.find((i) => i.issue.includes("TODO"))!;
    expect(todo.file).toBeUndefined();
    expect(todo.action).toBe("实现或移除这些待办标记");
  });

  it("未跟踪的锁文件同样命中", () => {
    const report = makeReport({
      analysis: makeAnalysis({ untrackedFiles: ["pnpm-lock.yaml"] }),
    });
    expect(extractRepairDirectives(report).items[0]!.file).toBe("pnpm-lock.yaml");
  });

  it("分析结果干净时不产出任何指令，并给出回退原因", () => {
    const d = extractRepairDirectives(makeReport());
    expect(d.items).toEqual([]);
    expect(d.sources).toEqual([]);
    expect(d.fallbackReason).toBeTruthy();
  });
});

describe("并集与回退语义", () => {
  it("typecheck 与 diffstat 同时命中时两侧指令都产出且无 fallbackReason", () => {
    const report = makeReport({
      checks: [makeCheck({ outputTail: "src/t.ts(2,2): error TS2322: x" })],
      analysis: makeAnalysis({ signals: { todo: 1, consoleDebug: 0, commentedBlock: 0, secretLike: 0 } }),
    });
    const d = extractRepairDirectives(report);
    expect(d.sources).toEqual(["typecheck", "diffstat"]);
    expect(d.fallbackReason).toBeUndefined();
    expect(d.items.length).toBeGreaterThanOrEqual(2);
  });

  it("test 类失败提取不到时置 fallbackReason，而不是抛错", () => {
    const report = makeReport({
      checks: [
        makeCheck({
          name: "test",
          cmd: "npm test",
          outputTail: "✕ 3 tests failed\n  Expected: 1\n  Received: 2",
        }),
      ],
    });
    const d = extractRepairDirectives(report);
    expect(d.items).toEqual([]);
    expect(d.fallbackReason).toContain("无法解析");
  });

  it("单个 source 抛错被吞掉，其余 source 仍产出（提取器整体永不抛错）", () => {
    const report = makeReport({
      checks: [makeCheck({ outputTail: "src/ok.ts(1,1): error TS1: ok" })],
    });
    // 故意破坏结构：让 diffstat source 在读取 signals 时抛 TypeError
    (report.analysis as { signals: unknown }).signals = undefined;

    let d!: ReturnType<typeof extractRepairDirectives>;
    expect(() => {
      d = extractRepairDirectives(report);
    }).not.toThrow();
    expect(d.sources).toContain("typecheck");
    expect(d.items.map((i) => i.file)).toContain("src/ok.ts");
    expect(d.sources).not.toContain("diffstat");
  });

  it("全部 source 都抛错时返回空 items + 说明错误的 fallbackReason", () => {
    const report = makeReport();
    (report.analysis as { signals: unknown }).signals = undefined;
    // 再加一个形状会炸的检查项，让 typecheck source 也抛错
    report.checks = [{ ...makeCheck(), outputTail: null as unknown as string }];

    const d = extractRepairDirectives(report);
    expect(d.items).toEqual([]);
    expect(d.fallbackReason).toContain("结构化提取失败");
  });
});
