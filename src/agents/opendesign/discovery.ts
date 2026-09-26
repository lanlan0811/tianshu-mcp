/**
 * Open Design 桌面端（Electron）的安装发现与数据目录推导。
 *
 * 真机事实（2026-09-25，Open Design 0.24.1，Windows 10 19045）：
 * 1) 安装形态是**普通安装**（非 MSIX 商店包）：`D:\Open Design\Open Design.exe`，
 *    因此 `CreateProcess` 直启即可注入 `--remote-debugging-port`，不需要 Codex 那套 COM 激活。
 * 2) 版本与命名空间不写死：都从安装目录的 `resources/open-design-config.json` 读取
 *    （实测 `{"appVersion":"0.24.1","namespace":"release-stable-win", ...}`）。
 * 3) 数据目录是 `%APPDATA%\Open Design\namespaces\<namespace>`（Electron userData 被
 *    主进程强制 setPath 到这里，**不读 `--user-data-dir`**；见 packaged-main 的
 *    applyPackagedElectronPathOverrides / resolvePackagedNamespacePaths）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentProfile } from "../../config/schema.js";
import { expandEnvPath } from "../../util/path.js";
import { execFileAsync } from "../../verify/exec.js";

export interface OpenDesignCandidate {
  path: string;
  source: "explicit" | "fixed-drive" | "registry" | "standard" | "path" | "bundle";
  version?: string;
}

/** 安装目录内、承载版本与命名空间的配置文件（相对 exe 所在目录）。 */
export const OPEN_DESIGN_CONFIG_RELATIVE = "resources/open-design-config.json";

/** 可执行名含空格（Open Design.exe），取 basename 后按完整名精确匹配，不做模糊包含。 */
/** 文件存在性判定（可注入以便跨平台单测，见 discoverOpenDesign 的 input.statFile） */
export type StatFileFn = (p: string) => boolean;

const defaultStatFile: StatFileFn = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

export function validExecutable(
  p: string,
  platform: NodeJS.Platform = process.platform,
  statFile: StatFileFn = defaultStatFile,
): boolean {
  const fileName = p.split(/[\\/]/).at(-1) ?? "";
  return (
    statFile(p) &&
    (platform === "win32" ? /^open design\.exe$/i : /^open design$/i).test(fileName)
  );
}

export interface OpenDesignInstallInfo {
  /** 安装目录（exe 所在目录）；macOS 下是 .app 内的 MacOS 目录 */
  installDir: string;
  appVersion?: string;
  namespace?: string;
  /** resourceRoot：安装目录下 resources/ */
  resourcesDir: string;
}

/**
 * 按**路径自身的风格**选 path 实现。
 *
 * 为什么需要它（CI 实测教训）：`discoverOpenDesign(profile, { platform: "win32" })` 在 POSIX 宿主上
 * 会产出 `D:\...\Open Design.exe` 这样的 win32 风格路径，而 `path.dirname`/`path.join` 是**宿主**语义：
 * 在 POSIX 上 `dirname("D:\\a\\b.exe")` 得到 `"."`，于是 `resources/open-design-config.json` 永远找不到、
 * 版本恒为空 —— Windows 腿通过、ubuntu/macos 腿失败。
 * 因此凡是「可能收到非宿主风格路径」的解析都必须按路径风格分派。
 */
function pathApiFor(p: string): typeof path.win32 {
  // 反斜杠或盘符前缀 → 按 win32 解析；否则按宿主风格
  return /^[a-zA-Z]:/.test(p) || p.includes("\\") ? path.win32 : (path as unknown as typeof path.win32);
}

/**
 * 解析安装信息。`--config` 不存在或不可解析时返回 null（探测顺序不应被版本查询中断）。
 */
export function readInstallInfo(
  exePath: string,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8"),
): OpenDesignInstallInfo | null {
  const api = pathApiFor(exePath);
  const installDir = api.dirname(exePath);
  const configPath = api.join(installDir, OPEN_DESIGN_CONFIG_RELATIVE);
  const resourcesDir = api.join(installDir, "resources");
  let appVersion: string | undefined;
  let namespace: string | undefined;
  try {
    const raw = JSON.parse(readFile(configPath)) as {
      appVersion?: unknown;
      namespace?: unknown;
    };
    if (typeof raw.appVersion === "string" && raw.appVersion.trim())
      appVersion = raw.appVersion.trim();
    if (typeof raw.namespace === "string" && raw.namespace.trim()) namespace = raw.namespace.trim();
  } catch {
    return null;
  }
  return { installDir, appVersion, namespace, resourcesDir };
}

/**
 * 数据目录（Electron userData 根）：
 * Windows/macOS 都是 `<APPDATA|HOME>/Open Design/namespaces/<namespace>`。
 * 命名空间来自安装配置，取不到时返回 null——**不回退到写死的命名空间**，
 * 因为猜错命名空间会导致「绑定了目录但读不到 app-config.json」这类静默误判。
 */
export function openDesignNamespaceRoot(
  info: Pick<OpenDesignInstallInfo, "namespace">,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!info.namespace) return null;
  const base =
    process.platform === "win32"
      ? env.APPDATA
      : path.join(env.HOME ?? os.homedir(), "Library", "Application Support");
  if (!base) return null;
  return path.join(base, "Open Design", "namespaces", info.namespace);
}

