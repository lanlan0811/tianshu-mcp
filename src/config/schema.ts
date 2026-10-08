/**
 * zod schema 全集：server 配置 / agent profiles / projects / 项目验收配置 / 工具入参校验。
 * 所有外部输入都经这里解析，失败给默认值或明确报错（开发计划 §13）。
 */
import { z } from "zod";
import { VisualConfigSchema } from "../visual/schema.js";

/* ---------------- 工具入参 ---------------- */

const AbsPath = z.string().min(1, "projectPath 不能为空");

/** TraeWork 面板模式（Work=自带 agent 循环；Code=纯编码；Design=设计） */
export const TraeworkModeSchema = z.enum(["Work", "Code", "Design"]);
/** TraeWork 面板模式类型（单一真源，供 adapter/task/ui 共用） */
export type TraeworkMode = z.infer<typeof TraeworkModeSchema>;

/**
 * 思考等级：接受中英双语写法，Codex 内部归一为 low/medium/high。
 * 追加值（各 agent 按自己的档位语义解释，越权档位由 agent 侧显式拒绝）：
 * - `max`：Kimi Code 官方模型（仅 Low/High/Max 三档）
 * - `on` / `off`：Kimi Code 非官方模型（仅两档，默认 on）
 */
export const ReasoningLevelSchema = z.enum([
  "低",
  "中",
  "高",
  "low",
  "medium",
  "high",
  "max",
  "极高",
  "xhigh",
  "最大",
  "关闭思考",
  "on",
  "off",
]);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

/**
 * 幂等键（issue #15）：调用方为「同一次逻辑派单/验收」提供的稳定标识。
 * trim 后 1..128 字符、不允许控制字符；键在 `run_task` 与 `verify_task` 中**各自独立命名空间**。
 * 键明文只落本地任务快照，日志与事件流只用摘要（见 `keyDigest`）。
 */
export const IdempotencyKeySchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(1, "idempotencyKey 不能为空白")
      .max(128, "idempotencyKey 过长（上限 128 字符）")
      .regex(/^[^\u0000-\u001f\u007f]+$/, "idempotencyKey 不允许控制字符"),
  );
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

/** 幂等键命名空间：一次派单与一次验收互不干扰（issue #15）。 */
export const IdempotencyScopeSchema = z.enum(["run_task", "verify_task"]);
export type IdempotencyScope = z.infer<typeof IdempotencyScopeSchema>;

/** 幂等映射默认 TTL（24h）与条目上限（超限逐出最旧）。 */
export const IDEMPOTENCY_TTL_DEFAULT_MS = 24 * 60 * 60_000;
export const IDEMPOTENCY_MAX_ENTRIES_DEFAULT = 2000;

/**
 * 验收命令：**推荐数组形态**（结构化 argv，无歧义）。
 * 字符串形态为兼容保留：经极简分词（不经过 shell），**不支持转义**，引号不闭合
 * 不报错，含空格参数必须手写整段引号，写错会静默拆成多个 argv——详见 docs/acceptance-config.md。
 */
const CheckCmd = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
export const AcceptanceCheckSchema = z.object({
  name: z.string().min(1),
  cmd: CheckCmd,
  timeoutMs: z.number().int().positive().optional(),
  optional: z.boolean().optional(),
});
export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;
export type AcceptanceCheckDef = {
  name: string;
  cmd: string[];
  displayCmd: string;
  timeoutMs?: number;
  optional?: boolean;
};

/**
 * **分层**验收配置（issue #20）：每个字段都可选、**任何字段都不带 `.default()`**。
 *
 * 为什么必须与 `AcceptanceConfigSchema` 分开：`requireChanges` 在后者上有 `.default(true)`。
 * 若用带默认值的 schema 去解析「只写了 verifyConcurrency」的项目文件，会 materialize 出
 * `requireChanges: true`，在三级继承里**反过来把全局层的 `false` 覆盖掉** —— 这正是本次要修的隐患。
 * 分层解析一律用本 schema，默认值只在最终生效值缺省时由消费方兜底。
 */
export const PartialAcceptanceConfigSchema = z.object({
  checks: z.array(AcceptanceCheckSchema).optional(),
  /** 注意：`visual` **不做跨层深合并**，最高优先级的层整段生效（理由见 docs/acceptance-config.md） */
  visual: VisualConfigSchema.optional(),
  requireChanges: z.boolean().optional(),
  verifyConcurrency: z
    .number()
    .transform((n) => (Number.isFinite(n) ? Math.min(4, Math.max(1, Math.round(n))) : 1))
    .optional(),
});
export type PartialAcceptanceConfig = z.infer<typeof PartialAcceptanceConfigSchema>;

/** 单层 accept.json 的对外形态（供 CLI 调试命令与测试使用） */
export type AcceptanceLayerSource = "global" | "project" | "override";

/** 兼容形态：在分层 schema 之上补回 `requireChanges` 的历史默认值（供既有 visual/legacy 调用方） */
export const AcceptanceConfigSchema = PartialAcceptanceConfigSchema.extend({
  requireChanges: z.boolean().default(true),
});
export type AcceptanceConfig = z.infer<typeof AcceptanceConfigSchema>;

/**
 * `acceptanceOverride` 的**线上声明形态**（v0.8.4 schema 瘦身）。
 *
 * 为何不直接用 `PartialAcceptanceConfigSchema`：它的 `visual` 内联了完整的
 * `VisualConfigSchema`（9579 字符），而 MCP 下**每个工具的 inputSchema 独立序列化**、
 * 跨工具无法用 `$ref` 共享——`run_task` 与 `verify_task` 各内联一份，实测使
 * `tools/list` 达 35581 字符（两份 acceptanceOverride 子树合计 24679，占 69.4%）。
 *
 * 本形态只声明**字段骨架**，`visual` 转为不透明对象（字段细节见 docs/acceptance-config.md）。
 * **校验不因此放松**：handler 入口用 `PartialAcceptanceConfigSchema` 严格复核，
 * 非法输入仍 fail-closed（见 `parseAcceptanceOverride`）。
 *
 * 注意 不要在此处引入 `z.discriminatedUnion` / `.refine()`：实测这两者经 SDK 序列化后
 * 线上会退化成 `{"type":"object","properties":{}}`，参数信息全部丢失
 * （`test/protocol` 与 `test/integration/verify-params.test.ts` 有断言守着）。
 */
