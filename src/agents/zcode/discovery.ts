import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AgentProfile } from "../../config/schema.js";
import { expandEnvPath } from "../../util/path.js";

export interface ZcodeCandidate {
  path: string;
  source: "explicit" | "fixed-drive" | "registry" | "standard" | "path" | "bundle";
  version?: string;
}

function validExecutable(p: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const fileName = p.split(/[\\/]/).at(-1) ?? "";
    return (
      fs.statSync(p).isFile() &&
      (platform === "win32" ? /^zcode\.exe$/i : /^zcode$/i).test(fileName)
    );
  } catch {
    return false;
  }
}

function fileVersion(p: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const escaped = p.replace(/'/g, "''");
    return (
      execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-Item -LiteralPath '${escaped}').VersionInfo.FileVersion`],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5_000,
        },
      ).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

export function normalizeDrive(value: string): string | null {
  const m = /^([A-Za-z]):$/.exec(value.trim());
  return m ? `${m[1]!.toUpperCase()}:` : null;
}

export function windowsFixedDrives(): string[] {
  if (process.platform !== "win32") return [];
  try {
    const raw = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID",
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 8_000,
      },
    );
    return raw
      .split(/\r?\n/)
      .map((s) => normalizeDrive(s))
      .filter((s): s is string => Boolean(s));
  } catch {
    return [];
  }
}

export function orderedDrives(all: string[], preferred: string[]): string[] {
  const normalized = [...new Set(all.map(normalizeDrive).filter((s): s is string => Boolean(s)))];
  const prefs = preferred.map(normalizeDrive).filter((s): s is string => Boolean(s));
  return [
    ...prefs.filter((p) => normalized.includes(p)),
    ...normalized.filter((d) => !prefs.includes(d)),
  ];
}

function registryInstallLocations(): string[] {
  if (process.platform !== "win32") return [];
  const script =
    "$roots=@('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -match '^Z[ -]?Code' -and $_.InstallLocation} | ForEach-Object {$_.InstallLocation}";
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8_000,
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function pathCandidates(platform: NodeJS.Platform): string[] {
  const names = platform === "win32" ? ["ZCode.exe"] : ["ZCode"];
  const api = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  return (process.env.PATH ?? "")
    .split(delimiter)
    .flatMap((dir) => names.map((name) => api.join(dir, name)));
}

/** Data-driven ZCode discovery. Optional injected inputs make order/platform behavior unit-testable. */
export function discoverZcode(
  profile: AgentProfile,
  input: {
    platform?: NodeJS.Platform;
    fixedDrives?: string[];
    registryDirs?: string[];
    driveRoots?: Record<string, string>;
  } = {},
): ZcodeCandidate | null {
  const platform = input.platform ?? process.platform;
  const explicit = profile.gui?.exePath?.trim() || profile.command?.trim();
  if (explicit && validExecutable(explicit, platform))
    return { path: explicit, source: "explicit", version: fileVersion(explicit) };
  const disc = profile.executableDiscovery;
  if (!disc) return null;

  const firstValid = (
    candidates: Array<{ p: string; source: ZcodeCandidate["source"] }>,
  ): ZcodeCandidate | null => {
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = platform === "win32" ? candidate.p.toLowerCase() : candidate.p;
      if (seen.has(key)) continue;
      seen.add(key);
      if (validExecutable(candidate.p, platform))
        return { path: candidate.p, source: candidate.source, version: fileVersion(candidate.p) };
    }
    return null;
  };

  if (platform === "win32") {
    const preferredDrives = (disc.preferredDrives ?? [])
      .map(normalizeDrive)
      .filter((drive): drive is string => Boolean(drive));
    const driveCandidates = (
      drives: string[],
    ): Array<{ p: string; source: ZcodeCandidate["source"] }> => {
      const candidates: Array<{ p: string; source: ZcodeCandidate["source"] }> = [];
      for (const drive of drives)
        for (const rel of disc.relativePaths ?? [])
          candidates.push({
            // `platform` can be injected for cross-platform tests; candidate paths still belong
            // to the host filesystem that performs fs.statSync.
            p: path.join(input.driveRoots?.[drive] ?? `${drive}\\`, rel),
            source: "fixed-drive",
          });
      return candidates;
    };

    // Configured preferred drives are explicit profile data. Probe them first so a slow/failed
    // WMI fixed-drive query cannot make an installed GUI agent transiently unavailable.
    const preferred = firstValid(driveCandidates(preferredDrives));
    if (preferred) return preferred;

    const drives = orderedDrives(input.fixedDrives ?? windowsFixedDrives(), preferredDrives).filter(
      (drive) => !preferredDrives.includes(drive),
    );
    const fixedDrive = firstValid(driveCandidates(drives));
    if (fixedDrive) return fixedDrive;

    const registryCandidates: Array<{ p: string; source: ZcodeCandidate["source"] }> = [];
    for (const dir of input.registryDirs ?? registryInstallLocations()) {
      registryCandidates.push({ p: path.join(dir, "ZCode.exe"), source: "registry" });
      registryCandidates.push({
        p: path.join(dir, "ZCode", "ZCode.exe"),
        source: "registry",
      });
    }
    const registry = firstValid(registryCandidates);
    if (registry) return registry;
  }

  const standardCandidates: Array<{ p: string; source: ZcodeCandidate["source"] }> = [];
  for (const dirTpl of disc.dirs ?? []) {
    const dir = expandEnvPath(dirTpl.replace("{HOME}", os.homedir()));
    for (const name of disc.fileNames ?? [])
      standardCandidates.push({
        p: path.join(dir, name),
        source: platform === "darwin" && dir.includes(".app") ? "bundle" : "standard",
      });
  }
  const standard = firstValid(standardCandidates);
  if (standard) return standard;

  const executableInPath = firstValid(
    pathCandidates(platform).map((p) => ({ p, source: "path" as const })),
  );
  return executableInPath;
}
