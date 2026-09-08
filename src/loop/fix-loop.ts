/**
 * TaskOrchestrator：单任务的执行编排（开发计划 §6/§9）。
 * run_task 的实际工作循环：
 *   采集基线 → spawn agent（round 0）→ 可选验收 → 失败且 autoFixRounds 未用尽 → fixing → 再验 …
 * 每轮验收/agent 输出独立落盘；终态 succeeded / failed / needs_attention / cancelled。
 *
 * 并发闸/队列由 TaskManager 负责；这里只负责单任务推进（支持 AbortSignal 中止）。
 */
import { readTextSafe, exists, readDirSafe, mkdirp, writeJsonAtomic, readJsonSafe } from "../util/fs.js";
import type { TaskContext, ResolvedAgent } from "../agents/adapter.js";
import { AgentAdapterRegistry } from "../agents/registry.js";
import { runChild } from "../agents/spawn.js";
import { captureBaseline, type Baseline } from "../verify/git-baseline.js";
import { AcceptanceEngine, type VerifyRequest } from "../verify/acceptance.js";
import { summarizeReport } from "../verify/report.js";
import type { TaskMeta } from "../tasks/task.js";
import { TaskStore } from "../tasks/task-store.js";
import type { DataHome } from "../config/store.js";
import { Logger } from "../util/log.js";

export interface OrchestratorDeps {
  store: TaskStore;
  dataHome: DataHome;
  registry: AgentAdapterRegistry;
  engine: AcceptanceEngine;
  logger: Logger;
  buildCtx: (meta: TaskMeta, round: number, feedback?: string) => TaskContext;
}

export interface OrchestrateResult {
  status: TaskMeta["status"];
  meta: TaskMeta;
  summary?: string;
  reason?: string;
}

export class TaskOrchestrator {
  private done = false;

  constructor(
    private readonly deps: OrchestratorDeps,
    private readonly meta: TaskMeta,
    private readonly signal?: AbortSignal,
    private readonly initialFeedback?: string,
  ) {}

