/**
 * TaskManager（开发计划 §6/§10）：
 * - 每项目串行 FIFO 队列（规范化 path 为键，队首唯一 running）
 * - 全局并发闸 config.concurrency.maxRunning（默认 2）
 * - cancel(kill tree)、超时护栏、事件流落盘
 * - rework_task：终态任务重新入队续跑（同一 taskId 记账）
 * - server 退出：活动任务标 interrupted（启动归档不续跑，R6）
 * 单任务实际推进委托 TaskOrchestrator。
 */
import { TaskStore } from "./task-store.js";
import { type TaskMeta, ACTIVE_STATUSES, isTerminal } from "./task.js";
import type { TraeworkMode, ReasoningLevel } from "../config/schema.js";
import { TaskOrchestrator } from "../loop/fix-loop.js";
import { genTaskId, nowIso } from "../util/id.js";
import type { DataHome } from "../config/store.js";
import type { AgentAdapterRegistry } from "../agents/registry.js";
import type { AcceptanceEngine } from "../verify/acceptance.js";
import type { TaskContext } from "../agents/adapter.js";
import { Logger } from "../util/log.js";
import { normPath } from "../util/path.js";

export interface NewTaskInput {
  projectPath: string; // norm
  displayPath: string;
  agentId: string;
  task: string;
  context?: string;
  /** GUI 类 agent（traework/codex）使用的模型名；CLI 类忽略 */
  model?: string;
  /** Codex GUI 思考等级；其他 agent 忽略 */
  reasoningLevel?: ReasoningLevel;
  /** Codex GUI 初始开发指令引用的计划文档路径 */
  planDoc?: string;
  /** Codex GUI 初始开发指令引用的设计系统目录路径 */
  designSystem?: string;
  /** GUI 类 agent（traework）使用的面板模式；CLI 类忽略 */
  mode?: TraeworkMode;
  autoVerify: boolean;
  autoFixRounds: number;
  taskTimeoutMs: number;
}

/**
 * cancel_task 有界等待任务落终态的上限（issue #6）。
 * 必须大于 GUI agent 侧"点击停止 + gui.cancelWaitMs（默认 15s）等待"的预算，
 * 再加轮询与快照写入余量；两处约束需同步调整。
 */
const CANCEL_SETTLE_TIMEOUT_MS = 30_000;

export class TaskManager {
  private tasks = new Map<string, TaskMeta>();
  private queue = new Map<string, string[]>();
  private running = new Set<string>();
  private runningCount = 0;
  private abortControllers = new Map<string, AbortController>();
  private maxRunning = 2;

  constructor(
    private readonly store: TaskStore,
    private readonly dataHome: DataHome,
    private readonly registry: AgentAdapterRegistry,
    private readonly engine: AcceptanceEngine,
    private readonly logger: Logger,
    private readonly buildCtx: (meta: TaskMeta, round: number, feedback?: string) => TaskContext,
  ) {}

  /** 启动前注入并发上限，并归档遗留活动任务（不续跑） */
  async initialize(maxRunning: number): Promise<void> {
    this.maxRunning = maxRunning;
    const legacy = await this.store.scanLegacyActive();
    for (const meta of legacy) {
      this.tasks.set(meta.taskId, meta);
      meta.errorType = "interrupted";
      meta.abortSource = "shutdown";
      meta.lastMessage = "server 重启遗留（启动时归档，不续跑）。";
      await this.store.updateStatus(meta, "interrupted", "server 重启遗留归档");
    }
    if (legacy.length) this.logger.warn(`启动归档 ${legacy.length} 个遗留任务（interrupted）`);
  }

  get activeCount(): number {
    return this.runningCount;
  }

  getMaxRunning(): number {
    return this.maxRunning;
  }

  async getMeta(taskId: string): Promise<TaskMeta | null> {
    await this.store.waitForStatusWrite(taskId);
    return this.tasks.get(taskId) ?? (await this.store.readSnapshot(taskId));
  }

  /** S4：外部对终态任务元数据的更新（如手动 verify 更新报告指针/轮次）——写快照并同步内存 map */
  async persistMetaUpdate(meta: TaskMeta): Promise<void> {
    this.tasks.set(meta.taskId, meta);
    await this.store.writeSnapshot(meta);
  }