export const AcceptanceOverrideWireSchema = z.object({
  checks: z.array(AcceptanceCheckSchema).optional(),
  /** 不透明对象：字段细节见 docs/acceptance-config.md；handler 内严格校验 */
  visual: z.record(z.unknown()).optional(),
  requireChanges: z.boolean().optional(),
  verifyConcurrency: z.number().optional(),
});
export type AcceptanceOverrideWire = z.infer<typeof AcceptanceOverrideWireSchema>;

export const RunTaskParamsSchema = z.object({
  /**
   * 项目绝对路径。**省略** = 无项目模式（issue #12）：目前仅 ZCode 支持——任务在其 `default`
   * 工作区执行，不登记/导入项目、不采集 Git 基线、不执行项目验收。
   * 空串 / `null` / 相对路径 / 不存在的目录**不视为**无项目模式，仍按有项目模式拒绝。
   */
  projectPath: AbsPath.optional(),
  task: z.string().min(1, "task 任务书不能为空"),
  agentId: z.string().min(1).optional(),
  /**
   * 目标 agent 使用的模型（GUI 类 agent 如 traework/codex 用；CLI 类 agent 忽略）。
   * 例：GLM-5.3 / DeepSeek-V4-Flash / GPT-5.6 Sol。未传时沿用 agent 侧当前选择。
   */
  model: z.string().min(1).optional(),
  /**
   * GUI 思考等级；由具体适配器核对档位。Qoder CN 支持动态菜单校验。
   * 未传时沿用当前等级。
   */
  reasoningLevel: ReasoningLevelSchema.optional(),
  /** Qoder CN model group; omitted means unique exact match across groups. */
  modelSource: z.enum(["default", "custom"]).optional(),
  /**
   * TraeWork 面板模式（仅 GUI 类 agent traework 生效）。
   * 未传时从任务书文本识别「切换 Work/Code/Design 模式」，仍识别不到则保持 Work。
   * 项目文件夹绑定固定发生在 Work 模式，随后再切到目标模式。
   */
  mode: TraeworkModeSchema.optional(),
  /**
   * 计划文档路径（Codex / Qoder CN）：相对项目根或绝对路径，Qoder CN 必填。
   * 会被拼进初始开发指令「根据计划文档(<planDoc>)…」。
   */
  planDoc: z.string().min(1).optional(),
  /**
   * 设计系统目录路径（仅 codex GUI 生效）：相对项目根或绝对路径，
   * 会被拼进初始开发指令「…和设计系统(<designSystem>)…」。
   *
   * Open Design：此处传**设计系统名**（如 `Claude` / `Claude (Anthropic)`），
   * 由适配器在「设计系统」面板里搜索并点选——语义相同（指定设计系统），形态不同（名字 vs 目录）。
   */
  designSystem: z.string().min(1).optional(),
  /**
   * 设计方向（仅 opendesign-gui 生效）：只支持「原型 / 文档 / 网站复刻」
   * （prototype / document / clone 亦可）。其他 UI 方向（幻灯片/图片/HyperFrames）显式拒绝。
   *
   * 刻意**不复用** `mode`：`mode` 是 TraeWork 的 Work/Code/Design 面板模式，
   * 两者混在一个枚举里会让 TraeWork 的模式识别（detectModeFromText）分支失真。
   */
  designDirection: z.string().min(1).optional(),
  /**
   * 上下文窗口（仅 minimax-gui 生效）：界面候选实测为 `512K` / `1M`（数值换算而来：
   * `e/1e6 → nM`、`e/1e3 → nK`）。其他 agent 显式传入即报错。
   *
   * 刻意用宽松的 string 而不是枚举：候选值随模型变化（不同模型档位集合不同），
   * 硬编码枚举会把合法值拒之门外。合法性由**界面实际渲染的候选**在发送前校验（fail-closed）。
   */
  contextWindow: z.string().min(1).optional(),
  autoVerify: z.boolean().optional(),
  autoFixRounds: z.number().int().min(0).max(10).optional(),
  /**
   * 仅 ZCode 生效：目标目录未在 ZCode 项目列表中登记时，是否允许自动导入（添加项目）。
   * 省略 = 允许（保持既有自动导入行为）；false = 停止派发并返回 project_not_registered，
   * 不打开原生文件夹对话框、不添加项目。其他 agent 显式传入即报错。
   */
  allowCreateProject: z.boolean().optional(),
  context: z.string().optional(),
  taskTimeoutMs: z.number().int().positive().optional(),
  /**
   * 幂等键（issue #15）：TTL（默认 24h）内重复提交同一键**恒返回原 taskId 与当前 meta**，
   * 不新建任务；同一键携带不同参数会被 fail-closed 拒绝。不传 = 保持既有行为。
   */
  idempotencyKey: IdempotencyKeySchema.optional(),
  /**
   * 任务级临时验收配置覆盖（issue #20）：三级继承的最高优先级，**仅当次任务生效**。
   * 会随任务快照保存（属任务数据，不是配置文件），rework/continue 沿用同一任务时继续生效，
   * 不影响其他任务或项目。不传则完全沿用全局/项目层配置。
   */
  acceptanceOverride: PartialAcceptanceConfigSchema.optional(),
  /**
   * 干跑模式（issue #21）：agent **只分析、只规划**，输出将要修改的文件清单与方案，
   * 不动源码；验收引擎只做静态分析（引用文件是否存在、拟改位置是否存在、明显逻辑冲突），
   * 跳过 typecheck/test/build 等需要实际改动的检查。
   *
   * 默认关闭（缺省 = 与既有行为完全一致）。**需要 projectPath**：无项目模式没有可静态分析的基线。
   * dryRun 下忽略 `autoVerify`、不进入自动返修。
   */
  dryRun: z.boolean().optional(),
});
export type RunTaskParams = z.infer<typeof RunTaskParamsSchema>;

