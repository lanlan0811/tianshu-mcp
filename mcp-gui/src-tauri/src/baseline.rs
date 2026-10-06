//! A5 基线漂移：读取任务动工前保存的 `baseline.json`。
//!
//! **只读**：本模块只读 `tasks/<任务>/baseline.json`，不写任何文件。
//! 容错口径与其他只读命令一致：文件缺失 / 不可解析**都不是错误**，如实给出 `present = false`，
//! 由界面提示「该任务没有保存的动工前基线」，而不是编造一份零值基线。

use std::path::Path;

use serde_json::Value;

use crate::models::{BaselineInfo, BaselineRequest};

fn as_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn as_bool(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn count_of(v: &Value, key: &str) -> i64 {
    match v.get(key).and_then(Value::as_array) {
        Some(items) => items.len() as i64,
        // 缺失或类型不符一律 0（不猜）；同时兼容已经给出计数的写法
        None => v.get(key).and_then(Value::as_i64).unwrap_or(0),
    }
}

/// 读取基线摘要；文件缺失 / 损坏时返回 `present = false` 的默认值。
pub fn read_baseline(home: &Path, req: &BaselineRequest) -> BaselineInfo {
    // 任务 ID 先过字符白名单：非法 / 越界 ID 与「文件缺失」同口径 —— 如实给出
    // `present = false`，而不是去读数据目录之外的文件。（修复前此处是裸 `join`。）
    let Ok(dir) = crate::data_home::task_dir(home, &req.task_id) else {
        return BaselineInfo::default();
    };
    let path = dir.join("baseline.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return BaselineInfo::default(),
    };
    let parsed: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return BaselineInfo::default(),
    };
    if !parsed.is_object() {
        return BaselineInfo::default();
    }

    BaselineInfo {
        present: true,
        is_repo: as_bool(&parsed, "isRepo"),
        head: as_str(&parsed, "head"),
        dirty: as_bool(&parsed, "dirty"),
        dirty_files_count: count_of(&parsed, "dirtyFiles"),
        pre_existing_changed_count: count_of(&parsed, "preExistingChanged"),
        pre_existing_untracked_count: count_of(&parsed, "preExistingUntracked"),
        captured_at: as_str(&parsed, "capturedAt"),
        message: as_str(&parsed, "message"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_baseline(home: &Path, task_id: &str, body: &str) {
        let dir = home.join("tasks").join(task_id);
        std::fs::create_dir_all(&dir).expect("建目录");
        std::fs::write(dir.join("baseline.json"), body).expect("写基线");
    }

    fn req(task_id: &str) -> BaselineRequest {
        BaselineRequest {
            data_home: String::new(),
            task_id: task_id.to_string(),
        }
    }

    #[test]
    fn reads_full_baseline() {
        let home = std::env::temp_dir().join("tianshu-gui-baseline-test");
        let _ = std::fs::remove_dir_all(&home);
        write_baseline(
            &home,
            "tsk_1",
            r#"{"isRepo":true,"head":"abc123","dirty":true,
                "dirtyFiles":["a.ts","b.ts"],
                "preExistingChanged":[{"file":"a.ts"}],
                "preExistingUntracked":["c.ts"],
                "capturedAt":"2026-09-26T10:00:00Z","message":"动工前基线"}"#,
        );
        let info = read_baseline(&home, &req("tsk_1"));
        assert!(info.present);
        assert!(info.is_repo);
        assert!(info.dirty);
        assert_eq!(info.head.as_deref(), Some("abc123"));
        assert_eq!(info.dirty_files_count, 2);
        assert_eq!(info.pre_existing_changed_count, 1);
        assert_eq!(info.pre_existing_untracked_count, 1);
        assert_eq!(info.captured_at.as_deref(), Some("2026-09-26T10:00:00Z"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn missing_file_is_not_an_error() {
        let home = std::env::temp_dir().join("tianshu-gui-baseline-missing-test");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("tasks/tsk_none")).expect("建目录");
        let info = read_baseline(&home, &req("tsk_none"));
        assert!(!info.present);
        assert_eq!(info.dirty_files_count, 0);
        assert!(info.head.is_none());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn broken_json_yields_present_false() {
        let home = std::env::temp_dir().join("tianshu-gui-baseline-broken-test");
        let _ = std::fs::remove_dir_all(&home);
        write_baseline(&home, "tsk_2", "{坏行");
        let info = read_baseline(&home, &req("tsk_2"));
        assert!(!info.present);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn tolerates_missing_fields_and_wrong_types() {
        let home = std::env::temp_dir().join("tianshu-gui-baseline-tolerate-test");
        let _ = std::fs::remove_dir_all(&home);
        write_baseline(&home, "tsk_3", r#"{"isRepo":"yes","dirtyFiles":3}"#);
        let info = read_baseline(&home, &req("tsk_3"));
        assert!(info.present);
        // 类型不符的布尔一律 false（不猜）
        assert!(!info.is_repo);
        // 已给计数的写法也被接受
        assert_eq!(info.dirty_files_count, 3);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 越界防护（issue #32）：含 `..` 的 task_id **不得**读到数据目录之外。
    ///
    /// 修复前该用例为 RED：裸 join 会读到 `<home>/../outside/evil/baseline.json`。
    /// 断言不仅看 `present`，还直接检查**敏感字段有没有被读进来** —— 避免「恰好没读到」
    /// 被误当作「防线生效」。
    #[test]
    fn read_baseline_rejects_escape() {
        let base = std::env::temp_dir().join("tianshu-gui-baseline-escape-test");
        let _ = std::fs::remove_dir_all(&base);
        let home = base.join("home");
        std::fs::create_dir_all(home.join("tasks/tsk_ok")).expect("建数据目录");
        // 数据目录之外放一份「有辨识度」的基线
        let outside = base.join("outside/evil");
        std::fs::create_dir_all(&outside).expect("建外部目录");
        std::fs::write(
            outside.join("baseline.json"),
            r#"{"isRepo":true,"head":"SECRET-OUTSIDE","dirty":true}"#,
        )
        .expect("写外部基线");

        let info = read_baseline(&home, &req("../../outside/evil"));
        assert!(!info.present, "越界 task_id 必须视为「无基线」");
        assert_ne!(
            info.head.as_deref(),
            Some("SECRET-OUTSIDE"),
            "绝不能读到数据目录之外的基线内容"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 绝对路径注入同样必须被挡
    #[test]
    fn read_baseline_rejects_absolute_path() {
        let home = std::env::temp_dir().join("tianshu-gui-baseline-abs-test");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("tasks/tsk_ok")).expect("建目录");
        let info = read_baseline(&home, &req("/etc"));
        assert!(!info.present);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 反证用例：合法 ID 照常读到基线（修复不得误伤）
    #[test]
    fn legit_task_id_still_reads_baseline() {
        let home = std::env::temp_dir().join("tianshu-gui-baseline-legit-test");
        let _ = std::fs::remove_dir_all(&home);
        write_baseline(
            &home,
            "tsk_20260926135200_d4e5f6",
            r#"{"isRepo":true,"head":"abc","dirtyFiles":["x"]}"#,
        );
        let info = read_baseline(&home, &req("tsk_20260926135200_d4e5f6"));
        assert!(info.present);
        assert_eq!(info.head.as_deref(), Some("abc"));
        assert_eq!(info.dirty_files_count, 1);
        let _ = std::fs::remove_dir_all(&home);
    }
}
