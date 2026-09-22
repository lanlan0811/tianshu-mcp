/**
 * Task 类型 / 状态枚举 / 状态机迁移表。
 * 状态机见开发计划 §6：queued → running → … → succeeded/failed/cancelled/interrupted。
 */
import type { TraeworkMode, ReasoningLevel } from "../config/schema.js";
import type { VisualReport } from "../visual/types.js";

/**
 * 任务工作区模式（issue #12）：
 * - project：绑定了真实项目目录，projectPath/displayPath 为规范化绝对路径；
 * - default：ZCode 无项目会话（default 工作区），projectPath/displayPath 为空串，
 *   不采集 Git 基线、不进入项目验收与项目级锁。
 */
export type WorkspaceMode = "project" | "default";

export const TASK_STATUSES = [
  "queued",
  "running",
  "verify_start",
  "fixing",
  "succeeded",
  "failed",
  "needs_attention",
  "needs_user",
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
export const ACTIVE_STATUSES: readonly TaskStatus[] = [
  "queued",
  "running",
  "verify_start",
  "fixing",
];

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
  | "needs_user"
  | "continued"
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
  diffstat: {
    totalAdd: number;
    totalDel: number;
    perFile: { file: string; add: number; del: number; binary?: boolean }[];
  };
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
  files: { md: string; json: string; html?: string };
  visual?: VisualReport;
  message: string;
  blockingIssues?: { code: string; message: string }[];
}

/** 任务全量 meta（task.json 快照 + meta 块输出共用） */
export interface TaskMeta {
  taskId: string;
  status: TaskStatus;
  /**
   * 工作区模式。旧 task.json 无此字段时按 project 归一化（见 workspaceModeOf）——
   * 绝不把旧记录或损坏记录默认当成无项目。
   */
  workspaceMode?: WorkspaceMode;
  projectPath: string;
  displayPath: string;
  agentId: string;
  task: string;
  context?: string;
  /** GUI 类 agent（traework/codex）使用的模型名；CLI 类忽略 */
  model?: string;
  /** Codex GUI 思考等级（已归一 low/medium/high）；其他 agent 忽略 */
  reasoningLevel?: ReasoningLevel;
  modelSource?: "default" | "custom";
  /** Codex GUI 初始开发指令引用的计划文档路径 */
  planDoc?: string;
  /** Codex GUI 初始开发指令引用的设计系统目录路径 */
  designSystem?: string;
  /** GUI 类 agent（traework）使用的面板模式（Work/Code/Design）；CLI 类忽略 */
  mode?: TraeworkMode;
  /**
   * ZCode 专用：目标项目未登记时是否允许自动导入。省略视为允许；
   * 显式 false 时驱动层在导入动作之前停止派发（project_not_registered）。
   */
  allowCreateProject?: boolean;
  autoVerify: boolean;
  autoFixRounds: number;
  taskTimeoutMs: number;
  round: number;
  roundsUsed: number;
  errorType?:
    | "timeout"
    | "spawn"
    | "agent_failed"
    | "verify_failed"
    | "cancelled"
    | "interrupted"
    | "agent_unresolved"
    | "internal"
    | null;
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
  /**
   * 结构化「本轮不适用项目验收」的原因。无项目模式（default 工作区）执行成功后置为
   * "no_project"——用结构化字段表达跳过，而不是生成虚假的验收通过报告。
   */
  verificationNotApplicable?: "no_project";
  /** S4：最近一次验收的报告轮次（0-based，reportRound）——区别于 agent roundsUsed */
  reportRound?: number;
  pendingVisualVerification?: boolean;
  /** S4：最近一次验收来源：run_task 自动 / verify_task 手动；不覆盖 agentId */
  verificationSource?: "auto" | "manual";
  /** S4：最近一次手动验收结论（不改变 agent 任务终态时单独记录） */
  latestVerificationVerdict?: "passed" | "failed";
  /** 最近一次 GUI agent 的结构化结束原因 */
  agentEndReason?: string;
  /** 最近一次 GUI agent 结束后是否保留实例 */
  keptInstance?: boolean;
  needsUserKind?:
    | "agent_question"
    | "close_existing_instance"
    | "login_required"
    | "system_permission"
    | "setup_recovery"
    | "user_confirmation";
  pendingQuestion?: string;
  zcodeSessionId?: string;
  zcodeSessionTitle?: string;
  /**
   * Qoder CN 专用会话锚点与实况（**不复用 zcodeSession\***：语义与迁移风险不同——
   * 旧快照里的 zcodeSession\* 是 ZCode 会话，拿它去 Qoder 里定位会话必然失败）。
   * `qoderSessionId` 由 fix-loop 从 AgentRunResult.session 落盘，continue_task/rework 恢复时
   * 用于唯一定位原会话；`qoderTurnId` 预留给按轮定位，当前无写入方。
   */
  qoderSessionId?: string;
  qoderTurnId?: string;
  /** Qoder CN 实际生效的模型 / 等级 / 模型来源（由适配器回读，写入任务报告） */
  actualModel?: string;
  actualReasoningLevel?: string;
  guiStop?: { clicked: boolean; idle: boolean };
  /** Kimi Code 专用会话锚点（同样不复用 zcodeSession\*，理由同上） */
  kimicodeSessionId?: string;
  kimicodeSessionTitle?: string;
  boundProjectPath?: string;
  modelProvider?: string;
  permissionMode?: string;
  lastRunSignal?: string;
  progressSummary?: string;
  /** continue_task 待消费的数据，重启后保留。 */
  continueMessage?: string;
  continueSendMessage?: boolean;
  /** continue_task 待消费：codex user_confirmation 恢复走「重新接入观察」，不发送消息 */
  continueReobserve?: boolean;
}

/** manager 记录任务所需最小信息（内存态），与 TaskMeta 解耦 */
export interface TaskRecord {
  meta: TaskMeta;
  events: TaskEvent[];
}

/** 状态机合法迁移（用于单测 + 断言保护） */
export const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "cancelled", "interrupted"],
  running: [
    "verify_start",
    "fixing",
    "succeeded",
    "failed",
    "needs_attention",
    "needs_user",
    "cancelled",
    "interrupted",
  ],
  verify_start: ["succeeded", "failed", "needs_attention", "fixing", "cancelled", "interrupted"],
  fixing: ["running", "cancelled", "interrupted"],
  succeeded: [],
  failed: [],
  needs_attention: [],
  needs_user: ["queued", "cancelled"],
  cancelled: [],
  interrupted: [],
};

export function isTerminal(s: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

/** 归一化工作区模式：缺字段一律按 project（保守，绝不把旧记录或损坏记录当作无项目）。 */
export function workspaceModeOf(meta: Pick<TaskMeta, "workspaceMode">): WorkspaceMode {
  return meta.workspaceMode === "default" ? "default" : "project";
}

export function isProjectWorkspace(meta: Pick<TaskMeta, "workspaceMode">): boolean {
  return workspaceModeOf(meta) === "project";
}

export function isDefaultWorkspace(meta: Pick<TaskMeta, "workspaceMode">): boolean {
  return workspaceModeOf(meta) === "default";
}
