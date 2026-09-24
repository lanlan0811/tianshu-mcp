/**
 * `dryRun` 干跑模式的计划解析与静态检查（issue #21）。
 *
 * 背景：`run_task` 直接驱动 agent 修改源码，理解偏差可能产生大量需要回滚的改动。
 * `dryRun` 让 agent **只分析、只规划**、输出将要修改的文件清单与方案，不动源码；
 * 验收引擎在 dryRun 下**只做静态分析**（引用文件是否存在、拟改位置是否存在、
 * 是否存在明显逻辑冲突），跳过 typecheck/test/build 等需要实际改动的检查。
 *
 * 本模块是纯静态检查（除读文件外无副作用），因此可以完全离线单测。
 */
import path from "node:path";
import { exists, readJsonSafe, readTextSafe, toPosix } from "../util/fs.js";
import { z } from "zod";
import type { AnalysisResult } from "../tasks/task.js";

/** agent 在 dryRun 下必须产出的机器可读计划文件（项目相对路径） */
export const DRY_RUN_PLAN_REL_PATH = path.join(".tianshu-mcp", "dry-run-plan.json");

export const DryRunPlanFileSchema = z.object({
  /** 项目相对路径（拒绝绝对路径与路径穿越） */
  path: z.string().min(1),
  action: z.enum(["create", "modify", "delete"]),
  reason: z.string().optional(),
  edits: z
    .array(
      z.object({
        symbol: z.string().min(1).optional(),
        line: z.number().int().positive().optional(),
        action: z.string().optional(),
      }),
    )
    .optional(),
});
export type DryRunPlanFile = z.infer<typeof DryRunPlanFileSchema>;

export const DryRunPlanSchema = z.object({
  summary: z.string().optional(),
  files: z.array(DryRunPlanFileSchema).min(1),
});
export type DryRunPlan = z.infer<typeof DryRunPlanSchema>;

export interface DryRunFinding {
  code: string;
  severity: "error" | "warning";
  file?: string;
  line?: number;
  message: string;
}

export interface DryRunReport {
  taskId: string;
  projectPath: string;
  round: number;
  startedAt: string;
  finishedAt: string;
  /** 无 error 级 finding 即通过 */
  passed: boolean;
  verdict: "passed" | "failed";
  /** 是否成功解析到结构化计划；false 时只剩零改动门禁生效 */
  planExtracted: boolean;
  /** planExtracted=false 的原因（如实说明，不假装检查过） */
  fallbackReason?: string;
  plan?: DryRunPlan;
  findings: DryRunFinding[];
  analysis: AnalysisResult;
  summary: string;
}

/** 计划文件本身（以及 planDoc）是 MCP 允许 agent 写的产物，不构成「源码改动」 */
function isAllowedArtifact(rel: string, extra: string[] = []): boolean {
  const p = toPosix(rel);
  if (p === toPosix(DRY_RUN_PLAN_REL_PATH)) return true;
  return extra.some((e) => p === toPosix(e));
}

/** 路径是否越出项目根 / 落在不该碰的目录 */
function classifyPath(raw: string): { code?: string; message?: string } {
  const p = raw.replace(/\\/g, "/");
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    return { code: "path_outside_project", message: `计划路径为绝对路径：${raw}` };
  }
  const segs = p.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.includes("..")) {
    return { code: "path_outside_project", message: `计划路径越出项目根：${raw}` };
  }
  const first = segs[0];
  if (first === ".git" || segs.includes("node_modules")) {
    return { code: "path_forbidden", message: `计划路径落在不可修改的目录：${raw}` };
  }
  return {};
}

/** 解析 agent 写下的计划文件内容（纯函数，便于单测） */
export function parseDryRunPlan(raw: unknown): { plan?: DryRunPlan; error?: string } {
  const r = DryRunPlanSchema.safeParse(raw);
  if (!r.success) return { error: `计划文件结构不合法：${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("；")}` };
  for (const f of r.data.files) {
    const bad = classifyPath(f.path);
    if (bad.code) return { error: bad.message! };
  }
  return { plan: r.data };
}

export interface DryRunCheckOptions {
  projectPath: string;
  taskId: string;
  round: number;
  startedAt: string;
  /** MCP 显式允许 agent 在 dryRun 下写入的文件（相对项目根），不计入「源码改动」 */
  allowedArtifacts?: string[];
  /** 动工前基线的变更分析结果（零改动门禁用它） */
  analysis: AnalysisResult;
}

/**
 * 执行静态检查。顺序与 finding code 见 docs/dry-run.md。
 * 计划缺失/不可解析时**不静默通过**：降级为「只做零改动门禁」，并在 `fallbackReason` 里说明。
 */
