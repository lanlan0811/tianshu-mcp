/**
 * context：从工具参数构造命令上下文 + 项目登记。
 * buildCtx：meta → agent 任务上下文（taskDir / 工作目录 / 超时 / 轮次）。
 */
import type { TaskContext } from "../agents/adapter.js";
import type { TaskMeta } from "../tasks/task.js";
import type { TaskStore } from "../tasks/task-store.js";
import type { DataHome } from "../config/store.js";

export interface AppServices {
  store: TaskStore;
  dataHome: DataHome;
}

export function makeBuildCtx(services: AppServices) {
  return (meta: TaskMeta, round: number, feedback?: string): TaskContext => ({
    taskId: meta.taskId,
    projectPath: meta.projectPath,
    displayPath: meta.displayPath,
    agentId: meta.agentId,
    task: meta.task,
    context: meta.context,
    model: meta.model,
    reasoningLevel: meta.reasoningLevel,
    planDoc: meta.planDoc,
    designSystem: meta.designSystem,
    mode: meta.mode,
    round,
    feedback,
    taskDir: services.store.dir(meta.taskId),
    workDir: meta.projectPath,
    taskTimeoutMs: meta.taskTimeoutMs,
    resume: buildResume(meta, round),
  });
}

/**
 * GUI agent 的会话恢复块。
 * - zcode：需要显式回选原会话（sessionId/sessionTitle），轮次 > 0 或 continue_task 时启用。
 * - codex：实例与当前对话常驻，只需「复用同一会话」意图，无需回选 id。
 */
function buildResume(meta: TaskMeta, round: number): TaskContext["resume"] {
  const continuing = meta.continueMessage !== undefined;
  if (meta.agentId === "zcode") {
    if (!continuing && round <= 0) return undefined;
    return {
      kind: continuing ? "continue" : "rework",
      message: meta.continueMessage,
      sendMessage: meta.continueSendMessage ?? round > 0,
      sessionId: meta.zcodeSessionId,
      sessionTitle: meta.zcodeSessionTitle,
      boundProjectPath: meta.boundProjectPath,
      provider: meta.modelProvider,
      model: meta.model,
      permissionMode: meta.permissionMode,
    };
  }
  if (meta.agentId === "codex") {
    if (!continuing && round <= 0) return undefined;
    return {
      kind: continuing ? "continue" : "rework",
      message: meta.continueMessage,
      sendMessage: meta.continueSendMessage ?? round > 0,
      boundProjectPath: meta.boundProjectPath,
      model: meta.model,
      permissionMode: meta.permissionMode,
    };
  }
  return undefined;
}
