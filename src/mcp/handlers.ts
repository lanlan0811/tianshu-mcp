/**
 * 9 个工具的具体 handler。统一返回 ToolResult（文本 + meta 块）。
 * run_task / rework / verify 依赖 AppContext 提供的 manager/engine/services。
 */
import fsp from "node:fs/promises";
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
} from "../config/schema.js";
import { toAcceptanceDef, type DataHome } from "../config/store.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { AcceptanceEngine } from "../verify/acceptance.js";
import type { AgentAdapterRegistry } from "../agents/registry.js";
import type { TaskStore } from "../tasks/task-store.js";
import { isDefaultWorkspace, type TaskMeta } from "../tasks/task.js";
import type { Logger } from "../util/log.js";
import {
  formatToolResult,
  errorResult,
  metaFromTask,
  readLogTail,
  textResult,
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

export function makeHandlers(ctx: AppContext, defaults: Defaults) {
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
    run_task: runTaskHandler(ctx, defaults),
    query_task: queryTaskHandler(ctx),
    list_tasks: listTasksHandler(ctx),
    get_task_report: getReportHandler(ctx),
    cancel_task: cancelTaskHandler(ctx),
    verify_task: verifyTaskHandler(ctx),
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

function runTaskHandler(ctx: AppContext, defaults: Defaults): Handler {
  const { manager, dataHome, logger } = ctx;
  return async (rawArgs) => {
    const args = rawArgs as RunTaskParams;
    // 无项目模式（issue #12）：省略 projectPath 时不做目录校验与项目登记，
    // 待解析出最终 agent 之后再判断它是否支持无项目。
    if (args.projectPath === undefined) return runTaskWithoutProject(ctx, defaults, args);
    // 安全闸门：绝对路径 + 存在 + realpath 消除符号链接 + 拒绝主目录/系统根目录
    let dir: ReturnType<typeof assertSafeProjectDir>;
    try {
      dir = assertSafeProjectDir(args.projectPath);
    } catch (e) {
      return errorResult(e instanceof Error ? e.message : String(e));
    }
    const norm = dir.norm;
    const dirtyCount = await gitDirtyCount(dir.canonical);

    // 项目自动登记（首次出现即登记，R10）
    const agentId = args.agentId ?? defaults.defaultAgentId;
    const registered = await dataHome.registerProject(norm, agentId);
    void registered;
    const record = (await dataHome.projectByPath(norm)).record;
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

    const cfg = await dataHome.loadConfig();
    // 有效任务超时（R2）：调用参数 > profile > server 默认值，在提交时固化
    const taskTimeoutMs =
      args.taskTimeoutMs ?? resolved.profile.timeoutMs ?? cfg.defaultTaskTimeoutMs ?? 30 * 60_000;
    const meta = await manager.submit({
      projectPath: norm,
      displayPath: dir.raw,
      agentId: finalAgentId,
      task: args.task,
      context: args.context,
      model: args.model,
      reasoningLevel: args.reasoningLevel,
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
    });
    logger.info(`run_task 已提交 ${meta.taskId} (agent=${finalAgentId}, project=${norm})`);
    const lines = [
      `任务已提交：${meta.taskId}`,
      `Agent: ${finalAgentId}${resolved.message ? `（${resolved.message}）` : ""}`,
      `项目: ${norm}${dir.viaSymlink ? `（经符号链接解析自 ${dir.raw}）` : ""}`,
      `自动验收: ${meta.autoVerify ? "开" : "关"}${meta.autoFixRounds > 0 ? `，自动返修上限 ${meta.autoFixRounds} 轮` : "（未开启自动返修）"}`,
      `队列位置：每项目串行 + 全局并发 ${ctx.manager.getMaxRunning()}。请用 query_task(${meta.taskId}) 轮询（建议间隔 5–10 秒）。`,
      `任务书摘要: ${args.task.slice(0, 120)}${args.task.length > 120 ? "…" : ""}`,
    ];
    if (dirtyCount !== null && dirtyCount > 0) {
      lines.push(
        `注意：该仓库当前有 ${dirtyCount} 个未提交变更（可能有其他会话/在途工作共处），worker 将直接在原工作区上改动，验收仅归因相对基线的净变更。`,
      );
    }
    return formatToolResult(lines.join("\n"), metaFromTask(meta));
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
): Promise<ToolResult> {
  const { manager, logger } = ctx;
  const agentId = args.agentId ?? defaults.defaultAgentId;
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
  const meta = await manager.submit({
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
  });
  logger.info(`run_task 已提交 ${meta.taskId}（agent=${agentId}，无项目模式）`);
  return formatToolResult(
    [
      `任务已提交：${meta.taskId}`,
      `Agent: ${agentId}（无项目模式：ZCode default 工作区）`,
      `模式: default —— 不采集 Git 基线、不执行项目验收、不创建/登记 ZCode 项目`,
      `自动验收: 关（无项目模式固定关闭，执行完成后不会生成验收报告）`,
      `队列位置：全局并发 ${ctx.manager.getMaxRunning()}。请用 query_task(${meta.taskId}) 轮询（建议间隔 5–10 秒）。`,
      `任务书摘要: ${args.task.slice(0, 120)}${args.task.length > 120 ? "…" : ""}`,
    ].join("\n"),
    metaFromTask(meta),
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
    needs_user: "等待用户处理（可用 continue_task 恢复原 ZCode 会话）",
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

function verifyTaskHandler(ctx: AppContext): Handler {
  const { manager, engine, dataHome, store, logger } = ctx;
  return async (rawArgs) => {
    const args = rawArgs as VerifyTaskParams;
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

    const verifyTaskId = taskId ?? `vfy_${Date.now()}`;
    const req = {
      taskId: verifyTaskId,
      projectPath,
      displayPath,
      taskText,
      round,
      config: cfg,
      extraChecks,
      checksMode: args.checksMode ?? "append",
      projectVerify,
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
      if (!real) return errorResult(`任务不存在: ${taskId}`);
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
      };
      await manager.persistMetaUpdate(resultMeta);
    }
    const detailLines = [
      `${head}`,
      `变更 ${changed} 个文件，diffstat ${resultMeta.diffstat}。`,
      `报告：${report.files.md}`,
      `JSON：${report.files.json}`,
    ];
    return formatToolResult(detailLines.join("\n"), metaFromTask(resultMeta));
  };
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
    return formatToolResult(
      `任务 ${args.taskId} 已恢复并重新入队；将严格复用原 ZCode 会话与项目。`,
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
