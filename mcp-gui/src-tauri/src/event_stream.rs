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

/// 读取事件流并解析为事件数组。
///
/// - `req.full == false`（默认）：只读**尾部窗口**，行为与既有完全一致；
/// - `req.full == true`：读**全量**（阶段甘特需要从头看到尾），解析逻辑**与窗口模式共用同一段代码**，
///   只有「取文本的方式」不同；全量读取失败时退回尾部窗口，不把整页打空。
pub fn read_events(home: &Path, req: &ReadEventsRequest) -> ReadEventsResult {
    // 任务 ID 先过字符白名单：非法 / 越界 ID 与「文件缺失」同口径，如实返回空窗口，
    // 而不是去读数据目录之外的文件。（修复前此处是裸 `join`。）
    let Ok(dir) = crate::data_home::task_dir(home, &req.task_id) else {
        return ReadEventsResult {
            events: Vec::new(),
            total_bytes: 0,
            loaded_from: 0,
            loaded_to: 0,
            bad_lines: 0,
            loaded_count: 0,
        };
    };
    let path = dir.join("task.jsonl");
    let window_bytes = req.window_bytes.unwrap_or_else(tail::default_window);

    let window = if req.full {
        match tail::read_whole(&path) {
            Ok(text) => tail::ByteWindow {
                total: text.len() as u64,
                from: 0,
                to: text.len() as u64,
                text,
            },
            // 全量读取失败（含非 UTF-8）时退回尾部窗口，不静默给空内容
            Err(_) => match tail::read_tail(&path, window_bytes) {
                Ok(w) => w,
                Err(_) => {
                    return ReadEventsResult {
                        events: Vec::new(),
                        total_bytes: 0,
                        loaded_from: 0,
                        loaded_to: 0,
                        bad_lines: 0,
                        loaded_count: 0,
                    }
                }
            },
        }
    } else {
        match tail::read_tail(&path, window_bytes) {
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
            full: false,
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
            full: false,
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
            full: false,
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
            full: false,
        };
        let res = read_events(&home, &req);
        assert_eq!(res.events.len(), 0);
        assert_eq!(res.total_bytes, 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn full_reads_from_the_beginning_and_reports_total_bytes() {
        let home = std::env::temp_dir().join("tianshu-gui-events-full-test");
        let _ = std::fs::remove_dir_all(&home);
        // 造出远超默认窗口的内容：前面塞注释行（非 JSON 会记坏行，故用合法事件行填充）
        let mut body = String::from("{\"ts\":\"t0\",\"event\":\"created\",\"state\":\"queued\"}\n");
        for i in 0..2000 {
            body.push_str(&format!(
                "{{\"ts\":\"t{i}\",\"event\":\"note\",\"state\":\"running\"}}\n"
            ));
        }
        body.push_str("{\"ts\":\"tlast\",\"event\":\"succeeded\",\"state\":\"succeeded\"}\n");
        write_jsonl(&home, "tsk_full", &body);

        let tail_req = ReadEventsRequest {
            data_home: home.to_string_lossy().to_string(),
            task_id: "tsk_full".to_string(),
            limit: None,
            window_bytes: None,
            full: false,
        };
        let tail = read_events(&home, &tail_req);
        // 尾部窗口读不全：第一条事件不是 created
        assert!(tail.loaded_from > 0);
        assert_ne!(tail.events[0].event, "created");

        let full_req = ReadEventsRequest {
            full: true,
            ..tail_req
        };
        let full = read_events(&home, &full_req);
        assert_eq!(full.loaded_from, 0);
        assert_eq!(full.events[0].event, "created");
        assert_eq!(full.events.len(), 2002);
        assert_eq!(
            full.events.last().map(|e| e.event.as_str()),
            Some("succeeded")
        );
        assert_eq!(full.bad_lines, 0);
        assert_eq!(full.total_bytes, body.len() as u64);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 越界防护（issue #32）：含 `..` 的 task_id **不得**读到数据目录之外的事件流。
    ///
    /// 修复前该用例为 RED：裸 join 会读到 `<home>/../outside/evil/task.jsonl`。
    #[test]
    fn read_events_rejects_escape() {
        let base = std::env::temp_dir().join("tianshu-gui-events-escape-test");
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        std::fs::create_dir_all(home.join("tasks/tsk_ok")).expect("建数据目录");
        // 数据目录之外放一份「有辨识度」的事件流
        let outside = base.join("outside/evil");
        std::fs::create_dir_all(&outside).expect("建外部目录");
        std::fs::write(
            outside.join("task.jsonl"),
            "{\"ts\":\"t1\",\"event\":\"SECRET-OUTSIDE\",\"state\":\"running\"}\n",
        )
        .expect("写外部事件流");

        let res = read_events(
            &home,
            &ReadEventsRequest {
                data_home: home.to_string_lossy().to_string(),
                task_id: "../../outside/evil".to_string(),
                limit: None,
                window_bytes: None,
                full: true, // 用全量读，确保不是「窗口恰好没覆盖」造成的假绿
            },
        );
        assert!(res.events.is_empty(), "越界 task_id 必须返回空事件");
        assert_eq!(res.total_bytes, 0);
        assert!(
            !res.events.iter().any(|e| e.event == "SECRET-OUTSIDE"),
            "绝不能读到数据目录之外的事件内容"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 绝对路径注入同样必须被挡
    #[test]
    fn read_events_rejects_absolute_path() {
        let home = std::env::temp_dir().join("tianshu-gui-events-abs-test");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("tasks/tsk_ok")).expect("建目录");
        let res = read_events(
            &home,
            &ReadEventsRequest {
                data_home: home.to_string_lossy().to_string(),
                task_id: "/etc".to_string(),
                limit: None,
                window_bytes: None,
                full: true,
            },
        );
        assert!(res.events.is_empty());
        assert_eq!(res.total_bytes, 0);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 反证用例：合法 ID 照常读到事件（修复不得误伤）
    #[test]
    fn legit_task_id_still_reads_events() {
        let home = std::env::temp_dir().join("tianshu-gui-events-legit-test");
        let _ = std::fs::remove_dir_all(&home);
        write_jsonl(
            &home,
            "tsk_20260926135200_d4e5f6",
            "{\"ts\":\"t1\",\"event\":\"created\",\"state\":\"queued\"}\n",
        );
        let res = read_events(
            &home,
            &ReadEventsRequest {
                data_home: home.to_string_lossy().to_string(),
                task_id: "tsk_20260926135200_d4e5f6".to_string(),
                limit: None,
                window_bytes: None,
                full: true,
            },
        );
        assert_eq!(res.events.len(), 1);
        assert_eq!(res.events[0].event, "created");
        let _ = std::fs::remove_dir_all(&home);
    }
}
