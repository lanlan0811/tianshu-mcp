/**
 * 内容判定缓存（issue #13 计划 §4.4）：任务目录级、按输入哈希键。
 * 键含命令二进制身份（commandPath/commandDigest）——自备 CLI 升级后旧判定自动失效。
 * 仅缓存成功完成的判定（passed/failed/uncertain）；blocked 不入缓存，避免一次故障被固化。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { digest } from "./lock.js";
import { writeJsonAtomic } from "../util/fs.js";
import type { ContentVote } from "./types.js";

const SCHEMA_VERSION = 1;

export interface ContentCacheKeyInput {
  imageSha256: string;
  expect: string;
  command: string;
  commandPath: string | null;
  commandDigest: string | null;
  argsTemplate: string[];
  cwd: string;
  /** 已解析出的子进程环境值的哈希（不落明文） */
  envDigest: string;
  allowRemote: boolean;
  samples: number;
  minConfidence?: number;
}

/** 规范化 JSON：对象键排序、剔除 undefined，保证同输入同键 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function contentCacheKey(input: ContentCacheKeyInput): string {
  return digest(canonicalJson({ v: SCHEMA_VERSION, ...input }));
}

export interface ContentCacheEntry {
  schemaVersion: number;
  key: string;
  imageSha256: string;
  /** 期望文本摘要（缓存文件不落期望原文） */
  expectDigest: string;
  status: "passed" | "failed" | "uncertain";
  code: string;
  votes: ContentVote[];
  confidence?: number;
  createdAt: string;
  durationMs: number;
}

export function cacheableContentStatus(status: string): status is ContentCacheEntry["status"] {
  return status === "passed" || status === "failed" || status === "uncertain";
}

function cacheDir(taskDir: string): string {
  return path.join(taskDir, "visual-content-cache");
}
function cacheFile(taskDir: string, key: string): string {
  return path.join(cacheDir(taskDir), `${key}.json`);
}

/** 读缓存：缺失/损坏/版本不符一律按 miss 处理（调用方重算后重写） */
export async function readContentCache(
  taskDir: string,
  key: string,
): Promise<ContentCacheEntry | null> {
  try {
    const raw = JSON.parse(
      await fs.readFile(cacheFile(taskDir, key), "utf8"),
    ) as ContentCacheEntry;
    if (
      raw?.schemaVersion !== SCHEMA_VERSION ||
      raw.key !== key ||
      !cacheableContentStatus(raw.status)
    )
      return null;
    return raw;
  } catch {
    return null;
  }
}

/** 写缓存：writeJsonAtomic；同键并发竞态（后写覆盖）视为正常——键相同则内容语义相同 */
export async function writeContentCache(taskDir: string, entry: ContentCacheEntry): Promise<void> {
  await writeJsonAtomic(cacheFile(taskDir, entry.key), entry);
}

/** 清理任务级判定缓存（缓存是派生物、可重算，无需 --apply） */
export async function clearContentCache(taskDir: string): Promise<number> {
  const dir = cacheDir(taskDir);
  let removed = 0;
  try {
    removed = (await fs.readdir(dir)).filter((file) => file.endsWith(".json")).length;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return 0;
  }
  await fs.rm(dir, { recursive: true, force: true });
  return removed;
}
