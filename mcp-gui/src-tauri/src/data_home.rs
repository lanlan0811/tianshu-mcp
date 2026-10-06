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
///
/// **分工**：路径类输入（如 `tasks/<id>/agent-0.log`、用户从界面选中的相对路径）走本函数；
/// **ID 类输入**（裸任务 ID，如 `tsk_20260926135200_d4e5f6`）走 [`task_dir`] ——
/// 后者额外施加 `[A-Za-z0-9_-]` 字符白名单（`ARCHITECTURE.md` §16.10）。两者**不得混用**。
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

/// 任务 ID 字符白名单校验：只接受 `[A-Za-z0-9_-]`（首尾空白先 trim）。
///
/// 与前端 `core/deeplink.ts` 的 `TASK_ID_RE`（`/^[A-Za-z0-9_-]+$/`）及
/// `ARCHITECTURE.md` §16.10 同口径。任务 ID 会被拼进 `tasks/<id>/…` 路径，
/// 故**任何源自 IPC 的 task_id 在拼进路径前都必须过这道白名单**。
///
/// 用逐字节判定而非正则：不引入 `regex` 依赖，且 ASCII-only 天然排除 Unicode 同形字、
/// Windows 非法路径字符（`:` `*` `?` `"` `<` `>` `|`）与 NTFS 备用数据流（`a:b`）。
pub fn validate_task_id(task_id: &str) -> Result<&str, String> {
    let id = task_id.trim();
    if id.is_empty() {
        return Err("任务 ID 不能为空".to_string());
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(format!("任务 ID 含非法字符（只允许 [A-Za-z0-9_-]）：{id}"));
    }
    Ok(id)
}

/// 安全拼装 `<home>/tasks/<id>`：ID 先过 [`validate_task_id`] 白名单。
///
/// 所有「拿裸 task_id 拼路径」的调用点都应改用本函数，而不是自己 `join` ——
/// 单点收口才能保证新增命令自动继承防线。
pub fn task_dir(home: &Path, task_id: &str) -> Result<PathBuf, String> {
    let id = validate_task_id(task_id)?;
    Ok(home.join("tasks").join(id))
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

    #[test]
    fn validate_task_id_rejects_escapes_and_illegal_chars() {
        // 路径穿越
        assert!(validate_task_id("..").is_err());
        assert!(validate_task_id("a/../b").is_err());
        assert!(validate_task_id("a/b").is_err());
        assert!(validate_task_id("a\\b").is_err());
        // 绝对路径 / 盘符 / UNC
        assert!(validate_task_id("C:/Windows").is_err());
        assert!(validate_task_id("/etc/passwd").is_err());
        assert!(validate_task_id("\\\\server\\share").is_err());
        // Windows 非法字符与 NTFS 备用数据流
        assert!(validate_task_id("a:b").is_err());
        assert!(validate_task_id("a*b").is_err());
        assert!(validate_task_id("a?b").is_err());
        assert!(validate_task_id("a\"b").is_err());
        assert!(validate_task_id("a|b").is_err());
        // 空白与点号（点号不在白名单内）
        assert!(validate_task_id("").is_err());
        assert!(validate_task_id("   ").is_err());
        assert!(validate_task_id("tsk.1").is_err());
        assert!(validate_task_id("a b").is_err());
        // Unicode 同形字（ASCII-only 白名单应拒绝）
        assert!(validate_task_id("tsk＿1").is_err());
        assert!(validate_task_id("tаsk").is_err()); // 西里尔 а
    }

    #[test]
    fn validate_task_id_accepts_legit_ids_and_trims() {
        // 与 `genTaskId()` / `genVerifyId()` 的真实产物同位形
        assert_eq!(
            validate_task_id("tsk_20260926135200_d4e5f6").expect("合法"),
            "tsk_20260926135200_d4e5f6"
        );
        assert_eq!(validate_task_id("vfy_2026-09-26_x1").expect("合法"), "vfy_2026-09-26_x1");
        assert_eq!(validate_task_id("a-b_c9").expect("合法"), "a-b_c9");
        // 前后空白被 trim 后仍然合法
        assert_eq!(validate_task_id("  tsk_1  ").expect("trim 后合法"), "tsk_1");
    }

    #[test]
    fn task_dir_stays_inside_tasks_root() {
        let home = Path::new("/tmp/home");
        assert_eq!(
            task_dir(home, "tsk_1").expect("合法").to_string_lossy(),
            home.join("tasks").join("tsk_1").to_string_lossy()
        );
        // 越界 ID 被拒，绝不产出 tasks/ 之外的路径
        assert!(task_dir(home, "../../outside/evil").is_err());
        assert!(task_dir(home, "..").is_err());
    }
}
