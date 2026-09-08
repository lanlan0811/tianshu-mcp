/**
 * AgentAdapter 接口（开发计划 §7.1）：统一抽象，横向扩展点。
 * 实现基于 profile 数据驱动：resolve 探测可执行，buildInvocation 构造命令，
 * parseExit 判定结果。新增 agent = 新 profile +（如需）子类 adapter。
 */
import type { SpawnSpec } from "./spawn.js";
import type { AgentProfile, TraeworkMode } from "../config/schema.js";

export interface ResolvedAgent {
  id: string;
  displayName: string;
  profile: AgentProfile;
  command: string;
  argsTemplate: string[];
  ok: boolean;
  message: string;
  /** resolve 成功后缓存的探测信息 */
  discovered?: { source: "explicit" | "fallback" | "discovery"; version?: string };
}

export interface TaskContext {
  taskId: string;
  projectPath: string; // norm
  displayPath: string;
  agentId: string;
  task: string;
  context?: string;
  round: number;
  feedback?: string; // 返修轮附加的失败反馈
  taskDir: string;
  workDir: string;
  taskTimeoutMs: number;
  /** GUI 类 agent（traework）使用的模型名；CLI 类忽略 */
  model?: string;
  /** GUI 类 agent（traework）使用的面板模式；CLI 类忽略 */
  mode?: TraeworkMode;
}

export interface SpawnInvocation {
  spec: Omit<SpawnSpec, "logFile" | "timeoutMs">;
  promptText: string;
  stdinText?: string;
  timeoutMs: number;
  logFile: string;
}

export interface AgentRunResult {
  ok: boolean; // 依据 adapter 语义（默认 exit 0）
  exitCode: number | null;
  timeout: boolean;
  killed: boolean;
  error?: string;
  durationMs: number;
  logFile: string;
  hardFailure?: boolean; // 基础设施/认证等错误，不进入验收/返修
  /** GUI agent 的结构化结束原因（如 completion_mark / idle_no_completion / timeout） */
  endReason?: string;
  /** GUI 实例是否因任务未真正完成而被保留 */
  keptInstance?: boolean;
}

/** parseExit: SpawnResult → AgentRunResult，按 agent 语义 */
export type ParseExitFn = (res: {
  ok: boolean;
  exitCode: number | null;
  timeout: boolean;
  killed: boolean;
  error?: string;
  durationMs: number;
  logFile: string;
}) => AgentRunResult;

/** GUI 类 adapter 的自定义执行面选项 */
export interface AgentRunOptions {
  signal?: AbortSignal;
  logger: AgentRunLogger;
  /** 进度回报（写入任务事件流，供 query_task 观察） */
  onProgress?: (note: string) => void | Promise<void>;
}

/** 只依赖用到的最小日志接口，避免 adapter 层与 Logger 实现耦合 */
export interface AgentRunLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export interface AgentAdapter {
  id: string;
  /** 构造一次调用（命令/参数/工作目录/env/prompt 传递） */
  buildInvocation(ctx: TaskContext, resolved: ResolvedAgent): SpawnInvocation;
  /** 将子进程退出结果翻译为语义结果 */
  parseExit(res: {
    ok: boolean;
    exitCode: number | null;
    timeout: boolean;
    killed: boolean;
    error?: string;
    durationMs: number;
    logFile: string;
  }): AgentRunResult;
  /**
   * 可选：自定义执行面。存在时 TaskOrchestrator 不再 spawn 子进程，
   * 而是调用它（GUI 类 adapter 如 traework 实现；CLI 类不实现，走原 spawn 路径）。
   */
  run?(ctx: TaskContext, resolved: ResolvedAgent, opts: AgentRunOptions): Promise<AgentRunResult>;
}
