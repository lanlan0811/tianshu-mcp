/**
 * 任务终态通知（issue #22）。
 *
 * 长任务下调用方原先必须一直挂在天枢界面轮询 `query_task`；任务完成/失败/进入 `needs_attention`
 * 时没有任何主动推送，盯屏成本高。本模块在终态跃迁时向配置的 URL POST 一条 JSON。
 *
 * 设计约束（都是 issue 明确要求的）：
 * - **异步、不阻塞状态机**：`notify()` 立即返回，发送在后台进行。
 * - **失败不影响任务**：任何异常只记 `warn`，绝不外抛、绝不改变状态机。
 * - **默认关闭**：未配置 / `enabled:false` / 事件不在订阅集 → **完全不发起请求**。
 * - 重试 + 超时控制：总尝试 `1 + maxRetries` 次，退避 `backoffMs × 第几次`。
 *
 * 「恰好一次」的保证方式：按 `taskId + status + finishedAt` 进程内去重。
 * `finishedAt` 由 `updateStatus` 在写入终态时刷新为当前时刻，并被 `rework` / `continueTask`
 * 清空 —— 因此**同一回合**的重复写入被抑制，而返修后的**新一回合同样状态会再次通知**。
 * 不能改用 `prev !== status` 作为门条件：多条路径（cancel 的 queued 分支、shutdownInterrupt）
 * 会先直接改写 `meta.status` 再调用 `updateStatus`，那时 `prev` 已等于目标状态。
 */
import { createHmac } from "node:crypto";
import type { Logger } from "../util/log.js";
import type { NotificationEvent, ServerConfig } from "../config/schema.js";
import type { TaskStatus } from "./task.js";

/**
 * 任务状态 → 通知事件类别；非终态/不产生通知的状态返回 undefined。
 *
 * `needs_attention`（真终态）→ `needs_human`；`needs_user`（**非终态**，可被 continue 恢复、
 * 之后可能再次进入）→ 单独的 `needs_user` 类别，默认不在订阅集里（见 schema）。
 * 两者分开是刻意的：混为一类会让「默认只推真终态」失效。
 */
export function statusToEvent(status: TaskStatus): NotificationEvent | undefined {
  switch (status) {
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "needs_attention":
      return "needs_human";
    case "needs_user":
      return "needs_user";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    default:
      return undefined;
  }
}

export interface NotificationPayload {
  taskId: string;
  event: NotificationEvent;
  /** 原始任务状态（比 event 更细，便于接收端自行分流） */
  status: TaskStatus;
  /** 事件发生时刻（ISO） */
  ts: string;
  /** 该回合的终态时刻；去重键的一部分 */
  finishedAt?: string;
  agentId?: string;
  projectPath?: string;
  round?: number;
  reportRound?: number;
  message?: string;
  reportMd?: string;
  reportJson?: string;
}

export interface Notifier {
  notify(payload: NotificationPayload): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class TaskNotifier implements Notifier {
  /** 已通知过的 `taskId:status:finishedAt`（进程内；重启后按新回合重新通知，如实） */
  private readonly sent = new Set<string>();

  constructor(
    private readonly getConfig: () => Promise<ServerConfig>,
    private readonly logger: Logger,
  ) {}

  /** fire-and-forget：立即返回，发送与重试都在后台；绝不外抛 */
  notify(payload: NotificationPayload): void {
    const key = `${payload.taskId}:${payload.status}:${payload.finishedAt ?? ""}`;
    if (this.sent.has(key)) return;
    this.sent.add(key);
    void this.send(payload).catch((e: unknown) => {
      // send 内部已吞掉异常，这里是最后一道保险：通知绝不允许影响任务
      this.logger.warn(
        `任务 ${payload.taskId} 通知发送出现未预期异常：${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  private async send(payload: NotificationPayload): Promise<void> {
    let webhook;
    try {
      webhook = (await this.getConfig()).notifications?.webhook;
    } catch (e) {
      this.logger.warn(
        `读取通知配置失败，跳过任务 ${payload.taskId} 的通知：${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    // 默认关闭：未配置 / 未启用 / 无 url / 事件未订阅 → 不发起任何请求
    if (!webhook?.enabled || !webhook.url) return;
    if (!webhook.events.includes(payload.event)) return;

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-tianshu-event": payload.event,
    };
    if (webhook.secret) {
      headers["x-tianshu-signature"] =
        `sha256=${createHmac("sha256", webhook.secret).update(body, "utf8").digest("hex")}`;
    }

    const attempts = 1 + webhook.maxRetries;
    let lastError = "未知原因";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await fetch(webhook.url, {
          method: "POST",
          headers,
          body,
          // 与 visual 服务同一约定：不自动跟随重定向，超时用 AbortSignal.timeout
          redirect: "manual",
          signal: AbortSignal.timeout(webhook.timeoutMs),
        });
        if (res.ok) {
          this.logger.info(
            `任务 ${payload.taskId} 通知已送达（${payload.event}，HTTP ${res.status}${attempt > 1 ? `，第 ${attempt} 次尝试` : ""}）`,
          );
          return;
        }
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
      if (attempt < attempts && webhook.backoffMs > 0) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(webhook.backoffMs * attempt);
      }
    }
    // 尽最大努力通知即止：失败不影响任务本体，也不重排状态机
    this.logger.warn(
      `任务 ${payload.taskId} 通知发送失败（${payload.event}，已尝试 ${attempts} 次）：${lastError}`,
    );
  }
}
