/**
 * fs 帮手：目录创建 / JSON 原子写 / 追加 / 安全读。
 * 全部 async；对外部不可读文件返回 null 而不是抛错（便于容错热加载）。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export async function mkdirp(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

/**
 * 临时文件名：必须每次唯一。
 * 旧实现用 `<path>.<pid>.tmp`——同进程内并发写同一目标时会共用同一个临时文件，
 * 先完成的一方 rename 走后，后完成的一方 rename 抛 ENOENT（实测：CI 上
 * rework/task-flow 偶发「rework 返回 undefined meta」即由此引起）。
 */
function tmpNameFor(p: string): string {
  return `${p}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

/**
 * 带重试的 rename。
 * Windows 上并发 rename 到同一目标会抛 EPERM/EBUSY（目标文件正被另一个 rename 占用），
 * 属瞬时错误，短暂退避后重试即可（实测 8 路并发必现，重试后全通过）。
 */
async function renameWithRetry(from: string, to: string, attempts = 10): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || i >= attempts) throw e;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 10 * i));
    }
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readTextSafe(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, "utf8");
  } catch {
    return null;
  }
}

export async function readJsonSafe<T>(p: string): Promise<T | null> {
  const text = await readTextSafe(p);
  if (text == null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** 原子写：先写临时文件再 rename，避免进程被杀写坏配置 */
export async function writeJsonAtomic(p: string, data: unknown): Promise<void> {
  await mkdirp(path.dirname(p));
  const tmp = tmpNameFor(p);
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await renameWithRetry(tmp, p);
}

export async function writeTextAtomic(p: string, text: string): Promise<void> {
  await mkdirp(path.dirname(p));
  const tmp = tmpNameFor(p);
  await fsp.writeFile(tmp, text, "utf8");
  await renameWithRetry(tmp, p);
}

/** 追加一行（JSONL 用）。不存在则创建 */
export async function appendLine(p: string, line: string): Promise<void> {
  await mkdirp(path.dirname(p));
  await fsp.appendFile(p, `${line}\n`, "utf8");
}

export async function readDirSafe(p: string): Promise<string[]> {
  try {
    return await fsp.readdir(p);
  } catch {
    return [];
  }
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function walkFiles(root: string, maxDepth = 6): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else out.push(full);
    }
  };
  walk(root, 0);
  return out;
}
