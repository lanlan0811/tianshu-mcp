import net from "node:net";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { TraeworkCdpClient } from "../traework/cdp/client.js";
import type { GuiProfile } from "../../config/schema.js";
import type { AgentRunLogger } from "../adapter.js";

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

export function listZcodeProcesses(): ZcodeProcess[] {
  try {
    if (process.platform === "win32") {
      const script =
        'Get-CimInstance Win32_Process -Filter "Name=\'ZCode.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)" }';
      return parseProcessRows(
        execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 8_000,
        }),
      );
    }
    const raw = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 5_000 });
    return raw.split(/\r?\n/).flatMap((line) => {
      const m = /^\s*(\d+)\s+(.*ZCode.*)$/.exec(line);
      return m ? [{ pid: Number(m[1]), commandLine: m[2]! }] : [];
    });
  } catch {
    return [];
  }
}

export function rootZcodeProcesses(rows: ZcodeProcess[]): ZcodeProcess[] {
  return rows.filter((p) => !/--type=|zcode\.cjs|plugin-host|crashpad/i.test(p.commandLine));
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
  processes = listZcodeProcesses(),
): Promise<ZcodeReady | null> {
  const owner = rootZcodeProcesses(processes).find((p) => remoteDebugPort(p.commandLine) === port);
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
): Promise<{ ready?: ZcodeReady; needsClose?: boolean; child?: ChildProcess }> {
  const roots = rootZcodeProcesses(listZcodeProcesses());
  for (const proc of roots) {
    const port = remoteDebugPort(proc.commandLine);
    if (port) {
      // eslint-disable-next-line no-await-in-loop
      const ready = await probeZcodePort(port, roots);
      if (ready) return { ready };
    }
  }
  if (roots.length) return { needsClose: true };
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
  const child = spawn(exePath, args, { detached: false, stdio: "ignore", windowsHide: false });
  logger.info(
    `[zcode] 已启动 ${path.basename(exePath)}，CDP 端口 ${port}，pid=${child.pid ?? "unknown"}`,
  );
  const deadline = Date.now() + gui.launchTimeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 500));
    // eslint-disable-next-line no-await-in-loop
    const ready = await probeZcodePort(port);
    if (ready) return { ready, child };
    if (child.exitCode !== null) throw new Error(`ZCode 启动后提前退出（exit=${child.exitCode}）`);
  }
  throw new Error(`等待 ZCode CDP 就绪超时（${gui.launchTimeoutMs}ms）`);
}
