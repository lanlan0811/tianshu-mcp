/**
 * Open Design 桌面实例的探测、接管与受管启动。
 *
 * 真机事实（2026-09-25，Open Design 0.24.1 / Electron，Windows 10 19045）：
 * 1) 普通安装（非 MSIX）：`spawn(exePath, ["--remote-debugging-port=<port>"])` 即可开启 CDP。
 * 2) **单实例锁**：主进程调用 `requestSingleInstanceLock()`，第二个进程会立即退出
 *    （packaged-main.mjs:34250-34259）。因此「自启受管实例」在用户已开着 Open Design 时
 *    **大概率失败**，本模块的策略与 ZCode/Kimi Code 一致：**复用优先**，复用不到就
 *    `{needsClose:true}` 交上层转 needs_user，**绝不 kill 用户进程**。
 * 3) **`--user-data-dir` 对本产品无效**：主进程在启动早期强制
 *    `app.setPath("userData", <namespaceRoot>/user-data)`（同上 :34245-34248），
 *    命令行开关会被覆盖。故 exeArgs 只注入调试端口，不做「专属 userData」的假承诺。
 * 4) 产品校验不能只看「端口上有个 page」：必须是 Open Design 自己的窗口
 *    （/json/version 的 UA 含 electron，且存在标题以 `Open Design` 开头或 URL 含
 *    `open-design` 的页面），否则会把别的 Electron 应用当成本产品接管。
 */
import net from "node:net";
import fs from "node:fs";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { spawn, execFile } from "node:child_process";
import path from "node:path";
import type { GuiProfile } from "../../config/schema.js";
import type { AgentRunLogger } from "../adapter.js";
import { TtlCache } from "../../util/ttl-cache.js";
import { guiInstanceDiagSpawnOptions } from "../gui-instance.js";
import { fetchCdpJson, type CdpJsonFetcher } from "../kimicode/instance.js";

export { fetchCdpJson };
export type { CdpJsonFetcher };

export interface OpenDesignProcess {
  pid: number;
  commandLine: string;
  executable?: string;
}

export interface OpenDesignReady {
  port: number;
  title?: string;
  url?: string;
  pid?: number;
}

export interface OpenDesignProbeResult {
  ready: boolean;
  /** /json/version 里的 Electron 版本串（Browser 字段优先，缺省退回 User-Agent） */
  version?: string;
  title?: string;
  url?: string;
}

/** Windows：`pid\texe\tcommandLine`；darwin 的 ps 行在解析时补成同样形状 */
export function parseProcessRows(raw: string): OpenDesignProcess[] {
  const out: OpenDesignProcess[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^(\d+)\t(.*?)\t(.*)$/.exec(line.trim());
    if (m) out.push({ pid: Number(m[1]), executable: m[2] || undefined, commandLine: m[3] || "" });
  }
  return out;
}

/** 进程枚举短缓存（1.5s）：轮询环每 tick 复用同一快照，避免重复 powershell/pgrep 枚举 */
const processCache = new TtlCache<OpenDesignProcess[]>(1_500);
const PROCESS_CACHE_KEY = "opendesign-process-list";

export function listOpenDesignProcesses(): Promise<OpenDesignProcess[]> {
  return processCache.get(PROCESS_CACHE_KEY, enumerateOpenDesignProcesses);
}

/** macOS 进程匹配模式：可执行名含空格，用 pgrep -f 匹配完整名 */
const OPEN_DESIGN_PROCESS_PATTERN = "Open Design";

/** Windows 可执行名（含空格，Win32_Process 的 Name 过滤字面量必须精确） */
const OPEN_DESIGN_EXE_NAME = "Open Design.exe";

async function enumerateOpenDesignProcesses(): Promise<OpenDesignProcess[]> {
  if (process.platform === "win32") {
    const script = `Get-CimInstance Win32_Process -Filter "Name='${OPEN_DESIGN_EXE_NAME}'" | ForEach-Object { "$($_.ProcessId)\`t$($_.ExecutablePath)\`t$($_.CommandLine)" }`;
    for (let attempt = 0; attempt < 2; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await execFileAsyncSafe(
        "powershell.exe",
        ["-NoProfile", "-Command", script],
        15_000,
      );
      if (res.status === 0) return parseProcessRows(res.stdout);
    }
    return [];
  }
  const pids = await execFileAsyncSafe("pgrep", ["-f", OPEN_DESIGN_PROCESS_PATTERN], 5_000);
  if (pids.status !== 0) return [];
  const list = pids.stdout
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 64);
  if (!list.length) return [];
  // pgrep 只给 pid；调试端口在 argv 里，必须再取一次命令行。
  const details = await execFileAsyncSafe(
    "ps",
    ["-p", list.join(","), "-o", "pid=,command="],
    5_000,
  );
  if (details.status !== 0) return [];
  return details.stdout.split(/\r?\n/).flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), commandLine: m[2]! }] : [];
  });
}

