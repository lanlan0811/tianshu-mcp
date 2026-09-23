/**
 * TraeWork 进程生命周期（开发计划 traework-gui-adapter-plan §4.4）。
 *
 * 职责：端口探测/避让 → 复用已就绪实例 → 必要时带调试端口启动新实例 → 安全释放。
 *
 * 安全红线（源自 2026-09-08 误杀用户实例事故，见计划 §2.6/§9）：
 *  1. 默认 windowMode=reuse：已有可用实例直接复用，绝不启动第二个实例。
 *  2. 绝不对进程树使用 taskkill /T；只终止「本模块创建且命令行核对通过」的 PID。
 *  3. 传给 GUI 进程的路径一律用原生 Windows 形式（path.win32 语义），禁止 POSIX 路径。
 *  4. 无法确认归属时放弃终止并告警——遗留窗口远比误杀用户会话安全。
 */
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { TraeworkCdpClient } from "./cdp/client.js";
import type { AgentRunLogger } from "../adapter.js";
import type { GuiProfile } from "../../config/schema.js";
import { execFileAsync } from "../../verify/exec.js";
import { guiInstanceSpawnOptions } from "../gui-instance.js";

/** 端口是否空闲（可绑定） */
export function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

/** 从 start 起向后找一个空闲端口（最多 range 个）；全占用返回 null */
export async function findFreePort(start: number, range: number): Promise<number | null> {
  for (let p = start; p < start + range; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p)) return p;
  }
  return null;
}

/** 解析实际使用的调试端口：指定端口被占用时按配置避让 */
export async function resolvePort(gui: GuiProfile, logger: AgentRunLogger): Promise<number> {
  const base = gui.cdpPort;
  if (await isPortFree(base)) return base;
  // 端口被占用：可能是已有 TraeWork 实例（复用）或别的程序（避让）
  const probe = await TraeworkCdpClient.probe(base);
  if (probe.ready) {
    logger.info(`[traework] 端口 ${base} 已是 TraeWork 实例（${probe.title ?? "page"}），将复用`);
    return base;
  }
  if (!gui.cdpPortAuto) {
    throw new Error(`CDP 端口 ${base} 被其他程序占用，且 cdpPortAuto=false。请释放端口或改 profile.gui.cdpPort`);
  }
  const found = await findFreePort(base + 1, gui.cdpPortRange);
  if (found === null) {
    throw new Error(`CDP 端口 ${base}..${base + gui.cdpPortRange - 1} 均被占用，无法启动 TraeWork 调试实例`);
  }
  logger.warn(`[traework] 端口 ${base} 被占用，自动避让到 ${found}`);
  return found;
}

/** 已就绪实例的探测结果 */
export interface ReadyInstance {
  port: number;
  title?: string;
  url?: string;
}

/** 探测某端口上是否已有可复用的 TraeWork 页面 */
export async function probeReady(port: number): Promise<ReadyInstance | null> {
  const p = await TraeworkCdpClient.probe(port);
  if (!p.ready) return null;
  return { port, title: p.title, url: p.url };
}

/** 本模块创建实例的登记信息（用于安全释放） */
export interface SpawnedInstance {
  pid: number;
  port: number;
  /** 启动时的完整命令行（释放前用于核对归属） */
  commandLine: string;
  exePath: string;
  child?: ChildProcess;
  /**
   * 子进程退出信息（issue #23 C3 诊断）。
   * TraeWork 为单实例应用：若既有实例未带调试端口，新实例可能把启动交接给它后自身退出，
   * 导致端口从未监听。记录退出码/信号以区分「启动失败」与「单实例交接」。
   */
  exit?: { code: number | null; signal: string | null };
}

/** 读取进程命令行（Windows 用 CIM；其他平台读 /proc 或 ps） */
export async function readCommandLine(pid: number): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      const res = await execFileAsync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
        ],
        { timeoutMs: 10_000 },
      );
      const out = res.stdout.trim();
      return out || null;
    }
    const res = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { timeoutMs: 5_000 });
    const out = res.stdout.trim();
    return out || null;
  } catch {
    return null;
  }
}

/** 进程是否存活 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface LaunchOptions {
  exePath: string;
  port: number;
  gui: GuiProfile;
  logger: AgentRunLogger;
}

/**
 * 带调试端口启动新实例。
 * 参数模板中的 <port> 会被替换；不额外注入 --user-data-dir（避免与用户实例的 profile 冲突）。
 */
export function launchInstance(opts: LaunchOptions): SpawnedInstance {
  const { exePath, port, gui, logger } = opts;
  const args = gui.exeArgs.map((a) => a.replace(/<port>/g, String(port)));
  // 原生 Windows 路径：确保 exePath 用反斜杠形式传给 GUI 进程
  const nativeExe = process.platform === "win32" ? path.win32.normalize(exePath) : exePath;
  // 窗口必须可见：发送依赖模拟输入
  const child = spawn(nativeExe, args, guiInstanceSpawnOptions(false));
  child.unref();
  const pid = child.pid ?? -1;
  const commandLine = [nativeExe, ...args].join(" ");
  const inst: SpawnedInstance = { pid, port, commandLine, exePath: nativeExe, child };
  // issue #23 C3 诊断：记录退出码/信号，便于在「端口未就绪」时区分启动失败与单实例交接。
  // 注意：仍然 unref 且不接管 stdio（沿用既有安全语义，绝不影响用户实例）。
  child.once("exit", (code, signal) => {
    inst.exit = { code, signal };
    logger.info(`[traework] 启动的子进程已退出 pid=${pid} code=${code ?? "null"} signal=${signal ?? "null"}`);
  });
  logger.info(`[traework] 已启动实例 pid=${pid} port=${port} cmd=${commandLine}`);
  return inst;
}

