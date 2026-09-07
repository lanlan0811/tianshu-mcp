/**
 * 子进程封装：windowsHide / stdio 管道 → agent.log / 超时 / kill tree / abort 感知。
 * Windows: taskkill /pid <pid> /T /F；POSIX: detached + kill(-pgid)。
 * 用 cross-spawn 以便 Windows 下直接执行 npm/npx 等 .cmd 垫片（保持 argv 数组、非 shell 拼接）。
 * 遵循开发计划 §6/§12：不用 shell、不拼接 shell 字符串。
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
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

/**
 * 终止进程树。平台策略在实现内部决定：
 * - Windows：`taskkill /pid <pid> /T /F`（含子进程、无条件强制）。
 * - POSIX（macOS/Linux）：对独立进程组（detached 子进程）先 SIGTERM，等有限 grace 再 SIGKILL。
 * 终止后轮询确认进程已消失再 resolve（确定性，避免调用方误判）。
 * 即使调用方从旧 profile 传入 "taskkill"，非 Windows 平台也绝不执行 taskkill（R2 修复）。
 */
export function killTree(pid: number, _mode?: "taskkill" | "group" | "auto"): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const killer = nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => resolve());
      killer.on("close", () => resolve());
      return;
    }
    const alive = (target: number): boolean => {
      try {
        process.kill(target, 0);
        return true;
      } catch {
        return false;
      }
    };
    // 发送信号到进程组（负 pid）或单进程
    const signal = (target: number, sig: NodeJS.Signals): void => {
      try {
        process.kill(-target, sig);
      } catch {
        try {
          process.kill(target, sig);
        } catch {
          /* 已退出 */
        }
      }
    };
    if (!alive(pid)) {
      resolve();
      return;
    }
    signal(pid, "SIGTERM");
    // grace 后 SIGKILL，并轮询确认退出（最长 ~3s）
    const started = Date.now();
    const poll = (): void => {
      if (!alive(pid) && !alive(-pid)) {
        resolve();
        return;
      }
      if (Date.now() - started > 800) signal(pid, "SIGKILL");
      if (Date.now() - started > 3000) {
        resolve(); // 尽力而为：信号已发，不再无限等待
        return;
      }
      setTimeout(poll, 100).unref();
    };
    poll();
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
      // 竞态兜底：晚到的 stdout data 在 finish() 已 end() 后再写入会抛
      // ERR_STREAM_WRITE_AFTER_END —— 不能成为未处理 'error' 事件打崩 server。
      logStream.on("error", () => {});
      let streamEnded = false;
      const safeWrite = (s: string): void => {
        if (!streamEnded && logStream.writable) logStream.write(s);
      };
      const safeEnd = (): void => {
        if (!streamEnded) {
          streamEnded = true;
          logStream.end();
        }
      };
      safeWrite(`\n===== spawn: ${spec.command} ${spec.args.join(" ")} (cwd=${spec.cwd}) @ ${new Date().toISOString()} =====\n`);

      let child: ChildProcess;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let settled = false;
      let timedOut = false;
      let killedBySignal = false;

      const onAbort = (): void => {
        killedBySignal = true;
        if (child && child.pid) void killTree(child.pid, spec.killTree);
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
        safeEnd();
        resolve(res);
      };

      try {
        child = crossSpawn(spec.command, spec.args, {
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
      // spawn 期间收到 abort（cancel 竞态）→ 立即终止刚拉起的进程
      if (signal?.aborted && child.pid) {
        killedBySignal = true;
        void killTree(child.pid, spec.killTree);
      }

      child.stdout?.on("data", (d: Buffer) => safeWrite(`[stdout] ${d.toString()}`));
      child.stderr?.on("data", (d: Buffer) => safeWrite(`[stderr] ${d.toString()}`));
      child.on("error", (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        safeWrite(`[spawn-error] ${msg}\n`);
        finish({ ok: false, exitCode: null, timeout: timedOut, killed: killedBySignal, error: msg, durationMs: Date.now() - startedAt, logFile: spec.logFile });
      });
      child.on("close", (code) => {
        const durationMs = Date.now() - startedAt;
        safeWrite(`[exit] code=${code} ${timedOut ? "(timeout)" : killedBySignal ? "(killed)" : ""} duration=${durationMs}ms\n`);
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
          if (child && child.pid) void killTree(child.pid, spec.killTree);
        }, spec.timeoutMs);
      }

      if (stdinText != null) {
        child.stdin?.write(stdinText);
      }
      child.stdin?.end();
    })();
  });
}
