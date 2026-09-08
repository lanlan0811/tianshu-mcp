/**
 * zod schema 全集：server 配置 / agent profiles / projects / 项目验收配置 / 工具入参校验。
 * 所有外部输入都经这里解析，失败给默认值或明确报错（开发计划 §13）。
 */
import { z } from "zod";

/* ---------------- 工具入参 ---------------- */

const AbsPath = z.string().min(1, "projectPath 不能为空");

/** TraeWork 面板模式（Work=自带 agent 循环；Code=纯编码；Design=设计） */
export const TraeworkModeSchema = z.enum(["Work", "Code", "Design"]);
/** TraeWork 面板模式类型（单一真源，供 adapter/task/ui 共用） */
export type TraeworkMode = z.infer<typeof TraeworkModeSchema>;

export const RunTaskParamsSchema = z.object({
  projectPath: AbsPath,
  task: z.string().min(1, "task 任务书不能为空"),
  agentId: z.string().min(1).optional(),
  /**
   * 目标 agent 使用的模型（GUI 类 agent 如 traework 用；CLI 类 agent 忽略）。
   * 例：GLM-5.3 / DeepSeek-V4-Flash。未传时沿用 agent 侧当前选择。
   */
  model: z.string().min(1).optional(),
  /**
   * TraeWork 面板模式（仅 GUI 类 agent traework 生效）。
   * 未传时从任务书文本识别「切换 Work/Code/Design 模式」，仍识别不到则保持 Work。
   * 项目文件夹绑定固定发生在 Work 模式，随后再切到目标模式。
   */
  mode: TraeworkModeSchema.optional(),
  autoVerify: z.boolean().optional(),
  autoFixRounds: z.number().int().min(0).max(10).optional(),
  context: z.string().optional(),
  taskTimeoutMs: z.number().int().positive().optional(),
});
export type RunTaskParams = z.infer<typeof RunTaskParamsSchema>;

export const QueryTaskParamsSchema = z.object({
  taskId: z.string().min(1),
  tailLines: z.number().int().positive().optional(),
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

/** 验收命令：结构化 argv 或字符串（字符串会被分词为 argv，非 shell 执行） */
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
});
export type VerifyTaskParams = z.infer<typeof VerifyTaskParamsSchema>;

export const ReworkTaskParamsSchema = z.object({
  taskId: z.string().min(1),
  feedback: z.string().optional(),
});
export type ReworkTaskParams = z.infer<typeof ReworkTaskParamsSchema>;

/* ---------------- server 配置 config.json ---------------- */

export const ServerConfigSchema = z.object({
  concurrency: z
    .object({
      maxRunning: z.number().int().min(1).max(32).default(2),
    })
    .default({}),
  defaultTaskTimeoutMs: z.number().int().positive().default(30 * 60_000),
  verifyCommandTimeoutMs: z.number().int().positive().default(5 * 60_000),
  skills: z
    .object({
      autoInstall: z.boolean().default(true),
    })
    .default({}),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/* ---------------- agent-profiles.json ---------------- */

export const ExecutableDiscoverySchema = z.object({
  /**
   * 候选根目录。支持 {LOCALAPPDATA} {APPDATA} {HOME} {USERPROFILE} 占位符与
   * 平台相对路径；留空时由实现按平台注入标准候选（如 Windows 的 LOCALAPPDATA、macOS 的 ~/Applications）。
   */
  dirs: z.array(z.string()).default([]),
  fileNames: z.array(z.string()).default([]),
  /** PATH 中查找的回退命令名 */
  fallbackCommand: z.string().optional(),
});

/**
 * GUI 驱动配置（driver="gui" 的 agent 使用，如 traework）。
 * 所有字段均可由数据目录 agent-profiles.json 覆盖，代码只给默认值与探测规则。
 */
export const GuiProfileSchema = z.object({
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
  idleTimeoutMs: z.number().int().nonnegative().default(10 * 60_000),
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
});
export type GuiProfile = z.infer<typeof GuiProfileSchema>;

export const AgentProfileSchema = z.object({
  id: z.string().min(1).optional(), // 仅内置 profiles 使用；数据目录 profiles 以键名为准
  displayName: z.string().default(""),
  type: z.enum(["cli"]).default("cli"),
  /**
   * 执行面：spawn=外部 CLI 子进程（默认）；gui=桌面 UI 自动化（CDP）。
   * 决定 registry 构造哪个 adapter、orchestrator 走哪条执行路径。
   */
  driver: z.enum(["spawn", "gui"]).default("spawn"),
  status: z.enum(["ready", "research", "unsupported"]).default("ready"),
  command: z.string().nullable().optional(),
  argsTemplate: z.array(z.string()).default([]),
  promptMode: z.enum(["arg", "stdin", "file"]).default("arg"),
  cwd: z.enum(["task", "home"]).default("task"),
  env: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().default(30 * 60_000),
  killTree: z.enum(["taskkill", "group"]).default("taskkill"),
  authNote: z.string().default(""),
  executableDiscovery: ExecutableDiscoverySchema.optional(),
  gui: GuiProfileSchema.optional(),
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

/* ---------------- 项目内 .tianshu-mcp/acceptance.json ---------------- */

export const AcceptanceConfigSchema = z.object({
  checks: z.array(AcceptanceCheckSchema).default([]),
});
export type AcceptanceConfig = z.infer<typeof AcceptanceConfigSchema>;
