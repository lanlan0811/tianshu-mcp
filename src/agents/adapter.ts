/**
 * AgentAdapter 接口（开发计划 §7.1）：统一抽象，横向扩展点。
 * 实现基于 profile 数据驱动：resolve 探测可执行，buildInvocation 构造命令，
 * parseExit 判定结果。新增 agent = 新 profile +（如需）子类 adapter。
 */
import type { SpawnSpec } from "./spawn.js";
import type { AgentProfile } from "../config/schema.js";

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
}
