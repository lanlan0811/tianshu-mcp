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
        // 当前 Node 超时杀进程时 err.code === null（不置 ETIMEDOUT）、err.killed === true——
        // 旧式 code === "ETIMEDOUT" 分支已不可达（实测 Node 20/22/24）。
        // 排除 maxBuffer 溢出（同样 killed=true，但属输出超限，不是超时）。
        const killed = (err as { killed?: boolean }).killed === true;
        const maxBufferHit =
          code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || code === "ENOBUFS" || code === "E2BIG";
        if (code === "ETIMEDOUT" || (killed && !maxBufferHit)) {
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
