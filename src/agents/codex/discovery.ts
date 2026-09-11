/**
 * Codex（OpenAI 桌面端）安装发现 —— MSIX(AppX) 优先，扫盘回退。
 *
 * 实测事实（2026-09-11）：
 * - 包名 OpenAI.Codex，PackageFamilyName = OpenAI.Codex_2p2nqsd0c76g0
 * - InstallLocation = C:\Program Files\WindowsApps\OpenAI.Codex_<版本>_x64__2p2nqsd0c76g0
 * - GUI 宿主 = <InstallLocation>\app\ChatGPT.exe（清单 Application Id="App"）
 * - AUMID = <PackageFamilyName>!App
 *
 * 版本号与 WindowsApps 位置都可能变，故一律动态获取：
 *   1) Get-AppxPackage 查询 InstallLocation（权威，自动跟版本）
 *   2) 扫盘 {SYSTEMDRIVE}\Program Files\WindowsApps\OpenAI.Codex_*_x64__<pfn>\app\ChatGPT.exe
 * 绝不硬编码版本号或内核 bin 的 hash 目录。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AgentProfile } from "../../config/schema.js";
import { expandEnvPath } from "../../util/path.js";

export interface CodexCandidate {
  /** GUI 宿主 exe 绝对路径 */
  path: string;
  /** 激活标识（AUMID），Windows MSIX 必需 */
  aumid?: string;
  /** 包安装目录 */
  installLocation?: string;
  source: "explicit" | "appx" | "scan" | "macos";
  version?: string;
}

/** Get-AppxPackage 结果 */
export interface AppxInfo {
  installLocation: string;
  packageFamilyName: string;
  packageFullName?: string;
  version?: string;
}

export interface CodexDiscoveryInput {
  platform?: NodeJS.Platform;
  /** 注入的 Appx 查询结果（便于单测）；未提供时在 win32 上真实查询 */
  appx?: AppxInfo | null;
  /** 注入的扫盘结果（便于单测） */
  scanned?: string[];
  /** 扫盘根目录（便于单测注入盘根映射） */
  scanRoots?: string[];
}

const DEFAULT_APPX_NAME = "OpenAI.Codex";
const DEFAULT_PFN_SUFFIX = "2p2nqsd0c76g0";

function isExecutableFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 从 Get-AppxPackage 的 JSON 输出解析安装信息（导出以便单测） */
export function parseAppxPackageJson(raw: string): AppxInfo | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const loc = String(parsed.InstallLocation ?? "").trim();
    const pfn = String(parsed.PackageFamilyName ?? "").trim();
    if (!loc || !pfn) return null;
    return {
      installLocation: loc,
      packageFamilyName: pfn,
      packageFullName: String(parsed.PackageFullName ?? "").trim() || undefined,
      version: String(parsed.Version ?? "").trim() || undefined,
    };
  } catch {
    return null;
  }
}

/** 真实调用 Get-AppxPackage（仅 Windows） */
export function queryAppxPackage(packageName = DEFAULT_APPX_NAME): AppxInfo | null {
  if (process.platform !== "win32") return null;
  const script = `$p = Get-AppxPackage -Name '${packageName.replace(/'/g, "''")}' | Select-Object -First 1; if ($p) { $p | Select-Object InstallLocation,PackageFamilyName,PackageFullName,Version | ConvertTo-Json -Compress }`;
  try {
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 25_000,
    });
    return parseAppxPackageJson(raw);
  } catch {
    return null;
  }
}

