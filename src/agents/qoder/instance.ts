/** Qoder CN GUI support. Protocol and native-dialog scaffolding derived from the existing Electron adapters; Qoder-specific behavior is verified separately. */
import net from "node:net";
import { get as httpGet } from "node:http";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { spawn, execFile } from "node:child_process";
import path from "node:path";
import type { GuiProfile } from "../../config/schema.js";
import type { AgentRunLogger } from "../adapter.js";
import { execFileAsync } from "../../verify/exec.js";
import { TtlCache } from "../../util/ttl-cache.js";
import { guiInstanceSpawnOptions } from "../gui-instance.js";
import { qoderTargetRank } from './cdp.js';

export interface QoderProcess {
  pid: number;
  commandLine: string;
  executable?: string;
}

export interface QoderReady {
  port: number;
  title?: string;
  url?: string;
  pid?: number;
}

export interface QoderProbeResult {
  ready: boolean;
  /** /json/version 里的产品版本串（Browser 字段优先，缺省退回 User-Agent） */
  version?: string;
  title?: string;
  url?: string;
}

/** Windows：`pid\texe\tcommandLine`；darwin 的 ps 行在解析时补成同样形状 */
export function parseProcessRows(raw: string): QoderProcess[] {
  const out: QoderProcess[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^(\d+)\t(.*?)\t(.*)$/.exec(line.trim());
    if (m) out.push({ pid: Number(m[1]), executable: m[2] || undefined, commandLine: m[3] || "" });
  }
  return out;
}

/** 进程枚举短缓存（1.5s）：轮询环每 tick 复用同一快照，避免重复 powershell/pgrep 枚举 */
const processCache = new TtlCache<QoderProcess[]>(1_500);
const PROCESS_CACHE_KEY = "qoder-process-list";

export function listQoderProcesses(): Promise<QoderProcess[]> {
  return processCache.get(PROCESS_CACHE_KEY, enumerateQoderProcesses);
}

/** macOS 进程匹配模式：可执行名含空格，用 pgrep -f 匹配完整名 */
const QODER_PROCESS_PATTERN = "Qoder CN";

async function enumerateQoderProcesses(): Promise<QoderProcess[]> {
  if (process.platform === "win32") {
    // 可执行名含空格：Win32_Process 的 Name 过滤字面量必须是 'Qoder CN.exe'。
    const script =
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter "Name=\'Qoder CN.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)" }';
    for (let attempt = 0; attempt < 2; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
        timeoutMs: 15_000,
      });
      if (res.status === 0) return parseProcessRows(res.stdout);
    }
    throw new Error("Qoder 进程枚举失败，拒绝启动重复实例");
  }
  const pids = await execFileAsync("pgrep", ["-f", QODER_PROCESS_PATTERN], { timeoutMs: 5_000 });
  if (pids.status !== 0) return [];
  const list = pids.stdout
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 64);
  if (!list.length) return [];
  // pgrep 只给 pid；调试端口在 argv 里，必须再取一次命令行。
  const details = await execFileAsync("ps", ["-p", list.join(","), "-o", "pid=,command="], {
    timeoutMs: 5_000,
  });
  if (details.status !== 0) return [];
  return details.stdout.split(/\r?\n/).flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), commandLine: m[2]! }] : [];
  });
}

export interface QoderInstanceOptions {
  signal?: AbortSignal;
  deadline?: number;
}

/** 带 signal/deadline 的进程枚举（ensureQoderInstance 内部用；缓存版本不感知取消） */
export async function listQoderProcessesAsync(
  options: QoderInstanceOptions = {},
): Promise<QoderProcess[]> {
  options.signal?.throwIfAborted();
  if (process.platform === "win32") {
    const timeout = Math.max(1, Math.min(30_000, (options.deadline ?? Infinity) - Date.now()));
    const script =
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter "Name=\'Qoder CN.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)" }';
    const { stdout } = await promisify(execFile)(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      { timeout, signal: options.signal, windowsHide: true },
    );
    return parseProcessRows(stdout);
  }
  return enumerateQoderProcesses();
}

