import net from "node:net";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import path from "node:path";
import { TraeworkCdpClient } from "../traework/cdp/client.js";
import type { GuiProfile } from "../../config/schema.js";
import type { AgentRunLogger } from "../adapter.js";
import { execFileAsync } from "../../verify/exec.js";
import { TtlCache } from "../../util/ttl-cache.js";

export interface ZcodeProcess {
  pid: number;
  commandLine: string;
  executable?: string;
}
export interface ZcodeReady {
  port: number;
  title?: string;
  url?: string;
  pid?: number;
}

export function parseProcessRows(raw: string): ZcodeProcess[] {
  const out: ZcodeProcess[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^(\d+)\t(.*?)\t(.*)$/.exec(line.trim());
    if (m) out.push({ pid: Number(m[1]), executable: m[2] || undefined, commandLine: m[3] || "" });
  }
  return out;
}

/** 进程枚举短缓存（1.5s）：轮询环每 tick 复用同一快照，避免重复 powershell/ps 枚举 */
const processCache = new TtlCache<ZcodeProcess[]>(1_500);
/** 无参枚举，缓存 key 为固定常量（参数集为空） */
const PROCESS_CACHE_KEY = "zcode-process-list";

export function listZcodeProcesses(): Promise<ZcodeProcess[]> {
  return processCache.get(PROCESS_CACHE_KEY, enumerateZcodeProcesses);
}

async function enumerateZcodeProcesses(): Promise<ZcodeProcess[]> {
  if (process.platform === "win32") {
    const script =
      'Get-CimInstance Win32_Process -Filter "Name=\'ZCode.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)" }';
    for (let attempt = 0; attempt < 2; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
        timeoutMs: 15_000,
      });
      if (res.status === 0) return parseProcessRows(res.stdout);
    }
    return [];
  }
  const res = await execFileAsync("ps", ["-axo", "pid=,command="], { timeoutMs: 5_000 });
  if (res.status !== 0) return [];
  return res.stdout.split(/\r?\n/).flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*ZCode.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), commandLine: m[2]! }] : [];
  });
}

export interface ZcodeInstanceOptions {
  signal?: AbortSignal;
  deadline?: number;
}
export async function listZcodeProcessesAsync(
  options: ZcodeInstanceOptions = {},
): Promise<ZcodeProcess[]> {
  options.signal?.throwIfAborted();
  const timeout = Math.max(1, Math.min(30_000, (options.deadline ?? Infinity) - Date.now()));
  if (process.platform === "win32") {
    const script =
      'Get-CimInstance Win32_Process -Filter "Name=\'ZCode.exe\'" | ForEach-Object { "$($_.ProcessId)\`t$($_.ExecutablePath)\`t$($_.CommandLine)" }';
    const { stdout } = await promisify(execFile)(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      { timeout, signal: options.signal, windowsHide: true },
    );
    return parseProcessRows(stdout);
  }
  const { stdout } = await promisify(execFile)("ps", ["-axo", "pid=,command="], {
    timeout,
    signal: options.signal,
  });
  return stdout.split(/\r?\n/).flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*ZCode.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), commandLine: m[2]! }] : [];
  });
}

export function rootZcodeProcesses(rows: ZcodeProcess[]): ZcodeProcess[] {
  return rows.filter(
    (p) => !/--type=|zcode\.cjs|plugin-host|cua-helper|crashpad/i.test(p.commandLine),
  );
}

export function remoteDebugPort(commandLine: string): number | null {
  const m = /--remote-debugging-port(?:=|\s+)(\d+)/.exec(commandLine);
  return m ? Number(m[1]) : null;
}

function freePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function productTarget(title = "", url = ""): boolean {
  return /z[ -]?code/i.test(`${title} ${url}`) || /zcode/i.test(url);
}

export async function probeZcodePort(
  port: number,
  processes?: ZcodeProcess[],
): Promise<ZcodeReady | null> {
  const rows = processes ?? (await listZcodeProcesses());
  const owner = rootZcodeProcesses(rows).find((p) => remoteDebugPort(p.commandLine) === port);
  if (!owner) return null;
  try {
    const targets = await TraeworkCdpClient.listTargets(port, 1500);
    const page = targets.find((t) => t.type === "page" && productTarget(t.title, t.url));
    return page ? { port, pid: owner.pid, title: page.title, url: page.url } : null;
  } catch {
    return null;
  }
}

