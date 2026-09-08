/**
 * 8 个工具的具体 handler。统一返回 ToolResult（文本 + meta 块）。
 * run_task / rework / verify 依赖 AppContext 提供的 manager/engine/services。
 */
import fsp from "node:fs/promises";
import { assertExistingDir, normPath } from "../util/path.js";
import {
  type RunTaskParams,
  type QueryTaskParams,
  type ListTasksParams,
  type GetReportParams,
  type CancelTaskParams,
  type VerifyTaskParams,
  type ReworkTaskParams,
} from "../config/schema.js";
import { toAcceptanceDef, type DataHome } from "../config/store.js";
import type { TaskManager } from "../tasks/task-manager.js";
import type { AcceptanceEngine } from "../verify/acceptance.js";
import type { AgentAdapterRegistry } from "../agents/registry.js";
import type { TaskStore } from "../tasks/task-store.js";
import type { TaskMeta } from "../tasks/task.js";
import type { Logger } from "../util/log.js";
import { formatToolResult, errorResult, metaFromTask, readLogTail, textResult, type ToolResult } from "./formatter.js";
import { captureBaseline, gitRefExists, type Baseline as BaselineT } from "../verify/git-baseline.js";
import { readTextSafe, readJsonSafe } from "../util/fs.js";
import { readLatestReportSummary } from "../loop/fix-loop.js";
import { readDirSafe } from "../util/fs.js";

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
    run_task: runTaskHandler(ctx, defaults),
    query_task: queryTaskHandler(ctx),
    list_tasks: listTasksHandler(ctx),
    get_task_report: getReportHandler(ctx),
    cancel_task: cancelTaskHandler(ctx),
    verify_task: verifyTaskHandler(ctx),
    rework_task: reworkTaskHandler(ctx),
    get_profiles: getProfilesHandler(ctx),
  };
}

type Handler = (args: Record<string, unknown>) => Promise<ToolResult>;

function runTaskHandler(ctx: AppContext, defaults: Defaults): Handler {
  const { manager, dataHome, logger } = ctx;
  return async (rawArgs) => {
    const args = rawArgs as RunTaskParams;
    // 规范化 + 校验目录
    const dir = assertExistingDir(args.projectPath);
    const norm = normPath(dir.raw);

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

    const cfg = await dataHome.loadConfig();
    // 有效任务超时（R2）：调用参数 > profile > server 默认值，在提交时固化
    const taskTimeoutMs =
      args.taskTimeoutMs ??
      resolved.profile.timeoutMs ??
      cfg.defaultTaskTimeoutMs ??
      30 * 60_000;
    const meta = await manager.submit({
      projectPath: norm,
      displayPath: dir.raw,
      agentId: finalAgentId,
      task: args.task,
      context: args.context,
      model: args.model,
      autoVerify: args.autoVerify ?? defaults.defaultAutoVerify,
      autoFixRounds: args.autoFixRounds ?? defaults.defaultAutoFixRounds,
      taskTimeoutMs,
    });
    logger.info(`run_task 已提交 ${meta.taskId} (agent=${finalAgentId}, project=${norm})`);
    const lines = [
      `任务已提交：${meta.taskId}`,
      `Agent: ${finalAgentId}${resolved.message ? `（${resolved.message}）` : ""}`,
      `项目: ${norm}`,
      `自动验收: ${meta.autoVerify ? "开" : "关"}${meta.autoFixRounds > 0 ? `，自动返修上限 ${meta.autoFixRounds} 轮` : "（未开启自动返修）"}`,
      `队列位置：每项目串行 + 全局并发 ${ctx.manager.getMaxRunning()}。请用 query_task(${meta.taskId}) 轮询（建议间隔 5–10 秒）。`,
      `任务书摘要: ${args.task.slice(0, 120)}${args.task.length > 120 ? "…" : ""}`,
    ];
    return formatToolResult(lines.join("\n"), metaFromTask(meta));
  };
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
      (meta.roundsUsed > 0 ? store.agentLogPath(meta.taskId, Math.max(0, meta.roundsUsed - 1)) : undefined);
    if (logFile) {
      if (await existsFile(logFile)) logTail = await readLogTail(logFile, tailLines);
    }
    const statusLine = describeStatus(meta);
    const lines = [
      statusLine,
      meta.lastMessage ? `最近消息: ${meta.lastMessage}` : "",
      logTail ? `--- agent 日志尾部（${logTail.split("\n").length} 行）---\n${logTail}` : "（暂无 agent 日志）",
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
      const norm = normPath(args.projectPath);
      projectPath = norm;
    }
    const list = await manager.listTasks({ projectPath, status: args.status, limit: args.limit ?? 50 });
    if (list.length === 0) {
      return formatToolResult("没有符合条件的任务。", { ok: true, message: "空列表" });
    }
    const lines = list.map((m) => {
      return `${m.taskId}\t${m.status.padEnd(15)}\t${(m.agentId ?? "").padEnd(8)}\t${m.projectPath}\t${m.task.slice(0, 60)}`;
    });
    return formatToolResult(`任务列表（${list.length} 条，列: taskId / status / agent / project / 任务摘要）\n${lines.join("\n")}`, {
      ok: true,
      message: `共 ${list.length} 条`,
    });
  };
}

