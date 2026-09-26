//! 数据目录解析 / 校验 / 相对路径安全拼接。
//!
//! 与 MCP server 的 `resolveDataHome()` 保持同一口径：
//! `TIANSHU_MCP_HOME` 覆盖 → 否则 `~/.tianshu-mcp`。

use std::path::{Component, Path, PathBuf};

/// 自动探测默认数据目录
pub fn resolve_data_home() -> PathBuf {
    if let Ok(raw) = std::env::var("TIANSHU_MCP_HOME") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    match dirs::home_dir() {
        Some(home) => home.join(".tianshu-mcp"),
        None => PathBuf::from(".tianshu-mcp"),
    }
}

/// 合法性校验：目录下必须存在 `logs/` 或 `tasks/`（与 issue #25 的附加目录规则一致）
pub fn validate_data_home(path: &Path) -> (bool, String) {
    if !path.is_dir() {
        return (false, "目录不存在或不可读".to_string());
    }
    if path.join("logs").is_dir() || path.join("tasks").is_dir() {
        (true, String::new())
    } else {
        (false, "目录下必须存在 logs/ 或 tasks/".to_string())
    }
}

/// 把「相对数据目录的路径」解析为绝对路径，并拒绝任何越界尝试。
///
/// 规则：不接受绝对路径、不接受 `..`、不接受盘符/前缀段。
pub fn resolve_rel(home: &Path, rel: &str) -> Result<PathBuf, String> {
    let normalized = rel.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err("只接受相对数据目录的路径".to_string());
    }
    let mut out = home.to_path_buf();
    for seg in normalized.split('/') {
        match seg {
            "" | "." => continue,
            ".." => return Err("路径不得包含 ..".to_string()),
            other => {
                if Path::new(other).components().any(|c| {
                    matches!(
                        c,
                        Component::Prefix(_) | Component::RootDir | Component::ParentDir
                    )
                }) {
                    return Err("路径不得包含盘符或根前缀".to_string());
                }
                out.push(other);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rel_rejects_escapes() {
        let home = Path::new("/tmp/home");
        assert!(resolve_rel(home, "../etc/passwd").is_err());
        assert!(resolve_rel(home, "/etc/passwd").is_err());
        assert!(resolve_rel(home, "tasks/../../x").is_err());
        // 盘符前缀只在 Windows 上是 `Component::Prefix`；类 Unix 下 "C:/Windows" 只是普通相对路径
        #[cfg(windows)]
        assert!(resolve_rel(home, "C:/Windows").is_err());
    }

    #[test]
    fn resolve_rel_normalizes_separators() {
        let home = Path::new("/tmp/home");
        let p = resolve_rel(home, "tasks\\tsk_1\\agent-0.log").expect("应当可解析");
        assert!(p.ends_with("agent-0.log"));
        assert!(p.to_string_lossy().contains("tsk_1"));
    }

    #[test]
    fn validate_requires_logs_or_tasks() {
        let dir = std::env::temp_dir().join("tianshu-gui-validate-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("logs")).expect("建目录");
        assert!(validate_data_home(&dir).0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
