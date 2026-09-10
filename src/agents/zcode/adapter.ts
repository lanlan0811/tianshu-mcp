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

export class ZcodeGuiAdapter implements AgentAdapter {
  constructor(readonly id: string) {}

  buildInvocation(): SpawnInvocation {
    throw new Error("zcode-gui 不通过 spawn 执行");
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
    serial = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const { runZcodeTask } = await import("./run.js");
      return await runZcodeTask({
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
