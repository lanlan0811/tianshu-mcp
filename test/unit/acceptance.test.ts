/** 单元测试：默认验收集推导 / 代码分析可疑标记扫描 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import fsp from "node:fs/promises";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { AcceptanceEngine, deriveDefaultChecks } from "../../src/verify/acceptance.js";
import { scanChangedLinesForSignals } from "../../src/verify/signals.js";
import { captureBaseline, parsePorcelain } from "../../src/verify/git-baseline.js";
import { TaskStore } from "../../src/tasks/task-store.js";
import { Logger } from "../../src/util/log.js";
import { gitInitAndCommit } from "../test-utils.js";

const logger = new Logger(null, "error");

async function tmpDir(tag: string): Promise<string> {
  const p = path.join(os.tmpdir(), `tsmcp-unit-${tag}-${randomBytes(4).toString("hex")}`);
  await fsp.mkdir(p, { recursive: true });
  return p;
}

async function verifyProject(
  projectPath: string,
  options: {
    baseline?: Awaited<ReturnType<typeof captureBaseline>>;
    checks?: { name: string; cmd: string[]; displayCmd: string; optional?: boolean }[];
  } = {},
) {
  const home = await tmpDir("acceptance-home");
  const store = new TaskStore(home, logger);
  const engine = new AcceptanceEngine(store, logger);
  return engine.runVerify({
    taskId: `tsk_${randomBytes(4).toString("hex")}`,
    projectPath,
    displayPath: projectPath,
    round: 0,
    baseline: options.baseline,
    extraChecks: options.checks ?? [
      { name: "pass", cmd: [process.execPath, "-e", "process.exit(0)"], displayCmd: "pass" },
    ],
    checksMode: "replace",
    store,
    logger,
  });
}

describe("deriveDefaultChecks", () => {
  it("package.json 有 build 无 test → 推导 build、跳过 test，并注明缺失", async () => {
    const p = await tmpDir("pkg");
    await fsp.writeFile(
      path.join(p, "package.json"),
      JSON.stringify({ name: "x", scripts: { build: "tsc" } }),
    );
    const { checks, notes } = await deriveDefaultChecks(p);
    const names = checks.map((c) => c.name);
    expect(names).toContain("build");
    expect(names).not.toContain("test");
    expect(notes.join(" ")).toContain("test");
  });

  it("tsconfig 无 package scripts → npx tsc --noEmit", async () => {
    const p = await tmpDir("ts");
    await fsp.writeFile(path.join(p, "tsconfig.json"), "{}");
    const { checks } = await deriveDefaultChecks(p);
    expect(checks.some((c) => c.cmd.join(" ").includes("tsc --noEmit"))).toBe(true);
  });

  it("python 项目 → pytest", async () => {
    const p = await tmpDir("py");
    await fsp.writeFile(path.join(p, "pytest.ini"), "[pytest]\n");
    const { checks } = await deriveDefaultChecks(p);
    expect(checks.some((c) => c.name === "pytest")).toBe(true);
  });

  it("go 项目 → go test", async () => {
    const p = await tmpDir("go");
    await fsp.writeFile(path.join(p, "go.mod"), "module x\n");
    const { checks } = await deriveDefaultChecks(p);
    expect(checks.some((c) => c.name === "go-test")).toBe(true);
  });

  it("空项目 → 空检查（仅 git-diff-check 内置）", async () => {
    const p = await tmpDir("empty");
    const { checks } = await deriveDefaultChecks(p);
    expect(checks).toHaveLength(0);
  });
});

describe("验收 fail-closed", () => {
  it("node --test 退出码为 0 但 TAP 零用例时改判失败", async () => {
    const project = await tmpDir("zero-tests");
    const { report, passed } = await verifyProject(project, {
      checks: [
        {
          name: "test",
          cmd: [process.execPath, "-e", "console.log('# tests 0')"],
          displayCmd: "node --test",
        },
      ],
    });
    expect(passed).toBe(false);
    expect(report.checks.find((check) => check.name === "test")).toMatchObject({
      passed: false,
      exitCode: 0,
    });
    expect(report.message).toContain("测试命令零用例");
  });

  it("git 仓库默认零变更时由 no-changes 门禁判失败", async () => {
    const project = await tmpDir("zero-changes-default");
    await fsp.writeFile(path.join(project, "README.md"), "baseline\n", "utf8");
    await gitInitAndCommit(project);
    const baseline = await captureBaseline(project);
    const { report, passed } = await verifyProject(project, { baseline });
    expect(passed).toBe(false);
    expect(report.checks.find((check) => check.name === "no-changes")).toMatchObject({
      passed: false,
      cmd: "requireChanges 门禁",
    });
  });

  it("requireChanges=false 时 git 仓库零变更仅提示不拦截", async () => {
    const project = await tmpDir("zero-changes-disabled");
    await fsp.mkdir(path.join(project, ".tianshu-mcp"), { recursive: true });
    await fsp.writeFile(
      path.join(project, ".tianshu-mcp", "acceptance.json"),
      JSON.stringify({ checks: [], requireChanges: false }),
      "utf8",
    );
    await gitInitAndCommit(project);
    const baseline = await captureBaseline(project);
    const { report, passed } = await verifyProject(project, { baseline });
    expect(passed).toBe(true);
    expect(report.checks.some((check) => check.name === "no-changes")).toBe(false);
    expect(report.analysis.notes.join(" ")).toContain("requireChanges=false");
  });

  it("非 git 仓库零变更不误伤", async () => {
    const project = await tmpDir("zero-changes-non-git");
    const { report, passed } = await verifyProject(project);
    expect(passed).toBe(true);
    expect(report.checks.find((check) => check.name === "git-diff-check")?.skipped).toBe(true);
    expect(report.checks.some((check) => check.name === "no-changes")).toBe(false);
  });
});

describe("可疑标记扫描", () => {
  it("命中 TODO / console.log / debugger / 注释块 / 密钥形态", () => {
    const lines = [
      "const a = 1; // TODO: 重构",
      "console.log('debug');",
      "// 整块注释",
      "// 整块注释2",
      "// 整块注释3",
      "apiKey: 'sk-1234567890abcdef'",
      "normal code",
    ];
    const s = scanChangedLinesForSignals(lines);
    expect(s.todo).toBeGreaterThan(0);
    expect(s.consoleDebug).toBeGreaterThan(0);
    expect(s.commentedBlock).toBeGreaterThan(0);
    expect(s.secretLike).toBeGreaterThan(0);
  });

  it("干净代码无命中", () => {
    const lines = ["export function add(a: number, b: number) {", "  return a + b;", "}"];
    const s = scanChangedLinesForSignals(lines);
    expect(s.todo).toBe(0);
    expect(s.consoleDebug).toBe(0);
    expect(s.commentedBlock).toBe(0);
    expect(s.secretLike).toBe(0);
  });
});

describe("git porcelain 解析", () => {
  it("区分已改/未跟踪/其它", () => {
    const r = parsePorcelain([" M src/a.ts", "?? new.txt", "A  staged.ts", " M src/b.ts"]);
    expect(r.changed).toContain("src/a.ts");
    expect(r.changed).toContain("src/b.ts");
    expect(r.changed).toContain("staged.ts");
    expect(r.untracked).toContain("new.txt");
  });
});

/**
 * 非 git 仓库下的 requireChanges 静默降级（真机缺陷，2026-10-10）。
 *
 * 真机现象（MiniMax Code 冒烟，工作区 `D:\Trae项目\AI游戏\Minecraft` 不是 git 仓库）：
 *   `--auto-verify` 跑了验收，`requireChanges` 默认 true，但报告写
 *     「[INFO] requireChanges=true，但项目不是 git 仓库，零变更门禁已跳过。」
 *     「[INFO] 项目不是 git 仓库，未做变更清单/diffstat 分析。」
 *   结论 **[PASS]** —— 而同一份报告里 `changedFiles: []`、`diffstat: +0 -0`。
 *
 * 即：用户以为开着「零变更保护」，实际在非 git 仓库里**被静默跳过**。
 * 若 agent 什么都没产出，验收依然判 PASS —— **假成功**。
 * 对照 git 仓库：同样零变更会 fail-closed（`no-changes` 检查项失败）。
 *
 * 正解：非 git 仓库时**不得把「无法判定」当成「通过」**。
 * 零变更门禁无法用 git 判定时，要么用文件系统快照替代判据，
 * 要么把该门禁如实标为**不通过/不确定**，绝不能静默 PASS。
 */
