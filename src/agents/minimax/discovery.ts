/**
 * MiniMax Code 安装探测。
 *
 * 真机事实（2026-10-05，MiniMax Code 3.1.0 / Electron 42.8.0 / Chromium 148.0.7778.280）：
 * - 普通 Electron 安装（非 MSIX）：`LICENSE.electron.txt` + `resources/app.asar`（426MB）；
 * - 实测安装于 `D:\MiniMax-Code\MiniMax Code\MiniMax Code.exe`（232MB）；
 * - 无 `resources/*-config.json` 形式的版本文件（opendesign 有），版本号只能从 CDP UA 读，
 *   而 UA 在驱动失败时恰恰读不到 → 不做前置版本门禁，改用 selector_drift 兜底。
 *
 * 探测顺序（与 kimicode/opendesign 同构）：显式路径 → 固定盘相对路径（preferredDrives 优先）
 * → 注册表安装位置 → 标准目录（含 macOS .app bundle）→ PATH。可选注入输入让顺序/平台行为可单测。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProfile } from "../../config/schema.js";
import { expandEnvPath } from "../../util/path.js";
import { execFileAsync } from "../../verify/exec.js";

/** 可执行名（含空格）——探测端按 basename 完整名精确匹配，不做模糊包含 */
export const MINIMAX_EXE_NAME = "MiniMax Code.exe";

/** macOS bundle 内的可执行名（无扩展名） */
export const MINIMAX_MAC_EXE_NAME = "MiniMax Code";

export interface MinimaxCandidate {
  path: string;
  source: "explicit" | "fixed-drive" | "registry" | "standard" | "path" | "bundle";
  version?: string;
}

/** 可执行名含空格（MiniMax Code.exe），所以取 basename 后按完整名精确匹配，不做模糊包含。 */
function validExecutable(p: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const fileName = p.split(/[\\/]/).at(-1) ?? "";
    return (
      fs.statSync(p).isFile() &&
      (platform === "win32"
        ? /^minimax code\.exe$/i.test(fileName)
        : /^minimax code$/i.test(fileName))
    );
  } catch {
    return false;
  }
}

/**
 * 读文件版本；非 Windows 或路径不存在时安全返回 undefined（探测顺序不应因版本查询失败而中断）。
 *
 * 超时取 30s：本机实测 PowerShell 冷启动（首次 `Add-Type`/模块加载）需 6–10s，
 * 原先的 5s 会让版本恒为空——`query_info(type=profiles)` 于是显示不出已安装客户端的版本。
 * 只影响诊断信息的完整性，不影响可用性判定。
 */
async function fileVersion(p: string): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  if (!fs.existsSync(p)) return undefined;
  const escaped = p.replace(/'/g, "''");
  const res = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${escaped}').VersionInfo.FileVersion`],
    { timeoutMs: 30_000 },
  );
  return res.status === 0 ? res.stdout.trim() || undefined : undefined;
}

export function normalizeDrive(value: string): string | null {
  const m = /^([A-Za-z]):$/.exec(value.trim());
  return m ? `${m[1]!.toUpperCase()}:` : null;
}

/** 枚举本机固定盘（DriveType=3）；查询失败返回空数组，调用方仍需按配置的 preferredDrives 探测。 */
export async function windowsFixedDrives(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const res = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID",
    ],
    { timeoutMs: 8_000 },
  );
  if (res.status !== 0) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((s) => normalizeDrive(s))
    .filter((s): s is string => Boolean(s));
}

export function orderedDrives(all: string[], preferred: string[]): string[] {
  const normalized = [...new Set(all.map(normalizeDrive).filter((s): s is string => Boolean(s)))];
  const prefs = preferred.map(normalizeDrive).filter((s): s is string => Boolean(s));
  return [
    ...prefs.filter((p) => normalized.includes(p)),
    ...normalized.filter((d) => !prefs.includes(d)),
  ];
}

/**
 * 注册表卸载信息里的安装目录（MiniMax Code 为普通安装，会登记 InstallLocation）。
 * 真机实测的 DisplayName 形如 `MiniMax Code`，正则刻意接受 `MiniMax Code` / `MiniMax-Code`。
 */
