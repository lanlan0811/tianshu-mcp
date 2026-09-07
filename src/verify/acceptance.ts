/**
 * AcceptanceEngine（开发计划 §8）：A. 自动命令检查 + B. 代码分析，
 * 产出 report.md + report.json，判定一轮验收通过/失败。
 * 配置优先级：extraChecks 参数 > 项目内 .tianshu-mcp/acceptance.json > projects.json 补录 > 默认集。
 */
import path from "node:path";
import { exists, readJsonSafe } from "../util/fs.js";
import {
  type AcceptanceCheckDef,
  type AcceptanceConfig,
  AcceptanceConfigSchema,
  type ServerConfig,
} from "../config/schema.js";
import { toAcceptanceDef } from "../config/store.js";
import { runVerifyCommand, makeSkipResult } from "./runner.js";
import { analyzeChanges } from "./code-analysis.js";
import { captureBaseline, gitDiffCheckSince } from "./git-baseline.js";
import { nowIso } from "../util/id.js";
import type { VerifyReport, CheckResult } from "../tasks/task.js";
import { TaskStore } from "../tasks/task-store.js";
import { Logger } from "../util/log.js";

export interface VerifyRequest {
  taskId: string;
  projectPath: string; // norm
  displayPath: string;
  taskText?: string;
  round: number;
  config?: ServerConfig;
  extraChecks?: AcceptanceCheckDef[];
  projectVerify?: AcceptanceCheckDef[]; // projects.json 补录
  baseline?: Awaited<ReturnType<typeof captureBaseline>>;
  store: TaskStore;
  logger: Logger;
}

const SCRIPT_NAMES = ["typecheck", "lint", "test", "build"] as const;

/** 从项目内容推导默认检查集（开发计划 §8.2） */
export async function deriveDefaultChecks(projectPath: string): Promise<{ checks: AcceptanceCheckDef[]; notes: string[] }> {
  const checks: AcceptanceCheckDef[] = [];
  const notes: string[] = [];
  const pkgJson = await readJsonSafe<{ scripts?: Record<string, string> }>(path.join(projectPath, "package.json"));
  const hasTsconfig = await exists(path.join(projectPath, "tsconfig.json"));
  const hasPytest = await exists(path.join(projectPath, "pytest.ini"));
  const hasGoMod = await exists(path.join(projectPath, "go.mod"));
  const hasCargo = await exists(path.join(projectPath, "Cargo.toml"));

  const add = (name: string, cmd: string[], timeoutMs?: number, optional = true): void => {
    checks.push({ name, cmd, displayCmd: cmd.join(" "), timeoutMs, optional });
  };

  if (pkgJson?.scripts && Object.keys(pkgJson.scripts).length > 0) {
    const scripts = pkgJson.scripts;
    for (const script of SCRIPT_NAMES) {
      if (scripts[script] !== undefined) {
        add(script, ["npm", "run", script], undefined, false);
      }
    }
    const missing = SCRIPT_NAMES.filter((s) => scripts[s] === undefined);
    if (missing.length === SCRIPT_NAMES.length) {
      notes.push("package.json 无 typecheck/lint/test/build 脚本，仅做基础检查。");
    } else if (missing.length > 0) {
      notes.push(`package.json 缺少脚本（跳过）: ${missing.join("/")}。`);
    }
  } else if (hasTsconfig) {
    add("typecheck-tsc", ["npx", "tsc", "--noEmit"]);
  }
  if (hasPytest) add("pytest", ["pytest", "-q"]);
  if (hasGoMod) add("go-test", ["go", "test", "./..."]);
  if (hasCargo) add("cargo-test", ["cargo", "test"]);
  void hasTsconfig;
  return { checks, notes };
}

export class AcceptanceEngine {
  constructor(
    private readonly store: TaskStore,
    private readonly logger: Logger,
  ) {}

  /** 组装一轮验收要跑的检查项（含 git diff --check 内置） */
  private async resolveChecks(
    req: VerifyRequest,
  ): Promise<{ checks: AcceptanceCheckDef[]; notes: string[] }> {
    const notes: string[] = [];
    const out: AcceptanceCheckDef[] = [];
    // 1) 显式 extraChecks
    if (req.extraChecks?.length) {
      out.push(...req.extraChecks);
    }
    const hasExtra = req.extraChecks && req.extraChecks.length > 0;
    if (!hasExtra) {
      // 2) 项目内验收配置
      const inProject = await this.readProjectAcceptance(req.projectPath);
      if (inProject) {
        notes.push(`使用项目内验收配置 <project>/.tianshu-mcp/acceptance.json（${inProject.length} 项）。`);
        out.push(...inProject);
      } else if (req.projectVerify?.length) {
        notes.push(`使用 server 数据目录 projects.json 补录的验收配置（${req.projectVerify.length} 项）。`);
        out.push(...req.projectVerify);
      } else {
        // 4) 默认集
        const def = await deriveDefaultChecks(req.projectPath);
        out.push(...def.checks);
        notes.push(...def.notes);
        notes.push("使用默认验收集（依据项目技术栈推导）。");
      }
    } else {
      notes.push("使用调用方 extraChecks（临时验收，不落库）。");
    }
    return { checks: out, notes };
  }

