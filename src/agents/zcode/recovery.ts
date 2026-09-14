import type { AgentRunOptions } from "../adapter.js";

export class ZcodeSetupPause extends Error {
  constructor(
    message: string,
    readonly needsPermission = false,
  ) {
    super(message);
  }
}

export class ZcodeBudgetError extends Error {
  constructor(
    readonly reason: "setup_recovery" | "operation_timeout" | "task_timeout" | "aborted",
    readonly stage: string,
  ) {
    super(`ZCode ${stage}: ${reason}`);
  }
}

/** One deadline for initialization; after binding only the task deadline applies. */
export class ZcodeBudget {
  stage = "准备项目连接";
  private bound = false;
  private readonly started = Date.now();
  private heartbeat?: ReturnType<typeof setInterval>;
  constructor(
    readonly taskDeadline: number,
    readonly setupDeadline: number,
    private readonly opts: AgentRunOptions,
    progressIntervalMs: number,
  ) {
    this.heartbeat = setInterval(() => this.report(), progressIntervalMs);
    this.heartbeat.unref();
    this.report();
  }
  setStage(stage: string): void {
    this.stage = stage;
    this.report();
  }
  private report(): void {
    const note = `ZCode ${this.stage}；已等待 ${Date.now() - this.started}ms`;
    this.opts.logger.info(note);
    void Promise.resolve(this.opts.onProgress?.(note)).catch(() => {});
  }
  finishSetup(): void {
    this.bound = true;
    this.close();
  }
  get settingUp(): boolean {
    return !this.bound;
  }
  close(): void {
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
  check(): void {
    if (this.opts.signal?.aborted) throw new ZcodeBudgetError("aborted", this.stage);
    if (Date.now() >= this.taskDeadline) throw new ZcodeBudgetError("task_timeout", this.stage);
    if (!this.bound && Date.now() >= this.setupDeadline)
      throw new ZcodeBudgetError("setup_recovery", this.stage);
  }
  remaining(cap = Infinity): number {
    this.check();
    return Math.max(
      1,
      Math.min(
        cap,
        this.taskDeadline - Date.now(),
        this.bound ? Infinity : this.setupDeadline - Date.now(),
      ),
    );
  }
  async run<T>(
    operation: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
    cap = Infinity,
  ): Promise<T> {
    const timeoutMs = this.remaining(cap);
    const deadline = Math.min(
      Date.now() + timeoutMs,
      this.taskDeadline,
      this.bound ? Infinity : this.setupDeadline,
    );
    const controller = new AbortController();
    let reject!: (error: Error) => void;
    const aborted = new Promise<never>((_, fail) => {
      reject = fail;
    });
    let timer: ReturnType<typeof setTimeout>;
    const stop = () => {
      if (!this.opts.signal?.aborted && Date.now() < deadline) {
        timer = setTimeout(stop, Math.max(1, deadline - Date.now()));
        return;
      }
      const reason = this.opts.signal?.aborted
        ? "aborted"
        : Date.now() >= this.taskDeadline
          ? "task_timeout"
          : !this.bound && Date.now() >= this.setupDeadline
            ? "setup_recovery"
            : "operation_timeout";
      reject(new ZcodeBudgetError(reason, this.stage));
      // Preserve the controlling deadline/cancellation reason before dependent CDP
      // operations synchronously reject their own promises in abort listeners.
      controller.abort();
    };
    timer = setTimeout(stop, timeoutMs);
    this.opts.signal?.addEventListener("abort", stop, { once: true });
    try {
      const result = await Promise.race([operation(controller.signal, timeoutMs), aborted]);
      this.check();
      return result;
    } catch (error) {
      this.check();
      throw error;
    } finally {
      clearTimeout(timer);
      this.opts.signal?.removeEventListener("abort", stop);
    }
  }
}

export function transientSetupError(error: unknown): boolean {
  if (error instanceof ZcodeBudgetError)
    return error.reason === "setup_recovery" || error.reason === "operation_timeout";
  const e = error as { code?: string; killed?: boolean; message?: string };
  return (
    e?.killed === true ||
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ABORT_ERR"].includes(e?.code ?? "") ||
    /超时|timeout|timed out|renderer busy/i.test(e?.message ?? "")
  );
}

export function permissionError(error: unknown): boolean {
  return /ACCESSIBILITY_PERMISSION_REQUIRED|not authorized|辅助功能|not allowed assistive|(-1743)|(-1719)/i.test(
    error instanceof Error ? error.message : String(error),
  );
}