async function registryInstallLocations(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const script =
    "$roots=@('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -match '^MiniMax[ -]?Code' -and $_.InstallLocation} | ForEach-Object {$_.InstallLocation}";
  const res = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    timeoutMs: 8_000,
  });
  if (res.status !== 0) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function pathCandidates(platform: NodeJS.Platform): string[] {
  const names = platform === "win32" ? [MINIMAX_EXE_NAME] : [MINIMAX_MAC_EXE_NAME];
  const api = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  return (process.env.PATH ?? "")
    .split(delimiter)
    .flatMap((dir) => names.map((name) => api.join(dir, name)));
}

/**
 * 数据驱动的 MiniMax Code 探测：显式路径 → 固定盘相对路径（preferredDrives 优先）→ 注册表安装位置
 * → 标准目录（含 macOS .app bundle）→ PATH。可选注入输入让顺序/平台行为可单测。
 */
export async function discoverMinimax(
  profile: AgentProfile,
  input: {
    platform?: NodeJS.Platform;
    fixedDrives?: string[];
    registryDirs?: string[];
    driveRoots?: Record<string, string>;
  } = {},
): Promise<MinimaxCandidate | null> {
  const platform = input.platform ?? process.platform;
  const explicit = profile.gui?.exePath?.trim() || profile.command?.trim();
  if (explicit && validExecutable(explicit, platform))
    return { path: explicit, source: "explicit", version: await fileVersion(explicit) };
  const disc = profile.executableDiscovery;
  if (!disc) return null;

  const firstValid = async (
    candidates: Array<{ p: string; source: MinimaxCandidate["source"] }>,
  ): Promise<MinimaxCandidate | null> => {
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = platform === "win32" ? candidate.p.toLowerCase() : candidate.p;
      if (seen.has(key)) continue;
      seen.add(key);
      if (validExecutable(candidate.p, platform))
        return {
          path: candidate.p,
          source: candidate.source,
          version: await fileVersion(candidate.p),
        };
    }
    return null;
  };

  if (platform === "win32") {
    const preferredDrives = (disc.preferredDrives ?? [])
      .map(normalizeDrive)
      .filter((drive): drive is string => Boolean(drive));
    const driveCandidates = (
      drives: string[],
    ): Array<{ p: string; source: MinimaxCandidate["source"] }> => {
      const candidates: Array<{ p: string; source: MinimaxCandidate["source"] }> = [];
      for (const drive of drives)
        for (const rel of disc.relativePaths ?? [])
          candidates.push({
            // `platform` 可注入以便跨平台单测；候选路径仍属于执行 fs.statSync 的宿主文件系统。
            p: path.join(input.driveRoots?.[drive] ?? `${drive}\\`, rel),
            source: "fixed-drive",
          });
      return candidates;
    };

    // 配置的 preferredDrives 是显式 profile 数据：优先探测，使 WMI 固定盘查询慢/失败时
    // 不会让已安装的 GUI agent 短暂「不可用」。
    const preferred = await firstValid(driveCandidates(preferredDrives));
    if (preferred) return preferred;

    const drives = orderedDrives(
      input.fixedDrives ?? (await windowsFixedDrives()),
      preferredDrives,
    ).filter((drive) => !preferredDrives.includes(drive));
    const fixedDrive = await firstValid(driveCandidates(drives));
    if (fixedDrive) return fixedDrive;

    const registryCandidates: Array<{ p: string; source: MinimaxCandidate["source"] }> = [];
    for (const dir of input.registryDirs ?? (await registryInstallLocations())) {
      registryCandidates.push({ p: path.join(dir, MINIMAX_EXE_NAME), source: "registry" });
      registryCandidates.push({
        p: path.join(dir, "MiniMax Code", MINIMAX_EXE_NAME),
        source: "registry",
      });
    }
    const registry = await firstValid(registryCandidates);
    if (registry) return registry;
  }

  const standardCandidates: Array<{ p: string; source: MinimaxCandidate["source"] }> = [];
  for (const dirTpl of disc.dirs ?? []) {
    const dir = expandEnvPath(dirTpl.replace("{HOME}", os.homedir()));
    for (const name of disc.fileNames ?? [])
      standardCandidates.push({
        p: path.join(dir, name),
        source: platform === "darwin" && dir.includes(".app") ? "bundle" : "standard",
      });
  }
  const standard = await firstValid(standardCandidates);
  if (standard) return standard;

  const executableInPath = await firstValid(
    pathCandidates(platform).map((p) => ({ p, source: "path" as const })),
  );
  return executableInPath;
}