export async function runDryRunChecks(opts: DryRunCheckOptions): Promise<DryRunReport> {
  const findings: DryRunFinding[] = [];
  const rawPlan = await readJsonSafe<unknown>(path.join(opts.projectPath, DRY_RUN_PLAN_REL_PATH));
  let plan: DryRunPlan | undefined;
  let fallbackReason: string | undefined;

  if (rawPlan == null) {
    fallbackReason = `未找到计划文件 ${toPosix(DRY_RUN_PLAN_REL_PATH)}（agent 未按 dryRun 约束产出机器可读计划），仅执行零改动门禁`;
  } else {
    const parsed = parseDryRunPlan(rawPlan);
    if (parsed.error) fallbackReason = `计划文件不可用：${parsed.error}；仅执行零改动门禁`;
    else plan = parsed.plan;
  }

  if (plan) {
    await checkPlanFiles(plan, opts, findings);
  }

  // 5) 零改动门禁：dryRun 的核心证据（这一条无论计划是否解析成功都要查）
  checkNoSourceChanges(opts, findings);

  const errors = findings.filter((f) => f.severity === "error");
  const passed = errors.length === 0;
  const summary = passed
    ? `dryRun 通过：${plan ? `计划含 ${plan.files.length} 个文件` : "未取得结构化计划"}，源码零改动。`
    : `dryRun 未通过：${errors.length} 项阻断${plan ? `（计划含 ${plan.files.length} 个文件）` : ""}。`;
  return {
    taskId: opts.taskId,
    projectPath: opts.projectPath,
    round: opts.round,
    startedAt: opts.startedAt,
    finishedAt: new Date().toISOString(),
    passed,
    verdict: passed ? "passed" : "failed",
    planExtracted: plan !== undefined,
    ...(fallbackReason ? { fallbackReason } : {}),
    ...(plan ? { plan } : {}),
    findings,
    analysis: opts.analysis,
    summary,
  };
}

async function checkPlanFiles(
  plan: DryRunPlan,
  opts: DryRunCheckOptions,
  findings: DryRunFinding[],
): Promise<void> {
  // 同路径重复 / 动作矛盾
  const byPath = new Map<string, Set<string>>();
  for (const f of plan.files) {
    const key = toPosix(f.path);
    const set = byPath.get(key) ?? new Set<string>();
    set.add(f.action);
    byPath.set(key, set);
  }
  for (const [p, actions] of byPath) {
    if (actions.size > 1) {
      findings.push({
        code: "conflicting_actions",
        severity: "error",
        file: p,
        message: `同一路径被声明了互相矛盾的动作：${[...actions].join("、")}`,
      });
    }
  }

  for (const f of plan.files) {
    const bad = classifyPath(f.path);
    if (bad.code) {
      findings.push({ code: bad.code, severity: "error", file: toPosix(f.path), message: bad.message! });
      continue;
    }
    const rel = toPosix(f.path);
    const abs = path.join(opts.projectPath, ...rel.split("/"));
    const present = await exists(abs);

    // 2) 引用文件存在性
    if (f.action === "create" && present) {
      findings.push({
        code: "file_already_exists",
        severity: "warning",
        file: rel,
        message: "计划新建的文件已存在（确认是覆盖还是应改为 modify）",
      });
    }
    if ((f.action === "modify" || f.action === "delete") && !present) {
      findings.push({
        code: "file_not_found",
        severity: "warning",
        file: rel,
        message: `计划 ${f.action} 的文件不存在`,
      });
      continue;
    }

    // 3) 拟修改位置存在性（create 无既有内容可校验，跳过）
    if (f.action === "create" || !present) continue;
    const text = await readTextSafe(abs);
    if (text == null) {
      findings.push({ code: "file_unreadable", severity: "warning", file: rel, message: "文件存在但不可读" });
      continue;
    }
    const lineCount = text.split("\n").length;
    for (const edit of f.edits ?? []) {
      if (edit.line !== undefined && (edit.line < 1 || edit.line > lineCount)) {
        findings.push({
          code: "edit_line_out_of_range",
          severity: "warning",
          file: rel,
          line: edit.line,
          message: `拟修改行号超出文件范围（该文件共 ${lineCount} 行）`,
        });
      }
      if (edit.symbol !== undefined && !text.includes(edit.symbol)) {
        findings.push({
          code: "edit_location_missing",
          severity: "warning",
          file: rel,
          line: edit.line,
          message: `文件中找不到拟修改的符号/代码片段：${edit.symbol.slice(0, 80)}`,
        });
      }
    }
  }
}

/** 5) 零改动门禁：排除 MCP 自有产物后，仍存在变更即视为违反只读预演 */
function checkNoSourceChanges(opts: DryRunCheckOptions, findings: DryRunFinding[]): void {
  const a = opts.analysis;
  const allowed = opts.allowedArtifacts ?? [];
  const offending = [...a.changedFiles, ...a.untrackedFiles].filter(
    (f) => !isAllowedArtifact(f, allowed),
  );
  const diffTouch = a.diffstat.totalAdd + a.diffstat.totalDel;
  if (offending.length > 0) {
    findings.push({
      code: "dry_run_violation",
      severity: "error",
      message: `dryRun 要求源码零改动，但检测到 ${offending.length} 个变更文件：${offending.slice(0, 20).join("、")}`,
    });
  } else if (diffTouch > 0) {
    // 变更全部落在允许产物内：如实记录为提示，不阻断
    findings.push({
      code: "dry_run_artifacts_only",
      severity: "warning",
      message: `仅检测到 MCP 允许的产物变更（diffstat +${a.diffstat.totalAdd} -${a.diffstat.totalDel}），不计为源码改动`,
    });
  }
}

