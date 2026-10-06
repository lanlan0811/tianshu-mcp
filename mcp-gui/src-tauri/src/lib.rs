//! Tianshu-mcp 日志台 —— Tauri 后端入口与命令注册。
//!
//! **只读契约**：全部取数命令只读业务数据；唯一的写入是应用自身偏好
//! （系统应用配置目录）与用户显式选择的导出/更新临时文件。

mod baseline;
mod data_home;
mod diskscan;
mod event_stream;
mod export;
mod insights;
mod models;
mod preferences;
mod scanner;
mod schema;
mod search;
mod tail;
mod timestamps;
mod tray;
mod updater;
mod watcher;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;

use models::{
    AppVersionInfo, BaselineInfo, BaselineRequest, CheckUpdateResult, DataHomeEntry, DataHomeState,
    DiskUsage, DiskUsageRequest, ExportFileRequest, ExportResult, ExportTaskZipRequest,
    InsightsRequest, InsightsResult, InstallUpdateResult, ListTasksRequest, LogChunk, Preferences,
    ProbeSourceResult, ReadEventsRequest, ReadEventsResult, ReadLogRequest, ReadReportRequest,
    ReadReportResult, SearchRequest, SearchResult, TaskSummary,
};

/// 深链事件名（Rust → 前端）。前端收到后**从 `take_pending_deeplinks` 取走队列**再解析路由，
/// 因此冷启动（事件早于前端监听）与热启动（已有窗口）走同一条取数路径，不会丢链接。
pub const DEEPLINK_EVENT: &str = "gui://deeplink";

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
    /// 待处理深链 URL 队列（冷启动先入队，前端挂载后取走）
    pub pending_deeplinks: Mutex<Vec<String>>,
}

impl AppState {
    fn new(data_home: String, preferences: Preferences) -> Self {
        Self {
            data_home: Mutex::new(data_home),
            preferences: Mutex::new(preferences),
            search_cancel: Arc::new(AtomicBool::new(false)),
            watcher: Mutex::new(None),
            probe_cache: Mutex::new(None),
            pending_deeplinks: Mutex::new(Vec::new()),
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
    // 第一道闸门：非法 task_id 直接报错（模块层 task_dir 再兜一道，防未来漏加）
    data_home::validate_task_id(&req.task_id)?;
    let home = home_of(&state);
    Ok(event_stream::read_events(&home, &req))
}

/// 洞察聚合（A1 效能 / A2 归因 / A3 趋势）：只读扫描 `tasks/`，不写任何业务数据。
#[tauri::command]
async fn get_insights(
    state: State<'_, AppState>,
    req: InsightsRequest,
) -> Result<InsightsResult, String> {
    let home = if req.data_home.trim().is_empty() {
        home_of(&state)
    } else {
        PathBuf::from(req.data_home.trim())
    };
    Ok(insights::collect(&home, &req))
}

/// A5 基线漂移：只读 `tasks/<任务>/baseline.json`（缺失 / 损坏一律 `present = false`，不编造）。
#[tauri::command]
async fn read_baseline(
    state: State<'_, AppState>,
    req: BaselineRequest,
) -> Result<BaselineInfo, String> {
    // 任务 ID 缺失或含非法字符都是调用方错误：明确报错，而不是回一份「没有基线」的默认值
    data_home::validate_task_id(&req.task_id)?;
    Ok(baseline::read_baseline(&home_of(&state), &req))
}

/// A9 磁盘占用：只读 `stat` 统计体积，**不删任何文件**。
#[tauri::command]
async fn scan_disk_usage(
    state: State<'_, AppState>,
    req: DiskUsageRequest,
) -> Result<DiskUsage, String> {
    let home = if req.data_home.trim().is_empty() {
        home_of(&state)
    } else {
        PathBuf::from(req.data_home.trim())
    };
    Ok(diskscan::scan_disk_usage(&home))
}

/// 取走待处理深链队列（前端挂载后调用；热启动由 `gui://deeplink` 事件触发同一次取数）。
#[tauri::command]
async fn take_pending_deeplinks(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let mut guard = state
        .pending_deeplinks
        .lock()
        .map_err(|_| "深链队列不可用".to_string())?;
    Ok(std::mem::take(&mut *guard))
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
    // 第一道闸门：与 `resolve_rel` 的越界防护同口径，另加 ID 字符白名单（ARCHITECTURE §16.10）
    data_home::validate_task_id(&req.task_id)?;
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
    // 第一道闸门：非法 task_id 不进入打包流程（模块层 task_dir 再兜一道）
    data_home::validate_task_id(&req.task_id)?;
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
    let previous_language = {
        let mut guard = state
            .preferences
            .lock()
            .map_err(|_| "偏好状态锁失效".to_string())?;
        let previous = guard.language.clone();
        *guard = prefs.clone();
        previous
    };
    preferences::save(&app, &prefs)?;
    // 托盘菜单文案跟随界面语言；菜单创建必须在主线程执行。
    if previous_language != prefs.language {
        let handle = app.clone();
        let language = prefs.language.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = tray::update_menu(&handle, &language);
        });
    }
    Ok(())
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

/// 把深链 URL 记入待处理队列并通知前端。
///
/// **队列是唯一事实来源**：冷启动时事件早于前端监听器注册，只发事件会丢链接；
/// 热启动（已有窗口）则靠事件驱动前端立刻取走队列。前端两条路径都调 `take_pending_deeplinks`。
fn queue_deeplinks(app: &AppHandle, urls: Vec<String>) {
    if urls.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut pending) = state.pending_deeplinks.lock() {
            pending.extend(urls.iter().cloned());
        }
    }
    // 事件只作「去取队列」的信号；载荷同时带上 URL 便于开发期排查
    let _ = app.emit(DEEPLINK_EVENT, urls);
}

