/**
 * 代码分析（开发计划 §8.3，R3 重构）：程序化"读取并分析项目代码"——
 * 变更清单 / diffstat / 可疑标记扫描 / 结构性核对，全部相对动工前 git 基线。
 * 基线前已存在且内容未变的脏文件从"任务新增变更"中扣除；agent 是否创建提交都不丢变更。
 */
import path from "node:path";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import type { AnalysisResult } from "../tasks/task.js";
import { parsePorcelain, diffSinceBaseline, gitStatusPorcelain, type Baseline } from "./git-baseline.js";
import { scanChangedLinesForSignals } from "./signals.js";

/** diffstat per-file 行（report.json analysis.diffstat.perFile） */
interface NumstatLike {
  file: string;
  add: number;
  del: number;
  binary?: boolean;
}

const BIG_FILE_THRESHOLD = 500;
/** 内容 hash 上限：>4MiB 不哈希（与基线侧 fileHash 语义一致） */
const HASH_MAX_BYTES = 4 * 1024 * 1024;
/** 文件读取/探测的有界并发上限（worker 池，与 acceptance.ts 命令检查同构） */
const FILE_IO_CONCURRENCY = 8;
const LOCKFILE_PATTERN = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|Pipfile\.lock|poetry\.lock|composer\.lock)$/;
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".zip", ".gz", ".tar", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".wasm", ".class", ".jar", ".pyc",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ttf", ".woff", ".woff2", ".ico",
]);

export interface AnalyzeOpts {
  /** 动工前基线；非 git 仓库时 isRepo=false */
  baseline: Baseline;
  projectPath: string;
  taskText?: string;
}

export async function analyzeChanges(opts: AnalyzeOpts): Promise<AnalysisResult> {
  const { baseline } = opts;
  const notes: string[] = [];
  if (!baseline.isRepo) {
    notes.push("项目不是 git 仓库，未做变更清单/diffstat 分析。");
    return { ...emptyResult(), notes };
  }

  // 当前状态（工作树）
  const lines = await gitStatusPorcelain(opts.projectPath);
  const parsed = parsePorcelain(lines);

  // 基线前已存在的脏文件集合
  const preChanged = new Set(baseline.preExistingChanged);
  const preUntracked = new Set(baseline.preExistingUntracked);

  // 文件 IO 统一入口：预脏 tracked 文件（仅 hash）+ 全部未跟踪文件（单次读取派生全部判断），
  // 有界并发执行。每个文件全程最多读一次；hash/二进制嗅探/行数/文本共用同一 buffer。
  const preDirtyNowHashes = new Map<string, string | null>();
  const untrackedProbes = new Map<string, FileProbe>();
  await runWithConcurrency(
    [
      ...[...preChanged].map((f) => async () => {
        preDirtyNowHashes.set(f, await fileHashQuick(path.join(opts.projectPath, f)));
      }),
      ...parsed.untracked.map((f) => async () => {
        untrackedProbes.set(f, await probeFile(path.join(opts.projectPath, f)));
      }),
    ],
    FILE_IO_CONCURRENCY,
  );

  // S3：排除"基线前脏且任务期间内容未变化"的 tracked 文件（避免把用户原有改动归因给 agent）。
  // 对每个基线前脏文件，比较基线内容 hash 与当前工作树内容 hash；一致 = agent 未触碰 → 完全排除。
  const unchangedPreDirty = new Set<string>();
  for (const f of [...preChanged]) {
    const baseHash = baseDirtyHash(baseline, f);
    if (!baseHash) continue; // 无基线 hash（超大/删除等）不排除，交给 diff 判断
    if (preDirtyNowHashes.get(f) === baseHash) unchangedPreDirty.add(f);
  }

  // 相对基线 ref 的已跟踪差异（含 agent 提交前移 + 工作树）；排除未变化的预脏文件
  const { numstat, changedLinesPerFile } = await diffSinceBaseline(opts.projectPath, baseline.head, unchangedPreDirty);
  const perFile: NumstatLike[] = [];
  const trackedSeen = new Set<string>();

  // 已跟踪变更：diffSinceBaseline 以 baseline.head 为边界（含 agent 提交前移），净增删为 0 的剔除。
  for (const row of numstat) {
    trackedSeen.add(row.file);
    if (row.add === 0 && row.del === 0 && !row.binary) continue;
    perFile.push({ file: row.file, add: row.add, del: row.del, binary: row.binary });
  }

  // 新增未跟踪文件：基线前不存在 → 整文件计入；基线前已存在 → 内容 hash 变化才计入，未变则排除。
  for (const f of parsed.untracked) {
    if (trackedSeen.has(f)) continue;
    const probe = untrackedProbes.get(f);
    if (!probe) continue; // 上面已全量探测，不会缺；防御性跳过
    if (preUntracked.has(f)) {
      const baseHash = baseDirtyHash(baseline, f);
      if (baseHash && probe.hash && baseHash === probe.hash) continue; // 基线前已有且未变：非任务改动
      notes.push(`未跟踪文件 ${f} 在动工前已存在但内容发生变化，已整文件计入本轮变更（无法按行精确归因）。`);
    }
    const { add, del } = probe.binary ? { add: 0, del: 0 } : { add: probe.lines, del: 0 };
    perFile.push({ file: f, add, del, binary: probe.binary });
  }

  // 汇总
  let totalAdd = 0;
  let totalDel = 0;
  for (const pf of perFile) {
    totalAdd += pf.add;
    totalDel += pf.del;
  }
  const bigFileChanges = perFile.filter((pf) => pf.add + pf.del > BIG_FILE_THRESHOLD).map((pf) => `${pf.file} (+${pf.add} -${pf.del})`);

  const warnings: string[] = [];
  for (const f of perFile) {
    if (LOCKFILE_PATTERN.test(f.file)) warnings.push(`锁文件被修改: ${f.file}（确认依赖变更是有意的）`);
  }

  // 可疑标记：只扫描"相对基线新增的行"
  const signals = { todo: 0, consoleDebug: 0, commentedBlock: 0, secretLike: 0 };
  const allAdded: string[] = [];
  for (const arr of changedLinesPerFile.values()) allAdded.push(...arr);
  // 未跟踪且基线前不存在 → 全量扫描；基线前已有且内容没变 → 已排除
  for (const f of parsed.untracked) {
    const probe = untrackedProbes.get(f);
    if (!probe) continue;
    if (preUntracked.has(f)) {
      const baseHash = baseDirtyHash(baseline, f);
      if (baseHash && probe.hash && baseHash === probe.hash) continue;
    }
    if (!probe.textFile) continue;
    if (probe.text) allAdded.push(...probe.text.split("\n"));
  }
  const scanRes = scanChangedLinesForSignals(allAdded);
  signals.todo = scanRes.todo;
  signals.consoleDebug = scanRes.consoleDebug;
  signals.commentedBlock = scanRes.commentedBlock;
  signals.secretLike = scanRes.secretLike;

  const trackedFiles = [...new Set(perFile.filter((p) => !parsed.untracked.includes(p.file)).map((p) => p.file))];
  const untrackedFiles = parsed.untracked.filter((f) => {
    if (!preUntracked.has(f)) return true;
    // 基线前已有：内容变了才作为本轮新增未跟踪
    const b = baseDirtyHash(baseline, f);
    const n = untrackedProbes.get(f)?.hash ?? null;
    return !(b && n && b === n);
  });
  const changedFiles = [...trackedFiles];

  if (preChanged.size || preUntracked.size) {
    notes.push(`动工前工作区已有 ${preChanged.size} 个已跟踪脏文件 + ${preUntracked.size} 个未跟踪文件；本报告仅归因相对动工前基线的净变更。`);
  }
  if (baseline.head && (await gitHeadMoved(opts.projectPath, baseline.head))) {
    notes.push("agent 在任务中创建了 git 提交；变更清单已按基线到当前 HEAD 合并，不丢失。");
  }

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

async function gitHeadMoved(projectPath: string, baseHead: string): Promise<boolean> {
  const { execFileAsync } = await import("./exec.js");
  const r = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectPath });
  return r.status === 0 && r.stdout.trim() !== baseHead;
}

