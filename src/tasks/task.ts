/**
 * Task 类型 / 状态枚举 / 状态机迁移表。
 * 状态机见开发计划 §6：queued → running → … → succeeded/failed/cancelled/interrupted。
 */
import type {
  TraeworkMode,
  ReasoningLevel,
  IdempotencyScope,
  PartialAcceptanceConfig,
} from "../config/schema.js";
import type { VisualReport } from "../visual/types.js";
import type { AgentEventName } from "../agents/agent-events.js";
import type { RepairDirectives } from "../verify/directives.js";

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
  | "gui_residual_acknowledged"
  | "note"
  // 细粒度 agent 事件（issue #18）：与 AGENT_EVENT_NAMES 同源，避免两处词表漂移。
  | AgentEventName;

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
  /**
   * 结构化修复指令（issue #19）：把失败原因解析为「文件 / 行 / 问题 / 动作」。
   * `sources` 非空但 `items` 为空、或 `fallbackReason` 非空时，渲染方必须回退完整报告。
   */
  repairDirectives?: RepairDirectives;
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
   * rework_task 注入的结构化修复提示（issue #19，仅作用于下一轮 agent）。
   * 与 reworkFeedback 同批消费与清空；渲染时置于 feedback 之前。
   */
  reworkHint?: string;
  /**
   * 任务级临时验收配置覆盖（issue #20，三级继承最高优先级）。随任务快照保存 ——
   * 这是**任务数据**而非配置文件：不写入任何 `acceptance*.json`，不影响其他任务或项目；
   * rework/continue 沿用同一任务时继续生效。
   */
  acceptanceOverride?: PartialAcceptanceConfig;
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
  /**
   * 最近一次 abort 得到的 GUI 侧停止结果（`clicked`/`idle`）。
   * 语义为「本次中断实际尝试过什么」：`idle=true` 才是**已确认**界面空闲；
   * 字段缺失表示该 agent 无停止能力或未及尝试——**不得**据此声称已停止（issue #14）。
   */
  guiStop?: { clicked: boolean; idle: boolean };
  /**
   * 本次 interrupted 是否**已确认** GUI 内运行停止（issue #14）。
   * 仅当 `guiStop.idle === true` 时为 true；false/缺失都表示未确认停止，
   * 终态文案必须明示「窗口中的任务可能仍在继续」。
   */
  interruptedCleanStop?: boolean;
  /**
   * GUI 任务的 interrupted 终态尚待人工确认残留（issue #14）。
   * 重启归档（`initialize`）时服务器对 GUI 无任何连接，必然无法确认，故无条件置 true；
   * 由 `cancel_task` 对终态任务做人工确认后清除。
   */
  guiResidualUnconfirmed?: boolean;
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
  /**
   * 调用方提供的幂等键原文（issue #15）。仅落本地任务快照，**不写日志正文**
   * （日志与事件流只用 `keyDigest` 摘要）；供 `query_task` 审计与映射文件损坏时重建。
   */
  idempotencyKey?: string;
  /** 幂等键所属命名空间（issue #15）：run_task / verify_task 各自独立。 */
  idempotencyScope?: IdempotencyScope;
  /** 幂等键对应的入参摘要（issue #15）：重建后仍能识别「同键异参」冲突。 */
  idempotencyDigest?: string;
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

/* ---------------- GUI 停止结果的如实披露（issue #14） ---------------- */

/**
 * 由 profile.displayName 派生「界面窗口称呼」，供终态文案使用。
 * 剥掉括号内的形式说明与「桌面端 / 客户端 / Desktop」等通用后缀——写进文案的是窗口名，
 * 不是 profile 文档里的自我介绍；无 displayName 时回退 agentId。
 * 纯字符串处理，无平台/文件系统依赖。
 * @param displayName profile.displayName（可能缺失）
 * @param agentId 回退用的 agentId
 */
export function guiAppNameOf(displayName: string | undefined, agentId: string): string {
  const raw = (displayName ?? "").trim() || agentId;
  // 只剥"说明性质"的括号段（含 GUI/桌面/客户端/Desktop 等描述词），以及这些通用后缀词本身。
  // 刻意不做无限剥离：像「TraeWork（测试）」这类有实际意义的括号段必须保留；
  // 凡是剥空的都不采纳，退回原名——文案可以长，不能失真。
  const stripped = raw
    .replace(/[（(]([^（()）]*)[)）]/g, (whole: string, inner: string) =>
      /gui|desktop|桌面|客户端|应用|窗口/i.test(inner) ? "" : whole,
    )
    .replace(/\b(desktop|gui)\b/gi, "")
    .replace(/桌面端|桌面版/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–—·]+|[\s\-–—·]+$/g, "")
    .trim();
  return stripped || raw.replace(/\s{2,}/g, " ").trim();
}

/**
 * GUI 停止结果的如实披露（红线 8 的单一实现）。
 * 判定矩阵：`idle === true` → 已确认停止；`idle === false` → 点击过但未确认；
 * `undefined` → 无停止结果（该 agent 无停止能力或未及尝试）——后两者都**不得**声称已停止。
 * @param stop 适配器回报的 guiStop；缺失即无停止结果
 * @param app 界面窗口称呼（见 guiAppNameOf）
 * @returns undefined 表示无需披露（非 GUI agent 调用方自行判断）
 */
export function guiStopDisclosure(
  stop: { clicked: boolean; idle: boolean } | undefined,
  app: string,
): { clean: boolean; text: string } {
  if (stop?.idle === true) {
    return { clean: true, text: `；已确认 ${app} 内运行停止。` };
  }
  if (!stop) {
    return {
      clean: false,
      text: `；${app} 内运行无停止结果可确认，窗口中的任务可能仍在继续，请人工打开 ${app} 确认无残留运行。`,
    };
  }
  return {
    clean: false,
    text: `；${app} 内运行未确认停止，窗口中的任务可能仍在继续，请人工打开 ${app} 确认无残留运行。`,
  };
}
