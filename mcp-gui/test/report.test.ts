import { describe, expect, it } from "vitest";
import { summarizeReport } from "@/core/report";

const RAW = {
  round: 1,
  taskId: "tsk_x",
  projectPath: "/p/a",
  startedAt: "2026-09-26T11:00:00.000Z",
  finishedAt: "2026-09-26T11:01:00.000Z",
  passed: true,
  verdict: "passed",
  message: "通过",
  checks: [
    { name: "build", cmd: "npm run build", passed: true, durationMs: 100, exitCode: 0, outputTail: "", timeout: false },
    { name: "lint", cmd: "npm run lint", passed: false, durationMs: 50, exitCode: 2, outputTail: "err", timeout: false },
    { name: "e2e", cmd: "npm run e2e", passed: true, durationMs: 10, exitCode: 0, outputTail: "", timeout: false, skipped: true, reason: "缺依赖" },
  ],
  analysis: {
    changedFiles: ["a.ts"],
    untrackedFiles: ["b.ts"],
    diffstat: { totalAdd: 5, totalDel: 2, perFile: [{ file: "a.ts", add: 5, del: 2 }] },
    signals: { todo: 1, consoleDebug: 2 },
    bigFileChanges: [],
    warnings: ["有 console.debug"],
    notes: ["备注"],
  },
  blockingIssues: [{ code: "x", message: "y" }],
};

describe("summarizeReport", () => {
  it("统计通过 / 失败 / 跳过", () => {
    const s = summarizeReport(RAW);
    expect(s).not.toBeNull();
    expect(s?.counts).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1, optional: 0 });
  });

  it("提取名字段与 diffstat / signals", () => {
    const s = summarizeReport(RAW);
    expect(s?.verdict).toBe("passed");
    expect(s?.changedFiles).toEqual(["a.ts"]);
    expect(s?.untrackedFiles).toEqual(["b.ts"]);
    expect(s?.diffstat.totalAdd).toBe(5);
    expect(s?.diffstat.perFile[0]?.file).toBe("a.ts");
    expect(s?.signals).toEqual({ todo: 1, consoleDebug: 2 });
    expect(s?.warnings).toEqual(["有 console.debug"]);
    expect(s?.blockingIssues).toEqual([{ code: "x", message: "y" }]);
  });

  it("字段缺失时给出安全默认值而不是抛错", () => {
    const s = summarizeReport({ taskId: "t" });
    expect(s?.checks).toEqual([]);
    expect(s?.changedFiles).toEqual([]);
    expect(s?.diffstat.totalAdd).toBe(0);
    expect(s?.signals).toEqual({});
    expect(s?.message).toBe("");
  });

  it("非对象输入返回 null（调用方据此显示“报告缺失”）", () => {
    expect(summarizeReport(null)).toBeNull();
    expect(summarizeReport("x")).toBeNull();
  });

  it("忽略缺少 name 的脏检查项", () => {
    const s = summarizeReport({ checks: [{ cmd: "x" }, { name: "ok", passed: true }] });
    expect(s?.checks.map((c) => c.name)).toEqual(["ok"]);
  });
});