  async listTasks(filter?: {
    projectPath?: string;
    status?: string;
    limit?: number;
  }): Promise<TaskMeta[]> {
    let metas = await this.store.listTaskSnapshots();
    if (filter?.projectPath) {
      const norm = normPath(filter.projectPath);
      metas = metas.filter((m) => m.projectPath === norm);
    }
    if (filter?.status) metas = metas.filter((m) => m.status === filter.status);
    metas.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (filter?.limit) metas = metas.slice(0, filter.limit);
    return metas;
  }

  /** 创建并排队一个新任务（run_task）。立即返回 queued meta。 */
  async submit(input: NewTaskInput): Promise<TaskMeta> {
    const now = nowIso();
    const meta: TaskMeta = {
      taskId: genTaskId(),
      projectPath: input.projectPath,
      displayPath: input.displayPath,
      agentId: input.agentId,
      task: input.task,
      context: input.context,
      model: input.model,
      reasoningLevel: input.reasoningLevel,
      planDoc: input.planDoc,
      designSystem: input.designSystem,
      mode: input.mode,
      autoVerify: input.autoVerify,
      autoFixRounds: input.autoFixRounds,
      taskTimeoutMs: input.taskTimeoutMs,
      round: 0,
      roundsUsed: 0,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(meta.taskId, meta);
    await this.store.appendEvent(meta.taskId, "created", "queued", "任务已创建");
    await this.store.writeSnapshot(meta);
    this.enqueue(meta);
    return meta;
  }

  /**
   * rework_task：对终态任务（failed/needs_attention/甚至 succeeded）手动续跑。
   * 复用原 agent/项目/验收设置与轮次记账，feedback 作用于下一轮 agent。
   */
  async rework(
    taskId: string,
    feedback?: string,
  ): Promise<{ found: boolean; reason?: string; meta?: TaskMeta }> {
    const meta = (await this.getMeta(taskId)) ?? undefined;
    if (!meta) return { found: false, reason: `任务不存在: ${taskId}` };
    if (!isTerminal(meta.status)) {
      return { found: false, reason: `任务仍在进行中（status=${meta.status}），无法 rework` };
    }
    if (meta.agentId === "zcode" && !meta.zcodeSessionId && !meta.zcodeSessionTitle) {
      return { found: false, reason: "ZCode 原会话定位信息缺失，拒绝创建新任务冒充续修" };
    }
    meta.status = "queued";
    meta.updatedAt = nowIso();
    meta.finishedAt = undefined;
    meta.reworkFeedback = feedback?.trim() || undefined;
    if (meta.reworkFeedback) {
      await this.store.appendEvent(
        meta.taskId,
        "note",
        "queued",
        `rework 请求，追加指示: ${meta.reworkFeedback.slice(0, 200)}`,
      );
    } else {
      await this.store.appendEvent(meta.taskId, "note", "queued", "rework 请求（无追加指示）");
    }
    await this.store.writeSnapshot(meta);
    this.tasks.set(taskId, meta);
    this.enqueue(meta);
    return { found: true, meta };
  }

  /**
   * 仅恢复 needs_user；按 agent 分派恢复语义（issue #5 修复）：
   * - zcode：原行为保留（agent_question 回发答案；其余类型 message 仅作已处理确认）。
   * - codex：user_confirmation → 重观察恢复（不发送消息）；login_required → 复检环境后
   *   全新派发并重发任务书。其余等待类型不支持。
   */
  async continueTask(
    taskId: string,
    message: string,
  ): Promise<{ found: boolean; reason?: string; meta?: TaskMeta }> {
    const meta = (await this.getMeta(taskId)) ?? undefined;
    if (!meta) return { found: false, reason: `任务不存在: ${taskId}` };
    if (meta.status !== "needs_user")
      return { found: false, reason: `任务状态为 ${meta.status}，只允许恢复 needs_user` };
    if (meta.agentId === "zcode") {
      if (
        meta.needsUserKind === "agent_question" &&
        !meta.zcodeSessionId &&
        !meta.zcodeSessionTitle
      ) {
        return { found: false, reason: "原 ZCode 会话定位信息丢失，拒绝打开最近会话" };
      }
      meta.continueMessage = message.trim();
      meta.continueSendMessage = meta.needsUserKind === "agent_question";
    } else if (meta.agentId === "codex") {
      if (meta.needsUserKind === "user_confirmation") {
        // GUI 内 turn 暂停等待用户；恢复后不发送消息，仅重连 CDP 观察至终态
        meta.continueMessage = message.trim();
        meta.continueSendMessage = false;
        meta.continueReobserve = true;
      } else if (meta.needsUserKind === "login_required") {
        // 登录前任务尚未发送、项目尚未绑定：恢复后走全新派发并重发任务书
        meta.continueMessage = message.trim();
        meta.continueSendMessage = false;
      } else {
        return {
          found: false,
          reason: `codex 任务等待类型为 ${meta.needsUserKind ?? "unknown"}，仅支持 login_required / user_confirmation`,
        };
      }
    } else {
      return {
        found: false,
        reason: `continue_task 当前仅支持 zcode/codex 任务（agentId=${meta.agentId}）`,
      };
    }
    meta.status = "queued";
    meta.updatedAt = nowIso();
    meta.finishedAt = undefined;
    await this.store.appendEvent(
      meta.taskId,
      "continued",
      "queued",
      `恢复 needs_user（${meta.needsUserKind ?? "unknown"}）`,
    );
    delete meta.pendingQuestion;
    delete meta.needsUserKind;
    await this.store.writeSnapshot(meta);
    this.tasks.set(taskId, meta);
    this.enqueue(meta);
    return { found: true, meta };
  }

  /**
   * cancel：仅取消目标任务。
   * 返回 settled 表示任务是否已在本调用内落终态（issue #6）：活动中任务会 abort 编排
   * 协程，GUI agent 侧 run 协程先尽力点击界面停止按钮并等待空闲（gui.cancelWaitMs，
   * 默认 15s），本方法有界等待其落终态后再返回，取消结果不再"请求即成功"。
   */
  async cancel(
    taskId: string,
    reason?: string,
  ): Promise<{ found: boolean; reason?: string; settled?: boolean }> {
    const meta = await this.getMeta(taskId);
    if (!meta) return { found: false, reason: `任务不存在: ${taskId}` };
    if (meta.status === "queued") {
      const q = this.queue.get(meta.projectPath);
      if (q) {
        const i = q.indexOf(taskId);
        if (i >= 0) q.splice(i, 1);
      }
      meta.status = "cancelled";
      meta.errorType = "cancelled";
      meta.abortSource = "user";
      meta.cancelRequestedAt = nowIso();
      meta.cancelReason = reason;
      meta.finishedAt = meta.cancelRequestedAt;
      meta.updatedAt = meta.cancelRequestedAt;
      meta.lastMessage = reason ? `已取消（排队中）：${reason}` : "已取消（排队中）";
      // 追加 cancel_requested 事件后再落 cancelled，保证事件流完整
      await this.store.appendEvent(
        meta.taskId,
        "cancel_requested",
        "queued",
        reason ? `收到取消请求：${reason}` : "收到取消请求（无 reason）",
      );
      // pump 从队列取出任务到 orchestrator 首次写 running 之间，快照仍是 queued，
      // 但 AbortController 已注册。此时也必须中止，否则任务会在 cancelled 后继续执行。
      this.abortControllers.get(taskId)?.abort();
      await this.store.updateStatus(meta, "cancelled", meta.lastMessage);
      return { found: true, settled: true };
    }
    if (meta.status === "needs_user") {
      meta.cancelRequestedAt = nowIso();
      meta.abortSource = "user";
      meta.errorType = "cancelled";
      meta.cancelReason = reason;
      // needs_user 时 run 协程已退出、CDP 已断开，MCP 侧无连接可点 GUI 停止按钮；
      // GUI 内可能仍有等待中的会话，必须如实提示人工检查。
      meta.lastMessage = reason
        ? `已取消（等待用户处理时）：${reason}；GUI 内可能仍有等待中的会话，请人工检查。`
        : "已取消（等待用户处理时）；GUI 内可能仍有等待中的会话，请人工检查。";
      await this.store.appendEvent(meta.taskId, "cancel_requested", "needs_user", meta.lastMessage);
      await this.store.updateStatus(meta, "cancelled", meta.lastMessage);
      return { found: true, settled: true };
    }
    if (ACTIVE_STATUSES.includes(meta.status)) {
      // queued 之外的活动中任务：记 cancel_requested（含 cancelReason）再 abort
      await this.store.markCancelRequested(meta, reason);
      this.abortControllers.get(taskId)?.abort();
      // 有界等待编排侧落终态：上限必须覆盖 GUI 侧"点击停止 + cancelWaitMs 等待"预算
      // （cancelWaitMs 默认 15s）+ 轮询与快照写入余量。超时仍返回（任务会自行落终态）。
      const deadline = Date.now() + CANCEL_SETTLE_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        const snap = await this.store.readSnapshot(taskId).catch(() => null);
        if (snap && isTerminal(snap.status)) return { found: true, settled: true };
      }
      return {
        found: true,
        settled: false,
        reason: "已请求取消，但任务尚未在本调用内落终态（GUI 侧停止可能未完成）；请稍后 query_task 复核",
      };
    }
    return { found: true, reason: `任务已处于终态（${meta.status}），无需取消`, settled: true };
  }

