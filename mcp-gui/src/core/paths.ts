/**
 * 任务产物命名约定（前端镜像）。
 *
 * 真源：`src/tasks/task-store.ts` 的 `dir/jsonlPath/snapshotPath/agentLogPath/verifyLogPath/
 * reportMdPath/reportJsonPath/reportHtmlPath/dryRunReport*` 与 `dry-run-plan.md`。
 * 全部使用**正斜杠**相对数据目录的路径，与后端返回的 `relPath` 口径一致。
 */

export const SERVER_LOG_REL = "logs/server.log";
export const EVENT_STREAM_NAME = "task.jsonl";
export const SNAPSHOT_NAME = "task.json";
export const BASELINE_NAME = "baseline.json";
export const DRY_RUN_PLAN_NAME = "dry-run-plan.md";

export function tasksRootRel(): string {
  return "tasks";
}

export function taskDirRel(taskId: string): string {
  return `tasks/${taskId}`;
}

export function eventStreamRel(taskId: string): string {
  return `${taskDirRel(taskId)}/${EVENT_STREAM_NAME}`;
}

export function snapshotRel(taskId: string): string {
  return `${taskDirRel(taskId)}/${SNAPSHOT_NAME}`;
}

export function agentLogRel(taskId: string, round: number): string {
  return `${taskDirRel(taskId)}/agent-${round}.log`;
}

export function verifyLogRel(taskId: string, round: number): string {
  return `${taskDirRel(taskId)}/verify-${round}.log`;
}

export function reportMdRel(taskId: string, round: number): string {
  return `${taskDirRel(taskId)}/report-${round}.md`;
}

export function reportJsonRel(taskId: string, round: number): string {
  return `${taskDirRel(taskId)}/report-${round}.json`;
}

export function reportHtmlRel(taskId: string, round: number): string {
  return `${taskDirRel(taskId)}/report-${round}.html`;
}

/** dryRun 报告与常规 report-<round>.* **刻意分开命名**（结论口径不同） */
export function dryRunMdRel(taskId: string, round: number): string {
  return `${taskDirRel(taskId)}/dry-run-report-${round}.md`;
}

export function dryRunJsonRel(taskId: string, round: number): string {
  return `${taskDirRel(taskId)}/dry-run-report-${round}.json`;
}

export function dryRunPlanRel(taskId: string): string {
  return `${taskDirRel(taskId)}/${DRY_RUN_PLAN_NAME}`;
}

export function baselineRel(taskId: string): string {
  return `${taskDirRel(taskId)}/${BASELINE_NAME}`;
}

/** 从相对路径判断所属 taskId（`tasks/<id>/...`），非任务路径返回 null */
export function taskIdFromRel(relPath: string): string | null {
  const m = /^tasks\/([^/]+)\//.exec(relPath);
  return m ? (m[1] ?? null) : null;
}