/**
 * zod schema 全集：server 配置 / agent profiles / projects / 项目验收配置 / 工具入参校验。
 * 所有外部输入都经这里解析，失败给默认值或明确报错（开发计划 §13）。
 */
import { z } from "zod";

/* ---------------- 工具入参 ---------------- */

const AbsPath = z.string().min(1, "projectPath 不能为空");

export const RunTaskParamsSchema = z.object({
  projectPath: AbsPath,
  task: z.string().min(1, "task 任务书不能为空"),
  agentId: z.string().min(1).optional(),
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

export const AgentProfileSchema = z.object({
  id: z.string().min(1).optional(), // 仅内置 profiles 使用；数据目录 profiles 以键名为准
  displayName: z.string().default(""),
  type: z.enum(["cli"]).default("cli"),
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
