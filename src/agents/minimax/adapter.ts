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

/**
 * 同一台机器上 MiniMax Code 只有一个受管实例：与 Kimi Code / Open Design 同构的
 * **全局串行门**。并行派活会两条流程同时点同一个「模型」/「项目」菜单，必然互相踩踏；
 * 而模型弹层是**独立窗口**，两条流程的 hover 二级子菜单会互相覆盖。
 */
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

export class MinimaxGuiAdapter implements AgentAdapter {
  constructor(readonly id: string) {}

  buildInvocation(): SpawnInvocation {
    throw new Error("minimax-gui 不通过 spawn 执行");
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
    // 串行链即使本次等待方被取消，也保留前一个持有者：后续任务不可能与它重叠执行。
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
      const { runMinimaxTask } = await import("./run.js");
      return await runMinimaxTask({
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