function emptyResult(): AnalysisResult {
  return {
    changedFiles: [],
    untrackedFiles: [],
    diffstat: { totalAdd: 0, totalDel: 0, perFile: [] },
    signals: { todo: 0, consoleDebug: 0, commentedBlock: 0, secretLike: 0 },
    bigFileChanges: [],
    warnings: [],
    notes: [],
  };
}

/** 有界并发执行异步任务（worker 池按声明顺序领取下标） */
async function runWithConcurrency(tasks: (() => Promise<void>)[], concurrency: number): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(concurrency, tasks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const task = tasks[cursor++];
      if (!task) return;
      await task();
    }
  });
  await Promise.all(workers);
}

/** 单文件单次读取的派生信息：hash/二进制嗅探/行数/文本共用同一 buffer */
interface FileProbe {
  /** 内容 sha1；读取失败或 >4MiB 为 null（同旧 fileHashQuick） */
  hash: string | null;
  /** 二进制扩展名命中，或前 8000 字节 NUL 占比 >10%；读取失败按二进制（同旧 looksBinary 的 catch → true） */
  binary: boolean;
  /** utf8 文本 split("\n") 行数；读取失败为 0（同旧 countLines 的 catch） */
  lines: number;
  /** 非二进制扩展名且前 4000 字节无 NUL；读取失败按文本（同旧 looksTextFile 的 catch → true） */
  textFile: boolean;
  /** utf8 全文（仅 textFile 时保留；读取失败为 null，同旧 readTextSafe） */
  text: string | null;
}

async function probeFile(full: string): Promise<FileProbe> {
  const isBinaryExt = BINARY_EXT.has(path.extname(full).toLowerCase());
  let buf: Buffer;
  try {
    buf = await fsp.readFile(full);
  } catch {
    return { hash: null, binary: true, lines: 0, textFile: !isBinaryExt, text: null };
  }
  const hash = buf.length > HASH_MAX_BYTES ? null : createHash("sha1").update(buf).digest("hex");
  const sample = buf.subarray(0, 8000);
  let suspicious = 0;
  for (const b of sample) if (b === 0) suspicious++;
  const binary = isBinaryExt || suspicious > sample.length * 0.1;
  let textFile = !isBinaryExt;
  if (textFile) {
    for (const b of buf.subarray(0, 4000)) {
      if (b === 0) {
        textFile = false;
        break;
      }
    }
  }
  const text = buf.toString("utf8");
  return { hash, binary, lines: text.split("\n").length, textFile, text: textFile ? text : null };
}

async function fileHashQuick(p: string): Promise<string | null> {
  try {
    const buf = await fsp.readFile(p);
    if (buf.length > HASH_MAX_BYTES) return null;
    return createHash("sha1").update(buf).digest("hex");
  } catch {
    return null;
  }
}

/** 基线脏文件内容 hash：优先新字段 preDirtyHashes，兼容旧快照回退 preUntrackedHashes */
function baseDirtyHash(baseline: Baseline, f: string): string | undefined {
  return baseline.preDirtyHashes?.[f] ?? baseline.preUntrackedHashes?.[f];
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
