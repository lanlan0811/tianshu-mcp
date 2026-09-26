/**
 * 事件流与状态词表的**前端镜像**。
 *
 * 真源（唯一权威）：
 *   - `src/tasks/task.ts`  → TASK_STATUSES / TERMINAL_STATUSES / ACTIVE_STATUSES / TaskEventName
 *   - `src/agents/agent-events.ts` → AGENT_EVENT_NAMES
 *
 * 本文件是**只读镜像**，用于前端展示与 mock 数据出口判定；
 * 与 Rust 侧 `src-tauri/src/schema.rs` 一起被 `scripts/check-schema-parity.mjs`
 * 在 CI 中做三方集合比对——任何一侧漂移即 fail。
 *
 * 禁止在本文件新增未在真源出现的成员。
 */
import type { EventKind, TaskEvent } from "@/api/types";

export const TASK_STATUSES = [
  "queued",
  "running",
  "verify_start",
  "fixing",
  "succeeded",
  "failed",
  "needs_attention",
  "needs_user",
  "cancelled",
  "interrupted",
] as const;

export const TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "needs_attention",
  "cancelled",
  "interrupted",
] as const;

export const ACTIVE_STATUSES = ["queued", "running", "verify_start", "fixing"] as const;

/** 细粒度 agent 事件（issue #18） */
export const AGENT_EVENT_NAMES = [
  "task_dispatched",
  "confirmation_dialog_detected",
  "awaiting_user_authorization",
  "file_modification_started",
  "rework_triggered",
] as const;

/** 内置状态跃迁事件名（`TaskEventName` 去掉 agent 事件与 note） */
export const STATUS_EVENT_NAMES = [
  "created",
  "queued",
  "started",
  "agent_exited",
  "verify_start",
  "verify_round",
  "fix_start",
  "succeeded",
  "failed",
  "needs_attention",
  "needs_user",
  "continued",
  "cancel_requested",
  "cancelled",
  "interrupted",
  "timeout_killed",
  "gui_residual_acknowledged",
] as const;

export function isActiveStatus(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isAgentEventName(name: string): boolean {
  return (AGENT_EVENT_NAMES as readonly string[]).includes(name);
}

/**
 * 事件分类。与后端 `schema.rs` 的同名判定保持同一口径：
 * agent 事件 → "agent"；`note` → "note"（进度/审计通道）；状态跃迁 → "status"；其余 → "unknown"。
 */
export function classifyEvent(name: string): EventKind {
  if (isAgentEventName(name)) return "agent";
  if (name === "note") return "note";
  if ((STATUS_EVENT_NAMES as readonly string[]).includes(name)) return "status";
  return "unknown";
}

export interface ParsedEvents {
  events: TaskEvent[];
  /** 被跳过的坏行数（如实披露，不静默） */
  badLines: number;
}

/**
 * 解析 task.jsonl 全文为事件数组。
 * 坏行（JSON 解析失败）**跳过但计数**——与 `TaskStore.readEvents()` 的容错口径一致。
 */
export function parseEventStream(text: string): ParsedEvents {
  const events: TaskEvent[] = [];
  let badLines = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? "").trim();
    if (!raw) continue;
    const line = i + 1;
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      badLines += 1;
      continue;
    }
    if (!obj || typeof obj !== "object") {
      badLines += 1;
      continue;
    }
    const rec = obj as Record<string, unknown>;
    const event = typeof rec.event === "string" ? rec.event : "";
    if (!event) {
      badLines += 1;
      continue;
    }
    events.push({
      ts: typeof rec.ts === "string" ? rec.ts : "",
      event,
      state: typeof rec.state === "string" ? rec.state : "",
      detail: typeof rec.detail === "string" ? rec.detail : null,
      data:
        rec.data && typeof rec.data === "object" ? (rec.data as Record<string, unknown>) : null,
      kind: classifyEvent(event),
      line,
    });
  }
  return { events, badLines };
}