/**
 * git 基线采集与变更统计（开发计划 §8.4 / R12）：
 * run_task/rework_task 动工前记录 HEAD + 脏状态；验收报告相对该基线。
 * 全程不自动 commit / stash。
 */
import { execFileAsync } from "./exec.js";

export interface Baseline {
  isRepo: boolean;
  head: string | null;
  dirty: boolean;
  dirtyFiles: string[];
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
      capturedAt: new Date().toISOString(),
      message: "非 git 仓库：变更清单/diffstat 不可用（验收仍执行命令检查）。",
    };
  }
  const headRes = await gitOk(projectPath, ["rev-parse", "HEAD"]);
  const head = headRes.ok ? headRes.stdout.trim() : null;
  const statusRes = await gitOk(projectPath, ["status", "--porcelain"]);
  const dirtyFiles = statusRes.ok ? statusRes.stdout.split("\n").filter((s) => s.trim().length > 0) : [];
  return {
    isRepo: true,
    head,
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
    capturedAt: new Date().toISOString(),
    message: head ? `基线 HEAD=${head}，工作树${dirtyFiles.length > 0 ? `脏（${dirtyFiles.length} 项）` : "干净"}。` : "无 HEAD（空仓库）。",
  };
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function gitOk(cwd: string, args: string[]): Promise<GitResult> {
  const r = await execFileAsync("git", args, { cwd });
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
}

/** git diff --check（空白错误）exitCode=0 表示通过 */
export async function gitDiffCheck(projectPath: string): Promise<GitResult> {
  return gitOk(projectPath, ["diff", "--check"]);
}

/** git status --porcelain 原文行 */
export async function gitStatusPorcelain(projectPath: string): Promise<string[]> {
  const r = await gitOk(projectPath, ["status", "--porcelain"]);
  if (!r.ok) return [];
  return r.stdout.split("\n").filter((s) => s.trim().length > 0);
}

export function parsePorcelain(lines: string[]): { changed: string[]; untracked: string[]; others: string[] } {
  const changed: string[] = [];
  const untracked: string[] = [];
  const others: string[] = [];
  for (const line of lines) {
    if (line.length < 3) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code === "??") untracked.push(file);
    else if (code.includes("?")) others.push(file);
    else changed.push(file);
  }
  return { changed, untracked, others };
}

export interface NumstatRow {
  file: string;
  add: number;
  del: number;
  binary: boolean;
}

/** git diff --numstat HEAD（相对基线的已跟踪改动） */
export async function gitNumstat(projectPath: string): Promise<NumstatRow[]> {
  const r = await gitOk(projectPath, ["diff", "--numstat", "HEAD"]);
  const rows: NumstatRow[] = [];
  if (!r.ok) return rows;
  for (const line of r.stdout.split("\n")) {
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

/** 提取已跟踪文件相对基线的全部变更行（-U0 的 + 行），供可疑标记扫描 */
export async function gitChangedLines(projectPath: string): Promise<{ addedLines: string[]; perFileHunks: Map<string, string[]> }> {
  const perFileHunks = new Map<string, string[]>();
  const r = await gitOk(projectPath, ["diff", "-U0", "HEAD"]);
  if (!r.ok) return { addedLines: [], perFileHunks };
  let currentFile: string | null = null;
  const added: string[] = [];
  const collect: string[] = [];
  for (const line of r.stdout.split("\n")) {
    const fileHead = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileHead) {
      if (currentFile) perFileHunks.set(currentFile, collect.splice(0));
      currentFile = fileHead[1] ?? null;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push(line.slice(1));
      collect.push(line.slice(1));
    }
  }
  if (currentFile) perFileHunks.set(currentFile, collect);
  return { addedLines: added, perFileHunks };
}
