/**
 * 通用 CLI adapter：由 profile 数据驱动（开发计划 §7.3 —— profile 是数据，不是代码）。
 * prompt 传递三种模式：arg / stdin / file。
 */
import path from "node:path";
import type { AgentAdapter, AgentRunResult, ResolvedAgent, SpawnInvocation, TaskContext } from "./adapter.js";
import { writeTextAtomic } from "../util/fs.js";
import type { SpawnResult } from "./spawn.js";

export const PROMPT_ARG = "<prompt:arg>";
export const PROMPT_STDIN = "<prompt:stdin>";
export const PROMPT_FILE = "<prompt:file>";

export class CliAdapter implements AgentAdapter {
  constructor(readonly id: string) {}

  buildInvocation(ctx: TaskContext, resolved: ResolvedAgent): SpawnInvocation {
    const profile = resolved.profile;
    const mode = profile.promptMode ?? "arg";
    let promptText = ctx.task;
    if (ctx.context) promptText = `${ctx.task}\n\n【附加上下文 / 约束】\n${ctx.context}`;
    if (ctx.feedback) {
      promptText += `\n\n【上一轮验收失败反馈 —— 请针对下列问题修改，不要大范围重构】\n${ctx.feedback}`;
    }

    const args = resolved.argsTemplate.map((t) => {
      if (t.includes(PROMPT_ARG)) return t.replace(PROMPT_ARG, mode === "arg" ? promptText : "");
      if (t.includes(PROMPT_FILE)) return t.replace(PROMPT_FILE, this.promptFilePath(ctx));
      if (t.includes(PROMPT_STDIN)) return t.replace(PROMPT_STDIN, "");
      return t;
    });

    let stdinText: string | undefined;
    if (mode === "stdin") {
      stdinText = promptText;
    } else if (mode === "file") {
      // prompt 文件在调用前已由 prepare 写入
      stdinText = undefined;
    }

    const env = { ...(profile.env ?? {}) };
    const cwd = profile.cwd === "home" ? this.homeDir() : ctx.workDir;

    return {
      spec: { command: resolved.command, args, cwd, env, killTree: profile.killTree ?? "taskkill" },
      promptText,
      stdinText,
      // 任务超时已在提交时固化到 ctx.taskTimeoutMs（调用参数 > profile > server 默认），
      // adapter 不得用 profile 再次覆盖（R2）。
      timeoutMs: ctx.taskTimeoutMs > 0 ? ctx.taskTimeoutMs : profile.timeoutMs,
      logFile: ctx.taskDir + path.sep + `agent-${ctx.round}.log`,
    };
  }

  /** file 模式下写 prompt 文件（幂等，可重复调用） */
  async prepare(ctx: TaskContext, resolved: ResolvedAgent): Promise<void> {
    if ((resolved.profile.promptMode ?? "arg") !== "file") return;
    const p = this.promptFilePath(ctx);
    const text = ctx.task + (ctx.context ? `\n\n【附加上下文 / 约束】\n${ctx.context}` : "") + (ctx.feedback ? `\n\n【上一轮验收失败反馈】\n${ctx.feedback}` : "");
    await writeTextAtomic(p, text);
  }

  private promptFilePath(ctx: TaskContext): string {
    return path.join(ctx.taskDir, `prompt-${ctx.round}.txt`);
  }

  private homeDir(): string {
    return process.env.USERPROFILE ?? process.env.HOME ?? ".";
  }

  parseExit(res: SpawnResult): AgentRunResult {
    const r: AgentRunResult = { ...res };
    if (res.error && res.exitCode === null) {
      r.hardFailure = true; // spawn/ENOENT/基础设施错误
    }
    return r;
  }
}
