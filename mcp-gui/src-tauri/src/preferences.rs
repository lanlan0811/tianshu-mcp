//! 应用偏好的持久化（语言 / 主题 / 更新源 / 数据目录历史）。
//!
//! **落点约束**：只写系统应用配置目录（`app_config_dir`），
//! 绝不写入业务数据目录或项目目录——GUI 对业务数据全程只读。

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::models::Preferences;

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("解析应用配置目录失败：{e}"))?;
    Ok(dir.join("preferences.json"))
}

/// 读取偏好；文件缺失或损坏时回退默认值（不阻塞启动）
pub fn load(app: &AppHandle) -> Preferences {
    let Ok(path) = config_path(app) else {
        return Preferences::default();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Preferences::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save(app: &AppHandle, prefs: &Preferences) -> Result<(), String> {
    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let text = serde_json::to_string_pretty(prefs).map_err(|e| format!("序列化偏好失败：{e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("写入偏好失败：{e}"))
}
