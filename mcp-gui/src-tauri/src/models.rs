//! 前后端共享的数据结构（与 `mcp-gui/src/api/types.ts` 一一对应）。
//!
//! 命名约定：Rust 侧 snake_case，经 `#[serde(rename_all = "camelCase")]` 与前端 JSON 对齐。
//! 输入侧（task.json / task.jsonl）**不做强类型映射**，一律按 `serde_json::Value` 容错解析：
//! GUI 是只读消费方，新增/缺失字段都不应让它失效。

use serde::{Deserialize, Serialize};

/// 一类产物文件的轮次集合
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRounds {
    pub agent_logs: Vec<i64>,
    pub verify_logs: Vec<i64>,
    pub report_md: Vec<i64>,
    pub report_json: Vec<i64>,
    pub report_html: Vec<i64>,
    pub dry_run_md: Vec<i64>,
    pub dry_run_json: Vec<i64>,
    pub has_baseline: bool,
    pub has_dry_run_plan: bool,
}

/// 左栏任务列表项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub task_id: String,
    pub status: String,
    pub workspace_mode: String,
    pub project_path: String,
    pub display_path: String,
    pub agent_id: String,
    pub task: String,
    pub rounds_used: i64,
    pub report_round: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
    pub last_message: Option<String>,
    pub dry_run: bool,
    pub error_type: Option<String>,
    pub check_summary: Option<String>,
    pub diffstat: Option<String>,
    pub changed_files: Vec<String>,
    pub data_home: String,
    pub artifacts: ArtifactRounds,
}

/// 事件流单条
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEventOut {
    pub ts: String,
    pub event: String,
    pub state: String,
    pub detail: Option<String>,
    pub data: Option<serde_json::Value>,
    /// 由后端判定（status / agent / note / unknown），前端不重复维护词表
    pub kind: String,
    /// task.jsonl 中的物理行号（从 1 起，坏行也占号）
    pub line: i64,
}

/// 一段日志读取结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogChunk {
    pub text: String,
    pub rel_path: String,
    pub absolute_path: String,
    pub from_byte: u64,
    pub to_byte: u64,
    pub loaded_from: u64,
    pub loaded_to: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataHomeEntry {
    pub path: String,
    pub label: String,
    pub valid: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataHomeState {
    pub detected: String,
    pub active: String,
    pub entries: Vec<DataHomeEntry>,
}

/// 用户偏好（应用自身配置，**不落业务数据目录以外的地方**）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub language: String,
    pub theme: String,
    pub update_source: String,
    pub data_homes: Vec<String>,
    pub last_good_update_source: Option<String>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            language: "zh-CN".to_string(),
            theme: "system".to_string(),
            update_source: "auto".to_string(),
            data_homes: Vec::new(),
            last_good_update_source: None,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFilter {
    #[serde(default)]
    pub keyword: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub project_path: Option<String>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub only_active: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTasksRequest {
    pub data_home: String,
    #[serde(default)]
    pub filter: TaskFilter,
    #[serde(default = "default_sort_key")]
    pub sort_key: String,
    #[serde(default = "default_sort_dir")]
    pub sort_dir: String,
}

fn default_sort_key() -> String {
    "updatedAt".to_string()
}

fn default_sort_dir() -> String {
    "desc".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadEventsRequest {
    pub data_home: String,
    pub task_id: String,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub window_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadEventsResult {
    pub events: Vec<TaskEventOut>,
    pub total_bytes: u64,
    pub loaded_from: u64,
    pub loaded_to: u64,
    pub bad_lines: i64,
    pub loaded_count: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadLogRequest {
    pub data_home: String,
    pub rel_path: String,
    /// "tail" | "before"
    pub mode: String,
    #[serde(default)]
    pub loaded_from: Option<u64>,
    #[serde(default)]
    pub window_bytes: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadReportRequest {
    pub data_home: String,
    pub task_id: String,
    pub round: i64,
    /// "md" | "json" | "html" | "dry-run-md" | "dry-run-json"
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadReportResult {
    pub rel_path: String,
    pub absolute_path: String,
    pub text: String,
    pub missing: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFileRequest {
    pub data_home: String,
    pub rel_path: String,
    pub target_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTaskZipRequest {
    pub data_home: String,
    pub task_id: String,
    pub target_path: String,
    #[serde(default)]
    pub exclude_heavy_logs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub target_path: String,
    pub bytes: u64,
    pub excluded: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchScope {
    #[serde(default)]
    pub event_stream: bool,
    #[serde(default)]
    pub agent_logs: bool,
    #[serde(default)]
    pub verify_logs: bool,
    #[serde(default)]
    pub reports: bool,
    #[serde(default)]
    pub server_log: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub data_home: String,
    pub keyword: String,
    pub scope: SearchScope,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default = "default_max_hits")]
    pub max_hits_per_file: usize,
}

fn default_max_hits() -> usize {
    50
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub rel_path: String,
    pub line: i64,
    pub text: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileGroup {
    pub task_id: Option<String>,
    pub rel_path: String,
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub groups: Vec<SearchFileGroup>,
    pub scanned_files: i64,
    pub total_hits: i64,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProbe {
    pub reachable: bool,
    pub latency_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeSourceResult {
    pub gitee: SourceProbe,
    pub github: SourceProbe,
    pub picked: String,
    pub cached: bool,
    pub degraded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckUpdateResult {
    pub available: bool,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub source: Option<String>,
    pub manual_download_url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallUpdateResult {
    pub installed: bool,
    pub version: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppVersionInfo {
    pub version: String,
    /// 内置公钥是否已配置（占位符未替换时为 false）
    pub updater_configured: bool,
}

/// 双源更新端点（与 README / docs 中登记的一致）
pub const UPDATE_ENDPOINT_GITHUB: &str =
    "https://raw.githubusercontent.com/lanlan0811/tianshu-mcp/master/update/gui/latest.json";
pub const UPDATE_ENDPOINT_GITEE: &str =
    "https://gitee.com/lan0811/tianshu-mcp/raw/master/update/gui/latest-gitee.json";

/// 手动下载兜底入口（更新失败时给用户）
pub const MANUAL_DOWNLOAD_URL: &str = "https://github.com/lanlan0811/tianshu-mcp/releases";

/// 尾窗默认字节数（与 `src/tasks/task-store.ts` 的 64 KiB 思路一致）
pub const DEFAULT_WINDOW_BYTES: u64 = 64 * 1024;
