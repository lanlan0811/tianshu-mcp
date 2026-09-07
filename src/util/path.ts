/**
 * 路径工具：统一路径规范化 + 项目身份哈希。
 * 命名约定见开发计划 §4.2：绝对路径盘符小写 + 正斜杠，pathHash = sha256(path)[:16]。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** 盘符小写 + 正斜杠的绝对路径规范化 */
export function normPath(p: string): string {
  if (!p) throw new Error("路径不能为空");
  const abs = path.resolve(p);
  let posix = abs.split(path.sep).join("/");
  if (/^[A-Za-z]:/.test(posix)) {
    posix = posix.charAt(0).toLowerCase() + posix.slice(1);
  }
  return posix.replace(/\/+$/, "") || "/";
}

/** 项目身份：规范化绝对路径 → 16 位 sha256 */
export function projectHash(p: string): string {
  const key = normPath(p);
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

/** 校验绝对目录参数（MCP 工具入参用）：必须绝对路径且是存在的目录 */
export function assertExistingDir(p: string): { raw: string; norm: string } {
  if (!path.isAbsolute(p)) {
    throw new Error(`projectPath 必须是绝对路径，收到: ${p}`);
  }
  const st = statOrNull(p);
  if (!st || !st.isDirectory()) {
    throw new Error(`目录不存在或不可访问: ${p}`);
  }
  return { raw: p, norm: normPath(p) };
}

function statOrNull(p: string): { isDirectory(): boolean } | null {
  try {
    return fs.statSync(p) as { isDirectory(): boolean };
  } catch {
    return null;
  }
}
