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

/**
 * 展开 profile 发现目录中的平台环境占位符（R5：源码不含用户名/盘符硬编码）。
 * 支持：{LOCALAPPDATA} {APPDATA} {HOME} {USERPROFILE} {PROGRAMFILES} {XDG_DATA_HOME}
 * 无法解析的占位符原样返回（探测时该目录不存在会被忽略）。
 */
export function expandEnvPath(tpl: string): string {
  const envMap: Record<string, string | undefined> = {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PROGRAMFILES: process.env.PROGRAMFILES,
    "PROGRAMFILES(X86)": process.env["PROGRAMFILES(X86)"],
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  let out = tpl;
  for (const [k, v] of Object.entries(envMap)) {
    if (v) out = out.split(`{${k}}`).join(v);
  }
  // Windows 下把模板里的正斜杠统一为平台分隔符（env 值本身已是平台分隔）
  if (process.platform === "win32") out = out.split("/").join("\\");
  return out;
}

/** 平台标准候选根（用于 dirs 留空时的注入）：Windows/macOS/Linux 常见应用与用户目录 */
export function platformDefaultDiscoveryDirs(): string[] {
  const dirs = new Set<string>();
  const push = (v: string | undefined): void => {
    if (v) dirs.add(v);
  };
  if (process.platform === "win32") {
    push(process.env.LOCALAPPDATA);
    push(process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local") : undefined);
    push(process.env.PROGRAMFILES);
    push(process.env["PROGRAMFILES(X86)"]);
  } else {
    push(process.env.HOME ? path.join(process.env.HOME, "Applications") : undefined);
    push("/Applications");
    push("/usr/local/bin");
    push("/opt/homebrew/bin");
    push("/usr/bin");
  }
  return [...dirs].filter(Boolean);
}
