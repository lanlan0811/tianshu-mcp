/**
 * TraeWork / TRAE SOLO CN 安装发现（issue #23 C3）。
 *
 * 背景：TraeWork 原先没有 discovery.ts，落到 registry.ts 的通用 probeDiscovery——
 * 只按已列目录递归（maxDepth=6），**无盘符枚举、无相对路径、无注册表**，故装在
 * 非标准盘符（D:\ / E:\）的客户端永远找不到，且内置目录写成 `{APPDATA}/TRAE SOLO CN`
 * （Roaming）而实际安装在 `{LOCALAPPDATA}/Programs`（Local）。
 *
 * 本文件复用 zcode/qoder 的固定盘扫描 + 注册表 + 相对路径逻辑，顺序：
 *   显式 exePath/command → preferredDrives×relativePaths → 注册表 InstallLocation
 *   → 快捷键(.lnk) → 固定盘×relativePaths → 标准目录（含 macOS .app bundle）→ PATH
 *
 * 可执行名（Windows）**只认 TRAE SOLO CN.exe**：内置清单曾含 "Trae CN"，而它属于
 * 另一个产品 TraeCode CN（本机 D:\Trae CN\Trae CN.exe 确实存在），会误匹配。
 *
 * 可选注入输入（fixedDrives/registryDirs/driveRoots/shortcuts/readVersion）便于单测。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProfile } from "../../config/schema.js";
import { expandEnvPath } from "../../util/path.js";
import { execFileAsync } from "../../verify/exec.js";

export interface TraeworkCandidate {
  path: string;
  source: "explicit" | "fixed-drive" | "registry" | "shortcut" | "standard" | "path" | "bundle";
  version?: string;
}

/** Windows 只认 TRAE SOLO CN.exe；macOS 允许旧命名（bundle 内可执行）。 */
export function validExecutable(p: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const fileName = p.split(/[\\/]/).at(-1) ?? "";
    return (
      fs.statSync(p).isFile() &&
      (platform === "win32"
        ? /^trae solo cn\.exe$/i.test(fileName)
        : /^(trae ?(solo ?cn|work ?cn|work) cn?|trae ?cn)$/i.test(fileName))
    );
  } catch {
    return false;
  }
}

/**
 * 读文件版本；非 Windows 或路径不存在时安全返回 undefined。
 * 超时取 30s：本机实测 PowerShell 冷启动（首次 Add-Type/模块加载）需 6–10s，
 * 5s 会让版本恒为空；只影响诊断信息完整性，不影响可用性判定。
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

/** 注册表卸载信息里的安装目录（TraeWork 为普通安装，会登记 InstallLocation）。 */
async function registryInstallLocations(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const script =
    "$roots=@('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -match '^(TraeWork|TRAE)[ -]?(SOLO[ -]?CN|Work[ -]?CN|Work)' -and $_.InstallLocation} | ForEach-Object {$_.InstallLocation}";
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
  const names = platform === "win32" ? ["TRAE SOLO CN.exe"] : ["TRAE SOLO CN", "TraeWork"];
  const api = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  return (process.env.PATH ?? "")
    .split(delimiter)
    .flatMap((dir) => names.map((name) => api.join(dir, name)));
}

async function shortcutTargets(): Promise<string[]> {
  const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$sh=New-Object -ComObject WScript.Shell
$roots=@([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'),[Environment]::GetFolderPath('Programs'),[Environment]::GetFolderPath('CommonPrograms'))
foreach($root in $roots){
  if($root -and (Test-Path -LiteralPath $root)){
    Get-ChildItem -LiteralPath $root -Filter '*TRAE*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
      $target=$sh.CreateShortcut($_.FullName).TargetPath
      if([IO.Path]::GetFileName($target) -ieq 'TRAE SOLO CN.exe'){Write-Output $target}
    }
  }
}`;
  const res = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { timeoutMs: 8_000 });
  return res.status === 0 ? res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * 数据驱动的 TraeWork 探测：显式路径 → 固定盘相对路径（preferredDrives 优先）
 * → 注册表安装位置 → 快捷键 → 固定盘枚举 → 标准目录（含 macOS .app bundle）→ PATH。
 */
export async function discoverTraework(
  profile: AgentProfile,
  input: {
    platform?: NodeJS.Platform;
    fixedDrives?: string[];
    registryDirs?: string[];
    driveRoots?: Record<string, string>;
    shortcuts?: string[];
    readVersion?: (file: string) => Promise<string | undefined>;
  } = {},
): Promise<TraeworkCandidate | null> {
  const platform = input.platform ?? process.platform;
  const versionOf = input.readVersion ?? fileVersion;
  const explicit = profile.gui?.exePath?.trim() || profile.command?.trim();
  if (explicit && validExecutable(explicit, platform))
    return { path: explicit, source: "explicit", version: await versionOf(explicit) };
  const disc = profile.executableDiscovery;
  if (!disc) return null;

  const firstValid = async (
    candidates: Array<{ p: string; source: TraeworkCandidate["source"] }>,
  ): Promise<TraeworkCandidate | null> => {
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = platform === "win32" ? candidate.p.toLowerCase() : candidate.p;
      if (seen.has(key)) continue;
      seen.add(key);
      if (validExecutable(candidate.p, platform))
        // eslint-disable-next-line no-await-in-loop
        return { path: candidate.p, source: candidate.source, version: await versionOf(candidate.p) };
    }
    return null;
  };

  if (platform === "win32") {
    const preferredDrives = (disc.preferredDrives ?? [])
      .map(normalizeDrive)
      .filter((drive): drive is string => Boolean(drive));
    const driveCandidates = (
      drives: string[],
    ): Array<{ p: string; source: TraeworkCandidate["source"] }> => {
      const candidates: Array<{ p: string; source: TraeworkCandidate["source"] }> = [];
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

    const registryCandidates: Array<{ p: string; source: TraeworkCandidate["source"] }> = [];
    for (const dir of input.registryDirs ?? (await registryInstallLocations())) {
      for (const rel of ["TRAE SOLO CN.exe", "TRAE Work CN/TRAE SOLO CN.exe", "TRAE SOLO CN/TRAE SOLO CN.exe"])
        registryCandidates.push({ p: path.join(dir, rel), source: "registry" });
    }
    const registry = await firstValid(registryCandidates);
    if (registry) return registry;

    const shortcut = await firstValid(
      (input.shortcuts ?? (await shortcutTargets())).map((p) => ({ p, source: "shortcut" as const })),
    );
    if (shortcut) return shortcut;

    const drives = orderedDrives(input.fixedDrives ?? (await windowsFixedDrives()), preferredDrives).filter(
      (drive) => !preferredDrives.includes(drive),
    );
    const fixedDrive = await firstValid(driveCandidates(drives));
    if (fixedDrive) return fixedDrive;
  }

  const standardCandidates: Array<{ p: string; source: TraeworkCandidate["source"] }> = [];
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
