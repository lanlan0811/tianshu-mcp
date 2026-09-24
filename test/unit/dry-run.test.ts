/**
 * 单元测试：dryRun 的计划解析与静态检查（issue #21）。
 *
 * 静态检查只依赖「项目文件 + 基线分析结果」，因此可以完全离线单测。
 */
import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import {
  DRY_RUN_PLAN_REL_PATH,
  dryRunPlanDocRelPath,
  dryRunReportToJsonable,
  parseDryRunPlan,
  renderDryRunPlanDoc,
  renderDryRunReportMd,
  runDryRunChecks,
  type DryRunReport,
} from "../../src/verify/dry-run.js";
import type { AnalysisResult } from "../../src/tasks/task.js";
import { makeTmpRoot, rmrf } from "../test-utils.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rmrf(root)));
});

async function project(): Promise<string> {
  const dir = await makeTmpRoot("dry-run");
  roots.push(dir);
  await fsp.writeFile(path.join(dir, "README.md"), "# stub fixture project\n\n正文。\n", "utf8");
  return dir;
}

function analysis(over: Partial<AnalysisResult> = {}): AnalysisResult {
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

async function writePlan(dir: string, plan: unknown): Promise<void> {
  await fsp.mkdir(path.join(dir, ".tianshu-mcp"), { recursive: true });
  await fsp.writeFile(
    path.join(dir, ".tianshu-mcp", "dry-run-plan.json"),
    JSON.stringify(plan, null, 2),
    "utf8",
  );
}

const goodPlan = {
  summary: "改标题",
  files: [
    {
      path: "README.md",
      action: "modify",
      reason: "标题要更新",
      edits: [{ line: 1, symbol: "stub fixture project", action: "改写" }],
    },
  ],
};

async function check(dir: string, over: Partial<AnalysisResult> = {}, allowed?: string[]) {
  return runDryRunChecks({
    taskId: "tsk_dry",
    projectPath: dir,
    round: 0,
    startedAt: "2026-09-24T00:00:00.000Z",
    analysis: analysis(over),
    ...(allowed ? { allowedArtifacts: allowed } : {}),
  });
}

describe("parseDryRunPlan", () => {
  it("接受合规计划", () => {
    const r = parseDryRunPlan(goodPlan);
    expect(r.error).toBeUndefined();
    expect(r.plan?.files[0]?.path).toBe("README.md");
  });

  it("拒绝空 files（必须至少声明一个文件）", () => {
    expect(parseDryRunPlan({ files: [] }).error).toContain("不合法");
  });

  it("拒绝未知 action", () => {
    expect(parseDryRunPlan({ files: [{ path: "a.ts", action: "rename" }] }).error).toContain("不合法");
  });

  it("拒绝绝对路径", () => {
    const r = parseDryRunPlan({ files: [{ path: "/etc/passwd", action: "modify" }] });
    expect(r.error).toContain("绝对路径");
  });

  it("拒绝 Windows 盘符绝对路径", () => {
    const r = parseDryRunPlan({ files: [{ path: "C:\\Windows\\system.ini", action: "modify" }] });
    expect(r.error).toContain("绝对路径");
  });

  it("拒绝路径穿越", () => {
    const r = parseDryRunPlan({ files: [{ path: "../../outside.ts", action: "create" }] });
    expect(r.error).toContain("越出项目根");
  });

  it("拒绝指向 .git / node_modules 的路径", () => {
    expect(parseDryRunPlan({ files: [{ path: ".git/config", action: "modify" }] }).error).toContain(
      "不可修改",
    );
    expect(
      parseDryRunPlan({ files: [{ path: "node_modules/x/index.js", action: "modify" }] }).error,
    ).toContain("不可修改");
  });

  it("行号必须为正整数", () => {
    const r = parseDryRunPlan({
      files: [{ path: "a.ts", action: "modify", edits: [{ line: 0 }] }],
    });
    expect(r.error).toContain("不合法");
  });
});

describe("runDryRunChecks：合规预演", () => {
  it("计划齐全 + 源码零改动 → 通过且无 error", async () => {
    const dir = await project();
    await writePlan(dir, goodPlan);
    const r = await check(dir);
    expect(r.passed).toBe(true);
    expect(r.verdict).toBe("passed");
    expect(r.planExtracted).toBe(true);
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(r.fallbackReason).toBeUndefined();
  });

  it("计划文件本身不算源码改动（它是 MCP 允许的产物）", async () => {
    const dir = await project();
    await writePlan(dir, goodPlan);
    // 模拟基线分析把计划文件算成了未跟踪新增
    const r = await check(dir, { untrackedFiles: [DRY_RUN_PLAN_REL_PATH.replace(/\\/g, "/")] });
    expect(r.passed).toBe(true);
  });

  it("planDoc 允许清单里的文件也不计为改动", async () => {
    const dir = await project();
    await writePlan(dir, goodPlan);
    const r = await check(dir, { untrackedFiles: [".tianshu-mcp/dry-run-plan-tsk_dry.md"] }, [
      ".tianshu-mcp/dry-run-plan-tsk_dry.md",
    ]);
    expect(r.passed).toBe(true);
  });

  it("仅 MCP 产物有变更时给出非阻断提示", async () => {
    const dir = await project();
    await writePlan(dir, goodPlan);
    const r = await check(dir, { diffstat: { totalAdd: 5, totalDel: 0, perFile: [] } });
    expect(r.passed).toBe(true);
    expect(r.findings.map((f) => f.code)).toContain("dry_run_artifacts_only");
  });
});

describe("runDryRunChecks：违规与降级", () => {
  it("改动源码 → dry_run_violation（error，阻断）", async () => {
    const dir = await project();
    await writePlan(dir, goodPlan);
    const r = await check(dir, { changedFiles: ["done.txt"] });
    expect(r.passed).toBe(false);
    expect(r.verdict).toBe("failed");
    const v = r.findings.find((f) => f.code === "dry_run_violation")!;
    expect(v.severity).toBe("error");
    expect(v.message).toContain("done.txt");
  });

  it("计划缺失 → 降级为仅零改动门禁，并如实说明原因", async () => {
    const dir = await project();
    const r = await check(dir);
    expect(r.planExtracted).toBe(false);
    expect(r.fallbackReason).toContain("未找到计划文件");
    // 源码零改动 → 仍然通过（降级不等于失败）
    expect(r.passed).toBe(true);
  });

  it("计划缺失**且**改了源码 → 仍被零改动门禁拦下（核心证据不依赖计划）", async () => {
    const dir = await project();
    const r = await check(dir, { changedFiles: ["src/a.ts"] });
    expect(r.passed).toBe(false);
    expect(r.findings.map((f) => f.code)).toContain("dry_run_violation");
  });

  it("计划 JSON 坏 → 降级并说明原因", async () => {
    const dir = await project();
    await fsp.mkdir(path.join(dir, ".tianshu-mcp"), { recursive: true });
    await fsp.writeFile(path.join(dir, ".tianshu-mcp", "dry-run-plan.json"), "{ 坏", "utf8");
    const r = await check(dir);
    expect(r.planExtracted).toBe(false);
    expect(r.fallbackReason).toContain("未找到计划文件");
  });

  it("计划结构非法 → 降级并带上解析错误", async () => {
    const dir = await project();
    await writePlan(dir, { files: [{ path: "/abs.ts", action: "modify" }] });
    const r = await check(dir);
    expect(r.planExtracted).toBe(false);
    expect(r.fallbackReason).toContain("不可用");
    expect(r.fallbackReason).toContain("绝对路径");
  });
});

describe("runDryRunChecks：逐项静态核对", () => {
  it("create 撞已存在文件 → warning", async () => {
    const dir = await project();
    await writePlan(dir, { files: [{ path: "README.md", action: "create" }] });
    const r = await check(dir);
    expect(r.findings.map((f) => f.code)).toContain("file_already_exists");
    expect(r.passed).toBe(true); // warning 不阻断
  });

  it("modify 指向不存在文件 → warning", async () => {
    const dir = await project();
    await writePlan(dir, { files: [{ path: "nope.ts", action: "modify" }] });
    const r = await check(dir);
    expect(r.findings.map((f) => f.code)).toContain("file_not_found");
  });

  it("行号越界 → warning 且带 file/line", async () => {
    const dir = await project();
    await writePlan(dir, {
      files: [{ path: "README.md", action: "modify", edits: [{ line: 999 }] }],
    });
    const r = await check(dir);
    const f = r.findings.find((x) => x.code === "edit_line_out_of_range")!;
    expect(f.file).toBe("README.md");
    expect(f.line).toBe(999);
  });

  it("symbol 不存在 → warning（指出找不到）", async () => {
    const dir = await project();
    await writePlan(dir, {
      files: [{ path: "README.md", action: "modify", edits: [{ symbol: "不存在的片段" }] }],
    });
    const r = await check(dir);
    const f = r.findings.find((x) => x.code === "edit_location_missing")!;
    expect(f.message).toContain("不存在的片段");
  });

  it("同路径动作矛盾（delete + modify）→ error", async () => {
    const dir = await project();
    await writePlan(dir, {
      files: [
        { path: "README.md", action: "delete" },
        { path: "README.md", action: "modify" },
      ],
    });
    const r = await check(dir);
    expect(r.findings.map((f) => f.code)).toContain("conflicting_actions");
    expect(r.passed).toBe(false);
  });

  it("计划里写绝对路径/穿越 → path_outside_project（error，且不因解析失败而漏掉）", async () => {
    const dir = await project();
    await writePlan(dir, { files: [{ path: "../escape.ts", action: "create" }] });
    const r = await check(dir);
    // 解析阶段就被拒 → 降级；原因里必须写明
    expect(r.fallbackReason).toContain("越出项目根");
  });
});

describe("报告与方案文档渲染", () => {
  it("dry-run 报告文件名与常规 report-<round>.* 不撞车（同目录可共存）", async () => {
    const dir = await project();
    await writePlan(dir, goodPlan);
    const r = await check(dir);
    const md = renderDryRunReportMd(r);
    expect(md).toContain("dryRun 静态分析报告");
    expect(md).toContain("[PASS]");
    expect(md).toContain("## 检查结论");
    expect(md).toContain("## 计划内容");
    // 渲染正文里不出现常规报告标题，避免人被误导
    expect(md).not.toContain("# 验收报告");
  });

  it("jsonable 带 kind 标记，便于读取侧区分两类报告", async () => {
    const dir = await project();
    await writePlan(dir, goodPlan);
    const r = await check(dir);
    const j = dryRunReportToJsonable(r);
    expect(j.kind).toBe("dry-run");
    expect(j.planExtracted).toBe(true);
  });

  it("方案文档只描述方案，并显式声明「尚未实施、不是验收通过证据」", async () => {
    const dir = await project();
    await writePlan(dir, goodPlan);
    const r = await check(dir);
    const doc = renderDryRunPlanDoc(r);
    expect(doc).toContain("README.md");
    expect(doc).toContain("modify");
    expect(doc).toContain("尚未实施");
    expect(doc).toContain("勿把它当作已验收通过的证据");
    expect(doc).not.toContain("[PASS]");
  });

  it("方案文档路径是项目相对 posix，可直接作为 planDoc 传给后续任务", () => {
    expect(dryRunPlanDocRelPath("tsk_x")).toBe(".tianshu-mcp/dry-run-plan-tsk_x.md");
  });

  it("未取得计划时方案文档如实标注，而不是留空", async () => {
    const dir = await project();
    const r = await check(dir);
    const doc = renderDryRunPlanDoc(r);
    expect(doc).toContain("（未取得结构化计划）");
  });

  it("回退原因会出现在报告里（dryRun 的降级必须可见）", async () => {
    const dir = await project();
    const r = await check(dir);
    const md = renderDryRunReportMd(r as DryRunReport);
    expect(md).toContain("计划提取: 失败");
    expect(md).toContain("降级原因");
  });
});
