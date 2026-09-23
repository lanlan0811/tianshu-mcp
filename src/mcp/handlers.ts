/**
 * 11 个工具的具体 handler。统一返回 ToolResult（文本 + meta 块）。
 * run_task / rework / verify 依赖 AppContext 提供的 manager/engine/services。
 */
import fsp from "node:fs/promises";
import { validateQoderReferences } from "../agents/qoder/references.js";
import { normalizeLevel } from "../agents/qoder/model.js";
import {
  prepareBaseline,
  approveBaseline,
  PrepareBaselineSchema,
  ApproveBaselineSchema,
} from "../visual/baselines.js";
import { assertSafeProjectDir, normPath, resolveProjectDir } from "../util/path.js";
import { execFileAsync } from "../verify/exec.js";
import {
  type RunTaskParams,
  type QueryTaskParams,
  type ListTasksParams,
  type GetReportParams,
  type CancelTaskParams,
  type VerifyTaskParams,
  type ReworkTaskParams,
  type ContinueTaskParams,
  type ServerConfig,
  type ProjectRecord,
} from "../config/schema.js";
import { toAcceptanceDef, type DataHome } from "../config/store.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { AcceptanceEngine } from "../verify/acceptance.js";
import type { AgentAdapterRegistry } from "../agents/registry.js";
import type { TaskStore } from "../tasks/task-store.js";
import {
  isDefaultWorkspace,
  isTerminal,
  type TaskMeta,
  type TaskStatus,
  type VerifyReport,
} from "../tasks/task.js";
import {
  canonicalDigest,
  IdempotencyIndex,
  keyDigest,
  type IdempotencyEntry,
} from "../tasks/idempotency.js";
import { genTaskId, genVerifyId, nowIso } from "../util/id.js";
import type { Logger } from "../util/log.js";
import {
  formatToolResult,
  errorResult,
  metaFromTask,
  readLogTail,
  textResult,
  type MetaBlockFields,
  type ToolResult,
} from "./formatter.js";
import {
  captureBaseline,
  gitRefExists,
  type Baseline as BaselineT,
} from "../verify/git-baseline.js";
import { readTextSafe, readJsonSafe } from "../util/fs.js";
import { readLatestReportSummary } from "../loop/fix-loop.js";
import { readDirSafe } from "../util/fs.js";
import { parseZcodeModel } from "../agents/zcode/model.js";
import { describeLevelValueError, parseKimicodeModel } from "../agents/kimicode/model.js";
import { validateTaskReferences } from "../agents/zcode/references.js";

/** 任务目录里下一可用 report round（避免手动验收覆盖已有 report-0/1…） */
async function nextReportRound(store: TaskStore, taskId: string | undefined): Promise<number> {
  if (!taskId) return 0;
  const dirs = await readDirSafe(store.dir(taskId));
  const rounds = dirs
    .filter((d) => /^report-(\d+)\.(md|json)$/.test(d))
    .map((d) => {
      const m = /^report-(\d+)\./.exec(d);
      return m ? Number(m[1]) : -1;
    });
  return rounds.length ? Math.max(...rounds) + 1 : 0;
}

export interface AppContext {
  manager: TaskManager;
  engine: AcceptanceEngine;
  registry: AgentAdapterRegistry;
  dataHome: DataHome;
  store: TaskStore;
  logger: Logger;
}

export interface Defaults {
  defaultAgentId: string;
  defaultAutoVerify: boolean;
  defaultAutoFixRounds: number;
}

/* ---------------- 幂等键（issue #15）：文案、错误与判定 ---------------- */

/** 同键异参的 fail-closed 错误：回报原记录 id，绝不静默返回错误对象的结果。 */
function idempotencyConflictError(
  scope: "run_task" | "verify_task",
  key: string,
  entry: IdempotencyEntry,
): ToolResult {
  const noun = scope === "run_task" ? "任务" : "验收记录";
  return errorResult(
    `idempotencyKey '${key}' 已被${noun} ${entry.taskId} 占用，但本次参数与首次提交不同。` +
      `幂等键不能在参数变更后复用：请改用新的 key，或直接对原记录操作（query_task / get_task_report / rework_task）。`,
  );
}

/** 幂等命中时向原任务/记录的事件流补一条审计 note；键明文不入事件流（只用摘要）。 */
async function appendIdempotencyNote(
  ctx: AppContext,
  entry: IdempotencyEntry,
  status: TaskStatus,
  detail: string,
): Promise<void> {
  await ctx.store
    .appendEvent(entry.taskId, "note", status, `幂等重放：keyDigest=${keyDigest(entry.key)}（${detail}）`)
    .catch((e) => ctx.logger.warn(`幂等审计事件写入失败（${entry.taskId}）：${String(e)}`));
}

/** run_task 幂等摘要的语义字段（不含幂等键本身，也不含运行期默认值/profile 派生物）。 */
function runTaskKeyedFields(args: RunTaskParams): Record<string, unknown> {
  return {
    agentId: args.agentId,
    task: args.task,
    context: args.context,
    model: args.model,
    reasoningLevel: args.reasoningLevel,
    modelSource: args.modelSource,
    planDoc: args.planDoc,
    designSystem: args.designSystem,
    mode: args.mode,
    allowCreateProject: args.allowCreateProject,
    autoVerify: args.autoVerify,
    autoFixRounds: args.autoFixRounds,
    taskTimeoutMs: args.taskTimeoutMs,
  };
}

/** 幂等重放的响应行：如实回报既有任务的当前状态（含终态），不承诺会重新派发。 */
function runTaskReplayLines(meta: TaskMeta): string[] {
  const lines = [
    `幂等重放：该 idempotencyKey 已对应任务 ${meta.taskId}（未新建任务）。`,
    describeStatus(meta),
    `Agent: ${meta.agentId}`,
    `项目: ${meta.projectPath || "（无项目模式：ZCode default 工作区）"}`,
    meta.lastMessage ? `最近消息: ${meta.lastMessage}` : "",
  ].filter((s) => s !== "");
  if (isTerminal(meta.status)) {
    lines.push(
      `任务已处于终态（${meta.status}）：如需继续处理请用 rework_task(${meta.taskId})，或改用新的 idempotencyKey 重新派单。`,
    );
  } else {
    lines.push(`请用 query_task(${meta.taskId}) 继续轮询。`);
  }
  return lines;
}