pub fn run() {
    let detected = data_home::resolve_data_home().to_string_lossy().to_string();

    let app = tauri::Builder::default()
        // `single-instance` **必须最先注册**（插件顺序是硬性要求）：第二个实例只做「转发 argv 后退出」。
        // 已启用其 `deep-link` feature，因此 URL 参数会先转给 deep-link 插件（触发首实例的 `on_open_url`）。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二实例被拒后把已有窗口唤到前台；深链路由由 `on_open_url` 走同一条队列
            tray::show_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let prefs = preferences::load(app.handle());
            let language = prefs.language.clone();
            app.manage(AppState::new(detected.clone(), prefs));
            // 托盘创建失败不阻塞启动：日志查看主流程优先。
            let _ = tray::init(app.handle(), &language);

            // A8b 深链：热启动（on_open_url）与冷启动（get_current）都只入队 + 发信号，解析与路由交前端。
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event.urls().into_iter().map(|u| u.to_string()).collect();
                queue_deeplinks(&handle, urls);
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                let urls: Vec<String> = urls.into_iter().map(|u| u.to_string()).collect();
                queue_deeplinks(app.handle(), urls);
            }
            // Windows/Linux 注册协议处理器；macOS 返回 UnsupportedPlatform 属**预期**，
            // 因此这里忽略结果——注册失败不阻塞启动（与「托盘创建失败不阻塞」同口径）。
            let _ = app.deep_link().register("tianshu");
            Ok(())
        })
        // 关闭窗口不等于退出应用：默认「缩小到托盘」，仅在偏好选择「关闭应用」时真正退出
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let to_tray = app
                    .state::<AppState>()
                    .preferences
                    .lock()
                    .map(|prefs| prefs.close_action != "exit")
                    .unwrap_or(true);
                if to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    app.exit(0);
                }
            }
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
            get_insights,
            read_baseline,
            scan_disk_usage,
            take_pending_deeplinks,
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
        .build(tauri::generate_context!())
        .expect("启动 Tianshu-mcp 日志台失败");

    app.run(|_app_handle, _event| {
        // macOS 专属：窗口收进托盘后，点 Dock 图标应重新显示窗口。
        // `RunEvent::Reopen` 仅在 macOS 上存在，其他平台必须条件编译，否则编译失败。
        #[cfg(target_os = "macos")]
        {
            if let tauri::RunEvent::Reopen { .. } = _event {
                tray::show_main_window(_app_handle);
            }
        }
    });
}
