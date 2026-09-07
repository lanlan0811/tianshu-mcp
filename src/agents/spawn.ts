/**
 * 子进程封装：windowsHide / stdio 管道 → agent.log / 超时 / kill tree / abort 感知。
 * Windows: taskkill /pid <pid> /T /F；POSIX: detached + kill(-pgid)。
 * 遵循开发计划 §6/§12：不用 shell、不拼接 shell 字符串。
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkdirp } from "../util/fs.js";
import { Logger } from "../util/log.js";

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logFile: string;
  timeoutMs: number;
  killTree: "taskkill" | "group";
}

export interface SpawnResult {
  ok: boolean;
  exitCode: number | null;
  timeout: boolean;
  killed: boolean;
  error?: string;
  durationMs: number;
  logFile: string;
}

export function killTree(pid: number, mode: "taskkill" | "group"): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === "win32" || mode === "taskkill") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
    } else {
      try {
        process.kill(-pid, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* 已退出 */
          }
        }, 1500).unref();
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* 已退出 */
        }
      }
      resolve();
    }
  });
}

/**
 * 运行子进程。prompt 通过 stdin 传入时使用 opts.stdinText。
 * 输出流式写入 logFile（[stdout]/[stderr] 分轨）。
 */
export function runChild(spec: SpawnSpec, opts: { signal?: AbortSignal; stdinText?: string; logger?: Logger }): Promise<SpawnResult> {
  const { signal, stdinText } = opts;
  const startedAt = Date.now();
  return new Promise<SpawnResult>((resolve) => {
    void (async () => {
      await mkdirp(path.dirname(spec.logFile));
      const logStream = fs.createWriteStream(spec.logFile, { flags: "a", encoding: "utf8" });
      logStream.write(`\n===== spawn: ${spec.command} ${spec.args.join(" ")} (cwd=${spec.cwd}) @ ${new Date().toISOString()} =====\n`);

      let child: ChildProcess;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let settled = false;
      let timedOut = false;
      let killedBySignal = false;

      const onAbort = (): void => {
        killedBySignal = true;
        if (child.pid) void killTree(child.pid, spec.killTree);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      const finish = (res: SpawnResult): void => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (signal) signal.removeEventListener("abort", onAbort);
        logStream.end();
        resolve(res);
      };

      try {
        child = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: { ...process.env, ...spec.env },
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        finish({ ok: false, exitCode: null, timeout: false, killed: false, error: `spawn 失败: ${msg}`, durationMs: Date.now() - startedAt, logFile: spec.logFile });
        return;
      }

      child.stdout?.on("data", (d: Buffer) => logStream.write(`[stdout] ${d.toString()}`));
      child.stderr?.on("data", (d: Buffer) => logStream.write(`[stderr] ${d.toString()}`));
      child.on("error", (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        logStream.write(`[spawn-error] ${msg}\n`);
        finish({ ok: false, exitCode: null, timeout: timedOut, killed: killedBySignal, error: msg, durationMs: Date.now() - startedAt, logFile: spec.logFile });
      });
      child.on("close", (code) => {
        const durationMs = Date.now() - startedAt;
        logStream.write(`[exit] code=${code} ${timedOut ? "(timeout)" : killedBySignal ? "(killed)" : ""} duration=${durationMs}ms\n`);
        if (timedOut) {
          finish({ ok: false, exitCode: code, timeout: true, killed: false, durationMs, logFile: spec.logFile });
        } else if (killedBySignal) {
          finish({ ok: false, exitCode: code, timeout: false, killed: true, durationMs, logFile: spec.logFile });
        } else {
          finish({ ok: code === 0, exitCode: code, timeout: false, killed: false, durationMs, logFile: spec.logFile });
        }
      });

      if (spec.timeoutMs && spec.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          if (child.pid) void killTree(child.pid, spec.killTree);
        }, spec.timeoutMs);
      }

      if (stdinText != null) {
        child.stdin?.write(stdinText);
      }
      child.stdin?.end();
    })();
  });
}
