//! 文件监听 → Tauri 事件推送（实时 tail）。
//!
//! 只监听**用户当前打开的那个日志文件**（以及其父目录，用于文件尚未创建的情况），
//! 事件负载为「相对路径 + 最新总字节数」，由前端据此增量拉取。

use std::path::Path;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;

pub const LOG_CHANGED_EVENT: &str = "gui/log-changed";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogChangedPayload {
    pub rel_path: String,
    pub total_bytes: u64,
}

fn emit_for_path(app: &AppHandle, home: &Path, abs: &Path) {
    let rel = match abs.strip_prefix(home) {
        Ok(r) => r.to_string_lossy().replace('\\', "/"),
        Err(_) => return,
    };
    let total = std::fs::metadata(abs).map(|m| m.len()).unwrap_or(0);
    let _ = app.emit(
        LOG_CHANGED_EVENT,
        LogChangedPayload {
            rel_path: rel,
            total_bytes: total,
        },
    );
}

/// 启动监听（会先停掉上一轮），`rel_paths` 为相对数据目录的路径
pub fn start(app: &AppHandle, home: &Path, rel_paths: &[String]) -> Result<(), String> {
    stop(app);

    let handle = app.clone();
    let home_owned = home.to_path_buf();

    let mut watcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let event = match res {
                Ok(e) => e,
                Err(_) => return,
            };
            if event.kind.is_remove() {
                return;
            }
            for path in &event.paths {
                emit_for_path(&handle, &home_owned, path);
            }
        })
        .map_err(|e| format!("创建文件监听失败：{e}"))?;
    for rel in rel_paths {
        let abs = crate::data_home::resolve_rel(home, rel)?;
        if abs.is_file() {
            watcher
                .watch(&abs, RecursiveMode::NonRecursive)
                .map_err(|e| format!("监听文件失败（{rel}）：{e}"))?;
        } else if let Some(parent) = abs.parent() {
            if parent.is_dir() {
                // 文件尚未创建：监听父目录，等它出现
                let _ = watcher.watch(parent, RecursiveMode::NonRecursive);
            }
        }
    }

    let state = app.state::<AppState>();
    let mut slot = state.watcher.lock().map_err(|_| "监听状态锁失效".to_string())?;
    *slot = Some(watcher);
    Ok(())
}

/// 停止监听（幂等）
pub fn stop(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(mut slot) = state.watcher.lock() {
        *slot = None;
    }
}
