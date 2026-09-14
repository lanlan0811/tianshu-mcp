/**
 * AcceptanceEngine（开发计划 §8）：A. 自动命令检查 + B. 代码分析，
 * 产出 report.md + report.json，判定一轮验收通过/失败。
 * 配置优先级：extraChecks 参数 > 项目内 .tianshu-mcp/acceptance.json > projects.json 补录 > 默认集。
 * 命令检查按 verifyConcurrency 有界并行（1=串行）；并行时每条 check 写独立 part 日志，
 * 结束后按声明顺序拼回同一份 verify-<round>.log（对外产物与串行一致）。
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readAcceptanceConfig } from "../visual/config.js";
import { visualError } from "../visual/errors.js";
import { runVisual } from "../visual/engine.js";
import { checkVisualSnapshot, freezeVisualSnapshot } from "../visual/snapshot.js";
import { withVisualLock } from "../visual/lock.js";
import fsp from "node:fs/promises";
import { exists, mkdirp, readJsonSafe, readTextSafe } from "../util/fs.js";
import { type AcceptanceCheckDef, type ServerConfig } from "../config/schema.js";
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
  /** append（默认）/ replace */
  checksMode?: "append" | "replace";
  projectVerify?: AcceptanceCheckDef[]; // projects.json 补录
  baseline?: Awaited<ReturnType<typeof captureBaseline>>;
  /** 任务取消信号：中断在途 check（杀进程树），未启动的 check 标记跳过不再 spawn */
  signal?: AbortSignal;
  store: TaskStore;
  logger: Logger;
}

const SCRIPT_NAMES = ["typecheck", "lint", "test", "build"] as const;

const ZERO_TEST_CASE_PATTERNS = [
  /#\s+tests\s+0\b/i,
  /\bno tests (?:were )?found\b/i,
  /\bno tests ran\b/i,
  /\b0 tests (?:ran|executed|found)\b/i,
] as const;

export function detectZeroTestCases(output: string): boolean {
  return ZERO_TEST_CASE_PATTERNS.some((pattern) => pattern.test(output));
}

function isTestCheck(name: string, cmd: string[]): boolean {
  const normalizedName = name.toLocaleLowerCase();
  const normalizedCmd = cmd.join(" ").toLocaleLowerCase();
  return (
    normalizedName.includes("test") ||
    /\bnode\s+--test\b/.test(normalizedCmd) ||
    /\bnpm\s+run\s+test(?:\b|:)/.test(normalizedCmd) ||
    /\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b|\bvitest\b|\bjest\b|\bmocha\b/.test(normalizedCmd)
  );
}

/** 从项目内容推导默认检查集（开发计划 §8.2） */
export async function deriveDefaultChecks(
  projectPath: string,
): Promise<{ checks: AcceptanceCheckDef[]; notes: string[] }> {
  const checks: AcceptanceCheckDef[] = [];
  const notes: string[] = [];
  const pkgJson = await readJsonSafe<{ scripts?: Record<string, string> }>(
    path.join(projectPath, "package.json"),
  );
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

/** part 日志文件名的安全片段（check 名可能含空格/斜杠等） */
function sanitizeFilePart(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40) || "check";
}

export class AcceptanceEngine {
  private readonly active = new Map<string, AbortController>();

