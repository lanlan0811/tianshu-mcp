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
    round,
    feedback,
    taskDir: services.store.dir(meta.taskId),
    workDir: meta.projectPath,
    taskTimeoutMs: meta.taskTimeoutMs,
  });
}
