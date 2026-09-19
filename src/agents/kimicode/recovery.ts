/**
 * Kimi Code 的预算与错误分类（与 zcode/recovery.ts 同构，仅换命名空间）：
 * 初始化阶段用 setup 预算，绑定完成后只剩任务总时限。
 */
import type { AgentRunOptions } from "../adapter.js";
import { ZCODE_SETUP_DEFAULTS, type GuiProfile } from "../../config/schema.js";

export class KimicodeSetupPause extends Error {
  constructor(
    message: string,
    readonly needsPermission = false,
  ) {
    super(message);
  }
}

export class KimicodeBudgetError extends Error {
  constructor(
    readonly reason: "setup_recovery" | "operation_timeout" | "task_timeout" | "aborted",
    readonly stage: string,
  ) {
    super(`Kimi Code ${stage}: ${reason}`);
  }
}

/** One deadline for initialization; after binding only the task deadline applies. */
export class KimicodeBudget {
  stage = "准备工作区连接";
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
    const note = `Kimi Code ${this.stage}；已等待 ${Date.now() - this.started}ms`;
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
    if (this.opts.signal?.aborted) throw new KimicodeBudgetError("aborted", this.stage);
    if (Date.now() >= this.taskDeadline) throw new KimicodeBudgetError("task_timeout", this.stage);
    if (!this.bound && Date.now() >= this.setupDeadline)
      throw new KimicodeBudgetError("setup_recovery", this.stage);
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
      reject(new KimicodeBudgetError(reason, this.stage));
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

/** 从 GUI 配置构造预算：初始化预算取自 gui.setupRecoveryTimeoutMs */
export function kimicodeBudgetFor(
  gui: GuiProfile,
  taskDeadline: number,
  opts: AgentRunOptions,
): KimicodeBudget {
  return new KimicodeBudget(
    taskDeadline,
    Date.now() + gui.setupRecoveryTimeoutMs,
    opts,
    gui.progressIntervalMs,
  );
}

/** 等待工作区触发器（ws-chip）挂载的就绪预算，取自 gui.workspaceTriggerTimeoutMs */
export function workspaceTriggerBudgetMs(gui: Pick<GuiProfile, "workspaceTriggerTimeoutMs">): number {
  return gui.workspaceTriggerTimeoutMs ?? ZCODE_SETUP_DEFAULTS.workspaceTriggerTimeoutMs;
}

export function transientSetupError(error: unknown): boolean {
  if (error instanceof KimicodeBudgetError)
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