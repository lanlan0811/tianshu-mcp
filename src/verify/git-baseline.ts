/**
 * git 基线采集与差异计算（开发计划 §8.4 / R12，R3 重构）：
 * run_task/rework_task 动工前记录 HEAD 与脏状态；验收报告相对该基线计算。
 * 差异以 baseline.head 为边界：agent 无论是否创建 commit，任务累计变更都不会丢失。
 * 全程不自动 commit / stash。
 */
import { execFileAsync } from "./exec.js";
import path from "node:path";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";

/** 文件读取/哈希的有界并发上限（worker 池，与 acceptance.ts 命令检查同构） */
const FILE_IO_CONCURRENCY = 8;
/** 未跟踪文件内容哈希的数量上限：超出部分不哈希（不参与预脏排除），并在 message 中注明 */
export const MAX_UNTRACKED_HASH = 5000;

export interface Baseline {
  isRepo: boolean;
  head: string | null;
  dirty: boolean;
  dirtyFiles: string[];
  /** 相对动工前 HEAD 的已跟踪变更（基线前已存在） */
  preExistingChanged: string[];
  preExistingUntracked: string[];
  /** 基线前脏文件（已跟踪 staged/unstaged + 未跟踪）的内容 hash：区分基线已有内容与 agent 后续改动 */
  preDirtyHashes: Record<string, string>;
  /** 基线前未跟踪文件的内容 hash（兼容旧字段，逻辑并入 preDirtyHashes） */
  preUntrackedHashes: Record<string, string>;
  /** 截断发生时的超帽数量（未跟踪 > 5000）：超帽文件无哈希，验收侧聚合提示且不归因，不发逐文件假 note */
  untrackedHashTruncated?: number;
  capturedAt: string;
  message: string;
}

export async function captureBaseline(projectPath: string): Promise<Baseline> {
  const inside = await gitOk(projectPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return {
      isRepo: false,
      head: null,
      dirty: false,
      dirtyFiles: [],
      preExistingChanged: [],
      preExistingUntracked: [],
      preDirtyHashes: {},
      preUntrackedHashes: {},
      capturedAt: new Date().toISOString(),
      message: "非 git 仓库：变更清单/diffstat 不可用（验收仍执行命令检查）。",
    };
  }
  const headRes = await gitOk(projectPath, ["rev-parse", "HEAD"]);
  const head = headRes.ok ? headRes.stdout.trim() : null;
  const statusRes = await gitOk(projectPath, ["status", "--porcelain", "--untracked-files=all"]);
  const porcelain = statusRes.ok ? statusRes.stdout.split("\n").filter((s) => s.trim().length > 0) : [];
  const parsed = parsePorcelain(porcelain);
  // 记录全部预脏文件（已跟踪 staged/unstaged + 未跟踪）的内容 hash：
  // 单遍有界并发哈希，preUntrackedHashes 从同一结果 pick 派生（不再二次读取）。
  const untrackedToHash = parsed.untracked.slice(0, MAX_UNTRACKED_HASH);
  const truncatedUntracked = parsed.untracked.length - untrackedToHash.length;
  const dirtyPaths = [...parsed.changed, ...untrackedToHash];
  const hashes = await hashFiles(projectPath, dirtyPaths);
  const preUntrackedHashes: Record<string, string> = {};
  for (const f of untrackedToHash) {
    const h = hashes[f];
    if (h) preUntrackedHashes[f] = h;
  }
  const baseMessage = head
    ? `基线 HEAD=${head}，工作树${porcelain.length > 0 ? `脏（${porcelain.length} 项）` : "干净"}。`
    : "无 HEAD（空仓库）。";
  return {
    isRepo: true,
    head,
    dirty: porcelain.length > 0,
    dirtyFiles: porcelain,
    preExistingChanged: parsed.changed,
    preExistingUntracked: parsed.untracked,
    preDirtyHashes: hashes,
    preUntrackedHashes,
    ...(truncatedUntracked > 0 ? { untrackedHashTruncated: truncatedUntracked } : {}),
    capturedAt: new Date().toISOString(),
    message:
      truncatedUntracked > 0
        ? `${baseMessage}注意：未跟踪文件共 ${parsed.untracked.length} 个，超出哈希上限 ${MAX_UNTRACKED_HASH}，仅前 ${untrackedToHash.length} 个计算内容 hash（超帽文件无法归因：验收时聚合标注且不计入本轮变更）。`
        : baseMessage,
  };
}

