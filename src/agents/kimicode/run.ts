import type { AgentRunOptions, AgentRunResult, ResolvedAgent, TaskContext } from "../adapter.js";

export interface RunKimicodeArgs {
  ctx: TaskContext;
  resolved: ResolvedAgent;
  opts: AgentRunOptions;
  logFile: string;
  deps?: Partial<KimicodeRunDeps>;
}

/** M1 占位：依赖注入面在后续里程碑随实例接管/CDP 客户端落地时填充。 */
export interface KimicodeRunDeps {
  sleep: (ms: number) => Promise<void>;
}

export async function runKimicodeTask(args: RunKimicodeArgs): Promise<AgentRunResult> {
  // M1 阶段占位：实例接管、会话/工作区绑定、模型与档位、运行检测将在后续里程碑实现。
  return {
    ok: false,
    exitCode: null,
    timeout: false,
    killed: false,
    durationMs: 0,
    logFile: args.logFile,
    hardFailure: true,
    endReason: "internal",
    error: "kimicode adapter 尚未实现（M1 占位）",
    keptInstance: false,
  };
}
