/**
 * Codex 受管实例：进程探测 / 端口避让 / COM 激活 / CDP 就绪等待。
 *
 * 复用优先：若已存在「本 MCP 专属 user-data-dir」的 Codex 实例且调试端口上确有 Codex 页面，
 * 直接接管；否则以专属 profile 激活一个新实例（绝不复用用户手动打开的默认 profile）。
 */
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TraeworkCdpClient } from "../traework/cdp/client.js";
import type { GuiProfile } from "../../config/schema.js";
import type { AgentRunLogger } from "../adapter.js";
import { activateCodexApp, buildActivationArgs } from "./launcher.js";
import { expandEnvPath } from "../../util/path.js";

export interface CodexProcess {
  pid: number;
  commandLine: string;
  executable?: string;
}
export interface CodexReady {
  port: number;
  title?: string;
  url?: string;
  pid?: number;
  /** 使用的 user-data-dir（用于身份判定） */
  userDataDir?: string;
}

export function parseProcessRows(raw: string): CodexProcess[] {
  const out: CodexProcess[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^(\d+)\t(.*?)\t(.*)$/.exec(line.trim());
    if (m) out.push({ pid: Number(m[1]), executable: m[2] || undefined, commandLine: m[3] || "" });
  }
  return out;
}

export function listCodexProcesses(): CodexProcess[] {
  if (process.platform !== "win32") return [];
  try {
    const script =
      'Get-CimInstance Win32_Process -Filter "Name=\'ChatGPT.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)" }';
    return parseProcessRows(
      execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        // Get-CimInstance 在繁忙机器上可能偏慢，放宽超时避免误判「无实例」
        timeout: 30_000,
      }),
    );
  } catch {
    return [];
  }
}

/** 根进程：排除 renderer/gpu/utility/crashpad 等子进程 */
export function rootCodexProcesses(rows: CodexProcess[]): CodexProcess[] {
  return rows.filter((p) => !/--type=|crashpad/i.test(p.commandLine));
}

export function remoteDebugPort(commandLine: string): number | null {
  const m = /--remote-debugging-port(?:=|\s+)(\d+)/.exec(commandLine);
  return m ? Number(m[1]) : null;
}

/** 解析命令行中的 --user-data-dir（支持 = 与带引号/不带引号） */
export function remoteUserDataDir(commandLine: string): string | null {
  const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(commandLine);
  if (!m) return null;
  return (m[1] ?? m[2] ?? "").trim() || null;
}

/** 路径归一（Windows 大小写不敏感 + 统一斜杠），用于身份比较 */
export function normalizeDir(value: string): string {
  const norm = path
    .resolve(value)
    .replace(/[\\/]+$/, "")
    .split(/[\\/]+/)
    .join("/");
  return process.platform === "win32" ? norm.toLowerCase() : norm;
}

/** 默认专属 profile 目录（不硬编码用户名/盘符） */
export function defaultUserDataDir(): string {
  if (process.platform === "win32")
    return expandEnvPath("{LOCALAPPDATA}/tianshu-mcp/codex-gui/profile");
  return expandEnvPath("{HOME}/.tianshu-mcp/codex-gui/profile");
}

export function resolveUserDataDir(gui: GuiProfile): string {
  const raw = gui.userDataDir?.trim();
  return raw ? expandEnvPath(raw) : defaultUserDataDir();
}

function freePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** Codex 页面身份：app:// 协议或标题 ChatGPT/Codex */
export function isCodexTarget(title = "", url = ""): boolean {
  return /^app:\/\//i.test(url) || /chatgpt|codex/i.test(`${title} ${url}`);
}

/** 主应用页优先（排除 avatar-overlay 等次级窗口） */
export function pickCodexPage<T extends { type: string; title?: string; url?: string }>(
  targets: T[],
): T | undefined {
  const pages = targets.filter((t) => t.type === "page");
  if (!pages.length) return undefined;
  const rank = (t: { title?: string; url?: string }): number => {
    const u = t.url ?? "";
    let r = 0;
    if (/overlay/i.test(u)) r += 100;
    if (/index\.html/i.test(u)) r -= 10;
    return r;
  };
  return [...pages].sort((a, b) => rank(a) - rank(b))[0];
}