/** 有界并发计算文件内容 hash（读取失败/超大文件跳过，与串行版语义一致） */
async function hashFiles(projectPath: string, files: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let cursor = 0;
  const workerCount = Math.min(FILE_IO_CONCURRENCY, files.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= files.length) return;
      const f = files[i]!;
      const h = await fileHash(path.join(projectPath, f));
      if (h) out[f] = h;
    }
  });
  await Promise.all(workers);
  return out;
}

async function fileHash(p: string): Promise<string | null> {
  try {
    const buf = await fsp.readFile(p);
    if (buf.length > 4 * 1024 * 1024) return null; // 超大文件不哈希
    return createHash("sha1").update(buf).digest("hex");
  } catch {
    return null;
  }
}

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  durationMs: number;
  timedOut: boolean;
}

async function gitOk(cwd: string, args: string[]): Promise<GitResult> {
  const r = await execFileAsync("git", args, { cwd });
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr, status: r.status, durationMs: r.durationMs, timedOut: r.timedOut };
}

/** git status --porcelain 原文行（--untracked-files=all：展开未跟踪目录为逐文件，避免 scratch/ 折叠） */
export async function gitStatusPorcelain(projectPath: string): Promise<string[]> {
  const r = await gitOk(projectPath, ["status", "--porcelain", "--untracked-files=all"]);
  if (!r.ok) return [];
  return r.stdout.split("\n").filter((s) => s.trim().length > 0);
}

/** porcelain 行首两位码 → 分类。M/A/D/R = 已跟踪变更；?? = 未跟踪；其余 = 其它 */
export function parsePorcelain(lines: string[]): { changed: string[]; untracked: string[]; others: string[] } {
  const changed: string[] = [];
  const untracked: string[] = [];
  const others: string[] = [];
  for (const line of lines) {
    if (line.length < 3) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code === "??") untracked.push(file);
    else if (code.trim() === "" && code.includes("?")) others.push(file);
    else if (/[MADRC]/.test(code[0]!) || /[MADRC]/.test(code[1]!)) changed.push(file);
    else others.push(file);
  }
  return { changed, untracked, others };
}

export interface NumstatRow {
  file: string;
  add: number;
  del: number;
  binary: boolean;
}

function parseNumstat(stdout: string): NumstatRow[] {
  const rows: NumstatRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!m) continue;
    if (m[1] === "-" || m[2] === "-") {
      rows.push({ file: m[3]!, add: 0, del: 0, binary: true });
    } else {
      rows.push({ file: m[3]!, add: Number(m[1]), del: Number(m[2]), binary: false });
    }
  }
  return rows;
}

