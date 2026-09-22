/**
 * TaskOrchestrator：单任务的执行编排（开发计划 §6/§9）。
 * run_task 的实际工作循环：
 *   采集基线 → spawn agent（round 0）→ 可选验收 → 失败且 autoFixRounds 未用尽 → fixing → 再验 …
 * 每轮验收/agent 输出独立落盘；终态 succeeded / failed / needs_attention / cancelled。
 *
 * 并发闸/队列由 TaskManager 负责；这里只负责单任务推进（支持 AbortSignal 中止）。
 */
import {
  readTextSafe,
  exists,
  readDirSafe,
  mkdirp,
  writeJsonAtomic,
  readJsonSafe,
} from "../util/fs.js";
import type { TaskContext, ResolvedAgent } from "../agents/adapter.js";
import { AgentAdapterRegistry } from "../agents/registry.js";
import { runChild } from "../agents/spawn.js";
import { captureBaseline, type Baseline } from "../verify/git-baseline.js";
import { AcceptanceEngine, type VerifyRequest } from "../verify/acceptance.js";
import { summarizeReport } from "../verify/report.js";
import { writeRepairPlan } from "./repair-plan.js";
import { writeCodexFixPlan } from "../agents/codex/fixplan.js";
import { buildFixPrompt } from "../agents/codex/input.js";
import { extractFailureEvidence } from "../agents/codex/verify.js";
import {
  type TaskMeta,
  type VerifyReport,
  isProjectWorkspace,
  guiAppNameOf,
  guiStopDisclosure,
} from "../tasks/task.js";
import { TaskStore } from "../tasks/task-store.js";
import type { DataHome } from "../config/store.js";
import { Logger } from "../util/log.js";
import { freezeVisualSnapshot, checkVisualSnapshot } from "../visual/snapshot.js";
import { visualEvidence } from "../visual/report.js";
import { withVisualLock } from "../visual/lock.js";
import path from "node:path";
import fsp from "node:fs/promises";
import { VisualError } from "../visual/errors.js";

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
    // issue #12：按工作区模式分流。无项目任务（default 工作区）不得进入项目级基础设施
    // ——Git 基线、项目快照冻结、项目锁、项目验收与验收驱动的自动返修。
    const projectMode = isProjectWorkspace(meta);

    try {
      let baseline: Baseline | undefined;
      if (projectMode) {
        // ---- 采集 git 基线（动工前，R12）----
        await store.appendEvent(meta.taskId, "note", meta.status, "采集 git 基线…");
        await mkdirp(store.dir(meta.taskId));
        const savedBaseline = await readJsonSafe<Baseline>(store.baselinePath(meta.taskId));
        baseline = savedBaseline ?? (await captureBaseline(meta.projectPath));
        if (!savedBaseline) await writeJsonAtomic(store.baselinePath(meta.taskId), baseline);
        try {
          const frozen = await freezeVisualSnapshot(meta.projectPath, store.dir(meta.taskId));
          await checkVisualSnapshot(meta.projectPath, frozen);
        } catch (e) {
          if (this.aborted()) return this.abortTerminal();
          meta.pendingVisualVerification = true;
          return this.finish("needs_attention", "verify_failed", String(e));
        }
      } else {
        await mkdirp(store.dir(meta.taskId));
        await store.appendEvent(
          meta.taskId,
          "note",
          meta.status,
          "无项目模式：跳过 Git 基线、项目快照/锁与项目验收",
        );
      }

      let resumedFeedback: string | undefined;
      if (meta.pendingVisualVerification) {
        if (!projectMode)
          return this.finish(
            "needs_attention",
            "internal",
            "无项目任务携带 pendingVisualVerification：状态不一致，拒绝进入项目视觉返修。",
          );
        await store.updateStatus(meta, "running", "恢复视觉阻塞：先重新验收");
        await store.updateStatus(meta, "verify_start", "恢复视觉阻塞：先重新验收");
        const retry = await this.runVerifyOnce(meta, meta.roundsUsed, baseline!);
        if (this.aborted()) return this.abortTerminal();
        if (retry.report.blockingIssues?.length)
          return this.finish("needs_attention", "verify_failed", retry.report.message);
        delete meta.pendingVisualVerification;
        if (retry.passed) return this.finish("succeeded", null, retry.summary);
        if (meta.roundsUsed > meta.autoFixRounds)
          return this.finish("failed", "verify_failed", retry.summary);
        resumedFeedback = `${retry.summary}\n${visualEvidence(retry.report)}`;
      }

      const resolved = await this.deps.registry.resolve(meta.agentId, true);
      if (!resolved.ok)
        return this.finish(
          "failed",
          "agent_unresolved",
          `agent '${meta.agentId}' 不可用：${resolved.message}`,
        );

      // ---- 返修循环 ----
      let round = meta.roundsUsed;
      let feedback =
        [this.initialFeedback, resumedFeedback].filter(Boolean).join("\n") || undefined;
      const maxRounds = meta.autoFixRounds;

      // Manual rework starts a new orchestrator, so it must also materialize a plan
      // before dispatch; the automatic loop below already does this per failed round.
      if (meta.agentId === "qoder" && round > 0 && meta.continueMessage === undefined) {
        const report = meta.reportJson ? await readJsonSafe<VerifyReport>(meta.reportJson) : null;
        if (!report || report.taskId !== meta.taskId || !meta.reportMd || await readTextSafe(meta.reportMd) == null) {
          return this.finish("failed", "internal", "Qoder 原验收报告不可读，无法生成返修计划，拒绝发送。");
        }
        const plan = await writeRepairPlan({
          taskId: meta.taskId, round: round - 1, projectPath: meta.projectPath,
          displayPath: meta.displayPath, taskText: meta.task, report,
          taskDir: store.dir(meta.taskId), logger,
        });
        if (feedback) await fsp.appendFile(plan.taskPath, `\n## 用户追加修复或优化要求\n\n${feedback}\n`);
        const planText = await readTextSafe(plan.taskPath);
        if (planText == null) return this.finish("failed", "internal", "Qoder 返修计划不可读，拒绝发送。");
        feedback = `${buildFixFeedback(meta.task, report.message, meta.reportMd, plan.taskPath)}\n\n修复计划全文（${plan.fileName}）：\n${planText}`;
      }

      for (;;) {
        if (this.aborted()) return this.abortTerminal();
        await store.updateStatus(meta, "running", `第 ${round} 轮 agent 执行`, "started");
        const ctx = this.deps.buildCtx(meta, round, feedback);
        if (meta.continueMessage !== undefined) {
          delete meta.continueMessage;
          delete meta.continueSendMessage;
          delete meta.continueReobserve;
          await store.writeSnapshot(meta);
        }
        const runRes = projectMode
          ? await withVisualLock(
              path.dirname(path.dirname(store.dir(meta.taskId))),
              await fsp.realpath(meta.projectPath),
              async () => {
                await checkVisualSnapshot(
                  meta.projectPath,
                  await freezeVisualSnapshot(meta.projectPath, store.dir(meta.taskId)),
                );
                return this.runAgentOnce(ctx, resolved);
              },
            )
          : await this.runAgentOnce(ctx, resolved);
        meta.logFile = runRes.logFile;
        meta.agentEndReason = runRes.endReason;
        meta.lastRunSignal = runRes.endReason ?? meta.lastRunSignal;
        meta.keptInstance = runRes.keptInstance;
        meta.progressSummary = runRes.progressSummary;
        if (meta.agentId === "qoder") {
          meta.actualModel = runRes.actualModel ?? meta.actualModel;
          meta.actualReasoningLevel = runRes.actualReasoningLevel ?? meta.actualReasoningLevel;
          meta.modelSource = runRes.actualModelSource ?? meta.modelSource;
        }
        // GUI 停止结果对所有 agent 落盘（issue #14）：此前只写 qoder，导致其余 GUI agent
        // 在 shutdown 竞态里丢失适配器已回报的停止结果，只能写"无停止结果可确认"。
        if (runRes.guiStop) meta.guiStop = runRes.guiStop;
        if (runRes.session) {
          // 会话锚点按 agent 分槽存放：zcodeSession* 与 kimicodeSession* 语义不同
          // （旧快照里的 zcodeSession* 是 ZCode 会话，拿去 Kimi Code 里定位必然失败）。
          if (meta.agentId === "qoder") {
            meta.qoderSessionId = runRes.session.id ?? meta.qoderSessionId;
          } else if (meta.agentId === "kimicode") {
            meta.kimicodeSessionId = runRes.session.id ?? meta.kimicodeSessionId;
            meta.kimicodeSessionTitle = runRes.session.title ?? meta.kimicodeSessionTitle;
          } else {
            meta.zcodeSessionId = runRes.session.id ?? meta.zcodeSessionId;
            meta.zcodeSessionTitle = runRes.session.title ?? meta.zcodeSessionTitle;
          }
          meta.boundProjectPath = runRes.session.boundProjectPath ?? meta.boundProjectPath;
          meta.modelProvider = runRes.session.provider ?? meta.modelProvider;
          meta.permissionMode = runRes.session.permissionMode ?? meta.permissionMode;
        }
        if (runRes.endReason || runRes.keptInstance !== undefined) {
          await store.appendEvent(
            meta.taskId,
            "note",
            meta.status,
            `agent 结束原因：${runRes.endReason ?? "unknown"}；实例${runRes.keptInstance ? "已保留" : "未保留"}`,
            { agentEndReason: runRes.endReason, keptInstance: runRes.keptInstance },
          );
        }

        if (runRes.needsUserKind) {
          meta.needsUserKind = runRes.needsUserKind;
          meta.pendingQuestion = runRes.pendingQuestion;
          meta.lastMessage = runRes.pendingQuestion ?? "ZCode 需要用户处理后继续";
          await store.updateStatus(meta, "needs_user", meta.lastMessage, "needs_user");
          return { status: "needs_user", meta, summary: meta.lastMessage };
        }
        if (
          (meta.agentId === "zcode" || meta.agentId === "codex") &&
          ["idle_timeout", "task_timeout", "cdp_disconnected"].includes(runRes.endReason ?? "")
        ) {
          const label = meta.agentId === "codex" ? "Codex" : "ZCode";
          const message = runRes.error ?? `${label} 执行中止：${runRes.endReason}`;
          meta.lastMessage = message;
          meta.errorType = runRes.endReason === "task_timeout" ? "timeout" : "agent_failed";
          await store.updateStatus(meta, "needs_attention", message);
          return { status: "needs_attention", meta, summary: message };
        }

        if (runRes.hardFailure) {
          return this.finish(
            "failed",
            "spawn",
            `agent 基础设施失败：${runRes.error ?? "未知"}（日志 ${runRes.logFile}）`,
          );
        }
        if (runRes.timeout) {
          // S2：统一超时终态 —— 落 failed(timeout) 并记录一次 timeout_killed
          return this.timeoutTerminal(
            runRes.error ?? `任务超时（${meta.taskTimeoutMs}ms）。日志 ${runRes.logFile}`,
          );
        }
        if (runRes.killed) {
          return this.abortTerminal(runRes.guiStop);
        }
        if (!runRes.ok && !meta.autoVerify) {
          return this.finish(
            "failed",
            "agent_failed",
            runRes.error ??
              `agent 执行失败（exit=${runRes.exitCode ?? "n/a"}）。日志 ${runRes.logFile}`,
          );
        }

        // ---- 验收 ----
        if (!meta.autoVerify) {
          if (!projectMode) meta.verificationNotApplicable = "no_project";
          return this.finish(
            "succeeded",
            null,
            projectMode
              ? `任务完成：agent 退出码 0（耗时 ${runRes.durationMs}ms，未启用验收）。日志 ${runRes.logFile}`
              : `任务完成：agent 退出码 0（无项目模式，未进行项目验收）。日志 ${runRes.logFile}`,
          );
        }

        // 到这里只可能是 project 模式：无项目模式在提交时已强制 autoVerify=false。
        if (!projectMode || !baseline)
          return this.finish(
            "failed",
            "internal",
            "无项目任务或缺少动工前基线时不得进入项目验收：状态不一致，已拒绝。",
          );

        await store.updateStatus(meta, "verify_start", `第 ${round} 轮验收开始`);
        const verdict = await this.runVerifyOnce(meta, round, baseline);
        meta.roundsUsed = round + 1;
        meta.reportMd = verdict.mdPath;
        meta.reportJson = verdict.jsonPath;
        meta.changedFiles = verdict.touchedFiles;
        meta.diffstat = verdict.diffstat;

        if (this.aborted()) return this.abortTerminal(); // 验收期间被取消：进入终态，不进入返修
        if (verdict.report.blockingIssues?.length) {
          meta.pendingVisualVerification = true;
          return this.finish("needs_attention", "verify_failed", verdict.report.message);
        }
        if (verdict.passed) {
          return this.finish("succeeded", null, verdict.summary);
        }
        // 返修仅由 verdict.passed === false 触发：blocking=true 的内容缺陷经 visualFailed 进入返修，
        // blocking=false 的内容告警与 uncertain 不改变 verdict，故不会触发返修（issue #13 D2/D7）
        if (maxRounds > round) {
          await store.updateStatus(
            meta,
            "fixing",
            `第 ${round} 轮验收失败，进入第 ${round + 1} 轮返修`,
          );
          round += 1;

          if (meta.agentId === "codex") {
            // 决策 11/12：Codex 的修复计划由 MCP 自动生成，落在**项目内** .zcode/plans/
            // （文件名含轮次号 codex-fix-r<N>.md，不覆盖历史）；因文件名发送前已知，
            // 可直接写进修复指令，无需从回复回读。
            const roundNo = round - 1 + 1;
            const plan = await writeCodexFixPlan({
              taskId: meta.taskId,
              round: round - 1,
              projectPath: meta.projectPath,
              displayPath: meta.displayPath,
              taskText: meta.task,
              report: verdict.report,
              fixPlanDir: resolved.profile.gui?.fixPlanDir,
              logger,
            });
            const [planReadable, reportReadable] = await Promise.all([
              readTextSafe(plan.absPath),
              readTextSafe(verdict.mdPath),
            ]);
            if (planReadable == null || reportReadable == null) {
              return this.finish(
                "failed",
                "internal",
                "Codex 修复计划或验收报告不可读，拒绝发送降级摘要",
              );
            }
            feedback = buildFixPrompt({
              summary: verdict.summary,
              planRelPath: plan.relPath,
              reportPath: verdict.mdPath,
              evidence: extractFailureEvidence(verdict.report),
            });
            logger.info(`[codex] 第 ${roundNo} 轮返修指令已引用修复计划 ${plan.relPath}`);
            continue;
          }

          // 决策 17：验收不通过时先写修复计划文件，再把文件名写进返修消息
          const plan = await writeRepairPlan({
            taskId: meta.taskId,
            round: round - 1,
            projectPath: meta.projectPath,
            displayPath: meta.displayPath,
            taskText: meta.task,
            report: verdict.report,
            taskDir: store.dir(meta.taskId),
            logger,
          });
          const [planReadable, reportReadable] = await Promise.all([
            readTextSafe(plan.taskPath),
            readTextSafe(verdict.mdPath),
          ]);
          if (planReadable == null || reportReadable == null) {
            return this.finish(
              "failed",
              "internal",
              "返修计划或验收报告在任务数据目录中不可读，拒绝发送降级摘要",
            );
          }
          feedback = buildFixFeedback(meta.task, verdict.summary, verdict.mdPath, plan.taskPath);
          if (meta.agentId === "qoder") feedback += `\n\n修复计划全文（${path.basename(plan.taskPath)}）：\n${planReadable}`;
          continue;
        }
        if (maxRounds === 0) {
          // 未开启自动返修：验收失败 → failed，天枢可手动 rework_task 或 verify_task 复查
          const msg = `验收失败（第 ${round} 轮）。未开启自动返修。可用 rework_task(${meta.taskId}, feedback=失败摘要) 手动续修，或 get_task_report 查看报告后裁决。`;
          return this.finish("failed", "verify_failed", `${msg}\n\n${verdict.summary}`);
        }
        // 自动返修轮次用尽 → needs_attention（待天枢裁决）
        const msg = `验收失败，自动返修轮次已用尽（${meta.roundsUsed}/${maxRounds} 轮）。建议人工介入或调 rework_task 追加指示。`;
        meta.lastMessage = msg;
        await store.updateStatus(meta, "needs_attention", msg);
        return { status: "needs_attention", meta, summary: `${msg}\n\n${verdict.summary}` };
      }
    } catch (e) {
      if (this.aborted()) return this.abortTerminal();
      if (e instanceof VisualError) {
        meta.pendingVisualVerification = true;
        return this.finish("needs_attention", "verify_failed", e.message);
      }
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`任务 ${meta.taskId} 编排异常: ${msg}`);
      return this.finish("failed", "internal", `内部错误：${msg}`);
    }
  }

  private aborted(): boolean {
    return this.signal?.aborted ?? false;
  }

  /**
   * 统一超时终态（S2）：落 failed(errorType=timeout) 并记录一次 timeout_killed 事件。
   * 普通 runRes.timeout 与 abort guard 超时共用此路径，保证事件不重复、顺序固定。
   */
  private async timeoutTerminal(reason: string): Promise<OrchestrateResult> {
    if (this.done)
      return { status: this.meta.status, meta: this.meta, reason: this.meta.lastMessage };
    this.done = true;
    const meta = this.meta;
    meta.errorType = "timeout";
    meta.abortSource = "timeout";
    meta.lastMessage = reason;
    // 事件顺序固定：先 failed 落盘（含 finishedAt），再记 timeout_killed
    await this.deps.store.updateStatus(meta, "failed", reason);
    await this.deps.store
      .appendEvent(meta.taskId, "timeout_killed", "failed", reason)
      .catch(() => {});
    return { status: "failed", meta, reason, summary: reason };
  }

  /**
   * 取消/中断的终态落盘（S1）：用独立 cancelRequestedAt/abortSource 判断来源，不依赖可选 reason。
   * - 用户取消（cancelRequestedAt 已置位 / abortSource=user / 排队中）→ cancelled
   * - server 关闭/EOF/未显式取消的中止 → interrupted
   * - 超时 → failed(timeout) + timeout_killed（委托 timeoutTerminal）
   * guiStop（issue #6 / #14）：GUI 停止结果必须如实写进**终态文案与结构化字段**——
   * `idle=false` 与"无停止结果"（ZCode/TraeWork 无停止能力、或未及尝试）都不得声称已停止。
   * 窗口名按 profile 派生，不再按 agentId 硬编码（旧实现把 zcode/qoder 都写成 "Codex" 是失真的）。
   */
  private async abortTerminal(guiStop?: {
    clicked: boolean;
    idle: boolean;
  }): Promise<OrchestrateResult> {
    if (this.done)
      return { status: this.meta.status, meta: this.meta, reason: this.meta.lastMessage };
    if (this.meta.abortSource === "timeout") {
      return this.timeoutTerminal(this.meta.lastMessage || "任务超时，进程树已终止。");
    }
    this.done = true;
    const meta = this.meta;
    // 落结构化停止结果：manager 的 persistInterrupted 在 shutdown 竞态里依赖它决定文案，
    // query_task 也可直接读 meta.guiStop 判断是否已确认停止。
    if (guiStop) meta.guiStop = guiStop;
    // 只有 driver=gui 的 agent 才谈「GUI 内运行是否已确认停止」：spawn 子进程由 killTree 终止，
    // 对其套用 GUI 文案本身就是新的失真。
    const disclosure = (await this.isGuiDriver())
      ? guiStopDisclosure(meta.guiStop, await this.guiAppName())
      : { clean: true, text: "" };
    meta.interruptedCleanStop = disclosure.clean;
    // 用户取消只认结构化意图。排队中用户取消由 TaskManager.cancel 直接落终态，不会进入本分支；
    // orchestrator 尚在采集基线时 status 仍可能是 queued，server shutdown 不得因此误记为用户取消。
    const isCancelled = Boolean(meta.cancelRequestedAt) || meta.abortSource === "user";
    if (isCancelled) {
      meta.errorType = "cancelled";
      meta.abortSource = "user";
      meta.guiResidualUnconfirmed = !disclosure.clean;
      meta.lastMessage =
        (meta.cancelReason ? `已取消：${meta.cancelReason}` : "已取消") + disclosure.text;
      await this.deps.store.updateStatus(meta, "cancelled", meta.lastMessage);
    } else {
      meta.errorType = "interrupted";
      meta.abortSource = "shutdown";
      meta.guiResidualUnconfirmed = !disclosure.clean;
      meta.lastMessage = `任务已中断（server 退出 / 父进程 EOF / 未显式取消的中止）。${disclosure.text}`;
      await this.deps.store.updateStatus(meta, "interrupted", meta.lastMessage);
    }
    return { status: meta.status, meta, reason: meta.lastMessage, summary: meta.lastMessage };
  }

  /** 该任务是否由 GUI driver 驱动；profile 不可读时保守按 GUI 处理（宁可多提示人工检查）。 */
  private async isGuiDriver(): Promise<boolean> {
    try {
      const profile = await this.deps.dataHome.getProfile(this.meta.agentId);
      return profile ? profile.driver === "gui" : true;
    } catch {
      return true;
    }
  }

  /** 终态文案里的界面窗口称呼：profile 派生，读取失败回退 agentId（issue #14）。 */
  private async guiAppName(): Promise<string> {
    try {
      const profile = await this.deps.dataHome.getProfile(this.meta.agentId);
      return guiAppNameOf(profile?.displayName, this.meta.agentId);
    } catch {
      return guiAppNameOf(undefined, this.meta.agentId);
    }
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
    const adapter = this.deps.registry.getAdapter(ctx.agentId);
    if (!adapter) throw new Error(`agent '${ctx.agentId}' 无 adapter`);

    // GUI 类 adapter（traework）自带执行面：不 spawn 子进程，直接驱动桌面 UI。
    if (typeof adapter.run === "function") {
      return adapter.run(ctx, resolved, {
        signal: this.signal,
        logger: this.deps.logger,
        onProgress: async (note) => {
          this.meta.progressSummary = note;
          this.meta.lastRunSignal = /运行证据=([^；]+)/.exec(note)?.[1] ?? this.meta.lastRunSignal;
          this.meta.updatedAt = new Date().toISOString();
          await this.deps.store.appendEvent(ctx.taskId, "note", this.meta.status, note);
          await this.deps.store.writeSnapshot(this.meta);
        },
      });
    }

    await this.deps.registry.prepareInvocation(ctx.agentId, ctx, resolved);
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
      return {
        name: v.name,
        cmd: Array.isArray(cmd) ? cmd : [cmd],
        displayCmd: Array.isArray(cmd) ? cmd.join(" ") : cmd,
      };
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
      signal: this.signal,
      store,
      logger: this.deps.logger,
    };
    const { report, passed } = await this.deps.engine.runVerify(req);
    meta.reportRound = report.round;
    meta.verificationSource = "auto";
    meta.reportMd = report.files.md;
    meta.reportJson = report.files.json;
    const summary = summarizeReport(report);
    return {
      passed,
      summary,
      report,
      mdPath: report.files.md,
      jsonPath: report.files.json,
      // meta.changedFiles = 已跟踪变更 + 未跟踪新增（相对基线被 agent 触碰的全部文件）
      touchedFiles: [...report.analysis.changedFiles, ...report.analysis.untrackedFiles],
      diffstat: `+${report.analysis.diffstat.totalAdd} -${report.analysis.diffstat.totalDel}`,
    };
  }
}

function buildFixFeedback(
  taskText: string,
  verifySummary: string,
  reportMd: string,
  planPath?: string,
): string {
  const lines = ["【上一轮验收失败反馈 —— 请针对下列失败项定向修复，不要大范围重构】", ""];
  if (planPath) {
    lines.push(`修复计划文档：\`${planPath}\`（MCP 任务数据目录绝对路径；请先读取并逐条处理）`, "");
  }
  lines.push(verifySummary, "", `完整验收报告：${reportMd}`, "修复完成后正常结束本轮即可。");
  return lines.join("\n");
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