  /** server 退出：终止全部活动任务并标 interrupted（排队中任务也归档） */
  async shutdownInterrupt(): Promise<void> {
    for (const ac of this.abortControllers.values()) ac.abort();
    // 有界等待 kill：每个任务最多给 2s，全部并行的等待不超过 ~2s，避免固定 400ms 竞态
    const killPromises: Promise<void>[] = [];
    for (const id of this.running) {
      const meta = this.tasks.get(id);
      if (meta && ACTIVE_STATUSES.includes(meta.status)) {
        killPromises.push(this.persistInterrupted(meta));
      }
    }
    await Promise.all(killPromises);
    // 排队中任务归档
    for (const [taskId, meta] of this.tasks) {
      if (meta.status === "queued") {
        meta.status = "interrupted";
        meta.errorType = "interrupted";
        meta.abortSource = "shutdown";
        meta.lastMessage = "server 退出，排队中任务已归档";
        await this.store.updateStatus(meta, "interrupted", meta.lastMessage).catch(() => {});
        void taskId;
      }
    }
    this.running.clear();
    this.runningCount = 0;
    this.queue.clear();
  }

  /** 有界等待子进程真正关闭后落 interrupted（server 关闭路径，不得误记为 cancelled） */
  private async persistInterrupted(meta: TaskMeta): Promise<void> {
    const deadline = Date.now() + 2000;
    for (;;) {
      if (!ACTIVE_STATUSES.includes(meta.status)) return; // orchestrator 已落终态
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    if (ACTIVE_STATUSES.includes(meta.status)) {
      meta.status = "interrupted";
      meta.errorType = "interrupted";
      meta.abortSource = "shutdown";
      meta.lastMessage = "server 退出，进程已终止";
      await this.store.updateStatus(meta, "interrupted", meta.lastMessage).catch(() => {});
    }
  }

  private enqueue(meta: TaskMeta): void {
    const key = meta.projectPath;
    if (!this.queue.has(key)) this.queue.set(key, []);
    const q = this.queue.get(key)!;
    if (!q.includes(meta.taskId)) q.push(meta.taskId);
    this.pump();
  }

  /** 该项目当前是否有 running 任务（每项目串行闸） */
  private projectBusy(key: string): boolean {
    for (const id of this.running) {
      const m = this.tasks.get(id);
      if (m && m.projectPath === key) return true;
    }
    return false;
  }

  /** 调度泵：有名额时，从"无 running 任务的非空项目"各启动一个队首任务，直到闸满或无就绪 */
  private pump(): void {
    for (;;) {
      if (this.runningCount >= this.maxRunning) return;
      let started = false;
      for (const [key, q] of this.queue) {
        if (q.length === 0) {
          this.queue.delete(key);
          continue;
        }
        if (this.projectBusy(key)) continue; // 该项目已有任务在跑，串行等待
        const idx = q.findIndex((id) => this.tasks.get(id)?.status === "queued");
        if (idx < 0) continue; // 队列里全是非 queued（如已取消）
        const id = q[idx]!;
        q.splice(idx, 1);
        const meta = this.tasks.get(id)!;
        void this.startTask(meta);
        started = true;
        break; // 每轮只启动一个；有剩余名额则下一轮继续
      }
      if (!started) {
        // 收尾：清理空队列
        for (const [k, qq] of this.queue) if (qq.length === 0) this.queue.delete(k);
        return;
      }
    }
  }

  private async startTask(meta: TaskMeta): Promise<void> {
    if (this.runningCount >= this.maxRunning) {
      this.enqueue(meta);
      return;
    }
    this.running.add(meta.taskId);
    this.runningCount++;
    const ac = new AbortController();
    this.abortControllers.set(meta.taskId, ac);
    this.logger.info(
      `任务 ${meta.taskId} 启动（agent=${meta.agentId}, project=${meta.projectPath}, roundsUsed=${meta.roundsUsed}）`,
    );

    // 消费 rework 指示：启动时原子取走并清空。
    // 必须在启动时清空，而不是运行结束后的收尾里——终态快照先落盘，调用方看到
    // failed 后可立即 rework_task 写入新的 reworkFeedback，而上一轮的收尾 delete
    // 会把这条新反馈一起抹掉，导致返修轮拿不到指示（实测负载下偶发）。
    const reworkFeedback = meta.reworkFeedback;
    if (reworkFeedback) {
      delete meta.reworkFeedback;
      await this.store.writeSnapshot(meta);
    }

    // 超时兜底（R2）：runChild 在 meta.taskTimeoutMs 处自行 kill 并返回 timeout → orchestrator 落 failed(timeout)。
    // 此 guard 只在非子进程阶段（resolve/编排卡死）长时间未返回时兜底，附一小段有文档说明的 kill grace。
    const KILL_GRACE_MS = 15_000;
    const guard = setTimeout(() => {
      const m = this.tasks.get(meta.taskId);
      if (m && ACTIVE_STATUSES.includes(m.status)) {
        this.logger.warn(
          `任务 ${meta.taskId} 超过任务级超时兜底（${meta.taskTimeoutMs}+${KILL_GRACE_MS}ms），标记 timeout 并 abort`,
        );
        m.errorType = "timeout";
        m.abortSource = "timeout";
        m.lastMessage = `任务超时兜底触发（${meta.taskTimeoutMs}ms + ${KILL_GRACE_MS}ms grace）。`;
        ac.abort();
      }
    }, meta.taskTimeoutMs + KILL_GRACE_MS);
    guard.unref?.();

    try {
      const orch = new TaskOrchestrator(
        {
          store: this.store,
          dataHome: this.dataHome,
          registry: this.registry,
          engine: this.engine,
          logger: this.logger,
          buildCtx: this.buildCtx,
        },
        meta,
        ac.signal,
        reworkFeedback, // 启动时已取走并清空（见上）
      );
      const result = await orch.run();
      // 防御：以持久化 meta 为准 —— orchestrator 返回 status 与持久化 status 不一致时告警。
      const persisted = (await this.store.readSnapshot(meta.taskId)) ?? meta;
      if (persisted.status !== result.status) {
        this.logger.warn(
          `任务 ${meta.taskId} 状态不一致：orchestrator=${result.status}, 持久化=${persisted.status}；以持久化 meta 为准`,
        );
      }
      this.tasks.set(meta.taskId, persisted);
      this.logger.info(`任务 ${meta.taskId} 结束: ${persisted.status}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      meta.status = "failed";
      meta.errorType = "internal";
      meta.lastMessage = `manager 内部错误: ${msg}`;
      await this.store.updateStatus(meta, "failed", meta.lastMessage).catch(() => {});
      this.logger.error(`任务 ${meta.taskId} manager 异常: ${msg}`);
    } finally {
      clearTimeout(guard);
      this.running.delete(meta.taskId);
      this.runningCount--;
      this.abortControllers.delete(meta.taskId);
      this.pump();
    }
  }
}