/** git rev-parse <ref> 是否存在 */
export async function gitRefExists(projectPath: string, ref: string): Promise<boolean> {
  const r = await gitOk(projectPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.ok;
}

/**
 * 相对基线 ref 的工作树差异 numstat：
 * - 若当前 HEAD === baseline.head：`git diff baseline.head`（含 staged+unstaged）
 * - 若 agent 创建了新提交（HEAD 前移）：`git diff baseline.head..HEAD` 拿到已提交变更，再叠加工作树 diff
 * excludeUnchangedPreDirty：基线前脏文件集合（按内容 hash 判定未变的应被排除，避免把用户原有改动归因给 agent，S3）。
 * 返回已跟踪文件相对基线的全部变更。
 */
export async function diffSinceBaseline(
  projectPath: string,
  baseRef: string | null,
  excludeFiles?: ReadonlySet<string>,
): Promise<{ numstat: NumstatRow[]; changedLinesPerFile: Map<string, string[]> }> {
  const skip = (f: string): boolean => (excludeFiles ? excludeFiles.has(f) : false);
  if (!baseRef || !(await gitRefExists(projectPath, baseRef))) {
    // 基线 ref 无效/缺失：退回当前 HEAD（仅跟踪工作树 + 已提交到 HEAD 的变化）
    const allN = await gitNumstat(projectPath, "HEAD");
    const n = allN.filter((r) => !skip(r.file));
    const allLines = await gitChangedLines(projectPath, "HEAD");
    for (const f of [...allLines.keys()]) if (skip(f)) allLines.delete(f);
    return { numstat: n, changedLinesPerFile: allLines };
  }
  const headNow = (await gitOk(projectPath, ["rev-parse", "HEAD"])).stdout.trim();
  // 工作树中相对基线的变更 = (baseline→工作树)，含 commit 前移部分
  const r = await gitOk(projectPath, ["diff", "--numstat", baseRef, "HEAD"]);
  const committed = parseNumstat(r.stdout);
  const w = await gitOk(projectPath, ["diff", "--numstat", "HEAD"]); // 工作树未提交
  const worktree = parseNumstat(w.stdout);

  const byFile = new Map<string, NumstatRow>();
  for (const row of committed) {
    if (skip(row.file)) continue;
    byFile.set(row.file, { ...row });
  }
  for (const row of worktree) {
    if (skip(row.file)) continue;
    const prev = byFile.get(row.file);
    if (prev) {
      // 合并：同文件在基线→HEAD 与 HEAD→工作树都有改动
      byFile.set(row.file, {
        file: row.file,
        add: (prev.binary ? 0 : prev.add) + row.add,
        del: (prev.binary ? 0 : prev.del) + row.del,
        binary: prev.binary || row.binary,
      });
    } else {
      byFile.set(row.file, { ...row });
    }
  }

  // 变更行（供可疑标记扫描）：基线→HEAD 的 + 行 与 HEAD→工作树 的 + 行
  const perFile = new Map<string, string[]>();
  const collectAdded = (diffOut: string, toMap: Map<string, string[]>): void => {
    let cur: string | null = null;
    for (const line of diffOut.split("\n")) {
      const fh = line.match(/^\+\+\+ b\/(.+)$/);
      if (fh) {
        cur = fh[1] ?? null;
        continue;
      }
      if (line.startsWith("+") && !line.startsWith("+++") && cur && !skip(cur)) {
        const arr = toMap.get(cur) ?? [];
        arr.push(line.slice(1));
        toMap.set(cur, arr);
      }
    }
  };
  if (headNow !== baseRef) {
    const rc = await gitOk(projectPath, ["diff", "-U0", baseRef, "HEAD"]);
    collectAdded(rc.stdout, perFile);
  }
  const rw = await gitOk(projectPath, ["diff", "-U0", "HEAD"]);
  collectAdded(rw.stdout, perFile);

  return { numstat: [...byFile.values()], changedLinesPerFile: perFile };
}

/** git diff --numstat <ref> */
export async function gitNumstat(projectPath: string, ref = "HEAD"): Promise<NumstatRow[]> {
  const r = await gitOk(projectPath, ["diff", "--numstat", ref]);
  if (!r.ok) return [];
  return parseNumstat(r.stdout);
}

/** 提取相对 <ref> 的 + 变更行 */
export async function gitChangedLines(projectPath: string, ref = "HEAD"): Promise<Map<string, string[]>> {
  const perFile = new Map<string, string[]>();
  const r = await gitOk(projectPath, ["diff", "-U0", ref]);
  if (!r.ok) return perFile;
  let cur: string | null = null;
  for (const line of r.stdout.split("\n")) {
    const fh = line.match(/^\+\+\+ b\/(.+)$/);
    if (fh) {
      cur = fh[1] ?? null;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++") && cur) {
      const arr = perFile.get(cur) ?? [];
      arr.push(line.slice(1));
      perFile.set(cur, arr);
    }
  }
  return perFile;
}

/** 单文件相对基线的 diff --check（空白错误）——覆盖已提交 + 未提交 */
export async function gitDiffCheckSince(projectPath: string, baseRef: string | null): Promise<GitResult> {
  if (baseRef && (await gitRefExists(projectPath, baseRef))) {
    const headNow = (await gitOk(projectPath, ["rev-parse", "HEAD"])).stdout.trim();
    if (headNow !== baseRef) {
      // 有已提交差异：检查 baseline..HEAD 与 HEAD..工作树两段
      const a = await gitOk(projectPath, ["diff", "--check", baseRef, "HEAD"]);
      if (!a.ok) return a;
    }
    return gitOk(projectPath, ["diff", "--check", "HEAD"]);
  }
  return gitOk(projectPath, ["diff", "--check", "HEAD"]);
}
