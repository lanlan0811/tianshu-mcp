//! 跨任务全局搜索（按需扫描，**不建本地全文索引**；支持进度事件与取消）。
//!
//! 只扫描**已知的日志/报告文件名**（task.jsonl / agent-*.log / verify-*.log / report-*.{md,json} /
//! logs/server.log），不递归任意文件，避免误读大二进制或无关内容。

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter};

use crate::models::{SearchFileGroup, SearchHit, SearchRequest, SearchResult};

pub const SEARCH_PROGRESS_EVENT: &str = "gui/search-progress";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProgressPayload {
    pub scanned_files: i64,
}

fn is_event_stream(name: &str) -> bool {
    name == "task.jsonl"
}

fn is_agent_log(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("agent-") else {
        return false;
    };
    let Some(num) = rest.strip_suffix(".log") else {
        return false;
    };
    num.parse::<i64>().is_ok()
}

fn is_verify_log(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("verify-") else {
        return false;
    };
    let Some(num) = rest.strip_suffix(".log") else {
        return false;
    };
    num.parse::<i64>().is_ok()
}

fn is_report(name: &str) -> bool {
    if name.starts_with("dry-run-report-") {
        return name.ends_with(".md") || name.ends_with(".json");
    }
    if let Some(rest) = name.strip_prefix("report-") {
        return rest.ends_with(".md") || rest.ends_with(".json");
    }
    false
}

/// 当前文件名是否落在所选检索范围内
fn in_scope(name: &str, req: &SearchRequest) -> bool {
    if is_event_stream(name) {
        return req.scope.event_stream;
    }
    if is_agent_log(name) {
        return req.scope.agent_logs;
    }
    if is_verify_log(name) {
        return req.scope.verify_logs;
    }
    if is_report(name) {
        return req.scope.reports;
    }
    false
}

fn snippet_of(line: &str, match_start: usize, match_len: usize) -> String {
    let chars: Vec<char> = line.chars().collect();
    // 命中字节位置 → 字符位置（中文场景下两者不同，这里按字符安全截断）
    let prefix_bytes = line
        .char_indices()
        .take_while(|(b, _)| *b < match_start)
        .count();
    let start = prefix_bytes.saturating_sub(40);
    let end = (prefix_bytes + match_len + 40).min(chars.len());
    let window: String = chars[start..end].iter().collect();
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.push_str(window.trim());
    if end < chars.len() {
        out.push('…');
    }
    out
}

fn scan_file(
    rel_path: &str,
    task_id: Option<String>,
    text: &str,
    req: &SearchRequest,
) -> Option<SearchFileGroup> {
    let needle = if req.case_sensitive {
        req.keyword.clone()
    } else {
        req.keyword.to_lowercase()
    };
    if needle.is_empty() {
        return None;
    }
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut truncated = false;
    for (index, line) in text.split('\n').enumerate() {
        let hay = if req.case_sensitive {
            line.to_string()
        } else {
            line.to_lowercase()
        };
        let Some(at) = hay.find(&needle) else {
            continue;
        };
        if hits.len() >= req.max_hits_per_file {
            truncated = true;
            break;
        }
        hits.push(SearchHit {
            rel_path: rel_path.to_string(),
            line: (index + 1) as i64,
            text: line.to_string(),
            snippet: snippet_of(line, at, needle.chars().count()),
        });
    }
    if hits.is_empty() {
        None
    } else {
        Some(SearchFileGroup {
            task_id,
            rel_path: rel_path.to_string(),
            hits,
            truncated,
        })
    }
}

fn task_id_of(rel: &str) -> Option<String> {
    let rest = rel.strip_prefix("tasks/")?;
    let id = rest.split('/').next()?;
    Some(id.to_string())
}

