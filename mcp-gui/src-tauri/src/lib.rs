//! Tianshu-mcp 日志台 —— Tauri 后端入口与命令注册。
//!
//! **只读契约**：全部取数命令只读业务数据；唯一的写入是应用自身偏好
//! （系统应用配置目录）与用户显式选择的导出/更新临时文件。

mod data_home;
mod event_stream;
mod export;
mod models;
mod preferences;
mod scanner;
mod schema;
mod search;
mod tail;
mod updater;
mod watcher;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

use models::{
    AppVersionInfo, CheckUpdateResult, DataHomeEntry, DataHomeState, ExportFileRequest,
    ExportResult, ExportTaskZipRequest, InstallUpdateResult, ListTasksRequest, LogChunk,
    Preferences, ProbeSourceResult, ReadEventsRequest, ReadEventsResult, ReadLogRequest,
    ReadReportRequest, ReadReportResult, SearchRequest, SearchResult, TaskSummary,
};

/// 应用全局状态（全部为内存态；业务数据永不写入）
pub struct AppState {
    /// 当前生效的数据目录（绝对路径）
    pub data_home: Mutex<String>,
    /// 用户偏好（与磁盘上的 preferences.json 同步）
    pub preferences: Mutex<Preferences>,
    /// 跨任务搜索的取消标记
    pub search_cancel: Arc<AtomicBool>,
    /// 文件监听句柄（同一时刻只监听当前打开的日志）
    pub watcher: Mutex<Option<notify::RecommendedWatcher>>,
    /// 更新源探测结果缓存（TTL 内复用）
    pub probe_cache: Mutex<Option<(std::time::Instant, ProbeSourceResult)>>,
}

impl AppState {
    fn new(data_home: String, preferences: Preferences) -> Self {
        Self {
            data_home: Mutex::new(data_home),
            preferences: Mutex::new(preferences),
            search_cancel: Arc::new(AtomicBool::new(false)),
            watcher: Mutex::new(None),
            probe_cache: Mutex::new(None),
        }
    }
}

fn home_of(state: &AppState) -> PathBuf {
    match state.data_home.lock() {
        Ok(guard) => PathBuf::from(guard.clone()),
        Err(_) => PathBuf::from("."),
    }
}