  /** 单任务完整推进；manager 负责写回 meta。 */
  async run(): Promise<OrchestrateResult> {
    const { meta } = this;
    const logger = this.deps.logger;
    const store = this.deps.store;

    try {
      // ---- 解析 agent（spawn/认证等基础设施错误不再重试）----
      const resolved = await this.deps.registry.resolve(meta.agentId, true);
      if (!resolved.ok) {
        return this.finish("failed", "agent_unresolved", `agent '${meta.agentId}' 不可用：${resolved.message}`);
      }

      // ---- 采集 git 基线（动工前，R12）----
      await store.appendEvent(meta.taskId, "note", meta.status, "采集 git 基线…");
      const baseline = await captureBaseline(meta.projectPath);
      await mkdirp(store.dir(meta.taskId));
      await writeJsonAtomic(store.baselinePath(meta.taskId), baseline);

      // ---- 返修循环 ----
      let round = meta.roundsUsed;
      let feedback = this.initialFeedback;
      const maxRounds = meta.autoFixRounds;

      for (;;) {
        if (this.aborted()) return this.abortTerminal();
        await store.updateStatus(meta, "running", `第 ${round} 轮 agent 执行`, "started");
        const ctx = this.deps.buildCtx(meta, round, feedback);
        const runRes = await this.runAgentOnce(ctx, resolved);
        meta.logFile = runRes.logFile;

        if (runRes.hardFailure) {
          return this.finish("failed", "spawn", `agent 基础设施失败：${runRes.error ?? "未知"}（日志 ${runRes.logFile}）`);
        }
        if (runRes.timeout) {
          return this.finish("failed", "timeout", `任务超时（${meta.taskTimeoutMs}ms），进程树已终止。日志 ${runRes.logFile}`);
        }
        if (runRes.killed) {
          return this.abortTerminal();
        }
        if (!runRes.ok && !meta.autoVerify) {
          return this.finish("failed", "agent_failed", `agent 执行失败（exit=${runRes.exitCode ?? "n/a"}）。日志 ${runRes.logFile}`);
        }

        // ---- 验收 ----
        if (!meta.autoVerify) {
          return this.finish("succeeded", null, `任务完成：agent 退出码 0（耗时 ${runRes.durationMs}ms，未启用验收）。日志 ${runRes.logFile}`);
        }

        await store.updateStatus(meta, "verify_start", `第 ${round} 轮验收开始`);
        const verdict = await this.runVerifyOnce(meta, round, baseline);
        meta.roundsUsed = round + 1;
        meta.reportMd = verdict.mdPath;
        meta.reportJson = verdict.jsonPath;
        meta.changedFiles = verdict.touchedFiles;
        meta.diffstat = verdict.diffstat;

        if (this.aborted()) return this.abortTerminal(); // 验收期间被取消：进入终态，不进入返修
        if (verdict.passed) {
          return this.finish("succeeded", null, verdict.summary);
        }
        if (maxRounds > round) {
          await store.updateStatus(meta, "fixing", `第 ${round} 轮验收失败，进入第 ${round + 1} 轮返修`);
          round += 1;
          feedback = buildFixFeedback(meta.task, verdict.summary, verdict.mdPath);
          continue;
        }
        if (maxRounds === 0) {
          // 未开启自动返修：验收失败 → failed，天枢可手动 rework_task 或 verify_task 复查
          const msg =
            `验收失败（第 ${round} 轮）。未开启自动返修。可用 rework_task(${meta.taskId}, feedback=失败摘要) 手动续修，或 get_task_report 查看报告后裁决。`;
          return this.finish("failed", "verify_failed", `${msg}\n\n${verdict.summary}`);
        }
        // 自动返修轮次用尽 → needs_attention（待天枢裁决）
        const msg = `验收失败，自动返修轮次已用尽（${meta.roundsUsed}/${maxRounds} 轮）。建议人工介入或调 rework_task 追加指示。`;
        meta.lastMessage = msg;
        await store.updateStatus(meta, "needs_attention", msg);
        return { status: "needs_attention", meta, summary: `${msg}\n\n${verdict.summary}` };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`任务 ${meta.taskId} 编排异常: ${msg}`);
      return this.finish("failed", "internal", `内部错误：${msg}`);
    }
  }

  private aborted(): boolean {
    return this.signal?.aborted ?? false;
  }

  /**
   * 取消/中断的终态落盘（S1）：用独立 cancelRequestedAt/abortSource 判断来源，不依赖可选 reason。
   * - 用户取消（cancelRequestedAt 已置位 / abortSource=user / 排队中）→ cancelled
   * - server 关闭/EOF/未显式取消的中止 → interrupted
   * - 超时 → failed(timeout) + timeout_killed
   */
  private async abortTerminal(): Promise<OrchestrateResult> {
    if (this.done) return { status: this.meta.status, meta: this.meta, reason: this.meta.lastMessage };
    this.done = true;
    const meta = this.meta;
    if (meta.abortSource === "timeout") {
      // 超时兜底 guard 已标 timeout → 落 failed(timeout)，记录 timeout_killed 事件
      meta.lastMessage = meta.lastMessage || "任务超时，进程树已终止。";
      await this.deps.store.updateStatus(meta, "failed", meta.lastMessage);
      await this.deps.store.appendEvent(meta.taskId, "timeout_killed", "failed", meta.lastMessage).catch(() => {});
      return { status: "failed", meta, reason: meta.lastMessage, summary: meta.lastMessage };
    }
    // 用户取消判定：cancelRequestedAt 置位 或 显式 user abortSource 或 queued 阶段取消
    const isCancelled = Boolean(meta.cancelRequestedAt) || meta.abortSource === "user" || meta.status === "queued";
    if (isCancelled) {
      meta.errorType = "cancelled";
      meta.abortSource = "user";
      meta.lastMessage = meta.cancelReason ? `已取消：${meta.cancelReason}` : "已取消";
      await this.deps.store.updateStatus(meta, "cancelled", meta.lastMessage);
    } else {
      meta.errorType = "interrupted";
      meta.abortSource = "shutdown";
      meta.lastMessage = "任务已中断（server 退出 / 父进程 EOF / 未显式取消的中止）。";
      await this.deps.store.updateStatus(meta, "interrupted", meta.lastMessage);
    }
    return { status: meta.status, meta, reason: meta.lastMessage, summary: meta.lastMessage };
  }