  async runVisualOperation<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = `visual-operation:${randomUUID()}`;
    const controller = new AbortController();
    this.active.set(key, controller);
    try {
      return await run(controller.signal);
    } finally {
      this.active.delete(key);
    }
  }

  async close(): Promise<void> {
    for (const controller of this.active.values()) controller.abort();
    while (this.active.size) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  constructor(
    private readonly store: TaskStore,
    private readonly logger: Logger,
  ) {}

  /** 组装一轮验收要跑的检查项（含 git diff --check 内置）与项目级并行度覆盖 */
  private async resolveChecks(req: VerifyRequest): Promise<{
    checks: AcceptanceCheckDef[];
    notes: string[];
    requireChanges: boolean;
    verifyConcurrency?: number;
  }> {
    const notes: string[] = [];
    const out: AcceptanceCheckDef[] = [];
    const mode = req.checksMode ?? "append";
    const hasExtra = !!req.extraChecks?.length;
    const inProject = await this.readProjectAcceptance(req.projectPath);
    const requireChanges = inProject?.requireChanges ?? true;

    // 先取基础集（项目/默认），除非 replace 模式只用 extraChecks
    if (!(mode === "replace" && hasExtra)) {
      if (inProject?.checks !== undefined) {
        notes.push(
          `使用项目内验收配置 <project>/.tianshu-mcp/acceptance.json（${inProject.checks.length} 项）。`,
        );
        out.push(...inProject.checks);
      } else if (req.projectVerify?.length) {
        notes.push(
          `使用 server 数据目录 projects.json 补录的验收配置（${req.projectVerify.length} 项）。`,
        );
        out.push(...req.projectVerify);
      } else {
        const def = await deriveDefaultChecks(req.projectPath);
        out.push(...def.checks);
        notes.push(...def.notes);
        notes.push("使用默认验收集（依据项目技术栈推导）。");
      }
    }

    // extraChecks：append 追加到基础集后；replace 时替换为基础集不加载（上面已跳过）
    if (hasExtra) {
      if (mode === "replace") {
        notes.push("checksMode=replace：仅执行调用方 extraChecks（跳过项目/默认检查）。");
      } else {
        notes.push(`extraChecks 追加 ${req.extraChecks!.length} 项临时检查（不替换基础门禁）。`);
      }
      out.push(...(req.extraChecks ?? []));
    }
    return { checks: out, notes, requireChanges, verifyConcurrency: inProject?.verifyConcurrency };
  }

  private async readProjectAcceptance(projectPath: string): Promise<{
    checks: AcceptanceCheckDef[] | undefined;
    requireChanges: boolean;
    verifyConcurrency?: number;
  } | null> {
    const config = await readAcceptanceConfig(projectPath);
    if (!config) return null;
    return {
      checks: config.checks?.map((c) => toAcceptanceDef(c)),
      requireChanges: config.requireChanges,
      verifyConcurrency: config.verifyConcurrency,
    };
  }

  /** 执行一轮完整验收。返回 report + 是否 pass。 */
  async runVerify(req: VerifyRequest): Promise<{ report: VerifyReport; passed: boolean }> {
    if (this.active.has(req.taskId)) throw new Error(`Verification already active: ${req.taskId}`);
    const controller = new AbortController();
    this.active.set(req.taskId, controller);
    const home = path.dirname(path.dirname(req.store.dir(req.taskId)));
    try {
      return await withVisualLock(home, `task:${req.taskId}`, async () => {
        const filenames = await fsp
          .readdir(req.store.dir(req.taskId))
          .catch((e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return [] as string[];
            throw e;
          });
        const rounds = filenames.flatMap((name) => {
          const m = /^report-(\d+)\.(md|json)$/.exec(name);
          return m ? [Number(m[1])] : [];
        });
        const round = Math.max(req.round, ...rounds.map((n) => n + 1));
        const request = {
          ...req,
          round,
          signal: req.signal ? AbortSignal.any([req.signal, controller.signal]) : controller.signal,
        };
        return await withVisualLock(home, await fsp.realpath(req.projectPath), () =>
          this.executeVerify(request),
        );
      });
    } finally {
      this.active.delete(req.taskId);
    }
  }

  private async executeVerify(
    req: VerifyRequest,
  ): Promise<{ report: VerifyReport; passed: boolean }> {
    const startedAt = nowIso();
    const config = req.config ?? { verifyCommandTimeoutMs: 5 * 60_000 };
    const timeoutMs = config.verifyCommandTimeoutMs ?? 5 * 60_000;
    const baseline = req.baseline ?? (await captureBaseline(req.projectPath));
    if (req.baseline)
      this.logger.debug(`使用 run_task 动工前基线（HEAD=${baseline.head ?? "n/a"}）`);

    let configurationError: { code: string; message: string } | undefined;
    const resolved = await this.resolveChecks(req).catch((e: unknown) => {
      const error = visualError(e);
      configurationError = { code: error.code, message: error.message };
      return {
        checks: [] as AcceptanceCheckDef[],
        notes: [error.message],
        requireChanges: false,
        verifyConcurrency: undefined,
      };
    });
    const { checks: rawChecks, notes, requireChanges, verifyConcurrency } = resolved;
    let visual: VerifyReport["visual"];
    if (!configurationError) {
      try {
        const frozen = await freezeVisualSnapshot(req.projectPath, req.store.dir(req.taskId));
        await checkVisualSnapshot(req.projectPath, frozen);
      } catch (e) {
        const error = visualError(e);
        configurationError = { code: error.code, message: error.message };
      }
    }
    const checks: CheckResult[] = [];
    const zeroTestChecks: string[] = [];
    // 命令检查并行度：项目 acceptance.json > server config.json > 默认 2（schema 已约束 1..4）
    const concurrency = verifyConcurrency ?? req.config?.verifyConcurrency ?? 2;

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

    if (concurrency <= 1 || rawChecks.length <= 1) {
      // 串行路径：verifyConcurrency=1（或仅单条命令检查）——与历史行为完全一致，直接追加 verify-<round>.log
      for (const c of rawChecks) {
        const { result, zeroTest } = await this.runCommandCheck(c, req, timeoutMs, verifyLog);
        if (zeroTest) zeroTestChecks.push(c.name);
        checks.push(result);
      }
    } else {
      // 有界并行：worker 池按声明顺序领取；每条 check 写独立 part 日志，
      // 全部结束后按声明顺序拼回同一份 verify-<round>.log（对外产物与串行一致）
      this.logger.debug(
        `命令检查有界并行：verifyConcurrency=${concurrency}，共 ${rawChecks.length} 项`,
      );
      const outcomes = await this.runCommandChecksParallel(
        rawChecks,
        req,
        timeoutMs,
        concurrency,
        logBase,
        verifyLog,
        req.round,
      );
      for (const { result, zeroTest } of outcomes) {
        if (zeroTest) zeroTestChecks.push(result.name);
        checks.push(result);
      }
    }

    // Visual checks inspect artifacts after command checks (for example a build) have completed.
    if (!configurationError) {
      try {
        const frozen = await freezeVisualSnapshot(req.projectPath, req.store.dir(req.taskId));
        await checkVisualSnapshot(req.projectPath, frozen);
        const visualConfig = (await readAcceptanceConfig(req.projectPath))?.visual;
        if (visualConfig?.enabled)
          visual = await runVisual(
            visualConfig,
            req.projectPath,
            path.dirname(path.dirname(req.store.dir(req.taskId))),
            path.join(req.store.dir(req.taskId), "visual", String(req.round)),
            req.signal,
          );
        await checkVisualSnapshot(req.projectPath, frozen);
      } catch (e) {
        const error = visualError(e);
        configurationError = { code: error.code, message: error.message };
      }
    }
    // 代码分析（相对动工前基线）
    const analysis = await analyzeChanges({
      baseline,
      projectPath: req.projectPath,
      taskText: req.taskText,
    });
    for (const n of notes) analysis.notes.push(n);

    const hasChanges =
      analysis.changedFiles.length > 0 ||
      analysis.untrackedFiles.length > 0 ||
      analysis.diffstat.totalAdd > 0 ||
      analysis.diffstat.totalDel > 0;
    if (baseline.isRepo && !hasChanges) {
      if (requireChanges) {
        checks.push({
          name: "no-changes",
          cmd: "requireChanges 门禁",
          passed: false,
          durationMs: 0,
          exitCode: null,
          outputTail: "fail-closed：相对动工前基线零文件变更",
          timeout: false,
          reason: "requireChanges 默认开启，但未检测到任务产出",
        });
      } else {
        analysis.notes.push("requireChanges=false：相对动工前基线零变更，仅提示不拦截。");
      }
    } else if (!baseline.isRepo && requireChanges) {
      analysis.notes.push("requireChanges=true，但项目不是 git 仓库，零变更门禁已跳过。");
    }

    if (!configurationError) {
      try {
        await checkVisualSnapshot(
          req.projectPath,
          await freezeVisualSnapshot(req.projectPath, req.store.dir(req.taskId)),
        );
      } catch (e) {
        const error = visualError(e);
        configurationError = { code: error.code, message: error.message };
      }
    }
    // optional:true 的失败只记 warning，不使本轮 verdict 失败（R4）
    const failed = checks.filter((c) => !c.passed && !c.skipped && !c.optional);
    const optFailed = checks.filter((c) => !c.passed && !c.skipped && c.optional);
    // 任务取消：验收被中断（在途 check 被杀、其余跳过），无论检查结果如何都不得落「通过」假绿
    const cancelled = req.signal?.aborted ?? false;
    const visualBlocked =
      visual?.results.filter(
        (r) =>
          r.status === "blocked" &&
          (!r.optional ||
            ["VISUAL_INTEGRITY", "MASK_ALL_PIXELS", "MASK_NOT_FOUND", "MASK_NOT_VISIBLE"].includes(
              r.code,
            )),
      ) ?? [];
    const visualFailed = visual?.results.filter((r) => !r.optional && r.status === "failed") ?? [];
    const blockingIssues = [
      ...(configurationError ? [configurationError] : []),
      ...visualBlocked.map((r) => ({ code: r.code, message: `${r.id}: ${r.message}` })),
    ];
    const passed =
      !cancelled && !blockingIssues.length && !visualFailed.length && failed.length === 0;
    const finishedAt = nowIso();

    const summaryBits: string[] = [];
    if (configurationError)
      summaryBits.push(`验收阻塞 [${configurationError.code}]: ${configurationError.message}`);
    if (visualBlocked.length)
      summaryBits.push(`视觉阻塞: ${visualBlocked.map((r) => `${r.id} [${r.code}]`).join(", ")}`);
    if (visualFailed.length)
      summaryBits.push(`视觉缺陷: ${visualFailed.map((r) => r.id).join(", ")}`);
    if (cancelled) {
      summaryBits.push("任务取消，验收未完成");
    }
    if (failed.length) {
      summaryBits.push(`未通过检查: ${failed.map((c) => c.name).join(", ")}`);
    }
    if (zeroTestChecks.length) {
      summaryBits.push(`测试命令零用例: ${zeroTestChecks.join(", ")}`);
    }
    if (failed.some((check) => check.name === "no-changes")) {
      summaryBits.push("相对动工前基线未检测到文件变更");
    }
    if (optFailed.length) {
      summaryBits.push(
        `optional 检查未通过（不影响结论）: ${optFailed.map((c) => c.name).join(", ")}`,
      );
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
      ...(blockingIssues.length ? { blockingIssues } : {}),
      ...(visual ? { visual } : {}),
    };
    await this.store.saveReport(req.taskId, report);
    this.logger.info(
      `任务 ${req.taskId} 第 ${req.round} 轮验收: ${passed ? "通过" : "失败"}（${checks.length} 项检查）`,
    );
    return { report, passed };
  }

  /**
   * 执行单条命令检查（skip 情形直接给结果，不落日志；含零用例 fail-closed 与 optional 标注）。
   * 取消语义：启动前 signal 已 aborted → skip（不 spawn）；在途 → 由 runner 的 signal 杀进程树。
   */
  private async runCommandCheck(
    c: AcceptanceCheckDef,
    req: VerifyRequest,
    defaultTimeoutMs: number,
    logFile: string,
  ): Promise<{ result: CheckResult; zeroTest: boolean }> {
    const argv = c.cmd;
    if (argv.length === 0) {
      return { result: makeSkipResult(c.name, c.displayCmd || c.name, "空命令"), zeroTest: false };
    }
    if (argv[0] === "skip" && argv[1] === ":") {
      return { result: makeSkipResult(c.name, c.displayCmd, "显式 skip 命令"), zeroTest: false };
    }
    if (req.signal?.aborted) {
      return {
        result: makeSkipResult(c.name, c.displayCmd || argv.join(" "), "任务取消，未执行"),
        zeroTest: false,
      };
    }
    const res = await runVerifyCommand(c.name, argv, {
      cwd: req.projectPath,
      timeoutMs: c.timeoutMs ?? defaultTimeoutMs,
      logFile,
      env: {},
      signal: req.signal,
    });
    let zeroTest = false;
    if (
      !c.optional &&
      res.exitCode === 0 &&
      res.passed &&
      isTestCheck(c.name, argv) &&
      detectZeroTestCases(res.outputTail)
    ) {
      res.passed = false;
      res.outputTail = `${res.outputTail}\n[fail-closed] 命令退出码 0 但未执行任何测试用例`.slice(
        -4000,
      );
      res.reason = "fail-closed：命令退出码 0 但未执行任何测试用例";
      zeroTest = true;
    }
    if (c.optional) res.optional = true;
    return { result: res, zeroTest };
  }

  /**
   * 有界并行执行命令检查（verifyConcurrency>1）：worker 池按声明顺序领取下标（结果顺序=声明顺序，
   * 与完成顺序无关）。每条 check 写独立 part 日志避免交错，全部结束后按声明顺序拼回
   * verify-<round>.log（文件名与格式和串行一致），随后清理 parts 目录。
   * runVerifyCommand 对所有失败/超时/abort 都 resolve 不 reject，Promise.all 不会中途抛出。
   */
  private async runCommandChecksParallel(
    rawChecks: AcceptanceCheckDef[],
    req: VerifyRequest,
    defaultTimeoutMs: number,
    concurrency: number,
    logBase: string,
    verifyLog: string,
    round: number,
  ): Promise<{ result: CheckResult; zeroTest: boolean }[]> {
    const partsDir = path.join(logBase, `verify-${round}.parts`);
    const outcomes: ({ result: CheckResult; zeroTest: boolean } | undefined)[] = new Array(
      rawChecks.length,
    );
    const partPaths: (string | undefined)[] = new Array(rawChecks.length);
    let cursor = 0;
    const workerCount = Math.min(concurrency, rawChecks.length);
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        if (req.signal?.aborted) return; // 未启动的 check 由下方统一补 skip 结果
        const i = cursor++;
        if (i >= rawChecks.length) return;
        const c = rawChecks[i]!;
        const partPath = path.join(
          partsDir,
          `${String(i).padStart(3, "0")}-${sanitizeFilePart(c.name)}.log`,
        );
        outcomes[i] = await this.runCommandCheck(c, req, defaultTimeoutMs, partPath);
        partPaths[i] = partPath;
      }
    });
    await Promise.all(workers);
    for (let i = 0; i < rawChecks.length; i++) {
      if (!outcomes[i]) {
        const c = rawChecks[i]!;
        outcomes[i] = {
          result: makeSkipResult(c.name, c.displayCmd || c.name, "任务取消，未执行"),
          zeroTest: false,
        };
      }
    }
    await this.mergePartLogs(partPaths, verifyLog, partsDir);
    return outcomes as { result: CheckResult; zeroTest: boolean }[];
  }

  /**
   * 按声明顺序把 part 日志拼回 verify-<round>.log（append 语义与串行一致；skip 的 check 无 part 文件，
   * 与串行时同样不落日志段落）。拼接成功才清理 parts；失败保留 parts 便于排查。
   */
  private async mergePartLogs(
    partPaths: (string | undefined)[],
    verifyLog: string,
    partsDir: string,
  ): Promise<void> {
    try {
      await mkdirp(path.dirname(verifyLog));
      for (const p of partPaths) {
        if (!p) continue;
        const text = await readTextSafe(p);
        if (text != null && text.length > 0) await fsp.appendFile(verifyLog, text, "utf8");
      }
      await fsp.rm(partsDir, { recursive: true, force: true });
    } catch (e) {
      this.logger.warn(
        `合并 verify 日志失败（保留 parts 目录 ${partsDir}）: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
