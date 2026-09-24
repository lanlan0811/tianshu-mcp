/**
 * agent 细粒度事件词表（issue #18）。
 *
 * 事件上报是**可选能力**：适配器实现 `AgentRunOptions.onEvent` 即在关键节点主动上报，
 * 未实现的适配器一个字节都不用改（调用侧一律走 `opts.onEvent?.(...)` 可选链）。
 *
 * 本模块刻意**零依赖**：`adapter.ts`、`tasks/task.ts`、`tasks/task-store.ts` 都要引用它，
 * 若它反向引用这些模块会形成循环。因此这里只有类型与常量，不 import 任何东西。
 *
 * 与既有 `note` 事件的关系：`note` 仍是进度/审计通道（承载 progressSummary、
 * lastRunSignal 等自由文本），本词表只表达**语义化节点**，两者同写 task.jsonl、共用时序。
 */

export const AGENT_EVENT_NAMES = [
  /** 指令已确认送达 agent（进入其执行队列） */
  "task_dispatched",
  /** 检测到需要人工处理的确认类对话框（含原生文件夹选择框、残留弹窗清理） */
  "confirmation_dialog_detected",
  /** 等待用户授权/登录/确认，任务已卡在人工介入上 */
  "awaiting_user_authorization",
  /**
   * agent 开始执行（GUI 侧观测到「运行中」信号首次出现）。
   * 注意：这是**启发式**推断——适配器并不直接观测文件系统，
   * 因此 detail 文案一律如实写「可能开始改动文件」，不声称已改动。
   */
  "file_modification_started",
  /** 验收失败后进入返修（自动或 manual） */
  "rework_triggered",
] as const;

export type AgentEventName = (typeof AGENT_EVENT_NAMES)[number];

export interface AgentEvent {
  kind: AgentEventName;
  detail?: string;
  data?: Record<string, unknown>;
}

export type OnAgentEvent = (event: AgentEvent) => void | Promise<void>;

/** 判断某个事件名是否属于本词表（供读取侧过滤使用） */
export function isAgentEventName(name: string): name is AgentEventName {
  return (AGENT_EVENT_NAMES as readonly string[]).includes(name);
}

/**
 * 把可选的 `onEvent` 钩子包成「永不抛错」的上报函数。
 *
 * 这是 issue #18「事件上报为可选能力，不影响原有逻辑」的落点：上报失败（例如落盘 IO 出错）
 * 绝不能中断正在进行的 GUI 任务，因此这里吞掉异常。未提供钩子时是空操作。
 */
export function makeEmitter(
  onEvent?: OnAgentEvent,
): AgentEventEmitter {
  return async (kind, detail, data) => {
    if (!onEvent) return;
    try {
      await onEvent({ kind, detail, data });
    } catch {
      // 有意吞掉：事件上报属观测能力，不得影响任务本体
    }
  };
}

/** `makeEmitter` 的返回类型：适配器内部把上报函数透传给辅助流程时用 */
export type AgentEventEmitter = (
  kind: AgentEventName,
  detail?: string,
  data?: Record<string, unknown>,
) => Promise<void>;
