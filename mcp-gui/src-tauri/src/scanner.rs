//! `tasks/` 扫描、`task.json` 快照解析与列表聚合（只读）。
//!
//! 产物命名真源：`src/tasks/task-store.ts` 的路径约定。刻意**不做强类型反序列化**：
//! 快照新增/缺失字段都不应让界面失效，缺失值一律给安全默认。

use std::path::Path;

use serde_json::Value;

use crate::models::{ArtifactRounds, ListTasksRequest, TaskFilter, TaskSummary};
use crate::schema::ACTIVE_STATUSES;

fn as_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn as_i64(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(Value::as_i64)
}

fn as_bool(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn as_str_vec(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_round(name: &str, prefix: &str, suffix: &str) -> Option<i64> {
    let rest = name.strip_prefix(prefix)?;
    let num = rest.strip_suffix(suffix)?;
    num.parse::<i64>().ok()
}

/// 聚合任务目录内的产物轮次（缺失即空数组，不补零、不猜测）
pub fn collect_artifacts(task_dir: &Path) -> ArtifactRounds {
    let mut out = ArtifactRounds::default();
    let entries = match std::fs::read_dir(task_dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(r) = parse_round(&name, "agent-", ".log") {
            out.agent_logs.push(r);
        } else if let Some(r) = parse_round(&name, "verify-", ".log") {
            out.verify_logs.push(r);
        } else if let Some(r) = parse_round(&name, "dry-run-report-", ".md") {
            out.dry_run_md.push(r);
        } else if let Some(r) = parse_round(&name, "dry-run-report-", ".json") {
            out.dry_run_json.push(r);
        } else if let Some(r) = parse_round(&name, "report-", ".md") {
            out.report_md.push(r);
        } else if let Some(r) = parse_round(&name, "report-", ".json") {
            out.report_json.push(r);
        } else if let Some(r) = parse_round(&name, "report-", ".html") {
            out.report_html.push(r);
        } else if name == "baseline.json" {
            out.has_baseline = true;
        } else if name == "dry-run-plan.md" {
            out.has_dry_run_plan = true;
        }
    }
    out.agent_logs.sort_unstable();
    out.verify_logs.sort_unstable();
    out.report_md.sort_unstable();
    out.report_json.sort_unstable();
    out.report_html.sort_unstable();
    out.dry_run_md.sort_unstable();
    out.dry_run_json.sort_unstable();
    out
}

/// 读取单个任务快照（不可解析时返回 None，前端据此跳过而不是显示假数据）
pub fn read_task_summary(home: &Path, task_id: &str) -> Option<TaskSummary> {
    let task_dir = home.join("tasks").join(task_id);
    let snapshot = task_dir.join("task.json");
    let text = std::fs::read_to_string(&snapshot).ok()?;
    let meta: Value = serde_json::from_str(&text).ok()?;
    if !meta.is_object() {
        return None;
    }
    Some(TaskSummary {
        task_id: task_id.to_string(),
        status: as_str(&meta, "status").unwrap_or_default(),
        workspace_mode: as_str(&meta, "workspaceMode").unwrap_or_else(|| "project".to_string()),
        project_path: as_str(&meta, "projectPath").unwrap_or_default(),
        display_path: as_str(&meta, "displayPath").unwrap_or_default(),
        agent_id: as_str(&meta, "agentId").unwrap_or_default(),
        task: as_str(&meta, "task").unwrap_or_default(),
        rounds_used: as_i64(&meta, "roundsUsed").unwrap_or(0),
        report_round: as_i64(&meta, "reportRound"),
        created_at: as_str(&meta, "createdAt").unwrap_or_default(),
        updated_at: as_str(&meta, "updatedAt").unwrap_or_default(),
        finished_at: as_str(&meta, "finishedAt"),
        last_message: as_str(&meta, "lastMessage"),
        dry_run: as_bool(&meta, "dryRun"),
        error_type: as_str(&meta, "errorType"),
        check_summary: as_str(&meta, "checkSummary"),
        diffstat: as_str(&meta, "diffstat"),
        changed_files: as_str_vec(&meta, "changedFiles"),
        data_home: home.to_string_lossy().to_string(),
        artifacts: collect_artifacts(&task_dir),
    })
}

fn matches_filter(task: &TaskSummary, filter: &TaskFilter) -> bool {
    if filter.only_active && !ACTIVE_STATUSES.contains(&task.status.as_str()) {
        return false;
    }
    if let Some(agent) = &filter.agent_id {
        if !agent.is_empty() && &task.agent_id != agent {
            return false;
        }
    }
    if let Some(status) = &filter.status {
        if !status.is_empty() && &task.status != status {
            return false;
        }
    }
    if let Some(project) = &filter.project_path {
        if !project.is_empty() && &task.project_path != project {
            return false;
        }
    }
    if let Some(from) = &filter.from {
        if !from.is_empty() && task.updated_at < *from {
            return false;
        }
    }
    if let Some(to) = &filter.to {
        if !to.is_empty() && task.updated_at > *to {
            return false;
        }
    }
    let keyword = filter.keyword.trim().to_lowercase();
    if !keyword.is_empty() {
        let haystack = format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            task.task_id,
            task.task,
            task.project_path,
            task.display_path,
            task.agent_id,
            task.last_message.clone().unwrap_or_default()
        )
        .to_lowercase();
        if !haystack.contains(&keyword) {
            return false;
        }
    }
    true
}

/// 扫描任务目录并应用筛选 / 排序。
///
/// 同时覆盖 `tsk_*`（派单任务）与 `vfy_*`（独立路径验收记录）——
/// 与 `TaskStore.scanAllSnapshots()` 口径一致；非这两种前缀的目录一律跳过。
pub fn list_tasks(home: &Path, req: &ListTasksRequest) -> Vec<TaskSummary> {
    let tasks_root = home.join("tasks");
    let entries = match std::fs::read_dir(&tasks_root) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<TaskSummary> = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !(name.starts_with("tsk_") || name.starts_with("vfy_")) {
            continue;
        }
        if let Some(summary) = read_task_summary(home, &name) {
            if matches_filter(&summary, &req.filter) {
                out.push(summary);
            }
        }
    }

    let key = req.sort_key.as_str();
    let asc = req.sort_dir.as_str() == "asc";
    out.sort_by(|a, b| {
        let (av, bv) = match key {
            "taskId" => (&a.task_id, &b.task_id),
            "createdAt" => (&a.created_at, &b.created_at),
            _ => (&a.updated_at, &b.updated_at),
        };
        let primary = av.cmp(bv);
        if primary != std::cmp::Ordering::Equal {
            return if asc { primary } else { primary.reverse() };
        }
        a.task_id.cmp(&b.task_id)
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_round_matches_expected_names() {
        assert_eq!(parse_round("agent-0.log", "agent-", ".log"), Some(0));
        assert_eq!(parse_round("verify-12.log", "verify-", ".log"), Some(12));
        assert_eq!(parse_round("report-3.md", "report-", ".md"), Some(3));
        assert_eq!(parse_round("agent-x.log", "agent-", ".log"), None);
        assert_eq!(parse_round("report-3.html", "report-", ".md"), None);
    }

    #[test]
    fn collect_artifacts_splits_dry_run_and_regular() {
        let dir = std::env::temp_dir().join("tianshu-gui-artifacts-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建目录");
        for name in [
            "agent-0.log",
            "agent-1.log",
            "verify-0.log",
            "report-0.md",
            "report-0.json",
            "report-0.html",
            "dry-run-report-2.md",
            "dry-run-report-2.json",
            "dry-run-plan.md",
            "baseline.json",
        ] {
            std::fs::write(dir.join(name), "x").expect("写文件");
        }
        let a = collect_artifacts(&dir);
        assert_eq!(a.agent_logs, vec![0, 1]);
        assert_eq!(a.verify_logs, vec![0]);
        assert_eq!(a.report_md, vec![0]);
        assert_eq!(a.report_json, vec![0]);
        assert_eq!(a.report_html, vec![0]);
        assert_eq!(a.dry_run_md, vec![2]);
        assert_eq!(a.dry_run_json, vec![2]);
        assert!(a.has_baseline);
        assert!(a.has_dry_run_plan);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_tasks_reads_snapshot_and_sorts() {
        let home = std::env::temp_dir().join("tianshu-gui-list-test");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("tasks/tsk_1")).expect("建目录");
        std::fs::create_dir_all(home.join("tasks/tsk_2")).expect("建目录");
        std::fs::write(
            home.join("tasks/tsk_1/task.json"),
            r#"{"status":"succeeded","agentId":"codex","task":"a","updatedAt":"2026-09-26T10:00:00Z"}"#,
        )
        .expect("写快照");
        std::fs::write(
            home.join("tasks/tsk_2/task.json"),
            r#"{"status":"running","agentId":"traework","task":"b","updatedAt":"2026-09-26T12:00:00Z"}"#,
        )
        .expect("写快照");

        let req = ListTasksRequest {
            data_home: home.to_string_lossy().to_string(),
            filter: TaskFilter::default(),
            sort_key: "updatedAt".to_string(),
            sort_dir: "desc".to_string(),
        };
        let tasks = list_tasks(&home, &req);
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].task_id, "tsk_2");

        let active_only = ListTasksRequest {
            filter: TaskFilter {
                only_active: true,
                ..TaskFilter::default()
            },
            ..req
        };
        assert_eq!(list_tasks(&home, &active_only).len(), 1);
        let _ = std::fs::remove_dir_all(&home);
    }
}