/**
 * `run_task` 的**线上声明形态**（v0.8.4 schema 瘦身）：与 {@link RunTaskParamsSchema}
 * 逐字段同构，仅把 `acceptanceOverride` 换成骨架形态以减少 `tools/list` 体积。
 * 两者靠类型断言锁定同构（见文件末尾的 `_RunTaskWireMatchesParams`）。
 */
export const RunTaskWireSchema = RunTaskParamsSchema.extend({
  acceptanceOverride: AcceptanceOverrideWireSchema.optional(),
});

/** query_task 返回的细粒度事件条数默认值（issue #18） */
export const QUERY_TASK_EVENT_LIMIT_DEFAULT = 10;

export const QueryTaskParamsSchema = z.object({
  taskId: z.string().min(1),
  tailLines: z.number().int().positive().optional(),
  /**
   * 返回最近 N 条细粒度 agent 事件（issue #18）：task_dispatched /
   * confirmation_dialog_detected / awaiting_user_authorization / file_modification_started /
   * rework_triggered。缺省 10，上限 50。未实现事件上报的适配器返回空数组。
   */
  eventLimit: z.number().int().min(1).max(50).optional(),
});
export type QueryTaskParams = z.infer<typeof QueryTaskParamsSchema>;

export const ListTasksParamsSchema = z.object({
  projectPath: AbsPath.optional(),
  status: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export type ListTasksParams = z.infer<typeof ListTasksParamsSchema>;

export const GetReportParamsSchema = z.object({
  taskId: z.string().min(1),
  /** 0-based 报告轮次；缺省返回最新报告 */
  round: z.number().int().min(0).optional(),
});
export type GetReportParams = z.infer<typeof GetReportParamsSchema>;

export const CancelTaskParamsSchema = z.object({
  taskId: z.string().min(1),
  reason: z.string().optional(),
});
export type CancelTaskParams = z.infer<typeof CancelTaskParamsSchema>;

export const VerifyTaskParamsSchema = z.object({
  taskId: z.string().optional(),
  projectPath: AbsPath.optional(),
  /** 临时追加的验收命令（追加到项目/默认集之后，不替换）。见 checksMode */
  extraChecks: z.array(AcceptanceCheckSchema).optional(),
  /** append（默认）= 项目/默认检查 + extraChecks；replace = 只用 extraChecks */
  checksMode: z.enum(["append", "replace"]).optional(),
  /**
   * 基线引用：任务 ID（用该任务动工前基线）或 Git ref（如 HEAD~1 / <sha>）。
   * 独立 projectPath 验收缺省不设 = 采集当前基线，仅做项目当前健康检查。
   */
  baselineRef: z.string().min(1).optional(),
  /**
   * 幂等键（issue #15）：重复提交同一键不重跑验收——执行中返回进行中提示，
   * 已完成直接返回已有报告与轮次；同一键携带不同参数会被 fail-closed 拒绝。
   */
  idempotencyKey: IdempotencyKeySchema.optional(),
  /** 任务级临时验收配置覆盖（issue #20）：三级继承的最高优先级，仅本次验收生效。 */
  acceptanceOverride: PartialAcceptanceConfigSchema.optional(),
});
export type VerifyTaskParams = z.infer<typeof VerifyTaskParamsSchema>;

/** `verify_task` 的**线上声明形态**（v0.8.4 schema 瘦身）：语义同 {@link RunTaskWireSchema}。 */
export const VerifyTaskWireSchema = VerifyTaskParamsSchema.extend({
  acceptanceOverride: AcceptanceOverrideWireSchema.optional(),
});

export const ReworkTaskParamsSchema = z.object({
  taskId: z.string().min(1),
  feedback: z.string().optional(),
  /**
   * 结构化修复提示（issue #19）：调用方自带的一小段「文件 / 行 / 做什么」，会以
   * 【结构化修复提示】块置于 feedback 之前，便于 agent 先精确定位再读整段说明。
   * 自由字符串（上限 4000 字符）；不传则行为与既有版本一致。
   */
  repairHint: z.string().max(4000).optional(),
});
export type ReworkTaskParams = z.infer<typeof ReworkTaskParamsSchema>;

export const ContinueTaskParamsSchema = z.object({
  taskId: z.string().min(1),
  message: z.string().min(1, "message 不能为空"),
});
export type ContinueTaskParams = z.infer<typeof ContinueTaskParamsSchema>;

/* ---------------- 等待原语（issue #28） ---------------- */

/**
 * `wait_task` 单次等待的**默认**上限（ms）。
 * 刻意低于生态常见的 60s 客户端单次工具超时，留出序列化 / 网络往返余量：
 * 若客户端超时比 50s 更短，截断也只让调用方多调一次（等待无损），不会出错。
 * 真机校准（计划 Wave 5）后如需按客户端调整，只改这一处常量。
 */
export const WAIT_TASK_TIMEOUT_DEFAULT_MS = 50_000;

/**
 * 单次 wait 调用可请求的等待**上限**（ms，10 分钟）：给「无超时或已知长超时」的调用方。
 * 显式传入超过本值的值会被钳制到本值并**如实披露**（不静默改值）；更长场景靠循环调用。
 */
export const WAIT_TASK_TIMEOUT_MAX_MS = 600_000;

/** `wait_any` 一次可等待的任务数上限。 */
export const WAIT_ANY_TASK_IDS_MAX = 20;

export const WaitTaskParamsSchema = z.object({
  taskId: z.string().min(1),
  /** 本次等待上限（ms）；缺省 {@link WAIT_TASK_TIMEOUT_DEFAULT_MS}，超 {@link WAIT_TASK_TIMEOUT_MAX_MS} 被钳制。 */
  timeoutMs: z.number().int().positive().optional(),
});
export type WaitTaskParams = z.infer<typeof WaitTaskParamsSchema>;

export const WaitAnyParamsSchema = z.object({
  /** 一组任务 id（1..{@link WAIT_ANY_TASK_IDS_MAX}）；开始前校验全部存在，缺一即报错。 */
  taskIds: z.array(z.string().min(1)).min(1).max(WAIT_ANY_TASK_IDS_MAX),
  /** 本次等待上限（ms）；语义同 {@link WaitTaskParamsSchema} 的 timeoutMs。 */
  timeoutMs: z.number().int().positive().optional(),
});
export type WaitAnyParams = z.infer<typeof WaitAnyParamsSchema>;

/**
 * 钳制等待上限：缺省用默认值；显式值超过上限时钳到上限并标记 `clamped`，由 handler
 * 在响应正文里**如实披露**（计划 §2.3 缓解 1：不静默改值）。
 * `timeoutMs` 的正整数约束由 schema 承担，此处只处理缺省与上限。
 */
export function clampWaitTimeout(timeoutMs?: number): { timeoutMs: number; clamped: boolean } {
  if (timeoutMs === undefined) {
    return { timeoutMs: WAIT_TASK_TIMEOUT_DEFAULT_MS, clamped: false };
  }
  if (timeoutMs > WAIT_TASK_TIMEOUT_MAX_MS) {
    return { timeoutMs: WAIT_TASK_TIMEOUT_MAX_MS, clamped: true };
  }
  return { timeoutMs, clamped: false };
}

/* ---------------- server 配置 config.json ---------------- */

/**
 * webhook 通知可订阅的事件类别（按任务**状态语义**归类，而非原始 status 字符串）。
 *
 * `needs_human` 与 `needs_user` 刻意分开：前者对应 `needs_attention`（**真终态**，等人工裁决后
 * 任务就结束了），后者对应 `needs_user`（**非终态** —— 它可被 `continue_task` 恢复到 `queued`，
 * 之后可能**再次**进入 `needs_user`）。混为一类会让「默认只推真终态」这条约定失效。
 */
export const NotificationEventSchema = z.enum([
  "done",
  "failed",
  "needs_human",
  "needs_user",
  "cancelled",
]);
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;

/**
 * 默认订阅集：**只含真终态**。
 * `needs_user` 不是终态，默认关闭；需要它的调用方显式加进 `events`（已知会反复推送）。
 * `cancelled` 同样默认关闭（多数场景无需被取消任务打扰）。
 */
export const NOTIFICATION_EVENTS_DEFAULT: NotificationEvent[] = ["done", "failed", "needs_human"];

export const WebhookConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    url: z.string().url().optional(),
    /** 单次请求超时（不阻塞状态机 —— 发送全程异步） */
    timeoutMs: z.number().int().positive().default(5_000),
    /** 失败重试次数上限（0 = 不重试）；总尝试次数 = 1 + maxRetries */
    maxRetries: z.number().int().min(0).max(5).default(2),
    /** 重试退避基数：第 n 次重试前等待 backoffMs × n（0 = 不退避） */
    backoffMs: z.number().int().min(0).default(500),
    /** 配置后对请求体做 HMAC-SHA256 签名，附 `X-Tianshu-Signature: sha256=<hex>` */
    secret: z.string().optional(),
    events: z.array(NotificationEventSchema).default(NOTIFICATION_EVENTS_DEFAULT),
  })
  .refine((v) => !v.enabled || (v.url !== undefined && v.url.length > 0), {
    message: "notifications.webhook.enabled=true 时必须提供 url",
    path: ["url"],
  });