/// 执行搜索；`cancel` 为真时提前返回且 `cancelled = true`
pub fn search(
    app: &AppHandle,
    home: &Path,
    req: &SearchRequest,
    cancel: &AtomicBool,
) -> SearchResult {
    let mut groups: Vec<SearchFileGroup> = Vec::new();
    let mut scanned: i64 = 0;
    let mut total_hits: i64 = 0;

    // 运行日志（单文件）
    if req.scope.server_log {
        let rel = "logs/server.log".to_string();
        let abs = home.join("logs").join("server.log");
        if let Ok(text) = std::fs::read_to_string(&abs) {
            scanned += 1;
            if let Some(group) = scan_file(&rel, None, &text, req) {
                total_hits += group.hits.len() as i64;
                groups.push(group);
            }
        }
    }

    // 任务目录
    let tasks_root = home.join("tasks");
    if let Ok(entries) = std::fs::read_dir(&tasks_root) {
        for entry in entries.flatten() {
            if cancel.load(Ordering::Relaxed) {
                return SearchResult {
                    groups,
                    scanned_files: scanned,
                    total_hits,
                    cancelled: true,
                };
            }
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let task_id = entry.file_name().to_string_lossy().to_string();
            if !(task_id.starts_with("tsk_") || task_id.starts_with("vfy_")) {
                continue;
            }
            let dir = entry.path();
            let Ok(files) = std::fs::read_dir(&dir) else {
                continue;
            };
            for file in files.flatten() {
                if cancel.load(Ordering::Relaxed) {
                    return SearchResult {
                        groups,
                        scanned_files: scanned,
                        total_hits,
                        cancelled: true,
                    };
                }
                let name = file.file_name().to_string_lossy().to_string();
                if !in_scope(&name, req) {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(file.path()) else {
                    continue;
                };
                scanned += 1;
                let rel = format!("tasks/{task_id}/{name}");
                if let Some(group) = scan_file(&rel, task_id_of(&rel), &text, req) {
                    total_hits += group.hits.len() as i64;
                    groups.push(group);
                }
                // 每扫过若干文件推一次进度，界面不必等全部完成
                if scanned % 10 == 0 {
                    let _ = app.emit(
                        SEARCH_PROGRESS_EVENT,
                        SearchProgressPayload {
                            scanned_files: scanned,
                        },
                    );
                }
            }
        }
    }

    let _ = app.emit(
        SEARCH_PROGRESS_EVENT,
        SearchProgressPayload {
            scanned_files: scanned,
        },
    );

    SearchResult {
        groups,
        scanned_files: scanned,
        total_hits,
        cancelled: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SearchScope;

    fn req(keyword: &str) -> SearchRequest {
        SearchRequest {
            data_home: String::new(),
            keyword: keyword.to_string(),
            scope: SearchScope {
                event_stream: true,
                agent_logs: true,
                verify_logs: true,
                reports: true,
                server_log: true,
            },
            case_sensitive: false,
            max_hits_per_file: 50,
        }
    }

    #[test]
    fn file_name_classification() {
        assert!(is_event_stream("task.jsonl"));
        assert!(is_agent_log("agent-0.log"));
        assert!(!is_agent_log("agent-x.log"));
        assert!(is_verify_log("verify-12.log"));
        assert!(is_report("report-1.md"));
        assert!(is_report("dry-run-report-0.json"));
        assert!(!is_report("baseline.json"));
    }

    #[test]
    fn scan_file_respects_limit_and_reports_truncation() {
        let mut r = req("e");
        r.max_hits_per_file = 2;
        let text = "e\ne\ne\ne\n";
        let group =
            scan_file("tasks/tsk_1/task.jsonl", Some("tsk_1".into()), text, &r).expect("应有命中");
        assert_eq!(group.hits.len(), 2);
        assert!(group.truncated);
    }

    #[test]
    fn scan_file_is_case_insensitive_by_default() {
        let group = scan_file("x", None, "Timeout 发生", &req("timeout")).expect("应有命中");
        assert_eq!(group.hits.len(), 1);
    }

    #[test]
    fn snippet_handles_multibyte_lines() {
        let group =
            scan_file("x", None, "前缀中文内容命中关键字后缀", &req("关键字")).expect("应有命中");
        assert!(group.hits[0].snippet.contains("关键字"));
    }

    #[test]
    fn task_id_extraction() {
        assert_eq!(
            task_id_of("tasks/tsk_1/agent-0.log").as_deref(),
            Some("tsk_1")
        );
        assert_eq!(task_id_of("logs/server.log"), None);
    }

    #[test]
    fn empty_keyword_yields_no_groups() {
        assert!(scan_file("x", None, "abc", &req("")).is_none());
    }
}
