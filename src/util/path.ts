/**
 * 路径工具：统一路径规范化 + 项目身份哈希。
 * 命名约定见开发计划 §4.2：绝对路径盘符小写 + 正斜杠，pathHash = sha256(path)[:16]。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
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

export interface ProjectDirResolution {
  /** 用户原始输入（展示用） */
  raw: string;
  /** realpath 解析后的真实路径（符号链接已消除） */
  canonical: string;
  /** normPath(canonical)（存储/比较/哈希用） */
  norm: string;
  /** canonical 与 raw 不同（经过了符号链接） */
  viaSymlink: boolean;
}

/**
 * 解析项目目录：绝对路径 + 必须存在 + realpath 消除符号链接。
 * macOS /tmp→/private/tmp 这类链接若不消除，同一目录会以两个字符串贯穿
 * 绑定/验收/git 基线，产生「写错路径」类事故。
 */
export function resolveProjectDir(p: string): ProjectDirResolution {
  if (!path.isAbsolute(p)) {
    throw new Error(`projectPath 必须是绝对路径，收到: ${p}`);
  }
  const st = statOrNull(p);
  if (!st || !st.isDirectory()) {
    throw new Error(`目录不存在或不可访问: ${p}`);
  }
  let canonical = p;
  try {
    canonical = fs.realpathSync(p);
  } catch {
    /* 极端情况（竞争删除/权限）：退回原始路径，后续 git/验收会自然报错 */
  }
  return {
    raw: p,
    canonical,
    norm: normPath(canonical),
    viaSymlink: normPath(canonical) !== normPath(p),
  };
}

/**
 * 禁止作为 projectPath 的根级目录（normPath 形态，精确相等才命中）：
 * worker（CLI 沙箱/GUI 绑定）可写其整个子树——传错一次就是全盘写入事故。
 */
const DANGEROUS_ROOTS: ReadonlySet<string> = new Set([
  "/",
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/var",
  "/opt",
  "/system",
  "/library",
  "/private",
  "/users",
  "/home",
  "/root",
  "/tmp",
  "/applications",
  // macOS 系统目录经 realpath 后落到 /private 下（/tmp→/private/tmp、/etc→/private/etc、/var→/private/var）
  "/private/tmp",
  "/private/etc",
  "/private/var",
  "c:/",
  "c:/windows",
  "c:/users",
  "c:/program files",
  "c:/program files (x86)",
  "d:/",
]);

/**
 * DANGEROUS_ROOTS 查询 key：win32 下具名目录按大小写不敏感语义小写化
 * （否则 `C:\Windows` 归一为 `c:/Windows`，与 Set 内小写字面量永不命中）。
 * 仅用于危险根/主目录相等比较；不改 normPath 本身（它参与 projectHash 存储身份）。
 */
export function dangerKey(norm: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? norm.toLowerCase() : norm;
}

/**
 * 写入类入口（run_task / verify_task）的项目目录闸门：
 * resolveProjectDir 之上再拒「主目录本身」与「系统/根级目录」。
 * 注意只挡精确相等的根——/tmp/xxx、/Users/name/repo 等子目录不受影响。
 */
/** 盘符根（Windows 的 C:\ / D:\ 等）：normPath 会剥掉尾斜杠得到 "d:"，需单独判定 */
function isDriveRoot(norm: string): boolean {
  return /^[a-z]:$/.test(norm);
}

export function assertSafeProjectDir(p: string): ProjectDirResolution {
  const r = resolveProjectDir(p);
  if (dangerKey(r.norm) === dangerKey(normPath(os.homedir()))) {
    throw new Error(`projectPath 不能是用户主目录本身（worker 将可写整个主目录）: ${r.canonical}`);
  }
  // 盘符根不在 DANGEROUS_ROOTS 里：normPath 把 "D:\" 归一为 "d:"（尾斜杠被剥掉），
  // 与清单里的 "d:/" 永不相等，故单独判定，覆盖所有盘符而不依赖枚举。
  if (DANGEROUS_ROOTS.has(dangerKey(r.norm)) || isDriveRoot(dangerKey(r.norm))) {
    throw new Error(`projectPath 指向系统/根级目录，worker 写权限将覆盖整个子树，已拒绝: ${r.canonical}`);
  }
  return r;
}

/** 校验绝对目录参数（MCP 工具入参用）：必须绝对路径且是存在的目录 */
export function assertExistingDir(p: string): { raw: string; norm: string } {
  const r = resolveProjectDir(p);
  return { raw: r.raw, norm: r.norm };
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
    SYSTEMDRIVE: process.env.SYSTEMDRIVE ?? process.env.SystemDrive,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  let out = tpl.replace(/\{([^{}]+)\}/g, (placeholder, key: string) => {
    const value = envMap[key.toUpperCase()];
    return value || placeholder;
  });
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
