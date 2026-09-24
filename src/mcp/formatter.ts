/**
 * formatter：统一结果文本 + ---tianshu-mcp-meta--- JSON 块拼装（开发计划 §5）。
 * meta 块固定以 ---tianshu-mcp-meta--- 起止行包裹，天枢可正则抽取。
 * ToolResult 使用 type alias（带隐式索引签名），以匹配官方 SDK 的 CallToolResult。
 */
import type { TaskMeta } from "../tasks/task.js";

export interface MetaBlockFields {
  ok: boolean;
  taskId?: string;
  status?: string;
  agentId?: string;
  projectPath?: string;
  /** GUI 类 agent 使用的模型（traework） */
  model?: string;
  /** GUI 类 agent 使用的面板模式（traework：Work/Code/Design） */
  mode?: string;
  round?: number;
  checks?: { name: string; passed: boolean; durationMs: number }[];
  changedFiles?: string[];
  diffstat?: string;
  reportFiles?: { md?: string; json?: string };
  logFile?: string;
  message: string;
  errorType?: string;
  cancelReason?: string;
  cancelRequestedAt?: string;
  abortSource?: string;
  finishedAt?: string;
  reportRound?: number;
  verificationSource?: string;
  latestVerificationVerdict?: string;
  agentEndReason?: string;
  keptInstance?: boolean;
  needsUserKind?: string;
  pendingQuestion?: string;
  zcodeSessionId?: string;
  boundProjectPath?: string;
  modelProvider?: string;
  permissionMode?: string;
  qoderSessionId?: string;
  actualModel?: string;
  actualReasoningLevel?: string;
  modelSource?: "default" | "custom";
  guiStop?: {clicked: boolean; idle: boolean};
  /**
   * GUI 任务终态是否**未确认**停止（issue #14）：true 时窗口中的任务可能仍在运行，
   * 必须先人工确认再重派；确认后用 cancel_task 清除（清除后回 false）。
   */
  guiStopUnconfirmed?: boolean;
  progressSummary?: string;
  lastRunSignal?: string;
  /** 本次调用携带的幂等键（issue #15）；未传时省略 */
  idempotencyKey?: string;
  /**
   * 幂等命中标记（issue #15）：`hit` = 返回既有任务/报告且未执行；
   * `in_progress` = 同键验收正在执行、本次未重复执行；缺省 = 本次为真实执行。
   */
  idempotencyReplay?: "hit" | "in_progress";
  /** 未传幂等键时，同工作区已有的未结束任务（issue #15 的重复派单提示，仅供人工判断） */
  projectActiveTask?: { taskId: string; status: string };
  /**
   * 最近的细粒度 agent 事件（issue #18），时间正序、最多 `eventLimit` 条。
   * 仅 `query_task` 填充；未实现事件上报的适配器为空数组。旧的调用方忽略本字段即可。
   */
  recentEvents?: {
    ts: string;
    event: string;
    detail?: string;
    data?: Record<string, unknown>;
  }[];
}

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

export function errorResult(msg: string): ToolResult {
  return textResult(`Error: ${msg}`, true);
}

/** 摘要文本 + meta 块，返回 ToolResult */
export function formatToolResult(text: string, meta: MetaBlockFields): ToolResult {
  const block = `---tianshu-mcp-meta---\n${JSON.stringify(meta, null, 2)}\n---tianshu-mcp-meta---`;
  return textResult(`${text}\n${block}`);
}

export function metaFromTask(meta: TaskMeta, extra?: Partial<MetaBlockFields>): MetaBlockFields {
  const ok = meta.status === "succeeded";
  return {
    ok,
    taskId: meta.taskId,
    status: meta.status,
    agentId: meta.agentId,
    projectPath: meta.projectPath,
    model: meta.model,
    mode: meta.mode,
    round: meta.roundsUsed,
    changedFiles: meta.changedFiles,
    diffstat: meta.diffstat,
    reportFiles:
      meta.reportMd || meta.reportJson ? { md: meta.reportMd, json: meta.reportJson } : undefined,
    logFile: meta.logFile,
    message: meta.lastMessage ?? "",
    errorType: meta.errorType ?? undefined,
    cancelReason: meta.cancelReason,
    cancelRequestedAt: meta.cancelRequestedAt,
    abortSource: meta.abortSource,
    finishedAt: meta.finishedAt,
    reportRound: meta.reportRound,
    verificationSource: meta.verificationSource,
    latestVerificationVerdict: meta.latestVerificationVerdict,
    agentEndReason: meta.agentEndReason,
    keptInstance: meta.keptInstance,
    needsUserKind: meta.needsUserKind,
    pendingQuestion: meta.pendingQuestion,
    zcodeSessionId: meta.zcodeSessionId,
    boundProjectPath: meta.boundProjectPath,
    modelProvider: meta.modelProvider,
    permissionMode: meta.permissionMode,
    progressSummary: meta.progressSummary,
    qoderSessionId: meta.qoderSessionId,
    actualModel: meta.actualModel,
    actualReasoningLevel: meta.actualReasoningLevel,
    modelSource: meta.modelSource,
    guiStop: meta.guiStop,
    // 待确认的两个来源取并集：shutdown 路径的 interruptedCleanStop===false，以及重启归档的
    // guiResidualUnconfirmed。未确认时为 true——编排方据此禁止直接重派。
    guiStopUnconfirmed:
      meta.guiResidualUnconfirmed === true || meta.interruptedCleanStop === false ? true : undefined,
    lastRunSignal: meta.lastRunSignal,
    idempotencyKey: meta.idempotencyKey,
    ...extra,
  };
}

/** 从一行 agent log 取尾部（供 query_task） */
export async function readLogTail(logFile: string, tailLines: number): Promise<string> {
  const { readTextSafe } = await import("../util/fs.js");
  const text = (await readTextSafe(logFile)) ?? "";
  const lines = text.split("\n");
  if (lines.length <= tailLines) return text;
  return lines.slice(-tailLines).join("\n");
}
