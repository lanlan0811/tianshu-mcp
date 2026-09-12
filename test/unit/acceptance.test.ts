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
