/**
 * Task 类型 / 状态枚举 / 状态机迁移表。
 * 状态机见开发计划 §6：queued → running → … → succeeded/failed/cancelled/interrupted。
 */
export const TASK_STATUSES = [
  "queued",
  "running",
  "verify_start",
  "fixing",
  "succeeded",
  "failed",
  "needs_attention",
  "cancelled",
  "interrupted",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES: readonly TaskStatus[] = [
  "succeeded",
  "failed",
  "needs_attention",
  "cancelled",
  "interrupted",
];
export const ACTIVE_STATUSES: readonly TaskStatus[] = ["queued", "running", "verify_start", "fixing"];

export type TaskEventName =
  | "created"
  | "queued"
  | "started"
  | "agent_exited"
  | "verify_start"
  | "verify_round"
  | "fix_start"
  | "succeeded"
  | "failed"
  | "needs_attention"
  | "cancel_requested"
  | "cancelled"
  | "interrupted"
  | "timeout_killed"
  | "note";

export interface TaskEvent {
  ts: string;
  event: TaskEventName;
  state: TaskStatus;
  detail?: string;
  data?: Record<string, unknown>;
}

/** 验收命令单条结果（report.json checks[] 项） */
export interface CheckResult {
  name: string;
  cmd: string;
  passed: boolean;
  durationMs: number;
  exitCode: number | null;
  outputTail: string;
  timeout: boolean;
  skipped?: boolean;
  reason?: string;
  /** 被外部 abort（如任务取消）打断 */
  aborted?: boolean;
  /** optional:true 的检查失败不使本轮 verdict 失败，仅记 warning */
  optional?: boolean;
}

/** 代码分析结果（report.json analysis 段） */
export interface AnalysisResult {
  changedFiles: string[];
  untrackedFiles: string[];
  diffstat: { totalAdd: number; totalDel: number; perFile: { file: string; add: number; del: number; binary?: boolean }[] };
  signals: { todo: number; consoleDebug: number; commentedBlock: number; secretLike: number };
  bigFileChanges: string[];
  warnings: string[];
  notes: string[];
}

/** 一轮验收报告（内存 + report.json） */
export interface VerifyReport {
  round: number;
  taskId: string;
  projectPath: string;
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  verdict: "passed" | "failed";
  checks: CheckResult[];
  analysis: AnalysisResult;
  files: { md: string; json: string };
  message: string;
}

/** 任务全量 meta（task.json 快照 + meta 块输出共用） */
export interface TaskMeta {
  taskId: string;
  status: TaskStatus;
  projectPath: string;
  displayPath: string;
  agentId: string;
  task: string;
  context?: string;
  autoVerify: boolean;
  autoFixRounds: number;
  taskTimeoutMs: number;
  round: number;
  roundsUsed: number;
  errorType?: "timeout" | "spawn" | "agent_failed" | "verify_failed" | "cancelled" | "interrupted" | "agent_unresolved" | "internal" | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastMessage?: string;
  changedFiles?: string[];
  diffstat?: string;
  checkSummary?: string;
  logFile?: string;
  reportMd?: string;
  reportJson?: string;
  cancelReason?: string;
  /** 用户取消意图的独立结构化标记（S1）：一旦用户调用 cancel_task 即置位，不依赖可选 reason 推断 */
  cancelRequestedAt?: string;
  /** 中断来源：user=用户取消；shutdown=server 关闭/EOF；timeout=任务超时；internal=内部错误 */
  abortSource?: "user" | "shutdown" | "timeout" | "internal";
  /** rework_task 注入的追加指示（仅作用于下一轮 agent） */
  reworkFeedback?: string;
}

/** manager 记录任务所需最小信息（内存态），与 TaskMeta 解耦 */
export interface TaskRecord {
  meta: TaskMeta;
  events: TaskEvent[];
}

/** 状态机合法迁移（用于单测 + 断言保护） */
export const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "cancelled", "interrupted"],
  running: ["verify_start", "fixing", "succeeded", "failed", "needs_attention", "cancelled", "interrupted"],
  verify_start: ["succeeded", "failed", "needs_attention", "fixing", "cancelled", "interrupted"],
  fixing: ["running", "cancelled", "interrupted"],
  succeeded: [],
  failed: [],
  needs_attention: [],
  cancelled: [],
  interrupted: [],
};

export function isTerminal(s: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}