/** dry-run 报告 markdown（刻意与 report-<round>.md 分开渲染：两者结论口径不同） */
export function renderDryRunReportMd(r: DryRunReport): string {
  const L: string[] = [];
  L.push(`# dryRun 静态分析报告 — 第 ${r.round} 轮`, "");
  L.push(`- 任务: ${r.taskId}`);
  L.push(`- 项目: ${r.projectPath}`);
  L.push(`- 开始: ${r.startedAt}`);
  L.push(`- 结束: ${r.finishedAt}`);
  L.push(`- 结论: **[${r.verdict === "passed" ? "PASS" : "FAIL"}]**`);
  L.push(`- 计划提取: ${r.planExtracted ? "成功" : "失败（降级为仅零改动门禁）"}`);
  if (r.fallbackReason) L.push(`- 降级原因: ${r.fallbackReason}`);
  L.push("", "## 检查结论", "");
  if (r.findings.length === 0) L.push("（无 finding）", "");
  for (const f of r.findings) {
    const loc = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
    L.push(`- [${f.severity === "error" ? "ERROR" : "WARN"}] ${f.code}${loc} — ${f.message}`);
  }
  L.push("", "## 计划内容", "");
  if (!r.plan) {
    L.push("（未取得结构化计划）", "");
  } else {
    if (r.plan.summary) L.push(r.plan.summary, "");
    for (const f of r.plan.files) {
      L.push(`- **${f.action}** \`${toPosix(f.path)}\`${f.reason ? ` — ${f.reason}` : ""}`);
      for (const e of f.edits ?? []) {
        const bits = [e.line !== undefined ? `行 ${e.line}` : "", e.symbol ? `符号 \`${e.symbol}\`` : ""]
          .filter(Boolean)
          .join(" / ");
        L.push(`  - ${bits || "（未指明位置）"}${e.action ? `：${e.action}` : ""}`);
      }
    }
    L.push("");
  }
  const a = r.analysis;
  L.push("## 变更情况（相对动工前基线）", "");
  L.push(`- 已跟踪变更: ${a.changedFiles.length === 0 ? "无" : a.changedFiles.join("、")}`);
  L.push(`- 未跟踪新增: ${a.untrackedFiles.length === 0 ? "无" : a.untrackedFiles.join("、")}`);
  L.push(`- diffstat: +${a.diffstat.totalAdd} -${a.diffstat.totalDel}`);
  L.push("", "---", "", r.summary, "");
  return L.join("\n");
}

export function dryRunReportToJsonable(r: DryRunReport): Record<string, unknown> {
  return { ...r, kind: "dry-run" };
}

/** 后续正式任务复用的计划文档：落在**项目内**，因为 codex/qoder 的 `planDoc` 只能读项目文件 */
export function dryRunPlanDocRelPath(taskId: string): string {
  return toPosix(path.join(".tianshu-mcp", `dry-run-plan-${taskId}.md`));
}

/**
 * 把 dryRun 计划渲染成可直接当 `planDoc` 用的 markdown（「先审后做」闭环的交接物）。
 * 刻意只写**方案本身**（文件 + 动作 + 位置），不掺 dryRun 的过程报告，免得正式任务
 * 误读「静态分析结论」为「验收已通过」。
 */
export function renderDryRunPlanDoc(r: DryRunReport): string {
  const L: string[] = [
    `# dryRun 方案（任务 ${r.taskId}）`,
    "",
    "> 本文件由 tianshu-mcp 的 dryRun 预演产出：**只描述将要做什么，尚未实施**。",
    "> 按本方案实施时，请勿把它当作已验收通过的证据。",
    "",
  ];
  if (r.plan?.summary) L.push("## 方案摘要", "", r.plan.summary, "");
  L.push("## 待改动文件", "");
  if (!r.plan) {
    L.push("（未取得结构化计划）", "");
  } else {
    for (const f of r.plan.files) {
      L.push(`### \`${toPosix(f.path)}\` — ${f.action}`, "");
      if (f.reason) L.push(`- 原因：${f.reason}`);
      for (const e of f.edits ?? []) {
        const bits = [
          e.line !== undefined ? `行 ${e.line}` : "",
          e.symbol ? `符号 \`${e.symbol}\`` : "",
        ]
          .filter(Boolean)
          .join(" / ");
        L.push(`- ${bits || "（未指明位置）"}${e.action ? `：${e.action}` : ""}`);
      }
      L.push("");
    }
  }
  const warn = r.findings.filter((f) => f.severity === "warning");
  if (warn.length) {
    L.push("## 预演提示（非阻断，实施时留意）", "");
    for (const f of warn) {
      const loc = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
      L.push(`- [${f.code}]${loc} — ${f.message}`);
    }
    L.push("");
  }
  return L.join("\n");
}