/**
 * 只保留 Qoder CN 根进程：Electron 的渲染/GPU/工具子进程同样命中可执行名，
 * 它们不带（也不该带）调试端口，混进来会让「是否已存在无 CDP 实例」的判断失真。
 */
export function rootQoderProcesses(rows: QoderProcess[]): QoderProcess[] {
  return rows.filter(
    (p) => !/--type=|crashpad|plugin-host|cua-helper|utility-sub-type|plugins[\\/]|node-repl/i.test(p.commandLine),
  );
}

export function remoteDebugPort(commandLine: string): number | null {
  const m = /--remote-debugging-port(?:=|\s+)(\d+)/.exec(commandLine);
  const value=m?Number(m[1]):0;
  return value>0&&value<=65535?value:null;
}

function freePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** CDP 只读 JSON 端点读取器（单测可注入假响应） */
export type CdpJsonFetcher = (port: number, pathname: string, timeoutMs: number) => Promise<unknown>;

export const fetchCdpJson: CdpJsonFetcher = (port, pathname, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = httpGet({ host: "127.0.0.1", port, path: pathname, timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`CDP ${pathname} 响应无法解析: ${(e as Error).message}`));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`连接 127.0.0.1:${port}${pathname} 超时`));
    });
    req.on("error", (e) => reject(e));
  });

interface CdpPageTargetLike {
  type?: string;
  title?: string;
  url?: string;
}

/**
 * 探测端口是否为「Qoder CN 的 CDP 端口」。
 * 必须存在 Qoder CN primary workbench；浏览器版本或标题不能单独证明产品身份。
 */
export async function probeQoderPort(
  port: number,
  timeoutMs = 1_500,
  fetchJson: CdpJsonFetcher = fetchCdpJson,
): Promise<QoderProbeResult> {
  const version = await fetchJson(port, "/json/version", timeoutMs).catch(() => undefined);
  const targets = await fetchJson(port, "/json", timeoutMs).catch(() => undefined);
  const ua = String(
    (version as { "User-Agent"?: unknown } | undefined)?.["User-Agent"] ?? "",
  );
  const browser = String((version as { Browser?: unknown } | undefined)?.Browser ?? "");
  const pages = (Array.isArray(targets) ? (targets as CdpPageTargetLike[]) : []).filter(
    (t) => t.type === "page",
  );
  const productPages = pages.filter((t) => qoderTargetRank(t) === 0);
  if (!productPages.length) return { ready: false };
  const main = productPages
    .filter((t) => !/browser-overlay|screenshot/i.test(t.url ?? ""))
    .sort((a, b) => rankOf(a) - rankOf(b))[0];
  return {
    ready: true,
    version: browser || ua || undefined,
    title: main?.title,
    url: main?.url,
  };
}

/** 主窗口优先：title 恰为 `Qoder CN` 者优先，其余 qoder-cn-app://renderer/ 页面次之 */
function rankOf(target: CdpPageTargetLike): number {
  return (target.title ?? "").trim() === "Qoder CN" ? 0 : 1;
}