/** `<namespaceRoot>/data/app-config.json`（含 agentModels / designSystemId / recentLinkedDirs）。 */
export function openDesignAppConfigPath(namespaceRoot: string | null): string | null {
  return namespaceRoot ? path.join(namespaceRoot, "data", "app-config.json") : null;
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

/** 注册表卸载信息里的安装目录（Open Design 为普通安装，会登记 InstallLocation）。 */
async function registryInstallLocations(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const script =
    "$roots=@('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -match '^Open[ -]?Design' -and $_.InstallLocation} | ForEach-Object {$_.InstallLocation}";
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
  const names = platform === "win32" ? ["Open Design.exe"] : ["Open Design"];
  const api = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  return (process.env.PATH ?? "")
    .split(delimiter)
    .flatMap((dir) => names.map((name) => api.join(dir, name)));
}

/**
 * 数据驱动的 Open Design 探测：显式路径 → 固定盘相对路径（preferredDrives 优先）
 * → 注册表安装位置 → 标准目录（含 macOS .app bundle）→ PATH。
 * 可选注入输入让顺序/平台行为可单测（与 kimicode/qoder 的 discovery 同构）。
 */
export async function discoverOpenDesign(
  profile: AgentProfile,
  input: {
    platform?: NodeJS.Platform;
    fixedDrives?: string[];
    registryDirs?: string[];
    driveRoots?: Record<string, string>;
    /**
     * 文件存在性判定（注入点）。
     * 为什么需要：win32 目标的候选路径在 POSIX 宿主上**不可能真的存在**（反斜杠不是分隔符），
     * 用真实 `fs.statSync` 会让「候选路径分隔符」这条断言只能在 Windows 上通过——
     * 正是 CI ubuntu/macos 腿长期红的原因。测试注入此函数即可让断言与宿主无关。
     */
    statFile?: StatFileFn;
  } = {},
): Promise<OpenDesignCandidate | null> {
  const platform = input.platform ?? process.platform;
  const statFile = input.statFile ?? defaultStatFile;
  /**
   * 候选路径必须按**目标平台**拼，不能跟着宿主 `path` 走：
   * `platform` 是注入参数，若仍用宿主 path，跨平台单测只能在 Windows 上通过，
   * CI 的 ubuntu / macOS 腿会因为分隔符不同而失败（实测踩到过）。
   */
  const api = platform === "win32" ? path.win32 : path.posix;
  const explicit = profile.gui?.exePath?.trim() || profile.command?.trim();
  if (explicit) {
    if (!validExecutable(explicit, platform, statFile)) return null;
    return { path: explicit, source: "explicit", version: readInstallInfo(explicit)?.appVersion };
  }
  const disc = profile.executableDiscovery;
  if (!disc) return null;

  const firstValid = (
    candidates: Array<{ p: string; source: OpenDesignCandidate["source"] }>,
  ): OpenDesignCandidate | null => {
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = platform === "win32" ? candidate.p.toLowerCase() : candidate.p;
      if (seen.has(key)) continue;
      seen.add(key);
      if (validExecutable(candidate.p, platform, statFile)) {
        return {
          path: candidate.p,
          source: candidate.source,
          version: readInstallInfo(candidate.p)?.appVersion,
        };
      }
    }
    return null;
  };

  if (platform === "win32") {
    const preferredDrives = (disc.preferredDrives ?? [])
      .map(normalizeDrive)
      .filter((drive): drive is string => Boolean(drive));
    const driveCandidates = (
      drives: string[],
    ): Array<{ p: string; source: OpenDesignCandidate["source"] }> => {
      const candidates: Array<{ p: string; source: OpenDesignCandidate["source"] }> = [];
      for (const drive of drives)
        for (const rel of disc.relativePaths ?? [])
          candidates.push({
            p: api.join(input.driveRoots?.[drive] ?? `${drive}\\`, rel),
            source: "fixed-drive",
          });
      return candidates;
    };

    // 配置的 preferredDrives 是显式 profile 数据：优先探测，使 WMI 固定盘查询慢/失败时
    // 不会让已安装的 GUI agent 短暂「不可用」。
    const preferred = firstValid(driveCandidates(preferredDrives));
    if (preferred) return preferred;

    const registryCandidates: Array<{ p: string; source: OpenDesignCandidate["source"] }> = [];
    for (const dir of input.registryDirs ?? (await registryInstallLocations())) {
      registryCandidates.push({ p: api.join(dir, "Open Design.exe"), source: "registry" });
      registryCandidates.push({
        p: api.join(dir, "Open Design", "Open Design.exe"),
        source: "registry",
      });
    }
    const registry = firstValid(registryCandidates);
    if (registry) return registry;

    const drives = orderedDrives(
      input.fixedDrives ?? (await windowsFixedDrives()),
      preferredDrives,
    ).filter((drive) => !preferredDrives.includes(drive));
    const fixedDrive = firstValid(driveCandidates(drives));
    if (fixedDrive) return fixedDrive;
  }

  const standardCandidates: Array<{ p: string; source: OpenDesignCandidate["source"] }> = [];
  for (const dirTpl of disc.dirs ?? []) {
    const dir = expandEnvPath(dirTpl.replace("{HOME}", os.homedir()));
    for (const name of disc.fileNames ?? [])
      standardCandidates.push({
        p: api.join(dir, name),
        source: platform === "darwin" && dir.includes(".app") ? "bundle" : "standard",
      });
  }
  const standard = firstValid(standardCandidates);
  if (standard) return standard;

  return firstValid(pathCandidates(platform).map((p) => ({ p, source: "path" as const })));
}
