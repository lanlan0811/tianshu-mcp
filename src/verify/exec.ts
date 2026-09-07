/** execFile 的 async 薄封装（git 等系统命令用，非 shell） */
import { execFile } from "node:child_process";

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut: boolean;
  durationMs: number;
}

export function execFileAsync(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 120_000,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...opts.env },
      },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        if (!err) {
          resolve({ status: 0, stdout: String(stdout), stderr: String(stderr), timedOut: false, durationMs });
          return;
        }
        const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
        if (code === "ETIMEDOUT") {
          resolve({ status: null, stdout: String(stdout), stderr: String(stderr), error: "timeout", timedOut: true, durationMs });
        } else if (typeof code === "number") {
          resolve({ status: code, stdout: String(stdout), stderr: String(stderr), timedOut: false, durationMs });
        } else {
          resolve({ status: null, stdout: String(stdout), stderr: String(stderr), error: (err as Error).message, timedOut: false, durationMs });
        }
      },
    );
  });
}