  private async readProjectAcceptance(projectPath: string): Promise<AcceptanceCheckDef[] | null> {
    const p = path.join(projectPath, ".tianshu-mcp", "acceptance.json");
    const raw = await readJsonSafe<unknown>(p);
    if (raw == null) return null;
    const r = AcceptanceConfigSchema.safeParse(raw);
    if (!r.success) {
      this.logger.warn(`项目 ${projectPath} 的 acceptance.json 解析失败: ${r.error.message}`);
      return null;
    }
    return (r.data as AcceptanceConfig).checks.map((c) => toAcceptanceDef(c));
  }

  /** 执行一轮完整验收。返回 report + 是否 pass。 */
  async runVerify(req: VerifyRequest): Promise<{ report: VerifyReport; passed: boolean }> {
    const startedAt = nowIso();
    const config = req.config ?? { verifyCommandTimeoutMs: 5 * 60_000 };
    const timeoutMs = config.verifyCommandTimeoutMs ?? 5 * 60_000;
    const baseline = req.baseline ?? (await captureBaseline(req.projectPath));
    if (req.baseline) this.logger.debug(`使用 run_task 动工前基线（HEAD=${baseline.head ?? "n/a"}）`);

    const { checks: rawChecks, notes } = await this.resolveChecks(req);
    const checks: CheckResult[] = [];

    // 内置 git diff --check（相对动工前基线；非 git 仓库跳过并标注）
    if (baseline.isRepo) {
      const r = await gitDiffCheckSince(req.projectPath, baseline.head);
      checks.push({
        name: "git-diff-check",
        cmd: `git diff --check${baseline.head ? ` (base=${baseline.head.slice(0, 7)})` : ""}`,
        passed: r.status === 0,
        durationMs: r.durationMs,
        exitCode: r.status,
        outputTail: r.stdout.slice(-2000) + r.stderr.slice(-2000),
        timeout: r.timedOut,
      });
    } else {
      checks.push(makeSkipResult("git-diff-check", "git diff --check", "非 git 仓库，跳过"));
    }

    const logBase = req.store.dir(req.taskId);
    const verifyLog = path.join(logBase, `verify-${req.round}.log`);
    const mdPath = path.join(logBase, `report-${req.round}.md`);
    const jsonPath = path.join(logBase, `report-${req.round}.json`);

    for (const c of rawChecks) {
      const argv = c.cmd;
      if (argv.length === 0) {
        checks.push(makeSkipResult(c.name, c.displayCmd || c.name, "空命令"));
        continue;
      }
      if (argv[0] === "skip" && argv[1] === ":") {
        checks.push(makeSkipResult(c.name, c.displayCmd, "显式 skip 命令"));
        continue;
      }
      const res = await runVerifyCommand(c.name, argv, {
        cwd: req.projectPath,
        timeoutMs: c.timeoutMs ?? timeoutMs,
        logFile: verifyLog,
        env: {},
      });
      if (res.skipped) {
        checks.push(res);
      } else {
        checks.push(res);
      }
    }

    // 代码分析（相对动工前基线）
    const analysis = await analyzeChanges({
      baseline,
      projectPath: req.projectPath,
      taskText: req.taskText,
    });
    for (const n of notes) analysis.notes.push(n);

    const failed = checks.filter((c) => !c.passed && !c.skipped);
    const passed = failed.length === 0;
    const finishedAt = nowIso();

    const summaryBits: string[] = [];
    if (failed.length) {
      summaryBits.push(`未通过检查: ${failed.map((c) => c.name).join(", ")}`);
    }
    if (analysis.signals.consoleDebug || analysis.signals.todo) {
      summaryBits.push("存在可疑标记，建议人工查看报告");
    }
    if (analysis.warnings.length) summaryBits.push(`告警 ${analysis.warnings.length} 条`);
    const message = summaryBits.length ? `${summaryBits.join("；")}。` : "验收通过。";

    const report: VerifyReport = {
      round: req.round,
      taskId: req.taskId,
      projectPath: req.projectPath,
      startedAt,
      finishedAt,
      passed,
      verdict: passed ? "passed" : "failed",
      checks,
      analysis,
      files: { md: mdPath, json: jsonPath },
      message,
    };
    await this.store.saveReport(req.taskId, report);
    this.logger.info(`任务 ${req.taskId} 第 ${req.round} 轮验收: ${passed ? "通过" : "失败"}（${checks.length} 项检查）`);
    return { report, passed };
  }
}
