/**
 * fs 帮手：目录创建 / JSON 原子写 / 追加 / 安全读。
 * 全部 async；对外部不可读文件返回 null 而不是抛错（便于容错热加载）。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export async function mkdirp(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
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
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fsp.rename(tmp, p);
}

export async function writeTextAtomic(p: string, text: string): Promise<void> {
  await mkdirp(path.dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, text, "utf8");
  await fsp.rename(tmp, p);
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
