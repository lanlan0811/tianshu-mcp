/**
 * Kimi Code 桌面实例的接管与端口探测。
 *
 * 真机事实（2026-09-20，Kimi Code 1.0.2 / Electron 43.1.1）：
 * 1) 普通 Electron 安装（非 MSIX）：`spawn(exePath, ["--remote-debugging-port=<port>"])` 可直接
 *    开启 CDP；基准端口 9666，被占用时向后避让（cdpPortAuto / cdpPortRange）。
 * 2) 已有 Kimi Code 进程但 argv 里没有有效调试端口 → 返回 `{ needsClose: true }`，
 *    由上层转 needs_user(close_existing_instance)。**绝不 kill 用户进程**。
 * 3) 产品校验不能只看「端口上有个 page」：必须是 Kimi Code 自己的窗口。
 *    /json/version 的 User-Agent 含 `kimi-code-app/`，或页面 URL 以 `app://renderer/` 开头。
 */
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

export interface KimicodeProcess {
  pid: number;
  commandLine: string;
  executable?: string;
}

export interface KimicodeReady {
  port: number;
  title?: string;
  url?: string;
  pid?: number;
}

export interface KimicodeProbeResult {
  ready: boolean;
  /** /json/version 里的产品版本串（Browser 字段优先，缺省退回 User-Agent） */
  version?: string;
  title?: string;
  url?: string;
}

/** Windows：`pid\texe\tcommandLine`；darwin 的 ps 行在解析时补成同样形状 */
export function parseProcessRows(raw: string): KimicodeProcess[] {
  const out: KimicodeProcess[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^(\d+)\t(.*?)\t(.*)$/.exec(line.trim());
    if (m) out.push({ pid: Number(m[1]), executable: m[2] || undefined, commandLine: m[3] || "" });
  }
  return out;
}

/** 进程枚举短缓存（1.5s）：轮询环每 tick 复用同一快照，避免重复 powershell/pgrep 枚举 */
const processCache = new TtlCache<KimicodeProcess[]>(1_500);
const PROCESS_CACHE_KEY = "kimicode-process-list";

export function listKimicodeProcesses(): Promise<KimicodeProcess[]> {
  return processCache.get(PROCESS_CACHE_KEY, enumerateKimicodeProcesses);
}

/** macOS 进程匹配模式：可执行名含空格，用 pgrep -f 匹配完整名 */
const KIMICODE_PROCESS_PATTERN = "Kimi Code";

async function enumerateKimicodeProcesses(): Promise<KimicodeProcess[]> {
  if (process.platform === "win32") {
    // 可执行名含空格：Win32_Process 的 Name 过滤字面量必须是 'Kimi Code.exe'。
    const script =
      'Get-CimInstance Win32_Process -Filter "Name=\'Kimi Code.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)" }';
    for (let attempt = 0; attempt < 2; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
        timeoutMs: 15_000,
      });
      if (res.status === 0) return parseProcessRows(res.stdout);
    }
    return [];
  }
  const pids = await execFileAsync("pgrep", ["-f", KIMICODE_PROCESS_PATTERN], { timeoutMs: 5_000 });
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

export interface KimicodeInstanceOptions {
  signal?: AbortSignal;
  deadline?: number;
}

/** 带 signal/deadline 的进程枚举（ensureKimicodeInstance 内部用；缓存版本不感知取消） */
export async function listKimicodeProcessesAsync(
  options: KimicodeInstanceOptions = {},
): Promise<KimicodeProcess[]> {
  options.signal?.throwIfAborted();
  if (process.platform === "win32") {
    const timeout = Math.max(1, Math.min(30_000, (options.deadline ?? Infinity) - Date.now()));
    const script =
      'Get-CimInstance Win32_Process -Filter "Name=\'Kimi Code.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)" }';
    const { stdout } = await promisify(execFile)(
      "powershell.exe",
      ["-NoProfile", "-Command", script],
      { timeout, signal: options.signal, windowsHide: true },
    );
    return parseProcessRows(stdout);
  }
  return enumerateKimicodeProcesses();
}

/**
 * 只保留 Kimi Code 根进程：Electron 的渲染/GPU/工具子进程同样命中可执行名，
 * 它们不带（也不该带）调试端口，混进来会让「是否已存在无 CDP 实例」的判断失真。
 */