export async function probeCodexPort(
  port: number,
  processes = listCodexProcesses(),
): Promise<CodexReady | null> {
  const owner = rootCodexProcesses(processes).find((p) => remoteDebugPort(p.commandLine) === port);
  if (!owner) return null;
  try {
    const targets = await TraeworkCdpClient.listTargets(port, 1500);
    const page = pickCodexPage(targets);
    return page && isCodexTarget(page.title, page.url)
      ? {
          port,
          pid: owner.pid,
          title: page.title,
          url: page.url,
          userDataDir: remoteUserDataDir(owner.commandLine) ?? undefined,
        }
      : null;
  } catch {
    return null;
  }
}

async function pickPort(gui: GuiProfile): Promise<number> {
  if (!gui.cdpPortAuto) {
    if (!(await freePort(gui.cdpPort))) throw new Error(`Codex CDP 端口 ${gui.cdpPort} 已被占用`);
    return gui.cdpPort;
  }
  for (let i = 0; i < gui.cdpPortRange; i++) {
    const port = gui.cdpPort + i;
    // eslint-disable-next-line no-await-in-loop
    if (await freePort(port)) return port;
  }
  throw new Error(`Codex CDP 端口范围不可用：${gui.cdpPort}-${gui.cdpPort + gui.cdpPortRange - 1}`);
}

/**
 * 确保存在可接管的 Codex 实例。
 * 返回值语义与 zcode/instance 对齐：ready 复用的可用实例；needsClose 表示存在非受管实例需人工关闭。
 */
export async function ensureCodexInstance(
  candidate: { path: string; aumid?: string },
  gui: GuiProfile,
  logger: AgentRunLogger,
): Promise<{ ready?: CodexReady; needsClose?: boolean }> {
  const userDataDir = resolveUserDataDir(gui);
  const wanted = normalizeDir(userDataDir);
  const roots = rootCodexProcesses(listCodexProcesses());

  // 1) 复用：已有实例的 user-data-dir 属于本 MCP 且端口可用
  for (const proc of roots) {
    const port = remoteDebugPort(proc.commandLine);
    const udd = remoteUserDataDir(proc.commandLine);
    if (!port || !udd) continue;
    if (normalizeDir(udd) !== wanted) continue;
    // eslint-disable-next-line no-await-in-loop
    const ready = await probeCodexPort(port, roots);
    if (ready) {
      logger.info(`[codex] 复用受管实例 pid=${proc.pid}，CDP 端口 ${port}`);
      return { ready: { ...ready, userDataDir } };
    }
  }

  // 2) 存在受管 profile 的进程但端口未就绪：等待其就绪（可能仍在启动）
  for (const proc of roots) {
    const udd = remoteUserDataDir(proc.commandLine);
    if (udd && normalizeDir(udd) === wanted) {
      const port = remoteDebugPort(proc.commandLine);
      if (port) {
        const deadline = Date.now() + gui.launchTimeoutMs;
        while (Date.now() < deadline) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 500));
          // eslint-disable-next-line no-await-in-loop
          const ready = await probeCodexPort(port);
          if (ready) return { ready: { ...ready, userDataDir } };
        }
      }
    }
  }

  // 3) 启动新的受管实例（MSIX COM 激活）——必须带专属 user-data-dir 才能开 CDP
  if (gui.activation !== "msix-com")
    throw new Error(`Codex 仅支持 activation=msix-com（当前 ${gui.activation}）`);
  if (!candidate.aumid) throw new Error("Codex AUMID 未解析，无法通过 MSIX 激活启动");

  const port = await pickPort(gui);
  const args = buildActivationArgs(userDataDir, port);
  logger.info(`[codex] 激活受管实例：aumid=${candidate.aumid}，CDP 端口 ${port}，profile=${userDataDir}`);
  const activated = await activateCodexApp(candidate.aumid, args);
  if (!activated.ok) throw new Error(activated.message);
  logger.info(`[codex] 激活返回 pid=${activated.pid ?? "unknown"}；等待 CDP 就绪…`);

  const deadline = Date.now() + gui.launchTimeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500));
    // eslint-disable-next-line no-await-in-loop
    const ready = await probeCodexPort(port);
    if (ready) return { ready: { ...ready, userDataDir } };
  }
  throw new Error(`等待 Codex CDP 就绪超时（${gui.launchTimeoutMs}ms）`);
}