export async function ensureQoderInstance(
  exePath: string,
  gui: GuiProfile,
  logger: AgentRunLogger,
  options: QoderInstanceOptions = {},
): Promise<{ ready?: QoderReady; needsClose?: boolean }> {
  let roots = rootQoderProcesses(await listQoderProcessesAsync(options));
  if (!roots.length) {
    await delay(500, undefined, { signal: options.signal });
    roots = rootQoderProcesses(await listQoderProcessesAsync(options));
  }
  if (roots.length) {
    const argvPorts = roots
      .map((p) => remoteDebugPort(p.commandLine))
      .filter((value): value is number => value !== null);
    // macOS 主进程启动后会改写进程标题（ps 里只剩 "Qoder CN"，argv 中的调试端口被隐藏）：
    // 此时补扫配置端口段，预算收窄到 10s——扫不到 Qoder CN 页面即确属「无 CDP 旧实例」。
    const scanAll = process.platform === "darwin" && argvPorts.length === 0;
    const ports = scanAll
      ? Array.from({ length: gui.cdpPortRange }, (_, i) => gui.cdpPort + i)
      : argvPorts;
    if (!ports.length) return { needsClose: true };
    const reuseDeadline = Math.min(
      options.deadline ?? Infinity,
      Date.now() + (scanAll ? Math.min(gui.launchTimeoutMs, 10_000) : gui.launchTimeoutMs),
    );
    while (Date.now() < reuseDeadline) {
      // eslint-disable-next-line no-await-in-loop
      roots = rootQoderProcesses(await listQoderProcessesAsync(options));
      const recomputed = roots
        .map((p) => remoteDebugPort(p.commandLine))
        .filter((value): value is number => value !== null);
      const tickPorts = scanAll ? ports : recomputed.length > 0 ? recomputed : ports;
      for (const port of tickPorts) {
        // eslint-disable-next-line no-await-in-loop
        const ready = await probeQoderPort(port);
        if (ready.ready) return { ready: { port, title: ready.title, url: ready.url } };
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(500, undefined, { signal: options.signal });
    }
    if (scanAll) return { needsClose: true };
    return { needsClose: true };
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
        `Qoder CN CDP 端口范围不可用：${gui.cdpPort}-${gui.cdpPort + gui.cdpPortRange - 1}`,
      );
  } else if (!(await freePort(port))) throw new Error(`Qoder CN CDP 端口 ${port} 已被占用`);
  const args = gui.exeArgs.map((arg) => arg.replaceAll("<port>", String(port)));
  options.signal?.throwIfAborted();
  // 桌面实例必须 detached：不变量与实测依据见 guiInstanceSpawnOptions。
  const child = spawn(exePath, args, guiInstanceSpawnOptions(false));
  let launchError: Error | undefined;
  child.once("error", (error) => {
    launchError = error;
  });
  // 实例要跨 MCP server 退出驻留，不能把已完成的探测进程挂在事件循环上。
  child.unref();
  logger.info(
    `[qoder] 已启动 ${path.basename(exePath)}，CDP 端口 ${port}，pid=${child.pid ?? "unknown"}`,
  );
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + gui.launchTimeoutMs);
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await delay(500, undefined, { signal: options.signal });
    // eslint-disable-next-line no-await-in-loop
    if (launchError) throw launchError;
    const ready = await probeQoderPort(port);
    if (ready.ready)
      return { ready: { port, title: ready.title, url: ready.url, pid: child.pid } };
    if (child.exitCode !== null) {
      // 启动器把参数转交给既有实例后会立刻退出：此时复用既有实例的 CDP 端口。
      const forwardedRoots = rootQoderProcesses(await listQoderProcessesAsync(options));
      for (const proc of forwardedRoots) {
        const forwardedPort = remoteDebugPort(proc.commandLine);
        if (!forwardedPort) continue;
        // eslint-disable-next-line no-await-in-loop
        const forwarded = await probeQoderPort(forwardedPort);
        if (forwarded.ready) {
          logger.info(
            `[qoder] 启动器 exit=${child.exitCode}，已复用现有 Qoder CN CDP 端口 ${forwardedPort}`,
          );
          return {
            ready: { port: forwardedPort, title: forwarded.title, url: forwarded.url, pid: proc.pid },
          };
        }
      }
      if (child.exitCode !== 0)
        throw new Error(`Qoder CN 启动后提前退出（exit=${child.exitCode}）`);
    }
  }
  throw new Error(`等待 Qoder CN CDP 就绪超时（${gui.launchTimeoutMs}ms）`);
}