export function rootKimicodeProcesses(rows: KimicodeProcess[]): KimicodeProcess[] {
  return rows.filter(
    (p) => !/--type=|crashpad|plugin-host|cua-helper|utility-sub-type/i.test(p.commandLine),
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
 * 探测端口是否为「Kimi Code 的 CDP 端口」。
 * 产品校验（二选一即可）：/json/version 的 UA 含 `kimi-code-app/`，
 * 或存在 URL 以 `app://renderer/` 开头的页面。二者都不成立即拒绝——
 * 否则会把别的 Electron 应用（同样有 page + CDP）当成本产品接管。
 */
export async function probeKimicodePort(
  port: number,
  timeoutMs = 1_500,
  fetchJson: CdpJsonFetcher = fetchCdpJson,
): Promise<KimicodeProbeResult> {
  const version = await fetchJson(port, "/json/version", timeoutMs).catch(() => undefined);
  const targets = await fetchJson(port, "/json", timeoutMs).catch(() => undefined);
  const ua = String(
    (version as { "User-Agent"?: unknown } | undefined)?.["User-Agent"] ?? "",
  );
  const browser = String((version as { Browser?: unknown } | undefined)?.Browser ?? "");
  const pages = (Array.isArray(targets) ? (targets as CdpPageTargetLike[]) : []).filter(
    (t) => t.type === "page",
  );
  const productPages = pages.filter((t) => (t.url ?? "").startsWith("app://renderer/"));
  if (!/kimi-code-app\//i.test(ua) && !productPages.length) return { ready: false };
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

/** 主窗口优先：title 恰为 `Kimi Code` 者优先，其余 app://renderer/ 页面次之 */
function rankOf(target: CdpPageTargetLike): number {
  return (target.title ?? "").trim() === "Kimi Code" ? 0 : 1;
}

export async function ensureKimicodeInstance(
  exePath: string,
  gui: GuiProfile,
  logger: AgentRunLogger,
  options: KimicodeInstanceOptions = {},
): Promise<{ ready?: KimicodeReady; needsClose?: boolean }> {
  let roots = rootKimicodeProcesses(await listKimicodeProcessesAsync(options));
  if (!roots.length) {
    await delay(500, undefined, { signal: options.signal });
    roots = rootKimicodeProcesses(await listKimicodeProcessesAsync(options));
  }
  if (roots.length) {
    const argvPorts = roots
      .map((p) => remoteDebugPort(p.commandLine))
      .filter((value): value is number => value !== null);
    // macOS 主进程启动后会改写进程标题（ps 里只剩 "Kimi Code"，argv 中的调试端口被隐藏）：
    // 此时补扫配置端口段，预算收窄到 10s——扫不到 Kimi Code 页面即确属「无 CDP 旧实例」。
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
      roots = rootKimicodeProcesses(await listKimicodeProcessesAsync(options));
      const recomputed = roots
        .map((p) => remoteDebugPort(p.commandLine))
        .filter((value): value is number => value !== null);
      const tickPorts = scanAll ? ports : recomputed.length > 0 ? recomputed : ports;
      for (const port of tickPorts) {
        // eslint-disable-next-line no-await-in-loop
        const ready = await probeKimicodePort(port);
        if (ready.ready) return { ready: { port, title: ready.title, url: ready.url } };
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(500, undefined, { signal: options.signal });
    }
    if (scanAll) return { needsClose: true };
    throw new Error(`等待既有 Kimi Code CDP 页面就绪超时（${gui.launchTimeoutMs}ms）`);
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
        `Kimi Code CDP 端口范围不可用：${gui.cdpPort}-${gui.cdpPort + gui.cdpPortRange - 1}`,
      );
  } else if (!(await freePort(port))) throw new Error(`Kimi Code CDP 端口 ${port} 已被占用`);
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
    `[kimicode] 已启动 ${path.basename(exePath)}，CDP 端口 ${port}，pid=${child.pid ?? "unknown"}`,
  );
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + gui.launchTimeoutMs);
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await delay(500, undefined, { signal: options.signal });
    // eslint-disable-next-line no-await-in-loop
    if (launchError) throw launchError;
    const ready = await probeKimicodePort(port);
    if (ready.ready)
      return { ready: { port, title: ready.title, url: ready.url, pid: child.pid } };
    if (child.exitCode !== null) {
      // 启动器把参数转交给既有实例后会立刻退出：此时复用既有实例的 CDP 端口。
      const forwardedRoots = rootKimicodeProcesses(await listKimicodeProcessesAsync(options));
      for (const proc of forwardedRoots) {
        const forwardedPort = remoteDebugPort(proc.commandLine);
        if (!forwardedPort) continue;
        // eslint-disable-next-line no-await-in-loop
        const forwarded = await probeKimicodePort(forwardedPort);
        if (forwarded.ready) {
          logger.info(
            `[kimicode] 启动器 exit=${child.exitCode}，已复用现有 Kimi Code CDP 端口 ${forwardedPort}`,
          );
          return {
            ready: { port: forwardedPort, title: forwarded.title, url: forwarded.url, pid: proc.pid },
          };
        }
      }
      if (child.exitCode !== 0)
        throw new Error(`Kimi Code 启动后提前退出（exit=${child.exitCode}）`);
    }
  }
  throw new Error(`等待 Kimi Code CDP 就绪超时（${gui.launchTimeoutMs}ms）`);
}