interface ExecOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * execFile 包一层，永不抛：探测失败必须返回空集而不是把异常抛进解析链。
 * 这里刻意不复用 `verify/exec.ts` 的 execFileAsync——后者用于验收命令（有额外语义），
 * 探测路径只需要「失败即空」。
 */
async function execFileAsyncSafe(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<ExecOutcome> {
  try {
    const res = await promisify(execFile)(cmd, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { status: 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      status: typeof e.code === "number" ? e.code : null,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

export interface OpenDesignInstanceOptions {
  signal?: AbortSignal;
  deadline?: number;
}

/** 带 signal/deadline 的进程枚举（ensureOpenDesignInstance 内部用；缓存版本不感知取消） */
export async function listOpenDesignProcessesAsync(
  options: OpenDesignInstanceOptions = {},
): Promise<OpenDesignProcess[]> {
  options.signal?.throwIfAborted();
  if (process.platform === "win32") {
    const timeout = Math.max(1, Math.min(30_000, (options.deadline ?? Infinity) - Date.now()));
    const script = `Get-CimInstance Win32_Process -Filter "Name='${OPEN_DESIGN_EXE_NAME}'" | ForEach-Object { "$($_.ProcessId)\`t$($_.ExecutablePath)\`t$($_.CommandLine)" }`;
    try {
      const { stdout } = await promisify(execFile)(
        "powershell.exe",
        ["-NoProfile", "-Command", script],
        { timeout, signal: options.signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      );
      return parseProcessRows(stdout);
    } catch {
      return [];
    }
  }
  return enumerateOpenDesignProcesses();
}

/**
 * 只保留 Open Design 的**桌面主进程**。三类干扰必须排除，否则「是否已有实例」会失真：
 * 1) Electron 子进程（渲染/GPU/网络/工具）：argv 里带 `--type=` 或 crashpad 字样；
 * 2) sidecar 监督进程：本产品把 daemon / web 两条 sidecar 也做成同一个可执行文件的子进程，
 *    实测命令行形如 `"Open Design.exe" "<...>/@open-design/sidecar/dist/supervisor.mjs" --od-stamp-app=daemon|web`
 *    与 `"Open Design.exe" "<...>/prebundled/daemon/daemon-sidecar.mjs"`——
 *    它们**没有窗口、不会抢单实例锁**，但会一直驻留。若把它们当成「已运行的实例」，
 *    用户关掉界面后仍会被判 needsClose，导致受管实例**永远起不来**（真机实测已验证该形态）。
 * 3) 任何 argv 里出现 `.mjs` 脚本路径的进程（上面两条的通用判据）。
 */
export function rootOpenDesignProcesses(rows: OpenDesignProcess[]): OpenDesignProcess[] {
  return rows.filter(
    (p) =>
      !/--type=|crashpad|plugin-host|cua-helper|utility-sub-type/i.test(p.commandLine) &&
      !/\.mjs\b/i.test(p.commandLine),
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

interface CdpPageTargetLike {
  type?: string;
  title?: string;
  url?: string;
}

/** 主窗口判定：标题以 Open Design 开头最优先，其次是 URL 里出现 open-design 的页面。 */
function isProductPage(target: CdpPageTargetLike): boolean {
  const title = (target.title ?? "").trim();
  const url = target.url ?? "";
  return /^open design/i.test(title) || /open-design/i.test(url);
}

/**
 * 探测端口是否为「Open Design 的 CDP 端口」。
 * 产品校验：UA 含 `electron`（本产品是 Electron 应用）且存在本产品页面。
 * 二者缺一即拒绝——否则会把别的 Electron 应用（同样有 page + CDP）当成本产品接管。
 */
export async function probeOpenDesignPort(
  port: number,
  timeoutMs = 1_500,
  fetchJson: CdpJsonFetcher = fetchCdpJson,
): Promise<OpenDesignProbeResult> {
  const version = await fetchJson(port, "/json/version", timeoutMs).catch(() => undefined);
  const targets = await fetchJson(port, "/json", timeoutMs).catch(() => undefined);
  const ua = String((version as { "User-Agent"?: unknown } | undefined)?.["User-Agent"] ?? "");
  const browser = String((version as { Browser?: unknown } | undefined)?.Browser ?? "");
  if (!/electron/i.test(ua)) return { ready: false };
  const pages = (Array.isArray(targets) ? (targets as CdpPageTargetLike[]) : []).filter(
    (t) => t.type === "page",
  );
  const productPages = pages.filter(isProductPage);
  if (!productPages.length) return { ready: false };
  const main = productPages.sort((a, b) => rankOf(a) - rankOf(b))[0];
  return {
    ready: true,
    version: browser || ua || undefined,
    title: main?.title,
    url: main?.url,
  };
}

/** 主窗口优先：标题恰为 `Open Design` 者最优先，其余本产品页面次之 */
function rankOf(target: CdpPageTargetLike): number {
  return (target.title ?? "").trim() === "Open Design" ? 0 : 1;
}

/**
 * 版本门禁：只对接已真机验证的版本。返回 null 表示放行，否则返回拒绝原因。
 *
 * **判据来源必须传「产品版本」**（`resources/open-design-config.json` 的 `appVersion`）：
 * CDP `/json/version` 的 `Browser` 字段是 **Electron 版本**（实测 `Electron/41.3.0`），
 * 拿它比对产品版本必然误判并阻断全部派发。期望版本来自 profile
 * （`opendesign.supportedVersions`），运行时不写死版本号。
 */
export function versionGateError(
  supported: Record<string, string[]> | undefined,
  detected: string | undefined,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const expected = supported?.[platform] ?? [];
  if (!expected.length) return null;
  const clean = detected?.trim();
  if (!clean) return null;
  // 容忍带前缀/后缀的版本串（如 "0.24.1 (stable)"），取首个 x.y.z 段比对。
  const m = /(\d+\.\d+\.\d+)/.exec(clean);
  const found = m ? m[1]! : clean;
  if (expected.includes(found)) return null;
  return `Open Design 版本不匹配：实测 ${found}，已真机验证的版本为 ${expected.join(" / ")}（其他版本未取证，禁止派发）`;
}

/**
 * 读取 `<namespaceRoot>/data/app-config.json`。仅用于**旁证**（目录绑定后的 recentLinkedDirs
 * / agentModels），不作为唯一判据——UI 回读才是权威。
 */
export function readAppConfig(namespaceRoot: string | null): Record<string, unknown> | null {
  if (!namespaceRoot) return null;
  const file = path.join(namespaceRoot, "data", "app-config.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 受管启动的环境变量净化（**真机关键修复**）。
 *
 * 实测（2026-09-26）：`Open Design.exe` 是「内嵌 Node 的 Electron」外层启动器。
 * 若调用方进程带着 `ELECTRON_RUN_AS_NODE=1`（本机 DSH harness 就会注入该变量），
 * 启动器会被强行置为 **Node 模式**，于是：
 * - `--remote-debugging-port=9889` 被 Node 参数解析器拒绝 → `bad option: --remote-debugging-port=9889`，退出码 9；
 * - `--headless` 同样被拒（`bad option: --headless`）；
 * - 应用**根本起不来**：无窗口、无新日志、无崩溃转储——极易被误判成应用本身损坏。
 *
 * 清除该变量后 `--remote-debugging-port` 立刻生效（启动器打印 `DevTools listening on ws://…`）。
 * 同时清掉 `NODE_OPTIONS`：Node 明确禁止 `--remote-debugging-port` 出现在 NODE_OPTIONS 里，
 * 残留时启动器会报 `is not allowed in NODE_OPTIONS` 直接失败。
 *
 * **只改环境、不改命令行**：命令行仍是 profile 的 `exeArgs`（`--remote-debugging-port=<port>`），
 * 即官方启动器本来就支持的形态；不需要绕开启动器去直启 `resources/app`。
 */
export const OPEN_DESIGN_ENV_DENYLIST: readonly string[] = [
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "ELECTRON_ENABLE_LOGGING",
  "ELECTRON_EXTRA_LAUNCH_ARGS",
];

/** 生成净化后的子进程环境（不修改调用方 process.env） */
export function sanitizedSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of OPEN_DESIGN_ENV_DENYLIST) delete env[key];
  return env;
}

/**
 * 启动器退出码分类（真机依据见 docs/opendesign-cdp.md §2）。
 *
 * - `0`：被单实例锁转交（首实例在跑）后主动退出——正常行为，但若既无 CDP 端口也无其他实例，
 *   说明用户开着没带调试端口的实例；
 * - `9`：Node 参数解析失败（`bad option:`）与「应用自身启动失败」实测都落在这个码上。
 *   与 0 同样按「无法接管 → 请用户处理」返回，但日志里必须区别于单实例锁转交；
 * - 其他非零：真实的启动失败，带上 stderr 尾部抛错。
 */
export function classifyLauncherExit(
  exitCode: number | null,
): "handoff" | "needs-close" | "failed" {
  if (exitCode === 0) return "handoff";
  if (exitCode === 9) return "needs-close";
  return "failed";
}

export async function ensureOpenDesignInstance(
  exePath: string,
  gui: GuiProfile,
  logger: AgentRunLogger,
  options: OpenDesignInstanceOptions = {},
): Promise<{ ready?: OpenDesignReady; needsClose?: boolean }> {
  let roots = rootOpenDesignProcesses(await listOpenDesignProcessesAsync(options));
  if (!roots.length) {
    await delay(500, undefined, { signal: options.signal });
    roots = rootOpenDesignProcesses(await listOpenDesignProcessesAsync(options));
  }
  if (roots.length) {
    const argvPorts = roots
      .map((p) => remoteDebugPort(p.commandLine))
      .filter((value): value is number => value !== null);
    // macOS 主进程启动后会改写进程标题（ps 里只剩 "Open Design"，argv 中的端口被隐藏）：
    // 此时补扫配置端口段，预算收窄到 10s——扫不到本产品页面即确属「无 CDP 旧实例」。
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
      roots = rootOpenDesignProcesses(await listOpenDesignProcessesAsync(options));
      const recomputed = roots
        .map((p) => remoteDebugPort(p.commandLine))
        .filter((value): value is number => value !== null);
      const tickPorts = scanAll ? ports : recomputed.length > 0 ? recomputed : ports;
      for (const port of tickPorts) {
        // eslint-disable-next-line no-await-in-loop
        const ready = await probeOpenDesignPort(port);
        if (ready.ready) return { ready: { port, title: ready.title, url: ready.url } };
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(500, undefined, { signal: options.signal });
    }
    if (scanAll) return { needsClose: true };
    throw new Error(`等待既有 Open Design CDP 页面就绪超时（${gui.launchTimeoutMs}ms）`);
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
        `Open Design CDP 端口范围不可用：${gui.cdpPort}-${gui.cdpPort + gui.cdpPortRange - 1}`,
      );
  } else if (!(await freePort(port))) throw new Error(`Open Design CDP 端口 ${port} 已被占用`);
  const args = gui.exeArgs.map((arg) => arg.replaceAll("<port>", String(port)));
  options.signal?.throwIfAborted();
  // 桌面实例必须 detached：不变量与实测依据见 guiInstanceSpawnOptions。
  // env 必须净化：继承来的 ELECTRON_RUN_AS_NODE / NODE_OPTIONS 会让启动器退化成 Node
  // 而拒绝调试端口（详见 sanitizedSpawnEnv）。
  // 另外收 stderr（有界缓冲）——启动失败时本产品可能**没有任何日志文件**，只有 stderr 说得清原因。
  const child = spawn(exePath, args, {
    ...guiInstanceDiagSpawnOptions(false),
    env: sanitizedSpawnEnv(),
  });
  let launchError: Error | undefined;
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = `${stderrTail}${String(chunk)}`;
    if (stderrTail.length > STDERR_TAIL_LIMIT) stderrTail = stderrTail.slice(-STDERR_TAIL_LIMIT);
  });
  child.stderr?.on("error", () => {
    /* 读 stderr 失败不影响启动判定 */
  });
  child.once("error", (error) => {
    launchError = error;
  });
  // 实例要跨 MCP server 退出驻留，不能把已完成的探测进程挂在事件循环上。
  child.unref();
  logger.info(
    `[opendesign] 已启动 ${path.basename(exePath)}，CDP 端口 ${port}，pid=${child.pid ?? "unknown"}`,
  );
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + gui.launchTimeoutMs);
  /** 已宣告的调试端口（从启动器 stderr 解析；见 devtoolsPortsFromOutput） */
  let announced: number[] = [];
  /** 启动器退出后的善后**只做一次**：子进程退出码是粘性的，逐轮重跑会刷日志、也会提前判死 */
  let exitHandled = false;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await delay(500, undefined, { signal: options.signal });
    // eslint-disable-next-line no-await-in-loop
    if (launchError) throw launchError;
    for (const candidate of new Set([port, ...announced])) {
      // eslint-disable-next-line no-await-in-loop
      const ready = await probeOpenDesignPort(candidate);
      if (ready.ready)
        return { ready: { port: candidate, title: ready.title, url: ready.url, pid: child.pid } };
    }
    if (child.exitCode === null || exitHandled) continue;
    exitHandled = true;
    // 单实例锁：启动器把参数转交给既有实例后会立刻退出。此时复用既有实例的 CDP 端口，
    // 但既有实例**没带**调试端口时，转发后端口依然不可用 → 明确要求用户关闭旧实例。
    // eslint-disable-next-line no-await-in-loop
    const forwardedRoots = rootOpenDesignProcesses(await listOpenDesignProcessesAsync(options));
    for (const proc of forwardedRoots) {
      const forwardedPort = remoteDebugPort(proc.commandLine);
      if (!forwardedPort) continue;
      // eslint-disable-next-line no-await-in-loop
      const forwarded = await probeOpenDesignPort(forwardedPort);
      if (forwarded.ready) {
        logger.info(
          `[opendesign] 启动器 exit=${child.exitCode}，已复用现有 Open Design CDP 端口 ${forwardedPort}`,
        );
        return {
          ready: { port: forwardedPort, title: forwarded.title, url: forwarded.url, pid: proc.pid },
        };
      }
    }
    // 退出码分类见 classifyLauncherExit 的注释（9 = 参数被拒 / 应用自身启动失败）。
    const verdict = classifyLauncherExit(child.exitCode);
    if (verdict === "failed") {
      throw new Error(
        `Open Design 启动后提前退出（exit=${child.exitCode}）：${shrink(stderrTail) || "（stderr 无输出）"}`,
      );
    }
    // 退出码 0：启动器把真正的 Electron 主进程作为**分离子进程**拉起后自行退出（实测形态）。
    // 此时 stderr 里已经有 `DevTools listening on ws://127.0.0.1:<port>/...`，
    // 于是把宣告端口纳入后续轮询，并在**剩余预算内**继续等待——
    // 首版在这里直接返回 needsClose，真机上表现为「明明起来了却说请关闭旧实例」。
    announced = devtoolsPortsFromOutput(stderrTail);
    if (!announced.length) {
      // 无端口宣告：确实起不来（被单实例锁转交到没有调试端口的既有实例，或应用自身失败）
      logger.warn(
        `[opendesign] 启动器 exit=${child.exitCode}（${verdict === "handoff" ? "疑似单实例锁转交" : "疑似应用自身启动失败"}），` +
          `既无 CDP 端口宣告也无其他 Open Design 进程（stderr: ${shrink(stderrTail) || "无输出"}）`,
      );
      return { needsClose: true };
    }
    logger.info(
      `[opendesign] 启动器 exit=0（分离子进程形态），stderr 宣告调试端口 ${announced.join("、")}，继续等待就绪`,
    );
  }
  if (announced.length)
    throw new Error(
      `Open Design 已宣告调试端口 ${announced.join("、")} 但 ${gui.launchTimeoutMs}ms 内未就绪` +
        `（应用主线程可能卡在启动期请求；stderr: ${shrink(stderrTail) || "无输出"}）`,
    );
  throw new Error(
    `等待 Open Design CDP 就绪超时（${gui.launchTimeoutMs}ms）` +
      (stderrTail.trim() ? `；启动器 stderr：${shrink(stderrTail)}` : ""),
  );
}

/** stderr 有界缓冲上限：只保留尾部用于报错，避免长跑任务把内存吃掉 */
const STDERR_TAIL_LIMIT = 4_000;

/**
 * 从启动器输出里抽出 DevTools 端口。
 *
 * 真机实测：外层启动器接受 `--remote-debugging-port=<port>` 后会打印
 * `DevTools listening on ws://127.0.0.1:9889/devtools/browser/<id>`，**然后自己以 0 退出**
 * （真正的 Electron 主进程是它 spawn 的分离子进程，端口由子进程监听）。
 * 所以「退出码 0」绝不能直接判失败——必须把 stderr 里的端口拿去探测，并给子进程留出监听时间。
 */
export function devtoolsPortsFromOutput(text: string): number[] {
  const ports = new Set<number>();
  const re = /DevTools listening on ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)/gi;
  for (const match of text.matchAll(re)) {
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports];
}

/** 报错文案里的单行化 + 截断（日志与错误信息都要保持可读） */
function shrink(text: string, limit = 800): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}
