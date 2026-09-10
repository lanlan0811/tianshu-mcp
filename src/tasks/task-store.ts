/**
 * TaskStore：每个任务一个目录 <home>/tasks/<taskId>/，
 * 维护 task.jsonl 事件流 + task.json 最新快照 + 日志/报告文件的路径约定。
 * 重启时通过快照恢复历史（只读归档，不续跑）。
 */
import path from "node:path";
import {
  type TaskEvent,
  type TaskEventName,
  type TaskMeta,
  type TaskStatus,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  type VerifyReport,
} from "./task.js";
import {
  appendLine,
  exists,
  mkdirp,
  readDirSafe,
  readJsonSafe,
  readTextSafe,
  writeJsonAtomic,
  writeTextAtomic,
} from "../util/fs.js";
import { nowIso } from "../util/id.js";
import { Logger } from "../util/log.js";
import { reportToJsonable, reportToMd } from "../verify/report.js";

const STATUS_EVENT_MAP: Record<TaskStatus, TaskEventName> = {
  queued: "queued",
  running: "started",
  verify_start: "verify_start",
  fixing: "fix_start",
  succeeded: "succeeded",
  failed: "failed",
  needs_attention: "needs_attention",
  needs_user: "needs_user",
  cancelled: "cancelled",
  interrupted: "interrupted",
};

export class TaskStore {
  constructor(
    private readonly home: string,
    private readonly logger: Logger,
  ) {}

  dir(taskId: string): string {
    return path.join(this.home, "tasks", taskId);
  }
  jsonlPath(taskId: string): string {
    return path.join(this.dir(taskId), "task.jsonl");
  }
  snapshotPath(taskId: string): string {
    return path.join(this.dir(taskId), "task.json");
  }
  baselinePath(taskId: string): string {
    return path.join(this.dir(taskId), "baseline.json");
  }
  /** 第 round 次 agent 执行日志（round 从 0 起） */
  agentLogPath(taskId: string, round: number): string {
    return path.join(this.dir(taskId), `agent-${round}.log`);
  }
  verifyLogPath(taskId: string, round: number): string {
    return path.join(this.dir(taskId), `verify-${round}.log`);
  }
  reportMdPath(taskId: string, round: number): string {
    return path.join(this.dir(taskId), `report-${round}.md`);
  }
  reportJsonPath(taskId: string, round: number): string {
    return path.join(this.dir(taskId), `report-${round}.json`);
  }

  /** 供 query/get_report 读取历史：目录内是否已有产物 */
  hasTaskDir(taskId: string): Promise<boolean> {
    return exists(this.dir(taskId));
  }

  /* ---------- 事件流 ---------- */
  async appendEvent(
    taskId: string,
    event: TaskEventName,
    state: TaskStatus,
    detail?: string,
    data?: TaskEvent["data"],
  ): Promise<void> {
    const ev: TaskEvent = { ts: nowIso(), event, state, detail, data };
    await mkdirp(this.dir(taskId));
    await appendLine(this.jsonlPath(taskId), JSON.stringify(ev));
  }

  async readEvents(taskId: string): Promise<TaskEvent[]> {
    const text = await readTextSafe(this.jsonlPath(taskId));
    if (!text) return [];
    const out: TaskEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TaskEvent);
      } catch {
        // 跳过坏行
      }
    }
    return out;
  }

  /* ---------- 快照 ---------- */
  async writeSnapshot(meta: TaskMeta): Promise<void> {
    await mkdirp(this.dir(meta.taskId));
    await writeJsonAtomic(this.snapshotPath(meta.taskId), meta);
  }

  async readSnapshot(taskId: string): Promise<TaskMeta | null> {
    return readJsonSafe<TaskMeta>(this.snapshotPath(taskId));
  }

  async updateStatus(
    meta: TaskMeta,
    status: TaskStatus,
    detail?: string,
    eventName?: TaskEvent["event"],
  ): Promise<void> {
    const prev = meta.status;
    meta.status = status;
    meta.updatedAt = nowIso();
    if (TERMINAL_STATUSES.includes(status)) meta.finishedAt = meta.updatedAt;
    const name = eventName ?? STATUS_EVENT_MAP[status];
    await this.appendEvent(meta.taskId, name, status, detail);
    await this.writeSnapshot(meta);
    this.logger.debug(`任务 ${meta.taskId}: ${prev} → ${status}${detail ? ` (${detail})` : ""}`);
  }

  async addNote(meta: TaskMeta, detail: string): Promise<void> {
    meta.updatedAt = nowIso();
    await this.appendEvent(meta.taskId, "note", meta.status, detail);
    await this.writeSnapshot(meta);
  }

  /** cancel_requested 事件 + 独立取消意图字段落盘（S1：不依赖可选 reason 判断取消来源） */
  async markCancelRequested(meta: TaskMeta, reason?: string): Promise<void> {
    meta.cancelReason = reason;
    meta.cancelRequestedAt = nowIso();
    meta.abortSource = "user";
    meta.updatedAt = meta.cancelRequestedAt;
    await this.appendEvent(
      meta.taskId,
      "cancel_requested",
      meta.status,
      reason ? `收到取消请求：${reason}` : "收到取消请求（无 reason）",
    );
    await this.writeSnapshot(meta);
  }

  /* ---------- 报告 ---------- */
  async saveReport(taskId: string, report: VerifyReport): Promise<void> {
    await mkdirp(this.dir(taskId));
    await writeTextAtomic(report.files.md, reportToMd(report));
    await writeJsonAtomic(report.files.json, reportToJsonable(report));
  }

  /** 启动扫描：找出 running/interrupted/queued 遗留，供归档 */
  async scanLegacyActive(): Promise<TaskMeta[]> {
    const dirs = await readDirSafe(path.join(this.home, "tasks"));
    const out: TaskMeta[] = [];
    for (const d of dirs) {
      if (!d.startsWith("tsk_")) continue;
      const meta = await this.readSnapshot(d);
      if (meta && ACTIVE_STATUSES.includes(meta.status)) out.push(meta);
    }
    return out;
  }

  /** 列出全部任务快照 */
  async listTaskSnapshots(): Promise<TaskMeta[]> {
    const dirs = await readDirSafe(path.join(this.home, "tasks"));
    const out: TaskMeta[] = [];
    for (const d of dirs) {
      if (!d.startsWith("tsk_")) continue;
      const meta = await this.readSnapshot(d);
      if (meta) out.push(meta);
    }
    return out;
  }
}
