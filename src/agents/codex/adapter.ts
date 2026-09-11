/**
 * CodexGuiAdapter：GUI 执行面接入点（对齐 ZcodeGuiAdapter 的串行门语义）。
 * driver="gui" + adapter="codex-gui" 的 profile 由 registry 选择本实现。
 *
 * 串行门：GUI 自动化对同一桌面会话是排他资源，前一个任务未释放前不并发第二个，
 * 但被取消的等待者不会让后续任务越过前一个持有者。
 */
import path from "node:path";
import type {
  AgentAdapter,
  AgentRunOptions,
  AgentRunResult,
  ResolvedAgent,
  SpawnInvocation,
  TaskContext,
} from "../adapter.js";
import type { SpawnResult } from "../spawn.js";

let serial: Promise<void> = Promise.resolve();

async function waitForPrevious(
  previous: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!signal) {
    await previous;
    return true;
  }
  if (signal.aborted) return false;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<false>((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([previous.then(() => true as const), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export class CodexGuiAdapter implements AgentAdapter {
  constructor(readonly id: string) {}

  buildInvocation(): SpawnInvocation {
    throw new Error("codex-gui 不通过 spawn 执行");
  }

  parseExit(res: SpawnResult): AgentRunResult {
    return { ...res, hardFailure: Boolean(res.error && res.exitCode === null) };
  }

  async run(
    ctx: TaskContext,
    resolved: ResolvedAgent,
    opts: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const previous = serial;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 链上保留前一个持有者：即使本等待者被取消，后续任务也无法越过它。
    serial = previous.then(() => gate);
    try {
      if (!(await waitForPrevious(previous, opts.signal))) {
        return {
          ok: false,
          exitCode: null,
          timeout: false,
          killed: true,
          durationMs: 0,
          logFile: path.join(ctx.taskDir, `agent-${ctx.round}.log`),
          endReason: "aborted",
          keptInstance: true,
        };
      }
      const { runCodexTask } = await import("./run.js");
      return await runCodexTask({
        ctx,
        resolved,
        opts,
        logFile: path.join(ctx.taskDir, `agent-${ctx.round}.log`),
      });
    } finally {
      release();
    }
  }
}