/** run_task 的锁外预检：命中即重放（连校验都不再跑），冲突即报错，其余返回 null 继续。 */
async function precheckRunTask(
  ctx: AppContext,
  idempotency: IdempotencyIndex,
  key: string,
  digest: string,
): Promise<ToolResult | null> {
  const found = await idempotency.lookup("run_task", key, digest);
  if (found.kind === "conflict") return idempotencyConflictError("run_task", key, found.entry);
  if (found.kind === "miss") return null;
  const existing = await ctx.manager.getMeta(found.entry.taskId);
  if (!existing) {
    // 记录存在但任务快照不可读 = 上次进程在「写完映射、建任务之前」崩溃：视为未生效并重新派发
    ctx.logger.warn(
      `幂等记录 ${found.entry.taskId}（keyDigest=${keyDigest(key)}）无对应任务快照，视为未生效并重新派发`,
    );
    return null;
  }
  await appendIdempotencyNote(ctx, found.entry, existing.status, "未新建任务");
  return formatToolResult(
    runTaskReplayLines(existing).join("\n"),
    metaFromTask(existing, { idempotencyReplay: "hit" }),
  );
}

/** 幂等提交的结局：重放/冲突（直接返回结果）或已创建（继续拼装新派单响应）。 */
type KeyedSubmitOutcome =
  | { kind: "result"; result: ToolResult }
  | { kind: "created"; meta: TaskMeta; persistenceWarning?: string };

/**
 * 锁内「判定 → 落映射 → 建任务」：并发同名请求在此排队并复检，不会各自建一个任务。
 * 先落映射再建任务，消除「映射已写、任务未建」的崩溃窗口（§6.1）。
 */
async function submitKeyedTask(opts: {
  ctx: AppContext;
  idempotency: IdempotencyIndex;
  key: string;
  digest: string;
  submit: (taskId: string) => Promise<TaskMeta>;
}): Promise<KeyedSubmitOutcome> {
  const { ctx, idempotency, key, digest, submit } = opts;
  return idempotency.runExclusive("run_task", key, async () => {
    const again = await idempotency.lookup("run_task", key, digest);
    if (again.kind === "conflict") {
      return { kind: "result", result: idempotencyConflictError("run_task", key, again.entry) };
    }
    if (again.kind === "hit") {
      const existing = await ctx.manager.getMeta(again.entry.taskId);
      if (existing) {
        await appendIdempotencyNote(ctx, again.entry, existing.status, "未新建任务");
        return {
          kind: "result",
          result: formatToolResult(
            runTaskReplayLines(existing).join("\n"),
            metaFromTask(existing, { idempotencyReplay: "hit" }),
          ),
        };
      }
    }
    const taskId = genTaskId();
    const rec = await idempotency.record({
      scope: "run_task",
      key,
      digest,
      taskId,
      kind: "task",
      createdAt: nowIso(),
    });
    const meta = await submit(taskId);
    return {
      kind: "created",
      meta,
      persistenceWarning: rec.persisted
        ? undefined
        : `幂等记录写入失败（${rec.error ?? "未知原因"}），本任务无法被同键重放`,
    };
  });
}

/** 未传幂等键时的重复派单提示（只读内存，不参与任何判定）。 */
function duplicateDispatchLine(active: TaskMeta): string {
  return `提示：该工作区已有未结束任务 ${active.taskId}（状态 ${active.status}），本次为新派单；若这是对上一次请求的重试，请改用 idempotencyKey 或先 query_task 复核。`;
}

/** 新派单响应里的幂等说明行。 */
function idempotencyCreatedLine(key: string): string {
  return `幂等键：${key}（重复提交将返回本任务，不会新建；TTL 见 server 配置 idempotency.ttlMs，默认 24h）。`;
}

/** 幂等映射落盘失败时的如实披露（fail-open：绝不把已派发的任务报成失败）。 */
function idempotencyWarningLine(warning: string): string {
  return `注意：${warning}。`;
}

export function makeHandlers(ctx: AppContext, defaults: Defaults) {
  // 幂等索引（issue #15）：实例挂在闭包里而不是进 AppContext，避免牵动全部构造点
  // （含测试里的假上下文）。索引内部懒加载、懒算路径，不传幂等键时完全不触盘。
  const idempotency = new IdempotencyIndex({
    home: ctx.dataHome.dir,
    store: ctx.store,
    logger: ctx.logger,
    loadConfig: () => ctx.dataHome.loadConfig(),
  });
  return {
    prepare_visual_baseline: async (args: Record<string, unknown>) =>
      textResult(
        JSON.stringify(
          await ctx.engine.runVisualOperation((signal) =>
            prepareBaseline(ctx.dataHome.dir, PrepareBaselineSchema.parse(args), signal),
          ),
          null,
          2,
        ),
      ),
    approve_visual_baseline: async (args: Record<string, unknown>) =>
      textResult(
        JSON.stringify(
          await approveBaseline(ctx.dataHome.dir, ApproveBaselineSchema.parse(args)),
          null,
          2,
        ),
      ),
    run_task: runTaskHandler(ctx, defaults, idempotency),
    query_task: queryTaskHandler(ctx),
    list_tasks: listTasksHandler(ctx),
    get_task_report: getReportHandler(ctx),
    cancel_task: cancelTaskHandler(ctx),
    verify_task: verifyTaskHandler(ctx, idempotency),
    rework_task: reworkTaskHandler(ctx),
    continue_task: continueTaskHandler(ctx),
    get_profiles: getProfilesHandler(ctx),
  };
}

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * 仓库未提交变更计数（git status --porcelain 行数）。
 * 非 git 仓库、git 不存在或执行失败 → null（调用方不展示）。
 * 仅作 run_task 提交时的共处警示，不参与任何判定。
 */
async function gitDirtyCount(dir: string): Promise<number | null> {
  try {
    const res = await execFileAsync("git", ["-C", dir, "status", "--porcelain"], {
      timeoutMs: 5_000,
    });
    if (res.status !== 0) return null;
    return res.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  } catch {
    return null;
  }
}

