/**
 * 单条验收命令执行（开发计划 §8.2）：结构化 argv、非 shell、超时、缺省跳过、输出捕获。
 * 输出同时追加写入该轮 verify log 与内存尾部（供报告/摘要）。
 * kill-tree 与 agent spawn 共用同一工具（killTree in agents/spawn.ts），支持 abort 感知。
 */
import crossSpawn from "cross-spawn";
import fs from "node:fs";
import path from "node:path";
import { mkdirp } from "../util/fs.js";
import type { CheckResult } from "../tasks/task.js";
import { killTree } from "../agents/spawn.js";

export interface RunCommandOpts {
  cwd: string;
  timeoutMs: number;
  logFile?: string;
  env?: Record<string, string>;
  /** abort 时立即杀子进程树；result.aborted=true（与 timeout 区分） */
  signal?: AbortSignal;
}

export function runVerifyCommand(name: string, argv: string[], opts: RunCommandOpts): Promise<CheckResult> {
  return new Promise<CheckResult>((resolve) => {
    const startedAt = Date.now();
    const displayCmd = argv.join(" ");
    let tail = "";
    let stream: fs.WriteStream | null = null;
    let streamEnded = false;
    let child: ReturnType<typeof crossSpawn> | null = null;
    let timer: NodeJS.Timeout | null = null;
    let timedOut = false;
    let aborted = false;
    const safeWrite = (s: string): void => {
      if (stream && !streamEnded && stream.writable) stream.write(s);
    };
    const safeEnd = (): void => {
      if (stream && !streamEnded) {
        streamEnded = true;
        stream.end();
      }
    };
    const killActive = (): void => {
      if (child?.pid) void killTree(child.pid, "auto");
    };
    const onAbort = (): void => {
      aborted = true;
      killActive();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    const releaseSignal = (): void => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };
    void (async () => {
      if (opts.logFile) {
        await mkdirp(path.dirname(opts.logFile));
        stream = fs.createWriteStream(opts.logFile, { flags: "a" });
        // 竞态兜底：晚到 data 在 end() 后写入会抛 ERR_STREAM_WRITE_AFTER_END，绝不能成为未处理 error 打崩 server。
        stream.on("error", () => {});
        safeWrite(`\n=== check: ${name} — ${displayCmd} @ ${new Date().toISOString()} ===\n`);
      }
      let spawnError: string | null = null;
      try {
        child = crossSpawn(argv[0]!, argv.slice(1), {
          cwd: opts.cwd,
          env: { ...process.env, ...opts.env },
          windowsHide: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
          detached: process.platform !== "win32", // POSIX 下独立进程组，便于整组 SIGTERM/SIGKILL
        });
      } catch (e) {
        spawnError = e instanceof Error ? e.message : String(e);
      }
      if (spawnError || !child) {
        const msg = spawnError ?? "未知 spawn 错误";
        tail = (tail + `\n[spawn-error] ${msg}`).slice(-16_384);
        releaseSignal();
        safeEnd();
        resolve({ name, cmd: displayCmd, passed: false, durationMs: Date.now() - startedAt, exitCode: null, outputTail: tail, timeout: false, aborted: false, reason: `无法启动命令：${msg}` });
        return;
      }
      const onChunk = (buf: Buffer): void => {
        const s = buf.toString();
        tail = (tail + s).slice(-16_384);
        safeWrite(s);
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      child.on("error", (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        tail = (tail + `\n[spawn-error] ${msg}`).slice(-16_384);
        releaseSignal();
        if (timer) clearTimeout(timer);
        safeEnd();
        resolve({ name, cmd: displayCmd, passed: false, durationMs: Date.now() - startedAt, exitCode: null, outputTail: tail, timeout: false, aborted, reason: `无法启动命令：${msg}` });
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        releaseSignal();
        safeWrite(`\n[exit] code=${code} ${timedOut ? "(timeout)" : aborted ? "(aborted)" : ""}\n`);
        safeEnd();
        resolve({
          name,
          cmd: displayCmd,
          passed: !timedOut && !aborted && code === 0,
          durationMs: Date.now() - startedAt,
          exitCode: timedOut || aborted ? null : code,
          outputTail: tail.slice(-4000),
          timeout: timedOut,
          aborted,
        });
      });
      if (opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killActive();
        }, opts.timeoutMs);
      }
    })();
  });
}

export function makeSkipResult(name: string, cmd: string, reason: string): CheckResult {
  return { name, cmd, passed: true, durationMs: 0, exitCode: null, outputTail: "", timeout: false, skipped: true, reason };
}