export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;

export const ServerConfigSchema = z.object({
  concurrency: z
    .object({
      maxRunning: z.number().int().min(1).max(32).default(2),
    })
    .default({}),
  defaultTaskTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60_000),
  verifyCommandTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  /**
   * 验收命令检查并行度（worker 池上限）：1=串行（与历史行为一致），默认 2，上限 4。
   * 项目级 .tianshu-mcp/acceptance.json 的 verifyConcurrency 可覆盖。
   */
  verifyConcurrency: z.number().int().min(1).max(4).default(2),
  /**
   * 技能自检安装（issue #16 加固）。
   * `autoInstall`：
   * - `true`（默认）：包内技能与目标不一致且可证目标未被改动时，自动备份并覆盖为新版；
   * - `"prompt"`：首次安装照常，**需变更时**不自动覆盖，只告警并在清单记 `pendingUpdate`，
   *   待用户带 `--approve-skill-update` 重启放行（stdio server 无同步交互通道）；
   * - `false`：完全不自动安装。
   * `backupKeep`：覆盖后保留的历史 `.bak-<时间戳>` 个数，`0` = 不清理（默认 3）。
   */
  skills: z
    .object({
      autoInstall: z.union([z.boolean(), z.literal("prompt")]).default(true),
      backupKeep: z.number().int().min(0).max(50).default(3),
    })
    .default({}),
  /**
   * server 关闭路径的预算（issue #14）。
   * `guiStopWaitMs`：`shutdownInterrupt()` 对 GUI agent 任务"尽力点击界面停止 + 有界等待空闲"
   * 的**全局**等待上限（全部 GUI 任务共享一份预算，避免多任务串行拖长退出），到期仍无法确认时
   * 终态如实写「未确认停止」。与 `gui.cancelWaitMs`（cancel_task 路径）解耦：cancel 由调用方
   * 主动等待，shutdown 受进程退出时限约束，因此默认值单独可调。
   */
  shutdown: z
    .object({
      guiStopWaitMs: z.number().int().positive().default(15_000),
    })
    .default({}),
  /**
   * 幂等键映射（issue #15）。
   * `ttlMs`：`<数据目录>/idempotency.json` 里键→taskId 记录的有效期，到期即视为未命中并清除；
   * `maxEntries`：条目上限，超限按 `createdAt` 逐出最旧（防映射文件无限增长）。
   */
  idempotency: z
    .object({
      ttlMs: z.number().int().positive().default(IDEMPOTENCY_TTL_DEFAULT_MS),
      maxEntries: z.number().int().min(1).max(100_000).default(IDEMPOTENCY_MAX_ENTRIES_DEFAULT),
    })
    .default({}),
  /**
   * 任务状态跃迁的通知钩子（issue #22）。
   *
   * 放在**全局** `config.json` 而非项目 `acceptance.json`：通知路由是宿主/传输层关注点，
   * 不是项目验收策略；一个端点通常按 `taskId` 自行分流即可。且状态跃迁的咽喉
   * （`TaskStore.updateStatus`）只有 `home` / `taskId` / `logger`，无法在每次跃迁时廉价读项目配置。
   *
   * **默认关闭**：不配置或 `enabled:false` 时**完全不发起任何请求**。
   */
  notifications: z
    .object({
      webhook: WebhookConfigSchema.optional(),
    })
    .default({}),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/* ---------------- agent-profiles.json ---------------- */

export const ExecutableDiscoverySchema = z.object({
  /**
   * 候选根目录。支持 {LOCALAPPDATA} {APPDATA} {HOME} {USERPROFILE} {PROGRAMFILES} 占位符与
   * 平台相对路径；留空时由实现按平台注入标准候选（如 Windows 的 LOCALAPPDATA、macOS 的 ~/Applications）。
   */
  dirs: z.array(z.string()).default([]),
  fileNames: z.array(z.string()).default([]),
  /** PATH 中查找的回退命令名 */
  fallbackCommand: z.string().optional(),
  /** Windows 固定盘搜索顺序；仅盘符偏好，不是安装绝对路径。 */
  preferredDrives: z.array(z.string().regex(/^[A-Za-z]:$/)).default([]),
  /** 相对固定盘根目录的候选可执行路径。 */
  relativePaths: z.array(z.string()).default([]),
  /** MSIX 应用包名（如 OpenAI.Codex）；用于 Get-AppxPackage 优先查询。 */
  appxPackageName: z.string().optional(),
  /** 包安装目录内、相对可执行路径（如 app/ChatGPT.exe）。 */
  installRelativeExe: z.array(z.string()).default([]),
  /** MSIX 回退扫盘的根目录（支持 {SYSTEMDRIVE} 等占位符）。 */
  scanRoots: z.array(z.string()).default([]),
  /** 扫盘时目录名匹配模式（glob，`*` 通配），如 OpenAI.Codex_*_x64__<pfn>/app/ChatGPT.exe。 */
  scanPattern: z.string().optional(),
});

/**
 * GUI 驱动配置（driver="gui" 的 agent 使用，如 traework）。
 * 所有字段均可由数据目录 agent-profiles.json 覆盖，代码只给默认值与探测规则。
 */
export const ZCODE_SETUP_DEFAULTS = {
  setupRecoveryTimeoutMs: 120_000,
  dialogProbeTimeoutMs: 30_000,
  dialogOperationTimeoutMs: 60_000,
  setupRecoveryMaxRetries: 2,
  /** 等待并确认 ZCode 项目触发器就绪的上限（含点击后确认项目菜单打开的预算）。 */
  projectTriggerTimeoutMs: 15_000,
  /**
   * 等待并确认「工作区触发器（Kimi Code 的 button.ws-chip）挂载」的上限。
   * 与 projectTriggerTimeoutMs 同构但预算独立：Kimi Code 的草稿页建立判据就是 ws-chip 挂载，
   * 点击返回 true 并不等于已切页（ZCode M22 教训），所以必须按「触发器出现」判定。
   */
  workspaceTriggerTimeoutMs: 15_000,
} as const;

export const GuiProfileSchema = z.object({
  setupRecoveryTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(ZCODE_SETUP_DEFAULTS.setupRecoveryTimeoutMs),
  /**
   * 等待 ZCode 项目触发器挂载并就绪的上限（ms）；点击后确认项目菜单打开的窗口也取自这里。
   * 整个「等待 → 回退一次 → 再等待」共享一个截止时间，重试不重置预算。
   */
  projectTriggerTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(ZCODE_SETUP_DEFAULTS.projectTriggerTimeoutMs),
  /**
   * 等待「工作区触发器」挂载并就绪的上限（ms）。Kimi Code 用它判定草稿页是否真的建立
   * （button.ws-chip 是否挂载），ZCode 不使用该字段。
   *
   * 刻意用 `.optional()` 而不是 `.default()`：`.default()` 会让该键在 GuiProfile 的输出类型里
   * 变成必填，迫使既有 ZCode/TraeWork profile 的对象字面量一起改（它们用显式字面量而非展开）。
   * 默认值由 ZCODE_SETUP_DEFAULTS.workspaceTriggerTimeoutMs 在读取点提供，语义等价且不改既有键。
   */
  workspaceTriggerTimeoutMs: z.number().int().positive().optional(),
  dialogProbeTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(ZCODE_SETUP_DEFAULTS.dialogProbeTimeoutMs),
  dialogOperationTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(ZCODE_SETUP_DEFAULTS.dialogOperationTimeoutMs),
  setupRecoveryMaxRetries: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(ZCODE_SETUP_DEFAULTS.setupRecoveryMaxRetries),
  /** CDP 调试端口（--remote-debugging-port） */
  cdpPort: z.number().int().positive().default(9222),
  /** 端口被占用时自动向后避让，直到找到可用端口 */
  cdpPortAuto: z.boolean().default(true),
  /** 自动避让时最多尝试的端口数 */
  cdpPortRange: z.number().int().positive().max(200).default(20),
  /** 可执行文件绝对路径；缺省用 executableDiscovery 探测 */
  exePath: z.string().optional(),
  /** 启动参数模板，<port> 会被替换为实际端口 */
  exeArgs: z.array(z.string()).default(["--remote-debugging-port=<port>"]),
  /** 已有可用实例时复用，否则启动新实例 */
  windowMode: z.enum(["reuse", "launch"]).default("reuse"),
  /** 等待 CDP 就绪的超时（ms） */
  launchTimeoutMs: z.number().int().positive().default(60_000),
  /** 回复 DOM 轮询间隔（ms） */
  pollIntervalMs: z.number().int().positive().default(3_000),
  /** 无完成标志时，连续多少次轮询无变化后开始计算空闲时长 */
  stableRounds: z.number().int().positive().default(12),
  /** 静态且无运行信号持续多久后判定空闲结束（ms） */
  idleTimeoutMs: z
    .number()
    .int()
    .nonnegative()
    .default(10 * 60_000),
  /**
   * 停止按钮可见且对话文本无变化持续此时长 → 判定 agent 在等待用户
   * （needs_user/user_confirmation），打破"停止按钮恒可见 → 恒报 running"死锁。
   * 长命令型任务（大依赖安装/构建）建议调大，避免把合法静默误判为等待用户。
   */
  stallTimeoutMs: z.number().int().positive().default(300_000),
  /** 取消任务时点击 GUI 停止按钮后等待界面真正空闲的上限（ms） */
  cancelWaitMs: z.number().int().positive().default(15_000),
  /** 单次 CDP 命令等待响应的超时（ms） */
  cdpSendTimeoutMs: z.number().int().positive().default(15_000),
  /** 轮询期间向任务事件流报告进度的间隔（ms） */
  progressIntervalMs: z.number().int().positive().default(30_000),
  /** 是否按任务指定的 model 切换模型 */
  modelSwitch: z.boolean().default(true),
  /** 是否按任务指定的 mode 切换面板模式（Work/Code/Design） */
  modeSwitch: z.boolean().default(true),
  /** 每任务是否新建会话（点「新建任务」） */
  freshSession: z.boolean().default(true),
  /** 选择器覆盖（语义键 → 选择器），用于 UI 升级漂移时热修复 */
  selectors: z.record(z.string(), z.string()).default({}),
  /** ZCode 必须显式传入 provider/model。 */
  modelRequired: z.boolean().default(false),
  /** GUI agent 发送前必须确认的权限模式。 */
  defaultPermissionMode: z.string().optional(),
  /** agent 级自动返修默认轮数。 */
  defaultAutoFixRounds: z.number().int().min(0).max(10).optional(),
  /**
   * GUI 启动通道：spawn=直接以子进程启动 exe（ZCode/TraeWork）；
   * msix-com=Windows MSIX 应用经 IApplicationActivationManager COM 激活（Codex 桌面端）。
   */
  activation: z.enum(["spawn", "msix-com"]).default("spawn"),
  /**
   * MSIX 应用的专属 user-data-dir（activation=msix-com 时必需）。
   * 必须独立于用户手动打开的实例，否则单实例锁会导致调试端口无法开启。
   * 支持 {LOCALAPPDATA} {APPDATA} {HOME} {USERPROFILE} 等占位符。
   */
  userDataDir: z.string().optional(),
  /** MSIX 应用包名（activation=msix-com 时用于 Get-AppxPackage 查询）。 */
  appxPackageName: z.string().optional(),
  /** 发送前必须确认的权限模式（如「完全访问」）。未配置则不强制。 */
  permissionMode: z.string().optional(),
  /** 修复计划文档输出目录（相对项目根），默认 .zcode/plans/。 */
  fixPlanDir: z.string().optional(),
});
export type GuiProfile = z.infer<typeof GuiProfileSchema>;

/**
 * Open Design 专属配置（`adapter="opendesign-gui"`）。
 *
 * 为什么单独一段而不是塞进 GuiProfileSchema：这些键只有 Open Design 语义能解释
 * （步骤预算、模型回读、工作目录回读、版本门禁），塞进公共 GuiProfile 会让其他
 * adapter 的 profile 字面量多出一堆与它无关的必填/默认键。
 *
 * 除 `supportedVersions` 外**全部可选且不带 `.default()`**：默认值由读取点兜底，
 * 避免「只写了一个键」的 profile 被 materialize 出一堆默认值。
 */
export const OpenDesignProfileSchema = z.object({
  /**
   * 已真机验证的产品版本（平台 → 版本列表），如 `{ win32: ["0.24.1"] }`。
   * 探测到的版本不在列表内时**拒绝派发**（fail-closed），并由错误信息回显实测版本。
   * 空对象/缺省 = 不做版本门禁。
   */
  supportedVersions: z.record(z.string(), z.array(z.string())).default({}),
  /** 等待「工作目录」面板展开并确认「选择目录」项的预算（ms） */
  workingDirPanelTimeoutMs: z.number().int().positive().optional(),
  /** 等待原生「选择文件夹」对话框出现的预算（ms） */
  nativeDialogTimeoutMs: z.number().int().positive().optional(),
  /** 等待模型菜单展开并回读触发区的预算（ms） */
  modelMenuTimeoutMs: z.number().int().positive().optional(),
  /** 等待设计系统面板展开并回读触发区的预算（ms） */
  designSystemTimeoutMs: z.number().int().positive().optional(),
  /** 等待设计方向菜单展开并回读触发区的预算（ms） */
  designDirectionTimeoutMs: z.number().int().positive().optional(),
  /** 等待发送按钮由「不可用」变可用的预算（ms） */
  sendReadyTimeoutMs: z.number().int().positive().optional(),
  /** 修复/优化计划文档输出目录（相对项目根），默认 `.opendesign/plans` */
  planDir: z.string().optional(),
  /**
   * 设计方向 → UI 菜单项显示名映射（可覆盖，应对 UI 文案漂移）。
   * 键为内部值 `prototype|document|clone`，值为该语言界面上的菜单文本。
   */
  directionLabels: z.record(z.string(), z.string()).default({}),
});
export type OpenDesignProfile = z.infer<typeof OpenDesignProfileSchema>;

/** OpenDesign 预算默认值（读取点兜底，profile 可覆盖） */
export const OPEN_DESIGN_DEFAULTS = {
  workingDirPanelTimeoutMs: 15_000,
  nativeDialogTimeoutMs: 20_000,
  modelMenuTimeoutMs: 15_000,
  designSystemTimeoutMs: 15_000,
  designDirectionTimeoutMs: 15_000,
  sendReadyTimeoutMs: 20_000,
  planDir: ".opendesign/plans",
  /** 枚举受管实例当前拥有的 #32770 窗口（残留对话框探测）的超时 */
  dialogProbeTimeoutMs: 30_000,
  /** 原生「选择文件夹」对话框「填路径 → 回读校验 → 确认 → 等关闭」的总预算 */
  dialogOperationTimeoutMs: 60_000,
} as const;

/**
 * MiniMax Code 专属配置（`adapter="minimax-gui"`）。
 *
 * 真机取证（2026-10-05，MiniMax Code 3.1.0）：模型弹层渲染在独立的 `Model menu` 窗口；
 * 推理等级与上下文窗口**不是平铺项**，而是悬停某个模型项后展开的**二级子菜单**
 * （`aria-haspopup="menu"` → `aria-expanded="true"`）。
 */
export const MinimaxProfileSchema = z.object({
  /**
   * 悬停模型项后等待二级子菜单展开的预算（ms）。
   *
   * 真机实测展开是**异步**的：hover 后需数百毫秒子菜单才渲染出 `role="group"`；
   * 预算不足会读到空档位集合，进而把合法档位误判成「界面不支持」。
   */
  submenuOpenTimeoutMs: z.number().int().positive().optional(),
  /** 等待模型菜单窗口（`Model menu`）出现的预算（ms） */
  modelMenuTimeoutMs: z.number().int().positive().optional(),
  /** 等待发送按钮由「不可用」变可用的预算（ms） */
  sendReadyTimeoutMs: z.number().int().positive().optional(),
  /**
   * 推理等级 token → UI 显示名映射（可覆盖，应对 UI 文案漂移）。
   * 键为内部值（default/low/medium/high/xhigh/max），值为界面上的档位文本。
   */
  levelLabels: z.record(z.string(), z.string()).default({}),
  /** 修复/优化计划文档输出目录（相对项目根），默认 `.minimax/plans` */
  planDir: z.string().optional(),
});
export type MinimaxProfile = z.infer<typeof MinimaxProfileSchema>;

/** MiniMax Code 预算默认值（读取点兜底，profile 可覆盖） */
export const MINIMAX_DEFAULTS = {
  submenuOpenTimeoutMs: 8_000,
  modelMenuTimeoutMs: 10_000,
  sendReadyTimeoutMs: 20_000,
  planDir: ".minimax/plans",
  /** 枚举受管实例当前拥有的 #32770 窗口（残留对话框探测）的超时 */
  dialogProbeTimeoutMs: 30_000,
  /** 原生「选择文件夹」对话框「填路径 → 回读校验 → 确认 → 等关闭」的总预算 */
  dialogOperationTimeoutMs: 60_000,
} as const;

export const AgentProfileSchema = z.object({
  id: z.string().min(1).optional(), // 仅内置 profiles 使用；数据目录 profiles 以键名为准
  displayName: z.string().default(""),
  type: z.enum(["cli"]).default("cli"),
  /**
   * 执行面：spawn=外部 CLI 子进程（默认）；gui=桌面 UI 自动化（CDP）。
   * 决定 registry 构造哪个 adapter、orchestrator 走哪条执行路径。
   */
  driver: z.enum(["spawn", "gui"]).default("spawn"),
  /** GUI adapter 显式判别；旧 profile 缺省时保持 TraeWork 兼容行为。 */
  adapter: z
    .enum([
      "traework-gui",
      "zcode-gui",
      "codex-gui",
      "kimicode-gui",
      "qoder-gui",
      "opendesign-gui",
      "minimax-gui",
    ])
    .optional(),
  status: z.enum(["ready", "research", "unsupported"]).default("ready"),
  command: z.string().nullable().optional(),
  argsTemplate: z.array(z.string()).default([]),
  promptMode: z.enum(["arg", "stdin", "file"]).default("arg"),
  cwd: z.enum(["task", "home"]).default("task"),
  env: z.record(z.string(), z.string()).default({}),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60_000),
  killTree: z.enum(["taskkill", "group"]).default("taskkill"),
  authNote: z.string().default(""),
  executableDiscovery: ExecutableDiscoverySchema.optional(),
  gui: GuiProfileSchema.optional(),
  /** Open Design 专属配置（adapter="opendesign-gui" 时使用） */
  opendesign: OpenDesignProfileSchema.optional(),
  /** MiniMax Code 专属配置（adapter="minimax-gui" 时使用） */
  minimax: MinimaxProfileSchema.optional(),
  note: z.string().optional(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const AgentProfilesFileSchema = z.object({
  profiles: z.record(z.string(), AgentProfileSchema).default({}),
});

/* ---------------- projects.json ---------------- */

export const ProjectRecordSchema = z.object({
  path: z.string(),
  displayPath: z.string().optional(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  verify: z.array(AcceptanceCheckSchema).optional(), // 管理员补录的验收配置（可选）
  defaultAgentId: z.string().optional(),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

/** projects.json 整体文件 schema（S5：不再用对象强制类型转换） */
export const ProjectsFileSchema = z.record(z.string().min(1), ProjectRecordSchema);
export type ProjectsFile = z.infer<typeof ProjectsFileSchema>;

/* 项目内 .tianshu-mcp/acceptance.json 的 schema 定义见文件上方（须早于 RunTaskParamsSchema，
   因为 run_task/verify_task 的 acceptanceOverride 参数引用它）。 */

/* ---------------- 线上 schema 同构锁定（v0.8.4） ---------------- */

/**
 * 编译期锁定：线上 wire schema 与严格 schema 的**字段集必须完全同构**，
 * 唯一允许的差异是 `acceptanceOverride` 的形态（严格 → 骨架）。
 *
 * 为什么用 `Equals<>` 而不是条件类型别名：条件类型落到 `never` 时 TypeScript **不报错**，
 * 那样的"锁"是假的。v0.8.4 实施时对假锁做过反证（注入多余字段后 typecheck 仍通过），
 * 才改成下面这种**会真的报错**的写法——`Equals<A,B>` 不等时为 `false`，
 * 赋给 `: true` 立即触发 TS2322。
 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

// 1) 非 acceptanceOverride 字段：双向等价（多一个/少一个/改类型都会红）
type RunTaskWireFields = Omit<z.infer<typeof RunTaskWireSchema>, "acceptanceOverride">;
type RunTaskStrictFields = Omit<RunTaskParams, "acceptanceOverride">;
type VerifyTaskWireFields = Omit<z.infer<typeof VerifyTaskWireSchema>, "acceptanceOverride">;
type VerifyTaskStrictFields = Omit<VerifyTaskParams, "acceptanceOverride">;

/**
 * 锁具：`false` 会让整个类型别名非法，而**在类型位置引用它**（见下方
 * `WireSchemaParityLock`）即触发真实编译错误——反证已验证（注入多余字段 → TS2322）。
 * 用类型别名而非 `const`，避免产生运行期无用变量（lint 会拦）。
 */
type Assert<T extends true> = T;

type RunTaskFieldParity = Assert<Equals<RunTaskWireFields, RunTaskStrictFields>>;
type VerifyTaskFieldParity = Assert<Equals<VerifyTaskWireFields, VerifyTaskStrictFields>>;

// 2) 骨架形态的字段集必须**恰好**是这 4 个（加字段意味着线上体积回升，须显式改这里）
type WireOverrideKeys = keyof AcceptanceOverrideWire;
type OverrideKeysExact = Assert<
  Equals<WireOverrideKeys, "checks" | "visual" | "requireChanges" | "verifyConcurrency">
>;

export type WireSchemaParityLock = [
  RunTaskFieldParity,
  VerifyTaskFieldParity,
  OverrideKeysExact,
];

/* ---------------- 工具合并 schema（v0.9.0，13 → 8） ---------------- */

/**
 * `manage_task` —— 合并 `cancel_task` + `continue_task` + `rework_task`。
 *
 * **为什么是 plain `z.object` 而非 `discriminatedUnion`**：实测 `z.discriminatedUnion`
 * 经 SDK 序列化后线上退化为 `{"type":"object","properties":{}}`，参数信息全部丢失
 * （详见文件上方 `AcceptanceOverrideWireSchema` 的说明）。因此分支约束只能下沉到 handler：
 * - `action=continue` 要求 `message` 非空（原 `continue_task` 的 `z.string().min(1)`）
 * - `action` 之外的字段按分支做白名单，多余字段 fail-closed
 */
export const ManageTaskParamsSchema = z.object({
  taskId: z.string().min(1),
  action: z.enum(["cancel", "continue", "rework"]),
  /** `action=cancel`：取消原因（原 `cancel_task.reason`）。 */
  reason: z.string().optional(),
  /** `action=continue`：发给原会话的消息；**在 handler 内要求非空**（原为 schema 层必填）。 */
  message: z.string().optional(),
  /** `action=rework`：追加指示（原 `rework_task.feedback`）。 */
  feedback: z.string().optional(),
  /** `action=rework`：结构化修复提示，上限 4000 字符（原 `rework_task.repairHint`）。 */
  repairHint: z.string().max(4000).optional(),
});
export type ManageTaskParams = z.infer<typeof ManageTaskParamsSchema>;

/**
 * `query_info` —— 合并 `list_tasks` + `get_task_report` + `get_profiles`。
 *
 * 分支约束同样下沉 handler：
 * - `type=report` 要求 `taskId` 非空
 * - `type` 之外的字段按分支白名单
 *
 * 注意 `status` **保持自由字符串**（原 `list_tasks.status` 就是 `z.string().optional()`，
 * 收紧成枚举属未论证的语义变更）；`limit` 上限 200 与 `round` 的 `.int().min(0)` 逐字保留。
 */
export const QueryInfoParamsSchema = z.object({
  type: z.enum(["tasks", "report", "profiles"]),
  /** `type=tasks`：按项目路径过滤。 */
  projectPath: AbsPath.optional(),
  /** `type=tasks`：按状态过滤（自由字符串，与原 `list_tasks` 一致）。 */
  status: z.string().optional(),
  /** `type=tasks`：返回条数上限，默认 50、上限 200。 */
  limit: z.number().int().positive().max(200).optional(),
  /** `type=report`：目标任务 id；**在 handler 内要求非空**（原为 schema 层必填）。 */
  taskId: z.string().min(1).optional(),
  /** `type=report`：0-based 报告轮次；缺省返回最新。 */
  round: z.number().int().min(0).optional(),
});
export type QueryInfoParams = z.infer<typeof QueryInfoParamsSchema>;

/**
 * `wait_task`（增强）—— 合并 `wait_task` + `wait_any`。
 *
 * 二选一约束（`taskId` 与 `taskIds` 恰有其一）**只能写在 handler 里**：
 * `.refine()` 经 SDK 序列化后同样会退化成空 schema。`taskIds` 的 1..20 与
 * `timeoutMs` 的正整数约束保留在 schema 层（这两条是**单字段**约束，不涉及跨字段）。
 */
export const WaitTaskMergedParamsSchema = z.object({
  /** 单任务模式：等待该任务到停点。 */
  taskId: z.string().min(1).optional(),
  /** 批量模式：等待首个到停点者，1..20 个。开始前校验全部存在，缺一即报错。 */
  taskIds: z.array(z.string().min(1)).min(1).max(WAIT_ANY_TASK_IDS_MAX).optional(),
  /** 本次等待上限（ms）；缺省默认值，超上限被钳制并如实披露。 */
  timeoutMs: z.number().int().positive().optional(),
});
export type WaitTaskMergedParams = z.infer<typeof WaitTaskMergedParamsSchema>;
