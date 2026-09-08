/**
 * TraeWork GUI 驱动适配器（开发计划 traework-gui-adapter-plan §4.2）。
 *
 * 与 CLI adapter 的区别：不 spawn 子进程，而是通过 CDP 驱动 TraeWork 桌面 UI
 * （新建会话 → 定位/新建项目 → 输入任务书 → 发送 → 等待完成 → 提取回复）。
 *
 * 本文件只负责「执行面」编排；具体的 CDP/UI 细节在 ./cdp 与 ./ui 下。
 * M1 阶段先落地接口与骨架，M2/M3/M4 逐步填充实现。
 */
import path from "node:path";
import type {
  AgentAdapter,
  AgentRunLogger,
  AgentRunOptions,
  AgentRunResult,
  ResolvedAgent,
  SpawnInvocation,
  TaskContext,
} from "../adapter.js";
import type { SpawnResult } from "../spawn.js";

export class TraeworkGuiAdapter implements AgentAdapter {
  constructor(readonly id: string) {}

  /** GUI 驱动不构造命令行；仅为满足接口，调用即报错。 */
  buildInvocation(_ctx: TaskContext, _resolved: ResolvedAgent): SpawnInvocation {
    throw new Error("traework-gui 不通过 spawn 执行（driver=gui），不应调用 buildInvocation");
  }

  /** GUI 驱动的结果由 run() 直接产出，parseExit 仅作接口兜底。 */
  parseExit(res: SpawnResult): AgentRunResult {
    const r: AgentRunResult = { ...res };
    if (res.error && res.exitCode === null) r.hardFailure = true;
    return r;
  }

  /** 自定义执行面：驱动 TraeWork UI 完成一次开发任务。 */
  async run(ctx: TaskContext, resolved: ResolvedAgent, opts: AgentRunOptions): Promise<AgentRunResult> {
    const startedAt = Date.now();
    const logFile = path.join(ctx.taskDir, `agent-${ctx.round}.log`);
    const log = opts.logger;
    try {
      const { runTraeworkTask } = await import("./run.js");
      return await runTraeworkTask({ ctx, resolved, opts, logFile, startedAt, logger: log });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        exitCode: null,
        timeout: false,
        killed: false,
        error: msg,
        durationMs: Date.now() - startedAt,
        logFile,
        // GUI 未就绪（CDP 连不上/可执行缺失）属基础设施失败，不进验收返修
        hardFailure: isInfraError(msg),
      };
    }
  }
}

/** 基础设施类错误（不进入验收/返修，直接判 failed） */
export function isInfraError(msg: string): boolean {
  return /CDP_|未找到.*可执行|未就绪|ECONNREFUSED|ENOENT/i.test(msg);
}

export type { AgentRunLogger };