describe("非 git 仓库：requireChanges 不得静默降级为通过", () => {
  it("非 git 仓库 + requireChanges=true → 零变更门禁不得被静默跳过（真机 RED）", async () => {
    const projectPath = await tmpDir("nogit");
    await fsp.writeFile(path.join(projectPath, "seed.txt"), "seed\n");
    const baseline = await captureBaseline(projectPath);
    expect(baseline.isRepo).toBe(false); // 前提：确实不是 git 仓库

    const { report } = await verifyProject(projectPath, { baseline });
    // 判定行为不变（非 git 仓库算不出基线，零变更不拦截——既有契约，有测试锁定）；
    // 但该降级**不得静默**：必须同时进 `analysis.warnings`
    // （渲染为 [WARN] 并计入报告摘要），而不是只躺在 `notes` 里以 [INFO] 淹没。
    const notesText = report.analysis.notes.join(" ");
    const warned = report.analysis.warnings.join(" ");
    expect(/零变更门禁已跳过/.test(notesText), "降级说明仍应保留（可读性）").toBe(true);
    expect(
      /零变更门禁已跳过/.test(warned),
      "非 git 仓库下 requireChanges 被静默跳过：仅写 notes（[INFO]）不够，必须进 warnings（[WARN] + 报告摘要）",
    ).toBe(true);
    // 摘要必须体现该告警（summaryBits 对 warnings 计数）
    expect(report.message).toContain("告警");
  });
});