function runTaskHandler(
  ctx: AppContext,
  defaults: Defaults,
  idempotency: IdempotencyIndex,
): Handler {
  const { manager, dataHome, logger } = ctx;
  return async (rawArgs) => {
    const args = rawArgs as RunTaskParams;
    // 无项目模式（issue #12）：省略 projectPath 时不做目录校验与项目登记，
    // 待解析出最终 agent 之后再判断它是否支持无项目。
    if (args.projectPath === undefined) {
      return runTaskWithoutProject(ctx, defaults, args, idempotency);
    }
    // 安全闸门：绝对路径 + 存在 + realpath 消除符号链接 + 拒绝主目录/系统根目录
    let dir: ReturnType<typeof assertSafeProjectDir>;
    try {
      dir = assertSafeProjectDir(args.projectPath);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
    const norm = dir.norm;
    const digest = canonicalDigest({
      workspaceMode: "project",
      projectPath: norm,
      args: runTaskKeyedFields(args),
    });
    // 幂等预检（锁外）：命中即重放，连校验都不再跑——原任务是否存在与当前 agent 是否可用无关
    if (args.idempotencyKey !== undefined) {
      const early = await precheckRunTask(ctx, idempotency, args.idempotencyKey, digest);
      if (early) return early;
    }
    const dirtyCount = await gitDirtyCount(dir.canonical);
    // 重复派单提示必须在 submit 之前采样，否则会命中刚建的任务自身
    const activeTask = manager.activeTaskOfWorkspace({
      workspaceMode: "project",
      projectPath: norm,
    });

    // 项目自动登记（首次出现即登记，R10）。登记失败即终止派单：否则会留下
    // 「任务已建、项目未登记」的半状态，projectByPath / list_tasks 等按项目维度的
    // 查询全部失真。registerProject 已返回记录，此处直接消费，不再二次读取。
    const agentId = args.agentId ?? defaults.defaultAgentId;
    let record: ProjectRecord | undefined;
    try {
      ({ record } = await dataHome.registerProject(norm, agentId));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.logger.warn(`项目登记失败，未派单：${norm}（${msg}）`);
      return errorResult(`项目登记失败，未派单：${msg}`);
    }
    const finalAgentId = record?.defaultAgentId ?? agentId;

    // 校验 agent 可解析（立即失败返回，不给天枢排队假象）
    const resolved = await ctx.registry.resolve(finalAgentId, true);
    if (!resolved.ok) {
      return formatToolResult(`agent '${finalAgentId}' 当前不可用：${resolved.message}`, {
        ok: false,
        projectPath: norm,
        agentId: finalAgentId,
        message: resolved.message,
      });
    }
    if (finalAgentId !== "zcode" && args.allowCreateProject !== undefined) {
      return errorResult(
        `allowCreateProject 是 ZCode 专用参数，agent '${finalAgentId}' 不支持；请移除该参数后重试`,
      );
    }
    if (finalAgentId === "zcode") {
      if (args.mode !== undefined) return errorResult("ZCode 不支持 mode 参数；请移除 mode 后重试");
      try {
        parseZcodeModel(args.model);
        validateTaskReferences(args.task, args.context, norm);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    }
    if (finalAgentId === "codex") {
      if (args.mode !== undefined) return errorResult("Codex 不支持 mode 参数；请移除 mode 后重试");
      try {
        const refs = [args.planDoc, args.designSystem].filter((v): v is string => Boolean(v));
        if (refs.length)
          validateTaskReferences(refs.map((r) => `\`${r}\``).join(" "), undefined, norm);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    }

    if (args.modelSource !== undefined && resolved.profile.adapter !== "qoder-gui")
      return errorResult("modelSource 是 Qoder CN 专用参数");
    if (args.reasoningLevel && ["极高", "xhigh", "最大", "关闭思考"].includes(args.reasoningLevel) && resolved.profile.adapter !== "qoder-gui")
      return errorResult("该思考等级别名仅由 Qoder CN 适配器支持；其他适配器须使用其已支持的档位");
    if (resolved.profile.adapter === "qoder-gui") {
      if (args.mode !== undefined) return errorResult("Qoder CN 不支持 mode 参数");
      try {
        await validateQoderReferences(dir.canonical, args.planDoc);
        normalizeLevel(args.reasoningLevel);
      } catch (error) { return errorResult(String(error)); }
    }
    if (finalAgentId === "kimicode") {
      if (args.mode !== undefined)
        return errorResult("Kimi Code 不支持 mode 参数；请移除 mode 后重试");
      try {
        // 参数级只做「格式 + 取值合法性」：`中/medium` 之类不在档位取值域内的值在这里就报错；
        // 「官方 Low/High/Max vs 非官方 On/Off」的档位集合校验必须在运行期读界面档位标签，
        // 故留给 run.ts（此处拿不到界面状态，硬校验等于写死模型名单）。
        const spec = parseKimicodeModel(args.model, args.reasoningLevel);
        const levelError = describeLevelValueError(spec);
        if (levelError) throw new Error(levelError);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
    }

    const cfg = await dataHome.loadConfig();
    // 有效任务超时（R2）：调用参数 > profile > server 默认值，在提交时固化
    const taskTimeoutMs =
      args.taskTimeoutMs ?? resolved.profile.timeoutMs ?? cfg.defaultTaskTimeoutMs ?? 30 * 60_000;
    const submit = (taskId?: string) =>
      manager.submit({
        taskId,
        projectPath: norm,
        displayPath: dir.raw,
        agentId: finalAgentId,
        task: args.task,
        context: args.context,
        model: args.model,
        reasoningLevel: args.reasoningLevel,
        modelSource: args.modelSource,
        planDoc: args.planDoc,
        designSystem: args.designSystem,
        mode: args.mode,
        allowCreateProject: args.allowCreateProject,
        autoVerify: args.autoVerify ?? defaults.defaultAutoVerify,
        autoFixRounds:
          args.autoFixRounds ??
          resolved.profile.gui?.defaultAutoFixRounds ??
          defaults.defaultAutoFixRounds,
        taskTimeoutMs,
        idempotencyKey: args.idempotencyKey,
        idempotencyScope: args.idempotencyKey === undefined ? undefined : "run_task",
        idempotencyDigest: args.idempotencyKey === undefined ? undefined : digest,
      });
    let meta: TaskMeta;
    let persistenceWarning: string | undefined;
    if (args.idempotencyKey === undefined) {
      meta = await submit();
    } else {
      const outcome = await submitKeyedTask({
        ctx,
        idempotency,
        key: args.idempotencyKey,
        digest,
        submit,
      });
      if (outcome.kind === "result") return outcome.result;
      meta = outcome.meta;
      persistenceWarning = outcome.persistenceWarning;
    }
    logger.info(`run_task 已提交 ${meta.taskId} (agent=${finalAgentId}, project=${norm})`);
    const lines = [
      `任务已提交：${meta.taskId}`,
      `Agent: ${finalAgentId}${resolved.message ? `（${resolved.message}）` : ""}`,
      `项目: ${norm}${dir.viaSymlink ? `（经符号链接解析自 ${dir.raw}）` : ""}`,
      `自动验收: ${meta.autoVerify ? "开" : "关"}${meta.autoFixRounds > 0 ? `，自动返修上限 ${meta.autoFixRounds} 轮` : "（未开启自动返修）"}`,
      `队列位置：每项目串行 + 全局并发 ${ctx.manager.getMaxRunning()}。请用 query_task(${meta.taskId}) 轮询（建议间隔 5–10 秒）。`,
      `任务书摘要: ${args.task.slice(0, 120)}${args.task.length > 120 ? "…" : ""}`,
    ];
    if (activeTask) lines.push(duplicateDispatchLine(activeTask));
    if (args.idempotencyKey !== undefined) lines.push(idempotencyCreatedLine(args.idempotencyKey));
    if (dirtyCount !== null && dirtyCount > 0) {
      lines.push(
        `注意：该仓库当前有 ${dirtyCount} 个未提交变更（可能有其他会话/在途工作共处），worker 将直接在原工作区上改动，验收仅归因相对基线的净变更。`,
      );
    }
    if (persistenceWarning) lines.push(idempotencyWarningLine(persistenceWarning));
    return formatToolResult(
      lines.join("\n"),
      metaFromTask(meta, {
        projectActiveTask: activeTask
          ? { taskId: activeTask.taskId, status: activeTask.status }
          : undefined,
      }),
    );
  };
}

/**
 * 无项目派发（issue #12）：ZCode 的 default 工作区承接任务。
 *
 * 契约：不做项目登记、不分配目录；验收与自动返修强制关闭（无目录可验）；
 * 语义校验在解析出最终 agent 之后进行——默认 agent 不支持就报错，不擅自改判为 ZCode。
 */
async function runTaskWithoutProject(
  ctx: AppContext,
  defaults: Defaults,
  args: RunTaskParams,
  idempotency: IdempotencyIndex,
): Promise<ToolResult> {
  const { manager, logger } = ctx;
  const agentId = args.agentId ?? defaults.defaultAgentId;
  const digest = canonicalDigest({
    workspaceMode: "default",
    projectPath: "",
    args: runTaskKeyedFields(args),
  });
  // 幂等预检（锁外）：命中即重放，连校验都不再跑
  if (args.idempotencyKey !== undefined) {
    const early = await precheckRunTask(ctx, idempotency, args.idempotencyKey, digest);
    if (early) return early;
  }
  const activeTask = manager.activeTaskOfWorkspace({ workspaceMode: "default", projectPath: "" });
  const resolved = await ctx.registry.resolve(agentId, true);
  if (!resolved.ok) {
    return formatToolResult(`agent '${agentId}' 当前不可用：${resolved.message}`, {
      ok: false,
      agentId,
      message: resolved.message,
    });
  }
  if (agentId !== "zcode") {
    return errorResult(
      `agent '${agentId}' 需要 projectPath；无项目派发当前仅支持 ZCode（default 工作区）。请提供 projectPath 或改用 agentId=zcode。`,
    );
  }
  if (args.autoVerify === true) {
    return errorResult(
      "无项目模式不支持 autoVerify=true：没有项目目录可执行验收。请提供 projectPath，或省略该参数。",
    );
  }
  if ((args.autoFixRounds ?? 0) > 0) {
    return errorResult(
      "无项目模式不支持 autoFixRounds>0：自动返修依赖项目验收。请提供 projectPath，或传 0。",
    );
  }
  if (args.mode !== undefined) return errorResult("ZCode 不支持 mode 参数；请移除 mode 后重试");
  try {
    parseZcodeModel(args.model);
    // 无项目模式不做项目引用解析：识别到本地引用就在发送前说明需要 projectPath。
    validateTaskReferences(args.task, args.context, undefined);
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e));
  }

  const cfg = await ctx.dataHome.loadConfig();
  const taskTimeoutMs =
    args.taskTimeoutMs ?? resolved.profile.timeoutMs ?? cfg.defaultTaskTimeoutMs ?? 30 * 60_000;
  const submit = (taskId?: string) =>
    manager.submit({
      taskId,
      workspaceMode: "default",
      projectPath: "",
      displayPath: "",
      agentId,
      task: args.task,
      context: args.context,
      model: args.model,
      reasoningLevel: args.reasoningLevel,
      planDoc: args.planDoc,
      designSystem: args.designSystem,
      mode: args.mode,
      allowCreateProject: args.allowCreateProject,
      autoVerify: false,
      autoFixRounds: 0,
      taskTimeoutMs,
      idempotencyKey: args.idempotencyKey,
      idempotencyScope: args.idempotencyKey === undefined ? undefined : "run_task",
      idempotencyDigest: args.idempotencyKey === undefined ? undefined : digest,
    });
  let meta: TaskMeta;
  let persistenceWarning: string | undefined;
  if (args.idempotencyKey === undefined) {
    meta = await submit();
  } else {
    const outcome = await submitKeyedTask({
      ctx,
      idempotency,
      key: args.idempotencyKey,
      digest,
      submit,
    });
    if (outcome.kind === "result") return outcome.result;
    meta = outcome.meta;
    persistenceWarning = outcome.persistenceWarning;
  }
  logger.info(`run_task 已提交 ${meta.taskId}（agent=${agentId}，无项目模式）`);
  const lines = [
    `任务已提交：${meta.taskId}`,
    `Agent: ${agentId}（无项目模式：ZCode default 工作区）`,
    `模式: default —— 不采集 Git 基线、不执行项目验收、不创建/登记 ZCode 项目`,
    `自动验收: 关（无项目模式固定关闭，执行完成后不会生成验收报告）`,
    `队列位置：全局并发 ${ctx.manager.getMaxRunning()}。请用 query_task(${meta.taskId}) 轮询（建议间隔 5–10 秒）。`,
    `任务书摘要: ${args.task.slice(0, 120)}${args.task.length > 120 ? "…" : ""}`,
  ];
  if (activeTask) lines.push(duplicateDispatchLine(activeTask));
  if (args.idempotencyKey !== undefined) lines.push(idempotencyCreatedLine(args.idempotencyKey));
  if (persistenceWarning) lines.push(idempotencyWarningLine(persistenceWarning));
  return formatToolResult(
    lines.join("\n"),
    metaFromTask(meta, {
      projectActiveTask: activeTask
        ? { taskId: activeTask.taskId, status: activeTask.status }
        : undefined,
    }),
  );
}

function queryTaskHandler(ctx: AppContext): Handler {
  const { manager, store } = ctx;
  return async (rawArgs) => {
    const args = rawArgs as QueryTaskParams;
    const meta = await manager.getMeta(args.taskId);
    if (!meta) {
      return errorResult(`任务不存在: ${args.taskId}`);
    }
    const tailLines = args.tailLines ?? 40;
    let logTail = "";
    const logFile =
      meta.logFile ??
      (meta.roundsUsed > 0
        ? store.agentLogPath(meta.taskId, Math.max(0, meta.roundsUsed - 1))
        : undefined);
    if (logFile) {
      if (await existsFile(logFile)) logTail = await readLogTail(logFile, tailLines);
    }
    const statusLine = describeStatus(meta);
    const lines = [
      statusLine,
      meta.lastMessage ? `最近消息: ${meta.lastMessage}` : "",
      logTail
        ? `--- agent 日志尾部（${logTail.split("\n").length} 行）---\n${logTail}`
        : "（暂无 agent 日志）",
    ].filter((s) => s !== "");
    return formatToolResult(lines.join("\n"), metaFromTask(meta));
  };
}

async function existsFile(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function describeStatus(meta: TaskMeta): string {
  const map: Record<string, string> = {
    queued: "排队中（每项目串行，等待前面任务完成）",
    running: "运行中（agent 正在开发）",
    verify_start: "验收中（自动命令检查 + 代码分析）",
    fixing: "返修中（上一轮验收失败，agent 正在按反馈修改）",
    succeeded: "[PASS] 任务成功",
    failed: "[FAIL] 任务失败",
    needs_attention: "[WARN] 需要人工介入（自动返修轮次已用尽或可修性存疑）",
    needs_user: "等待用户处理（可用 continue_task 恢复）",
    cancelled: "已取消",
    interrupted: "已中断（server 重启/退出）",
  };
  return `状态: ${map[meta.status] ?? meta.status}${meta.roundsUsed ? `（已用 ${meta.roundsUsed} 轮）` : ""}`;
}

function listTasksHandler(ctx: AppContext): Handler {
  const { manager } = ctx;
  return async (rawArgs) => {
    const args = rawArgs as ListTasksParams;
    let projectPath: string | undefined;
    if (args.projectPath) {
      // 与 run_task 的存储口径一致：realpath 归一（目录已被删等异常情况退回词法归一）
      try {
        projectPath = resolveProjectDir(args.projectPath).norm;
      } catch {
        projectPath = normPath(args.projectPath);
      }
    }
    const list = await manager.listTasks({
      projectPath,
      status: args.status,
      limit: args.limit ?? 50,
    });
    if (list.length === 0) {
      return formatToolResult("没有符合条件的任务。", { ok: true, message: "空列表" });
    }
    const lines = list.map((m) => {
      return `${m.taskId}\t${m.status.padEnd(15)}\t${(m.agentId ?? "").padEnd(8)}\t${m.projectPath}\t${m.task.slice(0, 60)}`;
    });
    return formatToolResult(
      `任务列表（${list.length} 条，列: taskId / status / agent / project / 任务摘要）\n${lines.join("\n")}`,
      {
        ok: true,
        message: `共 ${list.length} 条`,
      },
    );
  };
}

function getReportHandler(ctx: AppContext): Handler {
  const { manager, store } = ctx;
  return async (rawArgs) => {
    const args = rawArgs as GetReportParams;
    const meta = await manager.getMeta(args.taskId);
    if (!meta) return errorResult(`任务不存在: ${args.taskId}`);
    if (isDefaultWorkspace(meta))
      return errorResult(
        `任务 ${args.taskId} 是无项目模式（default 工作区）：不产生项目验收报告（not_applicable: no_project）。执行结果请用 query_task 查看。`,
      );
    // round 缺省（undefined）取最新；显式 0 取第 0 轮（R4：0-based 合法）
    let round = args.round;
    if (round === undefined) {
      const latest = await readLatestReportSummary(store, args.taskId);
      if (!latest)
        return errorResult(`任务 ${args.taskId} 还没有验收报告（可能未启用验收或尚未验收）。`);
      round = latest.round;
    }
    const mdPath = store.reportMdPath(args.taskId, round);
    const text = await readTextSafe(mdPath);
    if (text == null) return errorResult(`第 ${round} 轮验收报告不存在（${mdPath}）。`);
    return textResult(text);
  };
}

function cancelTaskHandler(ctx: AppContext): Handler {
  const { manager } = ctx;
  return async (rawArgs) => {
    const args = rawArgs as CancelTaskParams;
    const res = await manager.cancel(args.taskId, args.reason);
    const meta = await manager.getMeta(args.taskId);
    if (meta) {
      // settled=false：GUI 侧停止尚未确认（issue #6 语义），明示编排方稍后复核
      const note =
        res.settled === false ? "（尚未落终态：GUI 侧停止可能未完成，请稍后 query_task 复核）" : "";
      return formatToolResult((res.reason ?? `已取消 ${args.taskId}。`) + note, metaFromTask(meta));
    }
    return errorResult(res.reason ?? `任务不存在: ${args.taskId}`);
  };
}

/** verify_task 幂等摘要的语义字段（只做路径归一，不采集基线、不跑命令）。 */
async function verifyIdempotencyDigest(args: VerifyTaskParams): Promise<string> {
  let pathNorm: string | undefined;
  if (args.projectPath && !args.taskId) {
    try {
      pathNorm = assertSafeProjectDir(args.projectPath).norm;
    } catch {
      // 路径本身不合法：摘要退回词法归一，真正的报错交给主流程
      pathNorm = normPath(args.projectPath);
    }
  }
  return canonicalDigest({
    taskId: args.taskId,
    projectPath: pathNorm,
    checksMode: args.checksMode,
    extraChecks: args.extraChecks,
    baselineRef: args.baselineRef,
  });
}

/** 同键验收正在执行：返回**成功结果**（不是 error，避免宿主把它当失败再重试放大）。 */
function verifyInProgressResult(
  key: string,
  taskId: string,
  existingTaskMode: boolean,
  status?: TaskStatus,
): ToolResult {
  const lines = [
    "该 idempotencyKey 对应的验收仍在执行中（未重复执行）。",
    existingTaskMode
      ? `任务 ${taskId}：请用 query_task(${taskId}) 查看进度，完成后用 get_task_report(${taskId}) 读报告。`
      : `验收记录 ${taskId}：该记录在验收完成后才落盘；请稍后用同一 key 重试（会返回既有报告，不会重跑），或完成后用 get_task_report(${taskId}) 读取。`,
  ];
  return formatToolResult(lines.join("\n"), {
    ok: true,
    taskId,
    status,
    message: "幂等命中：同一 key 的验收正在执行中",
    idempotencyKey: key,
    idempotencyReplay: "in_progress",
  });
}

/** 已完成验收的幂等重放：如实回报该 key 那次验收的轮次与结论，绝不重跑。 */
async function verifyReplayResult(
  ctx: AppContext,
  key: string,
  entry: IdempotencyEntry,
): Promise<ToolResult> {
  const real = await ctx.manager.getMeta(entry.taskId);
  if (real) await appendIdempotencyNote(ctx, entry, real.status, "未重跑验收");
  const message = `幂等重放：第 ${entry.reportRound ?? 0} 轮验收（未重跑）`;
  const replayFields: Partial<MetaBlockFields> = {
    ok: entry.verdict === "passed",
    reportRound: entry.reportRound,
    verificationSource: "manual",
    latestVerificationVerdict: entry.verdict,
    reportFiles:
      entry.reportMd || entry.reportJson
        ? { md: entry.reportMd, json: entry.reportJson }
        : undefined,
    idempotencyReplay: "hit",
    message,
  };
  const lines = [
    `${entry.verdict === "passed" ? "[PASS]" : "[FAIL]"} 幂等重放：该 idempotencyKey 已对应第 ${entry.reportRound ?? 0} 轮验收（未重跑）。`,
  ];
  if (entry.reportMd) lines.push(`报告：${entry.reportMd}`);
  if (entry.reportJson) lines.push(`JSON：${entry.reportJson}`);
  if (real) return formatToolResult(lines.join("\n"), metaFromTask(real, replayFields));
  const fallback: MetaBlockFields = {
    taskId: entry.taskId,
    status: "succeeded",
    ...replayFields,
    message,
    ok: entry.verdict === "passed",
  };
  return formatToolResult(lines.join("\n"), fallback);
}

/**
 * verify_task 的幂等判定。
 * `includeInFlight`：锁外预检要看「执行中」；抢占成功后**必须**跳过它——否则会把本次自己
 * 刚抢占的标记误判成「别人在执行」。
 */
async function precheckVerify(
  ctx: AppContext,
  idempotency: IdempotencyIndex,
  key: string,
  digest: string,
  existingTaskMode: boolean,
  includeInFlight: boolean,
): Promise<ToolResult | null> {
  if (includeInFlight) {
    const inflight = idempotency.inFlightOf("verify_task", key);
    if (inflight) {
      const status = existingTaskMode
        ? (await ctx.manager.getMeta(inflight.taskId))?.status
        : undefined;
      return verifyInProgressResult(key, inflight.taskId, existingTaskMode, status);
    }
  }
  const found = await idempotency.lookup("verify_task", key, digest);
  if (found.kind === "conflict") return idempotencyConflictError("verify_task", key, found.entry);
  if (found.kind === "hit") return verifyReplayResult(ctx, key, found.entry);
  return null;
}

function verifyTaskHandler(ctx: AppContext, idempotency: IdempotencyIndex): Handler {
  const { manager, dataHome, store } = ctx;
  return async (rawArgs) => {
    const args = rawArgs as VerifyTaskParams;
    const key = args.idempotencyKey;
    const digest = key === undefined ? undefined : await verifyIdempotencyDigest(args);
    // 幂等预检放在昂贵步骤（基线采集、命令执行）之前
    if (key !== undefined && digest !== undefined) {
      const early = await precheckVerify(ctx, idempotency, key, digest, args.taskId !== undefined, true);
      if (early) return early;
    }
    const extraChecks = args.extraChecks?.map((c) => toAcceptanceDef(c));
    // 用任务或项目
    let projectPath: string;
    let displayPath: string;
    let taskText: string | undefined;
    let taskId = args.taskId;
    let baseline;
    if (args.projectPath && !taskId) {
      let dir: ReturnType<typeof assertSafeProjectDir>;
      try {
        dir = assertSafeProjectDir(args.projectPath);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : String(e));
      }
      projectPath = dir.norm;
      displayPath = dir.raw;
      // baselineRef：Git ref（任务 ID 不适用独立路径）
      if (args.baselineRef) {
        if (!(await gitRefExists(projectPath, args.baselineRef))) {
          return errorResult(
            `baselineRef '${args.baselineRef}' 不是有效 Git ref（项目 ${projectPath}）。`,
          );
        }
        baseline = { ...(await captureBaseline(projectPath)), head: args.baselineRef };
      } else {
        baseline = await captureBaseline(projectPath);
      }
    } else if (taskId) {
      const meta = await manager.getMeta(taskId);
      if (!meta) return errorResult(`任务不存在: ${taskId}`);
      if (isDefaultWorkspace(meta))
        return errorResult(
          `任务 ${taskId} 是无项目模式（default 工作区）：没有项目可验收（not_applicable: no_project）。请对真实 projectPath 发起独立验收，或改用 projectPath 参数。`,
        );
      projectPath = meta.projectPath;
      displayPath = meta.displayPath;
      taskText = meta.task;
      // 默认用该任务动工前基线（保存于任务目录）；baselineRef=task 或特定 git ref 可覆盖
      const savedBaseline = await readJsonSafe<BaselineT>(store.baselinePath(taskId));
      if (args.baselineRef && args.baselineRef !== "task") {
        if (!(await gitRefExists(projectPath, args.baselineRef))) {
          return errorResult(
            `baselineRef '${args.baselineRef}' 不是有效 Git ref（项目 ${projectPath}）。`,
          );
        }
        baseline = {
          ...(savedBaseline ?? (await captureBaseline(projectPath))),
          head: args.baselineRef,
        };
      } else {
        baseline = savedBaseline ?? (await captureBaseline(projectPath));
        if (!savedBaseline) {
          return errorResult(
            `任务 ${taskId} 没有保存的动工前基线（任务可能在改造前创建）。请用 projectPath 单独验收，或传 baselineRef=git ref。`,
          );
        }
      }
    } else {
      return errorResult("verify_task 需要 taskId 或 projectPath（二选一）。");
    }

    const cfg = await dataHome.loadConfig();
    const proj = await dataHome.projectByPath(projectPath);
    const projectVerify = proj.record?.verify?.map((v) => {
      const cmd = Array.isArray(v.cmd) ? [...v.cmd] : v.cmd;
      return {
        name: v.name,
        cmd: Array.isArray(cmd) ? cmd : [cmd],
        displayCmd: Array.isArray(cmd) ? cmd.join(" ") : cmd,
      };
    });

    // round 分配：手动验收写入任务目录时不能覆盖已有 report-0.*，分配下一可用轮次
    let round = await nextReportRound(store, taskId);

    const verifyTaskId = taskId ?? genVerifyId();
    // 抢占同键「执行中」标记：未抢到说明同键验收正在执行——立刻如实回报，而不是排队数分钟
    let reserved = false;
    if (key !== undefined && digest !== undefined) {
      reserved = idempotency.reserveInFlight("verify_task", key, verifyTaskId);
      if (!reserved) {
        const cur = idempotency.inFlightOf("verify_task", key);
        const status = taskId ? (await manager.getMeta(taskId))?.status : undefined;
        return verifyInProgressResult(
          key,
          cur?.taskId ?? verifyTaskId,
          taskId !== undefined,
          status,
        );
      }
      // 抢占后复检（跳过自己的在途标记）：上一次同键调用可能已在本次判定与抢占之间完成并落了报告
      const raced = await precheckVerify(ctx, idempotency, key, digest, taskId !== undefined, false);
      if (raced) {
        idempotency.releaseInFlight("verify_task", key);
        return raced;
      }
    }
    try {
      const executed = await executeVerify(ctx, {
        args,
        projectPath,
        displayPath,
        taskText,
        taskId,
        verifyTaskId,
        baseline,
        cfg,
        projectVerify,
        round,
        extraChecks,
        idempotencyKey: key,
        idempotencyDigest: digest,
      });
      if (executed.kind === "error") return executed.result;
      const detailLines = [
        `${executed.head}`,
        `变更 ${executed.changed} 个文件，diffstat ${executed.resultMeta.diffstat}。`,
        `报告：${executed.report.files.md}`,
        `JSON：${executed.report.files.json}`,
      ];
      if (key !== undefined && digest !== undefined) {
        const rec = await idempotency.record({
          scope: "verify_task",
          key,
          digest,
          taskId: executed.resultMeta.taskId,
          kind: "verify",
          createdAt: nowIso(),
          reportRound: executed.round,
          verdict: executed.passed ? "passed" : "failed",
          reportMd: executed.report.files.md,
          reportJson: executed.report.files.json,
        });
        detailLines.push(
          rec.persisted
            ? `幂等键：${key}（重复提交将返回本轮报告，不会重跑验收）。`
            : idempotencyWarningLine(
                `幂等记录写入失败（${rec.error ?? "未知原因"}），本 key 无法重放`,
              ),
        );
      }
      return formatToolResult(detailLines.join("\n"), metaFromTask(executed.resultMeta));
    } finally {
      if (reserved && key !== undefined) idempotency.releaseInFlight("verify_task", key);
    }
  };
}

/**
 * 执行一次真实验收并持久化结果（issue #15 抽出的执行体：让幂等路径能用 try/finally
 * 保证「执行中」标记一定释放，同时保持原有文案与行为逐字不变）。
 * 独立 projectPath 模式会把幂等键写进新建的 vfy 记录（供映射损坏时重建）；
 * taskId 模式**不写**原任务快照的幂等字段——避免覆盖该任务的派单键、避免语义混淆。
 */
async function executeVerify(
  ctx: AppContext,
  input: {
    args: VerifyTaskParams;
    projectPath: string;
    displayPath: string;
    taskText: string | undefined;
    taskId: string | undefined;
    verifyTaskId: string;
    baseline: BaselineT | undefined;
    cfg: ServerConfig;
    projectVerify:
      | { name: string; cmd: string[]; displayCmd: string }[]
      | undefined;
    round: number;
    extraChecks: ReturnType<typeof toAcceptanceDef>[] | undefined;
    idempotencyKey: string | undefined;
    idempotencyDigest: string | undefined;
  },
): Promise<
  | {
      kind: "ok";
      resultMeta: TaskMeta;
      report: VerifyReport;
      passed: boolean;
      head: string;
      changed: number;
      round: number;
    }
  | { kind: "error"; result: ToolResult }
> {
  const { manager, engine, store, logger } = ctx;
  const { args, projectPath, displayPath, taskText, taskId, verifyTaskId, baseline } = input;
  let round = input.round;
  const req = {
    taskId: verifyTaskId,
    projectPath,
    displayPath,
    taskText,
    round,
    config: input.cfg,
    extraChecks: input.extraChecks,
    checksMode: args.checksMode ?? "append",
    projectVerify: input.projectVerify,
    baseline,
    store,
    logger,
  };
  const { report, passed } = await engine.runVerify(req);
  round = report.round;
  const head = passed
    ? `[PASS] 手动验收通过（reportRound ${round}）：${report.checks.filter((c) => c.passed).length}/${report.checks.length} 项检查通过。`
    : `[FAIL] 手动验收失败（reportRound ${round}）：${report.checks.filter((c) => !c.passed && !c.skipped).length} 项检查未通过。`;
  const changed = report.analysis.changedFiles.length + report.analysis.untrackedFiles.length;
  const diffstat = `+${report.analysis.diffstat.totalAdd} -${report.analysis.diffstat.totalDel}`;

  // S4：taskId 模式下更新并持久化原任务元数据（保留原 agentId，不改任务终态；新增单独验收结论字段）。
  let resultMeta: TaskMeta;
  if (taskId) {
    const real = await manager.getMeta(taskId);
    if (!real) return { kind: "error", result: errorResult(`任务不存在: ${taskId}`) };
    real.reportRound = round;
    real.verificationSource = "manual";
    real.latestVerificationVerdict = passed ? "passed" : "failed";
    real.reportMd = report.files.md;
    real.reportJson = report.files.json;
    real.lastMessage = head;
    real.changedFiles = [...report.analysis.changedFiles, ...report.analysis.untrackedFiles];
    real.diffstat = diffstat;
    real.updatedAt = report.finishedAt;
    await manager.persistMetaUpdate(real);
    resultMeta = real;
  } else {
    // 独立 projectPath 验收：创建并持久化独立 vfy 记录
    resultMeta = {
      taskId: verifyTaskId,
      status: passed ? "succeeded" : report.blockingIssues?.length ? "needs_attention" : "failed",
      projectPath,
      displayPath,
      agentId: "manual-verify",
      task: taskText ?? "(手动验收)",
      autoVerify: true,
      autoFixRounds: 0,
      taskTimeoutMs: 0,
      round: 0,
      roundsUsed: 0,
      reportRound: round,
      verificationSource: "manual",
      latestVerificationVerdict: passed ? "passed" : "failed",
      createdAt: report.startedAt,
      updatedAt: report.finishedAt,
      lastMessage: head,
      changedFiles: [...report.analysis.changedFiles, ...report.analysis.untrackedFiles],
      diffstat,
      reportMd: report.files.md,
      reportJson: report.files.json,
      // 幂等键随独立记录落盘：映射文件损坏时可由 vfy 快照重建该键的重放能力
      idempotencyKey: input.idempotencyKey,
      idempotencyScope: input.idempotencyKey === undefined ? undefined : "verify_task",
      idempotencyDigest: input.idempotencyKey === undefined ? undefined : input.idempotencyDigest,
    };
    await manager.persistMetaUpdate(resultMeta);
  }
  return { kind: "ok", resultMeta, report, passed, head, changed, round };
}

function reworkTaskHandler(ctx: AppContext): Handler {
  const { manager } = ctx;
  return async (rawArgs) => {
    const args = rawArgs as ReworkTaskParams;
    const meta = await manager.getMeta(args.taskId);
    if (!meta) return errorResult(`任务不存在: ${args.taskId}`);
    const res = await manager.rework(args.taskId, args.feedback);
    if (!res.found) return errorResult(res.reason ?? `无法 rework ${args.taskId}`);
    const m = await manager.getMeta(args.taskId);
    if (!m) return errorResult(`任务不存在: ${args.taskId}`);
    const lines = [
      `任务 ${args.taskId} 已重新入队（手动返修）${args.feedback ? "，带追加指示" : ""}。`,
      `当前状态: ${m.status}，已用轮次 ${m.roundsUsed}。`,
      `请用 query_task(${args.taskId}) 轮询新一轮结果。`,
    ];
    return formatToolResult(lines.join("\n"), metaFromTask(m));
  };
}

function continueTaskHandler(ctx: AppContext): Handler {
  return async (rawArgs) => {
    const args = rawArgs as ContinueTaskParams;
    const res = await ctx.manager.continueTask(args.taskId, args.message);
    if (!res.found || !res.meta) return errorResult(res.reason ?? `无法继续任务 ${args.taskId}`);
    // 恢复语义按 agent 而异：zcode/kimicode 复用原会话（kimicode 还要定位到原会话），
    // codex 的实例与当前对话常驻——文案不得出现与实际 agent 不符的名字。
    const resumeHint =
      res.meta.agentId === "codex"
        ? "将严格复用原会话与项目。"
        : "将严格复用原会话与项目（定位不到原会话时 fail-closed，不会退化为打开最近会话）。";
    return formatToolResult(
      `任务 ${args.taskId} 已恢复并重新入队；${resumeHint}`,
      metaFromTask(res.meta),
    );
  };
}

function getProfilesHandler(ctx: AppContext): Handler {
  const { registry } = ctx;
  return async () => {
    // 用户自定义 profile 未 resolve 前没有注册 adapter，必须按 profile 键枚举，否则 get_profiles 漏列。
    const ids = await registry.listProfileIds();
    // 并行探测；Promise.all 保持结果顺序与 ids 一致。resolve 不抛错（失败返回 ok:false），
    // 若底层异常 reject 则与旧串行版一样整体失败，错误处理语义不变。
    const rows = await Promise.all(
      ids.map(async (id) => {
        const r = await registry.resolve(id, true);
        const mark = r.ok ? "[PASS] 可用" : "[FAIL] 不可用";
        const version = r.discovered?.version ? ` version=${r.discovered.version}` : "";
        return `${mark}\t${id}\t${r.displayName}\tdriver=${r.profile.driver ?? "unknown"}\tprofileStatus=${r.profile.status ?? "unknown"}${version}\t${r.message}${r.discovered ? ` [探测来源: ${r.discovered.source}]` : ""}`;
      }),
    );
    const head =
      "Agent 适配与可执行探测结果（列: 可用 / agentId / 名称 / driver / profileStatus/version / 说明）";
    return formatToolResult(`${head}\n${rows.join("\n")}`, {
      ok: true,
      message: `共 ${ids.length} 个 agent`,
      checks: [],
    });
  };
}
