//! 事件与状态词表的 Rust 镜像。
//!
//! **真源（唯一权威）**：
//!   - `src/tasks/task.ts`  → TASK_STATUSES / TERMINAL_STATUSES / ACTIVE_STATUSES / TaskEventName
//!   - `src/agents/agent-events.ts` → AGENT_EVENT_NAMES
//!
//! 本文件是**只读镜像**，由 `mcp-gui/scripts/check-schema-parity.mjs` 在 CI 中
//! 与真源做集合比对；任何一侧漂移即 fail。**禁止在此新增未在真源出现的成员。**

/// 任务状态全集（真源：`src/tasks/task.ts` 的 `TASK_STATUSES`）
pub const TASK_STATUSES: [&str; 10] = [
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
];

/// 终态集合（真源：`TERMINAL_STATUSES`）
pub const TERMINAL_STATUSES: [&str; 5] = [
    "succeeded",
    "failed",
    "needs_attention",
    "cancelled",
    "interrupted",
];

/// 活动态集合（真源：`ACTIVE_STATUSES`）
pub const ACTIVE_STATUSES: [&str; 4] = ["queued", "running", "verify_start", "fixing"];

/// 细粒度 agent 事件（真源：`src/agents/agent-events.ts` 的 `AGENT_EVENT_NAMES`）
pub const AGENT_EVENT_NAMES: [&str; 5] = [
    "task_dispatched",
    "confirmation_dialog_detected",
    "awaiting_user_authorization",
    "file_modification_started",
    "rework_triggered",
];

/// 内置状态跃迁事件名（`TaskEventName` 去掉 agent 事件与 `note`）
pub const STATUS_EVENT_NAMES: [&str; 17] = [
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
];

/// 事件类别（与前端 `core/events.ts` 的 `classifyEvent` 同口径）
pub fn classify_event(name: &str) -> &'static str {
    if AGENT_EVENT_NAMES.contains(&name) {
        "agent"
    } else if name == "note" {
        "note"
    } else if STATUS_EVENT_NAMES.contains(&name) {
        "status"
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_sets_are_consistent() {
        assert_eq!(TASK_STATUSES.len(), 10);
        assert_eq!(TERMINAL_STATUSES.len(), 5);
        assert_eq!(ACTIVE_STATUSES.len(), 4);
        for s in ACTIVE_STATUSES {
            assert!(TASK_STATUSES.contains(&s));
        }
        for s in TERMINAL_STATUSES {
            assert!(TASK_STATUSES.contains(&s));
        }
        // 活动态与终态互不重叠
        for s in ACTIVE_STATUSES {
            assert!(!TERMINAL_STATUSES.contains(&s));
        }
    }

    #[test]
    fn classify_event_distinguishes_kinds() {
        assert_eq!(classify_event("succeeded"), "status");
        assert_eq!(classify_event("task_dispatched"), "agent");
        assert_eq!(classify_event("note"), "note");
        assert_eq!(classify_event("something_else"), "unknown");
    }
}
