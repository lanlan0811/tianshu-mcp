//! `task.jsonl` 解析（事件流）。
//!
//! 容错口径与 MCP server 的 `TaskStore.readEvents()` 一致：
//! 坏行**跳过但计数**，绝不静默当正常内容。

use std::path::Path;

use serde_json::Value;

use crate::models::{ReadEventsRequest, ReadEventsResult, TaskEventOut};
use crate::schema::classify_event;
use crate::tail;

fn as_string(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn as_optional_string(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

/// 读取事件流尾部窗口并解析为事件数组
pub fn read_events(home: &Path, req: &ReadEventsRequest) -> ReadEventsResult {
    let path = home.join("tasks").join(&req.task_id).join("task.jsonl");
    let window_bytes = req.window_bytes.unwrap_or_else(tail::default_window);

    let window = match tail::read_tail(&path, window_bytes) {
        Ok(w) => w,
        Err(_) => {
            // 文件缺失不是错误：如实返回空窗口，由界面显示「没有事件记录」
            return ReadEventsResult {
                events: Vec::new(),
                total_bytes: 0,
                loaded_from: 0,
                loaded_to: 0,
                bad_lines: 0,
                loaded_count: 0,
            };
        }
    };

    let mut events: Vec<TaskEventOut> = Vec::new();
    let mut bad_lines: i64 = 0;
    for (index, raw) in window.text.split('\n').enumerate() {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let line = (index + 1) as i64;
        let parsed: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => {
                bad_lines += 1;
                continue;
            }
        };
        if !parsed.is_object() {
            bad_lines += 1;
            continue;
        }
        let event = as_string(&parsed, "event");
        if event.is_empty() {
            bad_lines += 1;
            continue;
        }
        let data = parsed.get("data").filter(|d| !d.is_null()).cloned();
        events.push(TaskEventOut {
            ts: as_string(&parsed, "ts"),
            kind: classify_event(&event).to_string(),
            event,
            state: as_string(&parsed, "state"),
            detail: as_optional_string(&parsed, "detail"),
            data,
            line,
        });
    }

    let loaded_count = events.len() as i64;
    if let Some(limit) = req.limit {
        if limit > 0 && events.len() > limit as usize {
            let start = events.len() - limit as usize;
            events = events.split_off(start);
        }
    }

    ReadEventsResult {
        events,
        total_bytes: window.total,
        loaded_from: window.from,
        loaded_to: window.to,
        bad_lines,
        loaded_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_jsonl(home: &Path, task_id: &str, body: &str) {
        let dir = home.join("tasks").join(task_id);
        std::fs::create_dir_all(&dir).expect("建目录");
        std::fs::write(dir.join("task.jsonl"), body).expect("写事件流");
    }

    #[test]
    fn parses_events_with_kind_and_line() {
        let home = std::env::temp_dir().join("tianshu-gui-events-test");
        let _ = std::fs::remove_dir_all(&home);
        write_jsonl(
            &home,
            "tsk_1",
            "{\"ts\":\"t1\",\"event\":\"created\",\"state\":\"queued\"}\n{\"ts\":\"t2\",\"event\":\"task_dispatched\",\"state\":\"running\",\"data\":{\"round\":0}}\n{\"ts\":\"t3\",\"event\":\"note\",\"state\":\"running\"}\n",
        );
        let req = ReadEventsRequest {
            data_home: home.to_string_lossy().to_string(),
            task_id: "tsk_1".to_string(),
            limit: None,
            window_bytes: None,
        };
        let res = read_events(&home, &req);
        assert_eq!(res.events.len(), 3);
        assert_eq!(res.bad_lines, 0);
        assert_eq!(res.events[0].kind, "status");
        assert_eq!(res.events[1].kind, "agent");
        assert_eq!(res.events[1].data.as_ref().unwrap()["round"], 0);
        assert_eq!(res.events[2].kind, "note");
        assert_eq!(res.events[2].line, 3);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn bad_lines_are_counted_not_swallowed() {
        let home = std::env::temp_dir().join("tianshu-gui-events-bad-test");
        let _ = std::fs::remove_dir_all(&home);
        write_jsonl(
            &home,
            "tsk_2",
            "{\"event\":\"queued\",\"state\":\"queued\"}\n{坏行\n\n",
        );
        let req = ReadEventsRequest {
            data_home: home.to_string_lossy().to_string(),
            task_id: "tsk_2".to_string(),
            limit: None,
            window_bytes: None,
        };
        let res = read_events(&home, &req);
        assert_eq!(res.events.len(), 1);
        assert_eq!(res.bad_lines, 1);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn limit_keeps_tail() {
        let home = std::env::temp_dir().join("tianshu-gui-events-limit-test");
        let _ = std::fs::remove_dir_all(&home);
        write_jsonl(
            &home,
            "tsk_3",
            "{\"event\":\"created\",\"state\":\"queued\"}\n{\"event\":\"started\",\"state\":\"running\"}\n{\"event\":\"succeeded\",\"state\":\"succeeded\"}\n",
        );
        let req = ReadEventsRequest {
            data_home: home.to_string_lossy().to_string(),
            task_id: "tsk_3".to_string(),
            limit: Some(2),
            window_bytes: None,
        };
        let res = read_events(&home, &req);
        assert_eq!(res.events.len(), 2);
        assert_eq!(res.events[0].event, "started");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn missing_file_yields_empty_window() {
        let home = std::env::temp_dir().join("tianshu-gui-events-missing-test");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("建目录");
        let req = ReadEventsRequest {
            data_home: home.to_string_lossy().to_string(),
            task_id: "tsk_none".to_string(),
            limit: None,
            window_bytes: None,
        };
        let res = read_events(&home, &req);
        assert_eq!(res.events.len(), 0);
        assert_eq!(res.total_bytes, 0);
        let _ = std::fs::remove_dir_all(&home);
    }
}
