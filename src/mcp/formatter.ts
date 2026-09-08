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
    reportFiles: meta.reportMd || meta.reportJson ? { md: meta.reportMd, json: meta.reportJson } : undefined,
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