function getReportHandler(ctx: AppContext): Handler {
  const { manager, store } = ctx;
  return async (rawArgs) => {
    const args = rawArgs as GetReportParams;
    const meta = await manager.getMeta(args.taskId);
    if (!meta) return errorResult(`任务不存在: ${args.taskId}`);
    // round 缺省（undefined）取最新；显式 0 取第 0 轮（R4：0-based 合法）
    let round = args.round;
    if (round === undefined) {
      const latest = await readLatestReportSummary(store, args.taskId);
      if (!latest) return errorResult(`任务 ${args.taskId} 还没有验收报告（可能未启用验收或尚未验收）。`);
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
      return formatToolResult(res.reason ?? `已请求取消 ${args.taskId}。`, metaFromTask(meta));
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
      const dir = assertExistingDir(args.projectPath);
      projectPath = normPath(dir.raw);
      displayPath = dir.raw;
      // baselineRef：Git ref（任务 ID 不适用独立路径）
      if (args.baselineRef) {
        if (!(await gitRefExists(projectPath, args.baselineRef))) {
          return errorResult(`baselineRef '${args.baselineRef}' 不是有效 Git ref（项目 ${projectPath}）。`);
        }
        baseline = { ...(await captureBaseline(projectPath)), head: args.baselineRef };
      } else {
        baseline = await captureBaseline(projectPath);
      }
    } else if (taskId) {
      const meta = await manager.getMeta(taskId);
      if (!meta) return errorResult(`任务不存在: ${taskId}`);
      projectPath = meta.projectPath;
      displayPath = meta.displayPath;
      taskText = meta.task;
      // 默认用该任务动工前基线（保存于任务目录）；baselineRef=task 或特定 git ref 可覆盖
      const savedBaseline = await readJsonSafe<BaselineT>(store.baselinePath(taskId));
      if (args.baselineRef && args.baselineRef !== "task") {
        if (!(await gitRefExists(projectPath, args.baselineRef))) {
          return errorResult(`baselineRef '${args.baselineRef}' 不是有效 Git ref（项目 ${projectPath}）。`);
        }
        baseline = { ...(savedBaseline ?? (await captureBaseline(projectPath))), head: args.baselineRef };
      } else {
        baseline = savedBaseline ?? (await captureBaseline(projectPath));
        if (!savedBaseline) {
          return errorResult(`任务 ${taskId} 没有保存的动工前基线（任务可能在改造前创建）。请用 projectPath 单独验收，或传 baselineRef=git ref。`);
        }
      }
    } else {
      return errorResult("verify_task 需要 taskId 或 projectPath（二选一）。");
    }

    const cfg = await dataHome.loadConfig();
    const proj = await dataHome.projectByPath(projectPath);
    const projectVerify = proj.record?.verify?.map((v) => {
      const cmd = Array.isArray(v.cmd) ? [...v.cmd] : v.cmd;
      return { name: v.name, cmd: Array.isArray(cmd) ? cmd : [cmd], displayCmd: Array.isArray(cmd) ? cmd.join(" ") : cmd };
    });

    // round 分配：手动验收写入任务目录时不能覆盖已有 report-0.*，分配下一可用轮次
    const round = await nextReportRound(store, taskId);

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
        status: passed ? "succeeded" : "failed",
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
    const detailLines = [`${head}`, `变更 ${changed} 个文件，diffstat ${resultMeta.diffstat}。`, `报告：${report.files.md}`, `JSON：${report.files.json}`];
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

function getProfilesHandler(ctx: AppContext): Handler {
  const { registry } = ctx;
  return async () => {
    const ids = registry.listAgentIds();
    const rows: string[] = [];
    for (const id of ids) {
      const r = await registry.resolve(id, true);
      const mark = r.ok ? "[PASS] 可用" : "[FAIL] 不可用";
      rows.push(`${mark}\t${id}\t${r.displayName}\t${r.message}${r.discovered ? ` [探测来源: ${r.discovered.source}]` : ""}`);
    }
    const head = "Agent 适配与可执行探测结果（列: 可用 / agentId / 名称 / 说明）";
    return formatToolResult(`${head}\n${rows.join("\n")}`, {
      ok: true,
      message: `共 ${ids.length} 个 agent`,
      checks: [],
    });
  };
}
