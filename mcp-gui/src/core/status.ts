/**
 * 状态 / 事件 / 日志级别的**视觉分类**（纯样式映射，不含文案——文案走 i18n）。
 */
import { isActiveStatus } from "@/core/events";
import type { LogLevel } from "@/core/logline";

/** 语义色标：active=进行中，ok=成功，fail=失败，warn=需注意，info=等待人工，muted=已终止 */
export type StatusTone = "active" | "ok" | "fail" | "warn" | "info" | "muted";

const STATUS_TONE: Record<string, StatusTone> = {
  queued: "active",
  running: "active",
  verify_start: "active",
  fixing: "active",
  succeeded: "ok",
  failed: "fail",
  needs_attention: "warn",
  needs_user: "info",
  cancelled: "muted",
  interrupted: "warn",
};

export function statusTone(status: string): StatusTone {
  return STATUS_TONE[status] ?? (isActiveStatus(status) ? "active" : "muted");
}

export function logLevelTone(level: LogLevel): StatusTone {
  switch (level) {
    case "error":
      return "fail";
    case "warn":
      return "warn";
    case "info":
      return "ok";
    case "debug":
    default:
      return "muted";
  }
}

export function eventKindTone(kind: string): StatusTone {
  switch (kind) {
    case "agent":
      return "info";
    case "note":
      return "muted";
    case "status":
      return "active";
    default:
      return "muted";
  }
}

/** 事件时间线各段的中文/英文标题由 i18n 提供，这里只给分类键 */
export function eventKindKey(kind: string): string {
  switch (kind) {
    case "agent":
      return "eventKind.agent";
    case "note":
      return "eventKind.note";
    case "status":
      return "eventKind.status";
    default:
      return "eventKind.unknown";
  }
}