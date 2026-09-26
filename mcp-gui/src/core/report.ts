/**
 * `report-<round>.json` → 结构化摘要（纯函数）。
 *
 * 真源：`src/tasks/task.ts` 的 `VerifyReport` / `CheckResult` / `AnalysisResult`。
 * 解析一律**容错**：字段缺失不抛错，缺失项按空值给出，避免一份损坏报告让整个界面不可用。
 */

export interface CheckSummary {
  name: string;
  cmd: string;
  passed: boolean;
  durationMs: number;
  exitCode: number | null;
  timeout: boolean;
  skipped: boolean;
  optional: boolean;
  aborted: boolean;
  reason: string | null;
  outputTail: string;
}

export interface ReportSummary {
  round: number | null;
  taskId: string | null;
  projectPath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  passed: boolean;
  verdict: string | null;
  message: string;
  checks: CheckSummary[];
  counts: { total: number; passed: number; failed: number; skipped: number; optional: number };
  changedFiles: string[];
  untrackedFiles: string[];
  diffstat: {
    totalAdd: number;
    totalDel: number;
    perFile: { file: string; add: number; del: number; binary: boolean }[];
  };
  signals: Record<string, number>;
  bigFileChanges: string[];
  warnings: string[];
  notes: string[];
  blockingIssues: { code: string; message: string }[];
  /** 是否含视觉验收产物（report-<round>.html 的存在性由后端另行提供） */
  hasVisual: boolean;
  /** dryRun 静态分析报告的人工可读结论（存在即非空） */
  dryRunReason: string | null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function parseCheck(raw: unknown): CheckSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = asString(r.name);
  if (!name) return null;
  return {
    name,
    cmd: asString(r.cmd) ?? "",
    passed: r.passed === true,
    durationMs: asNumber(r.durationMs) ?? 0,
    exitCode: asNumber(r.exitCode),
    timeout: r.timeout === true,
    skipped: r.skipped === true,
    optional: r.optional === true,
    aborted: r.aborted === true,
    reason: asString(r.reason),
    outputTail: asString(r.outputTail) ?? "",
  };
}

export function summarizeReport(raw: unknown): ReportSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const checks = Array.isArray(r.checks)
    ? r.checks.map(parseCheck).filter((c): c is CheckSummary => c !== null)
    : [];
  const skipped = checks.filter((c) => c.skipped).length;
  const optional = checks.filter((c) => c.optional).length;
  const failed = checks.filter((c) => !c.passed && !c.skipped).length;

  const analysis =
    r.analysis && typeof r.analysis === "object" ? (r.analysis as Record<string, unknown>) : {};
  const diffstatRaw =
    analysis.diffstat && typeof analysis.diffstat === "object"
      ? (analysis.diffstat as Record<string, unknown>)
      : {};
  const perFile = Array.isArray(diffstatRaw.perFile)
    ? diffstatRaw.perFile
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const f = x as Record<string, unknown>;
          const file = asString(f.file);
          if (!file) return null;
          return {
            file,
            add: asNumber(f.add) ?? 0,
            del: asNumber(f.del) ?? 0,
            binary: f.binary === true,
          };
        })
        .filter((x): x is { file: string; add: number; del: number; binary: boolean } => x !== null)
    : [];

  const signalsRaw =
    analysis.signals && typeof analysis.signals === "object"
      ? (analysis.signals as Record<string, unknown>)
      : {};
  const signals: Record<string, number> = {};
  for (const [k, v] of Object.entries(signalsRaw)) {
    const n = asNumber(v);
    if (n !== null) signals[k] = n;
  }

  const blocking = Array.isArray(r.blockingIssues)
    ? r.blockingIssues
        .map((x) => {
          if (!x || typeof x !== "object") return null;
          const b = x as Record<string, unknown>;
          return { code: asString(b.code) ?? "", message: asString(b.message) ?? "" };
        })
        .filter((x): x is { code: string; message: string } => x !== null)
    : [];

  return {
    round: asNumber(r.round),
    taskId: asString(r.taskId),
    projectPath: asString(r.projectPath),
    startedAt: asString(r.startedAt),
    finishedAt: asString(r.finishedAt),
    passed: r.passed === true,
    verdict: asString(r.verdict),
    message: asString(r.message) ?? "",
    checks,
    counts: { total: checks.length, passed: checks.length - failed - skipped, failed, skipped, optional },
    changedFiles: asStringArray(analysis.changedFiles),
    untrackedFiles: asStringArray(analysis.untrackedFiles),
    diffstat: {
      totalAdd: asNumber(diffstatRaw.totalAdd) ?? 0,
      totalDel: asNumber(diffstatRaw.totalDel) ?? 0,
      perFile,
    },
    signals,
    bigFileChanges: asStringArray(analysis.bigFileChanges),
    warnings: asStringArray(analysis.warnings),
    notes: asStringArray(analysis.notes),
    blockingIssues: blocking,
    hasVisual: r.visual !== undefined && r.visual !== null,
    dryRunReason: asString(r.reason),
  };
}