fn current_preferences(state: &AppState) -> Preferences {
    state
        .preferences
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

fn build_home_state(state: &AppState) -> DataHomeState {
    let detected = data_home::resolve_data_home();
    let active = home_of(state);
    let prefs = current_preferences(state);

    let mut entries: Vec<DataHomeEntry> = Vec::new();
    let detected_str = detected.to_string_lossy().to_string();
    let (valid, message) = data_home::validate_data_home(&detected);
    entries.push(DataHomeEntry {
        path: detected_str.clone(),
        label: detected_str.clone(),
        valid,
        message,
    });
    for extra in &prefs.data_homes {
        let path = PathBuf::from(extra);
        let (valid, message) = data_home::validate_data_home(&path);
        entries.push(DataHomeEntry {
            path: extra.clone(),
            label: extra.clone(),
            valid,
            message,
        });
    }

    DataHomeState {
        detected: detected_str,
        active: active.to_string_lossy().to_string(),
        entries,
    }
}

/* ---------------- 版本 / 数据目录 ---------------- */

#[tauri::command]
async fn get_app_version(app: AppHandle) -> AppVersionInfo {
    updater::app_version_info(&app)
}

#[tauri::command]
async fn get_data_home_state(state: State<'_, AppState>) -> Result<DataHomeState, String> {
    Ok(build_home_state(&state))
}

#[tauri::command]
async fn add_data_home(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<DataHomeState, String> {
    let candidate = PathBuf::from(path.trim());
    let (valid, message) = data_home::validate_data_home(&candidate);
    if !valid {
        return Err(if message.is_empty() {
            "目录不合法".to_string()
        } else {
            message
        });
    }
    let normalized = candidate.to_string_lossy().to_string();
    let prefs = {
        let mut guard = state
            .preferences
            .lock()
            .map_err(|_| "偏好状态锁失效".to_string())?;
        if !guard.data_homes.iter().any(|p| p == &normalized) {
            guard.data_homes.push(normalized.clone());
        }
        guard.clone()
    };
    preferences::save(&app, &prefs)?;
    Ok(build_home_state(&state))
}

#[tauri::command]
async fn remove_data_home(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<DataHomeState, String> {
    let prefs = {
        let mut guard = state
            .preferences
            .lock()
            .map_err(|_| "偏好状态锁失效".to_string())?;
        guard.data_homes.retain(|p| p != &path);
        guard.clone()
    };
    preferences::save(&app, &prefs)?;
    // 移除的是当前目录时退回自动探测目录
    {
        let detected = data_home::resolve_data_home();
        let mut active = state
            .data_home
            .lock()
            .map_err(|_| "数据目录锁失效".to_string())?;
        if *active == path {
            *active = detected.to_string_lossy().to_string();
        }
    }
    Ok(build_home_state(&state))
}

#[tauri::command]
async fn set_active_data_home(
    state: State<'_, AppState>,
    path: String,
) -> Result<DataHomeState, String> {
    let candidate = PathBuf::from(path.trim());
    let (valid, message) = data_home::validate_data_home(&candidate);
    if !valid {
        return Err(if message.is_empty() {
            "目录不合法".to_string()
        } else {
            message
        });
    }
    {
        let mut active = state
            .data_home
            .lock()
            .map_err(|_| "数据目录锁失效".to_string())?;
        *active = candidate.to_string_lossy().to_string();
    }
    Ok(build_home_state(&state))
}

fn optional_path(value: Option<tauri_plugin_dialog::FilePath>) -> Option<String> {
    value.and_then(|fp| fp.as_path().map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
async fn pick_directory(app: AppHandle) -> Option<String> {
    optional_path(app.dialog().file().blocking_pick_folder())
}

#[tauri::command]
async fn pick_save_path(app: AppHandle, default_name: String) -> Option<String> {
    optional_path(
        app.dialog()
            .file()
            .set_file_name(default_name)
            .blocking_save_file(),
    )
}

/* ---------------- 任务 / 事件 / 日志 / 报告 ---------------- */

#[tauri::command]
async fn list_tasks(
    state: State<'_, AppState>,
    req: ListTasksRequest,
) -> Result<Vec<TaskSummary>, String> {
    let home = if req.data_home.trim().is_empty() {
        home_of(&state)
    } else {
        PathBuf::from(req.data_home.trim())
    };
    Ok(scanner::list_tasks(&home, &req))
}

#[tauri::command]
async fn read_events(
    state: State<'_, AppState>,
    req: ReadEventsRequest,
) -> Result<ReadEventsResult, String> {
    let home = home_of(&state);
    Ok(event_stream::read_events(&home, &req))
}

#[tauri::command]
async fn read_log(state: State<'_, AppState>, req: ReadLogRequest) -> Result<LogChunk, String> {
    let home = home_of(&state);
    let abs = data_home::resolve_rel(&home, &req.rel_path)?;
    let window_bytes = req.window_bytes.unwrap_or_else(tail::default_window);
    let absolute_path = abs.to_string_lossy().to_string();
    let rel_path = req.rel_path;

    // 文件尚未出现：如实返回空窗口，而不是报错（日志文件可能还没创建）
    if !abs.is_file() {
        return Ok(LogChunk {
            text: String::new(),
            rel_path,
            absolute_path,
            from_byte: 0,
            to_byte: 0,
            loaded_from: 0,
            loaded_to: 0,
            total_bytes: 0,
        });
    }

    if req.mode == "before" {
        let to = req
            .loaded_from
            .ok_or_else(|| "before 模式必须提供 loadedFrom".to_string())?;
        let from = to.saturating_sub(window_bytes);
        let window = tail::read_range(&abs, from, to)?;
        Ok(LogChunk {
            text: window.text,
            rel_path,
            absolute_path,
            from_byte: window.from,
            to_byte: window.to,
            loaded_from: window.from,
            loaded_to: to,
            total_bytes: window.total,
        })
    } else {
        let window = tail::read_tail(&abs, window_bytes)?;
        Ok(LogChunk {
            text: window.text,
            rel_path,
            absolute_path,
            from_byte: window.from,
            to_byte: window.to,
            loaded_from: window.from,
            loaded_to: window.to,
            total_bytes: window.total,
        })
    }
}

fn report_rel_path(task_id: &str, round: i64, kind: &str) -> Result<String, String> {
    match kind {
        "md" => Ok(format!("tasks/{task_id}/report-{round}.md")),
        "json" => Ok(format!("tasks/{task_id}/report-{round}.json")),
        "html" => Ok(format!("tasks/{task_id}/report-{round}.html")),
        "dry-run-md" => Ok(format!("tasks/{task_id}/dry-run-report-{round}.md")),
        "dry-run-json" => Ok(format!("tasks/{task_id}/dry-run-report-{round}.json")),
        other => Err(format!("不支持的报告类型：{other}")),
    }
}

#[tauri::command]
async fn read_report(
    state: State<'_, AppState>,
    req: ReadReportRequest,
) -> Result<ReadReportResult, String> {
    let home = home_of(&state);
    let rel = report_rel_path(&req.task_id, req.round, &req.kind)?;
    let abs = data_home::resolve_rel(&home, &rel)?;
    let missing = !abs.is_file();
    let text = if missing {
        String::new()
    } else {
        tail::read_whole(&abs)?
    };
    Ok(ReadReportResult {
        rel_path: rel,
        absolute_path: abs.to_string_lossy().to_string(),
        text,
        missing,
    })
}

/* ---------------- 导出 ---------------- */

#[tauri::command]
async fn export_file(
    state: State<'_, AppState>,
    req: ExportFileRequest,
) -> Result<ExportResult, String> {
    let home = home_of(&state);
    export::export_file(&home, &req)
}

#[tauri::command]
async fn export_task_zip(
    state: State<'_, AppState>,
    req: ExportTaskZipRequest,
) -> Result<ExportResult, String> {
    let home = home_of(&state);
    export::export_task_zip(&home, &req)
}

/* ---------------- 搜索 ---------------- */

#[tauri::command]
async fn search_all(
    app: AppHandle,
    state: State<'_, AppState>,
    req: SearchRequest,
) -> Result<SearchResult, String> {
    if req.keyword.trim().is_empty() {
        return Ok(SearchResult {
            groups: Vec::new(),
            scanned_files: 0,
            total_hits: 0,
            cancelled: false,
        });
    }
    updater::reset_search_cancel(&app);
    let home = home_of(&state);
    let cancel = Arc::clone(&state.search_cancel);
    Ok(search::search(&app, &home, &req, &cancel))
}

#[tauri::command]
async fn search_cancel(state: State<'_, AppState>) -> Result<(), String> {
    state.search_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

/* ---------------- 偏好 / 监听 / 更新 ---------------- */

#[tauri::command]
async fn get_preferences(state: State<'_, AppState>) -> Result<Preferences, String> {
    Ok(current_preferences(&state))
}

#[tauri::command]
async fn set_preferences(
    app: AppHandle,
    state: State<'_, AppState>,
    prefs: Preferences,
) -> Result<(), String> {
    {
        let mut guard = state
            .preferences
            .lock()
            .map_err(|_| "偏好状态锁失效".to_string())?;
        *guard = prefs.clone();
    }
    preferences::save(&app, &prefs)
}

#[tauri::command]
async fn watch_start(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let home = home_of(&state);
    watcher::start(&app, &home, &paths)
}

#[tauri::command]
async fn watch_stop(app: AppHandle) -> Result<(), String> {
    watcher::stop(&app);
    Ok(())
}

#[tauri::command]
async fn probe_update_sources(app: AppHandle) -> ProbeSourceResult {
    updater::probe_sources(&app)
}

#[tauri::command]
async fn check_update(app: AppHandle, source: String) -> CheckUpdateResult {
    updater::check_update(app, source).await
}

#[tauri::command]
async fn install_update(app: AppHandle, source: String) -> InstallUpdateResult {
    updater::install_update(app, source).await
}

/// 应用入口（由 `main.rs` 调用）
pub fn run() {
    let detected = data_home::resolve_data_home().to_string_lossy().to_string();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let prefs = preferences::load(app.handle());
            app.manage(AppState::new(detected.clone(), prefs));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            get_data_home_state,
            add_data_home,
            remove_data_home,
            set_active_data_home,
            pick_directory,
            pick_save_path,
            list_tasks,
            read_events,
            read_log,
            read_report,
            export_file,
            export_task_zip,
            search_all,
            search_cancel,
            get_preferences,
            set_preferences,
            watch_start,
            watch_stop,
            probe_update_sources,
            check_update,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tianshu-mcp 日志台失败");
}
