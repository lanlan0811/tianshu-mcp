/**
 * 代码分析（开发计划 §8.3）：程序化"读取并分析项目代码"——
 * 变更清单 / diffstat / 可疑标记扫描 / 结构性核对。确定性、不依赖 LLM。
 */
import fs from "node:fs";
import path from "node:path";
import type { AnalysisResult } from "../tasks/task.js";
import { parsePorcelain, gitChangedLines, gitNumstat, gitStatusPorcelain } from "./git-baseline.js";
import { readTextSafe } from "../util/fs.js";
import { scanChangedLinesForSignals } from "./signals.js";

const BIG_FILE_THRESHOLD = 500;
const LOCKFILE_PATTERN = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|Pipfile\.lock|poetry\.lock|composer\.lock)$/;
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".zip", ".gz", ".tar", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm", ".class", ".jar", ".pyc",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ttf", ".woff", ".woff2", ".ico",
]);

export interface AnalyzeOpts {
  /** 非 git 仓库时把整树变化视作不可用（返回空变更） */
  isRepo: boolean;
  projectPath: string;
  taskText?: string;
}

export async function analyzeChanges(opts: AnalyzeOpts): Promise<AnalysisResult> {
  const empty: AnalysisResult = {
    changedFiles: [],
    untrackedFiles: [],
    diffstat: { totalAdd: 0, totalDel: 0, perFile: [] },
    signals: { todo: 0, consoleDebug: 0, commentedBlock: 0, secretLike: 0 },
    bigFileChanges: [],
    warnings: [],
    notes: [],
  };
  if (!opts.isRepo) {
    empty.notes.push("项目不是 git 仓库，未做变更清单/diffstat 分析。");
    return empty;
  }
  const lines = await gitStatusPorcelain(opts.projectPath);
  const parsed = parsePorcelain(lines);
  const numstat = await gitNumstat(opts.projectPath);
  const numstatByFile = new Map(numstat.map((r) => [r.file, r]));

  const changedFiles = parsed.changed;
  const untrackedFiles = parsed.untracked;

  // per-file add/del
  const perFile: { file: string; add: number; del: number; binary?: boolean }[] = [];
  const fileSet = new Set<string>();
  for (const f of changedFiles) {
    fileSet.add(f);
    const row = numstatByFile.get(f);
    if (row) perFile.push({ file: f, add: row.add, del: row.del, binary: row.binary });
    else perFile.push({ file: f, add: 0, del: 0 });
  }
  for (const f of untrackedFiles) {
    if (fileSet.has(f)) continue;
    const full = path.join(opts.projectPath, f);
    const isBinary = BINARY_EXT.has(path.extname(f).toLowerCase()) || looksBinary(full);
    const { add, del } = isBinary ? { add: 0, del: 0 } : countLines(full);
    perFile.push({ file: f, add, del, binary: isBinary });
  }
  let totalAdd = 0;
  let totalDel = 0;
  for (const pf of perFile) {
    totalAdd += pf.add;
    totalDel += pf.del;
  }
  const bigFileChanges = perFile.filter((pf) => pf.add + pf.del > BIG_FILE_THRESHOLD).map((pf) => `${pf.file} (+${pf.add} -${pf.del})`);

  const warnings: string[] = [];
  for (const f of changedFiles) if (LOCKFILE_PATTERN.test(f)) warnings.push(`锁文件被修改: ${f}（确认依赖变更是有意的）`);
  for (const f of untrackedFiles) if (LOCKFILE_PATTERN.test(f)) warnings.push(`新增锁文件: ${f}（确认依赖变更是有意的）`);

  // 可疑标记：变更行扫描
  const signals = { todo: 0, consoleDebug: 0, commentedBlock: 0, secretLike: 0 };
  const { addedLines } = await gitChangedLines(opts.projectPath);
  for (const f of untrackedFiles) {
    const full = path.join(opts.projectPath, f);
    if (!looksTextFile(full)) continue;
    const text = await readTextSafe(full);
    if (text) addedLines.push(...text.split("\n"));
  }
  const scanRes = scanChangedLinesForSignals(addedLines);
  signals.todo = scanRes.todo;
  signals.consoleDebug = scanRes.consoleDebug;
  signals.commentedBlock = scanRes.commentedBlock;
  signals.secretLike = scanRes.secretLike;

  const notes: string[] = [];
  // 结构性核对（启发式提示，不作失败依据）
  const fileTexts = changedFiles.concat(untrackedFiles).join("\n").toLowerCase();
  const task = (opts.taskText ?? "").toLowerCase();
  const taskExt = extractSuspiciousExtensions(task);
  if (taskExt.length > 0) {
    const matched = taskExt.filter((ext) => fileTexts.includes(ext));
    if (matched.length === 0) notes.push(`任务提到文件类型（${taskExt.join("/")}），但变更清单中没有对应后缀文件——请人工核对任务目标是否达成。`);
  }

  return {
    changedFiles,
    untrackedFiles,
    diffstat: { totalAdd, totalDel, perFile },
    signals,
    bigFileChanges,
    warnings,
    notes,
  };
}

const SUGGESTED_EXTS_PATTERNS: [RegExp, string][] = [
  [/\b(typescript|\.tsx?)\b/, ".ts"],
  [/\b(javascript|\.jsx?)\b/, ".js"],
  [/\bpython\b/, ".py"],
  [/\bgo\b/, ".go"],
  [/\bjava\b/, ".java"],
  [/\bvue\b/, ".vue"],
  [/\bcss\b|\b样式\b/, ".css"],
  [/\bhtml\b|\b页面\b/, ".html"],
  [/\brust\b/, ".rs"],
  [/\bmarkdown\b|\b文档\b/, ".md"],
  [/\bjson\b/, ".json"],
  [/\bsql\b/, ".sql"],
  [/\byaml\b|\byml\b/, ".yml"],
];

function extractSuspiciousExtensions(taskText: string): string[] {
  const found: string[] = [];
  for (const [re, ext] of SUGGESTED_EXTS_PATTERNS) {
    if (re.test(taskText) && !found.includes(ext)) found.push(ext);
  }
  return found;
}

function countLines(file: string): { add: number; del: number } {
  try {
    const text = fs.readFileSync(file, "utf8");
    const n = text.split("\n").length;
    return { add: n, del: 0 };
  } catch {
    return { add: 0, del: 0 };
  }
}

function looksBinary(file: string): boolean {
  try {
    const buf = fs.readFileSync(file);
    const sample = buf.subarray(0, 8000);
    let suspicious = 0;
    for (const b of sample) if (b === 0) suspicious++;
    return suspicious > sample.length * 0.1;
  } catch {
    return true;
  }
}

function looksTextFile(fullPath: string): boolean {
  if (BINARY_EXT.has(path.extname(fullPath).toLowerCase())) return false;
  try {
    const buf = fs.readFileSync(fullPath);
    for (const b of buf.subarray(0, 4000)) if (b === 0) return false;
    return true;
  } catch {
    return true;
  }
}