/** 通配符段匹配（仅支持 `*`，逐段比较，Windows 大小写不敏感） */
export function globSegmentsMatch(pattern: string, value: string): boolean {
  const p = pattern.split(/[\\/]+/);
  const v = value.split(/[\\/]+/);
  if (p.length !== v.length) return false;
  for (let i = 0; i < p.length; i++) {
    const seg = p[i]!;
    if (seg === "*") continue;
    if (!seg.includes("*")) {
      if (seg.toLowerCase() !== v[i]!.toLowerCase()) return false;
      continue;
    }
    const re = new RegExp(`^${seg.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
    if (!re.test(v[i]!)) return false;
  }
  return true;
}

/**
 * 从安装目录名解析版本号（OpenAI.Codex_<version>_<arch>__<pfn>）。
 * 无法解析时返回全 0（排最后）。
 */
export function versionFromPackageDir(dirName: string): number[] {
  const m = /^[A-Za-z0-9._-]+?_(\d+(?:\.\d+)*)_/i.exec(dirName);
  if (!m) return [0];
  return m[1]!.split(".").map((n) => Number(n) || 0);
}

/** 版本序列降序比较（新版优先） */
export function compareVersionsDesc(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 扫盘回退：枚举 scanRoots 下一级目录，用 scanPattern 相对路径匹配。
 * 返回匹配到的候选 exe 绝对路径，**按包版本降序**（多版本共存时取最新），
 * 不存在的被过滤。
 */
export function scanForCodex(
  roots: string[],
  relativeExe: string[],
  pattern: string | undefined,
): string[] {
  const out: { path: string; version: number[] }[] = [];
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      for (const rel of relativeExe) {
        const sep = path.sep;
        const relPlatform = rel.split("/").join(sep);
        const full = path.join(root, e.name, relPlatform);
        const relForPattern = `${e.name}/${rel}`;
        if (pattern && !globSegmentsMatch(pattern, relForPattern)) continue;
        if (isExecutableFile(full)) out.push({ path: full, version: versionFromPackageDir(e.name) });
      }
    }
  }
  out.sort((a, b) => compareVersionsDesc(a.version, b.version));
  return out.map((o) => o.path);
}

/**
 * 数据驱动的 Codex 发现。
 * 顺序：显式 exePath → Appx 查询 → 扫盘 → macOS bundle。
 */
export function discoverCodex(
  profile: AgentProfile,
  input: CodexDiscoveryInput = {},
): CodexCandidate | null {
  const platform = input.platform ?? process.platform;
  const disc = profile.executableDiscovery;
  const relativeExe = disc?.installRelativeExe?.length ? disc.installRelativeExe : ["app/ChatGPT.exe"];

  // 1) 显式路径（gui.exePath 或 command）
  const explicit = profile.gui?.exePath?.trim() || profile.command?.trim();
  if (explicit && isExecutableFile(explicit))
    return { path: explicit, source: "explicit" };

  if (platform === "win32") {
    // 2) Appx 查询（权威、自动跟版本）
    const appx = input.appx !== undefined ? input.appx : queryAppxPackage(disc?.appxPackageName);
    if (appx?.installLocation) {
      for (const rel of relativeExe) {
        const full = path.join(appx.installLocation, rel.split("/").join(path.sep));
        if (isExecutableFile(full))
          return {
            path: full,
            aumid: `${appx.packageFamilyName}!App`,
            installLocation: appx.installLocation,
            source: "appx",
            version: appx.version,
          };
      }
    }

    // 3) 扫盘回退
    const scanRoots = (
      input.scanRoots ??
      (disc?.scanRoots?.length
        ? disc.scanRoots.map(expandEnvPath)
        : [path.join(process.env.SystemDrive ?? "C:", "Program Files", "WindowsApps")])
    ).map(expandEnvPath);
    const scanned = input.scanned ?? scanForCodex(scanRoots, relativeExe, disc?.scanPattern);
    if (scanned.length > 0) {
      const chosen = scanned[0]!;
      const installLocation = path.dirname(path.dirname(chosen));
      return {
        path: chosen,
        aumid: discoverAumidFromScan(chosen, disc?.appxPackageName ?? DEFAULT_APPX_NAME),
        installLocation,
        source: "scan",
      };
    }
    return null;
  }

  // 4) macOS：普通 .app，直接可执行（本轮 research，不参与就绪判定）
  if (platform === "darwin") {
    const dirs = (disc?.dirs ?? []).map(expandEnvPath);
    for (const d of dirs) {
      const full = path.join(d, "ChatGPT");
      const alt = path.join(d, "Codex");
      if (isExecutableFile(full)) return { path: full, source: "macos" };
      if (isExecutableFile(alt)) return { path: alt, source: "macos" };
    }
  }
  return null;
}

/**
 * 从扫到的路径推断 AUMID：目录名形如 OpenAI.Codex_<ver>_x64__<pfn>，
 * 取最后一段（publisher hash）拼 PackageFamilyName + !App。
 */
export function discoverAumidFromScan(exePath: string, packageName: string): string | undefined {
  const parts = exePath.split(/[\\/]+/);
  for (const seg of parts) {
    const m = /^([A-Za-z0-9._-]+?)_\d+\.\d+[\d.]*_[a-z0-9]+__([a-z0-9]+)$/i.exec(seg);
    if (m) return `${m[1]}_${m[2]}!App`;
  }
  // 兜底：用包名 + 已知 publisher 后缀
  if (parts.some((s) => s.startsWith(packageName))) return `${packageName}_${DEFAULT_PFN_SUFFIX}!App`;
  return undefined;
}