export async function ensureZcodeInstance(
  exePath: string,
  gui: GuiProfile,
  logger: AgentRunLogger,
  options: ZcodeInstanceOptions = {},
): Promise<{ ready?: ZcodeReady; needsClose?: boolean; child?: ChildProcess }> {
  let roots = rootZcodeProcesses(await listZcodeProcessesAsync(options));
  if (!roots.length) {
    await delay(500, undefined, { signal: options.signal });
    roots = rootZcodeProcesses(await listZcodeProcessesAsync(options));
  }
  if (roots.length) {
    if (!roots.some((proc) => remoteDebugPort(proc.commandLine))) return { needsClose: true };
    const reuseDeadline = Math.min(options.deadline ?? Infinity, Date.now() + gui.launchTimeoutMs);
    while (Date.now() < reuseDeadline) {
      roots = rootZcodeProcesses(await listZcodeProcessesAsync(options));
      for (const proc of roots) {
        const port = remoteDebugPort(proc.commandLine);
        if (port) {
          // eslint-disable-next-line no-await-in-loop
          const ready = await probeZcodePort(port, roots);
          if (ready) return { ready };
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(500, undefined, { signal: options.signal });
    }
    throw new Error(`等待既有 ZCode CDP 页面就绪超时（${gui.launchTimeoutMs}ms）`);
  }
  options.signal?.throwIfAborted();
  let port = gui.cdpPort;
  if (gui.cdpPortAuto) {
    let found = false;
    for (let i = 0; i < gui.cdpPortRange; i++) {
      // eslint-disable-next-line no-await-in-loop
      if (await freePort(gui.cdpPort + i)) {
        port = gui.cdpPort + i;
        found = true;
        break;
      }
    }
    if (!found)
      throw new Error(
        `ZCode CDP 端口范围不可用：${gui.cdpPort}-${gui.cdpPort + gui.cdpPortRange - 1}`,
      );
  } else if (!(await freePort(port))) throw new Error(`ZCode CDP 端口 ${port} 已被占用`);
  const args = gui.exeArgs.map((arg) => arg.replaceAll("<port>", String(port)));
  options.signal?.throwIfAborted();
  const child = spawn(exePath, args, { detached: false, stdio: "ignore", windowsHide: false });
  let launchError: Error | undefined;
  child.once("error", (error) => {
    launchError = error;
  });
  // The desktop survives the MCP client; do not keep a completed smoke/server process alive.
  child.unref();
  logger.info(
    `[zcode] 已启动 ${path.basename(exePath)}，CDP 端口 ${port}，pid=${child.pid ?? "unknown"}`,
  );
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + gui.launchTimeoutMs);
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await delay(500, undefined, { signal: options.signal });
    // eslint-disable-next-line no-await-in-loop
    if (launchError) throw launchError;
    const ready = await probeZcodePort(port, await listZcodeProcessesAsync(options));
    if (ready) return { ready, child };
    if (child.exitCode !== null) {
      const forwardedRoots = rootZcodeProcesses(await listZcodeProcessesAsync(options));
      for (const proc of forwardedRoots) {
        const forwardedPort = remoteDebugPort(proc.commandLine);
        if (forwardedPort) {
          // eslint-disable-next-line no-await-in-loop
          const forwarded = await probeZcodePort(forwardedPort, forwardedRoots);
          if (forwarded) {
            logger.info(
              `[zcode] 启动器 exit=${child.exitCode}，已复用现有 ZCode CDP 端口 ${forwarded.port}`,
            );
            return { ready: forwarded, child };
          }
        }
      }
      if (child.exitCode !== 0) throw new Error(`ZCode 启动后提前退出（exit=${child.exitCode}）`);
    }
  }
  throw new Error(`等待 ZCode CDP 就绪超时（${gui.launchTimeoutMs}ms）`);
}
