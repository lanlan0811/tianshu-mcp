/**
 * 单条验收命令执行（开发计划 §8.2）：结构化 argv、非 shell、超时、缺省跳过、输出捕获。
 * 输出同时追加写入该轮 verify log 与内存尾部（供报告/摘要）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { mkdirp } from "../util/fs.js";
import type { CheckResult } from "../tasks/task.js";

export interface RunCommandOpts {
  cwd: string;
  timeoutMs: number;
  logFile?: string;
  env?: Record<string, string>;
}

export function runVerifyCommand(name: string, argv: string[], opts: RunCommandOpts): Promise<CheckResult> {
  return new Promise<CheckResult>((resolve) => {
    const startedAt = Date.now();
    const displayCmd = argv.join(" ");
    let tail = "";
    let stream: fs.WriteStream | null = null;
    void (async () => {
      if (opts.logFile) {
        await mkdirp(path.dirname(opts.logFile));
        stream = fs.createWriteStream(opts.logFile, { flags: "a" });
        stream.write(`\n=== check: ${name} — ${displayCmd} @ ${new Date().toISOString()} ===\n`);
      }
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let timer: NodeJS.Timeout | null = null;
      let timedOut = false;
      const onChunk = (buf: Buffer): void => {
        const s = buf.toString();
        tail = (tail + s).slice(-16_384);
        if (stream && !stream.destroyed) stream.write(s);
      };
      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      child.on("error", (e) => {
        const msg = e instanceof Error ? e.message : String(e);
        tail = (tail + `\n[spawn-error] ${msg}`).slice(-16_384);
        stream?.end();
        resolve({ name, cmd: displayCmd, passed: false, durationMs: Date.now() - startedAt, exitCode: null, outputTail: tail, timeout: false, reason: `无法启动命令：${msg}` });
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (stream && !stream.destroyed) stream.write(`\n[exit] code=${code} ${timedOut ? "(timeout)" : ""}\n`);
        stream?.end();
        resolve({
          name,
          cmd: displayCmd,
          passed: !timedOut && code === 0,
          durationMs: Date.now() - startedAt,
          exitCode: timedOut ? null : code,
          outputTail: tail.slice(-4000),
          timeout: timedOut,
        });
      });
      if (opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            if (process.platform === "win32") {
              void spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
            } else {
              try {
                process.kill(-child.pid, "SIGTERM");
              } catch {
                /* ignore */
              }
            }
          }
        }, opts.timeoutMs);
      }
    })();
  });
}

export function makeSkipResult(name: string, cmd: string, reason: string): CheckResult {
  return { name, cmd, passed: true, durationMs: 0, exitCode: null, outputTail: "", timeout: false, skipped: true, reason };
}