  private async finish(
    status: TaskMeta["status"],
    errorType: TaskMeta["errorType"],
    reason: string,
  ): Promise<OrchestrateResult> {
    if (this.done) return { status, meta: this.meta, reason };
    this.done = true;
    const meta = this.meta;
    meta.errorType = errorType;
    meta.lastMessage = reason;
    await this.deps.store.updateStatus(meta, status, reason);
    return { status, meta, summary: reason, reason };
  }

  private async runAgentOnce(ctx: TaskContext, resolved: ResolvedAgent) {
    await this.deps.registry.prepareInvocation(ctx.agentId, ctx, resolved);
    const adapter = this.deps.registry.getAdapter(ctx.agentId);
    if (!adapter) throw new Error(`agent '${ctx.agentId}' 无 adapter`);
    const inv = adapter.buildInvocation(ctx, resolved);
    const res = await runChild(
      { ...inv.spec, logFile: inv.logFile, timeoutMs: inv.timeoutMs },
      { signal: this.signal, stdinText: inv.stdinText, logger: this.deps.logger },
    );
    return adapter.parseExit(res);
  }

  private async runVerifyOnce(meta: TaskMeta, round: number, baseline: Baseline) {
    const store = this.deps.store;
    const proj = await this.deps.dataHome.projectByPath(meta.projectPath);
    const projectVerify = proj.record?.verify?.map((v) => {
      const cmd = Array.isArray(v.cmd) ? [...v.cmd] : v.cmd;
      return { name: v.name, cmd: Array.isArray(cmd) ? cmd : [cmd], displayCmd: Array.isArray(cmd) ? cmd.join(" ") : cmd };
    });
    const req: VerifyRequest = {
      taskId: meta.taskId,
      projectPath: meta.projectPath,
      displayPath: meta.displayPath,
      taskText: meta.task,
      round,
      config: await this.deps.dataHome.loadConfig(),
      projectVerify,
      baseline,
      store,
      logger: this.deps.logger,
    };
    const { report, passed } = await this.deps.engine.runVerify(req);
    const summary = summarizeReport(report);
    return {
      passed,
      summary,
      mdPath: report.files.md,
      jsonPath: report.files.json,
      // meta.changedFiles = 已跟踪变更 + 未跟踪新增（相对基线被 agent 触碰的全部文件）
      touchedFiles: [...report.analysis.changedFiles, ...report.analysis.untrackedFiles],
      diffstat: `+${report.analysis.diffstat.totalAdd} -${report.analysis.diffstat.totalDel}`,
    };
  }
}

function buildFixFeedback(taskText: string, verifySummary: string, reportMd: string): string {
  return [
    "【上一轮验收失败反馈 —— 请针对下列失败项定向修复，不要大范围重构】",
    "",
    verifySummary,
    "",
    `完整验收报告：${reportMd}`,
    "修复完成后正常结束进程即可。",
  ].join("\n");
}

/** 读取最近一轮 report.json / md 摘要（rework / query 用） */
export async function readLatestReportSummary(
  store: TaskStore,
  taskId: string,
): Promise<{ round: number; summary: string; passed: boolean } | null> {
  const dirs = await readDirSafe(store.dir(taskId));
  const rounds = dirs
    .filter((d) => /^report-\d+\.json$/.test(d))
    .map((d) => Number(/^report-(\d+)\.json$/.exec(d)?.[1]));
  if (rounds.length === 0) return null;
  const round = Math.max(...rounds);
  const raw = await readJsonSafe<{ passed: boolean }>(store.reportJsonPath(taskId, round));
  if (!raw) return null;
  const mdText = (await readTextSafe(store.reportMdPath(taskId, round))) ?? "";
  return { round, summary: mdText.slice(0, 6000), passed: raw.passed };
}

export async function hasReport(store: TaskStore, taskId: string, round: number): Promise<boolean> {
  return exists(store.reportJsonPath(taskId, round));
}