/** 等待 CDP 就绪 */
export async function waitReady(port: number, timeoutMs: number, logger: AgentRunLogger): Promise<ReadyInstance> {
  const deadline = Date.now() + timeoutMs;
  let lastLog = 0;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const ready = await probeReady(port);
    if (ready) return ready;
    if (Date.now() - lastLog > 10_000) {
      lastLog = Date.now();
      logger.info(`[traework] 等待 CDP 就绪（端口 ${port}）…`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`等待 TraeWork CDP 就绪超时（${timeoutMs}ms，端口 ${port}）。请确认窗口已打开且未处于登录/引导页`);
}

/**
 * 端口未就绪时的现场诊断（issue #23 C3，D3：只诊断，不改启动策略、不杀进程）。
 * 输出：子进程是否仍存活/退出码；命令行含该调试端口的进程数（期望 >0）；
 * 以及未带调试端口的既有 TRAE SOLO CN 进程数（单实例锁的常见触发条件）。
 */
export async function diagnosePortFailure(
  inst: SpawnedInstance | null,
  port: number,
  logger: AgentRunLogger,
): Promise<string> {
  const parts: string[] = [];
  if (inst) {
    if (inst.exit) {
      parts.push(`启动子进程 pid=${inst.pid} 已退出（code=${inst.exit.code ?? "null"}，signal=${inst.exit.signal ?? "null"}）`);
      if (inst.exit.code === 0)
        parts.push("退出码为 0：很可能是单实例锁把启动交接给既有实例后自身退出，故新端口从未监听");
    } else if (isAlive(inst.pid)) {
      parts.push(`启动子进程 pid=${inst.pid} 仍存活，但未监听端口 ${port}`);
    } else {
      parts.push(`启动子进程 pid=${inst.pid} 已不存在（且未捕获退出码）`);
    }
  } else {
    parts.push("本次未由本模块启动新实例（复用了既有实例）");
  }
  if (process.platform === "win32") {
    try {
      const listeners = await execFileAsync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `@(Get-CimInstance Win32_Process -Filter "Name='TRAE SOLO CN.exe'" | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${port}*' }).Count`,
        ],
        { timeoutMs: 10_000 },
      );
      parts.push(`命令行含 --remote-debugging-port=${port} 的 TRAE SOLO CN 进程数=${listeners.stdout.trim() || "0"}`);
      const existing = await execFileAsync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `@(Get-CimInstance Win32_Process -Filter "Name='TRAE SOLO CN.exe'" | Where-Object { $_.CommandLine -notlike '*--remote-debugging-port*' }).Count`,
        ],
        { timeoutMs: 10_000 },
      );
      const n = Number(existing.stdout.trim() || "0");
      if (n > 0)
        parts.push(
          `检测到 ${n} 个未带调试端口的既有 TRAE SOLO CN 进程（单实例锁会拦下新的调试实例）；` +
            "请先关闭这些窗口，或以任务书要求用户手动启动后再 continue_task（MCP 不自动终止既有实例）",
        );
    } catch (e) {
      parts.push(`进程枚举失败：${(e as Error).message}`);
    }
  }
  const msg = parts.join("；");
  logger.warn(`[traework] 端口未就绪诊断：${msg}`);
  return msg;
}

/**
 * 安全释放：只终止本模块创建、且命令行核对通过的进程。
 * 用户已有实例（非本模块创建）永不终止。
 * 注意：不使用 /T（不杀进程树），避免误伤同 app 的其他进程。
 *
 * @param deps 测试注入点（默认用真实进程探测）
 */
export async function releaseInstance(
  inst: SpawnedInstance,
  logger: AgentRunLogger,
  deps: {
    alive?: (pid: number) => boolean;
    readCmd?: (pid: number) => string | null | Promise<string | null>;
    kill?: (pid: number) => void;
  } = {},
): Promise<{ released: boolean; reason: string }> {
  const alive = deps.alive ?? isAlive;
  const readCmd = deps.readCmd ?? readCommandLine;
  if (inst.pid <= 0) return { released: false, reason: "无有效 pid" };
  if (!alive(inst.pid)) return { released: false, reason: "进程已退出" };
  const actual = await readCmd(inst.pid);
  if (!actual) {
    return { released: false, reason: `无法读取 pid ${inst.pid} 的命令行，放弃终止（避免误杀）` };
  }
  // 归属核对：命令行必须同时包含本模块启动时记录的端口参数与 exe 文件名
  const portArg = `--remote-debugging-port=${inst.port}`;
  if (!actual.includes(portArg) || !actual.includes(path.win32.basename(inst.exePath))) {
    logger.warn(`[traework] pid ${inst.pid} 命令行与启动记录不符，放弃终止（避免误杀）：${actual.slice(0, 200)}`);
    return { released: false, reason: "命令行核对失败，放弃终止" };
  }
  try {
    if (deps.kill) {
      deps.kill(inst.pid);
    } else if (process.platform === "win32") {
      // 不带 /T：只结束这一个进程，不波及子进程树
      await execFileAsync("taskkill", ["/PID", String(inst.pid), "/F"], { timeoutMs: 10_000 });
    } else {
      process.kill(inst.pid, "SIGTERM");
    }
    logger.info(`[traework] 已终止本模块创建的实例 pid=${inst.pid}`);
    return { released: true, reason: "已终止" };
  } catch (e) {
    return { released: false, reason: `终止失败: ${(e as Error).message}` };
  }
}
