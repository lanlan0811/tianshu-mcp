//! 双源（Gitee / GitHub）自动更新：**主动实测择优** + 三态开关 + 签名校验。
//!
//! 设计要点（对应 issue #25 §3.9）：
//! - 判定更新源**必须实测**，不得依赖系统区域 / 时区（VPN 场景下区域不可信）；
//! - 探测结果按 TTL 缓存，避免频繁探测拖慢启动；
//! - 两端均不可达 → 回退「上次成功使用的源」（无历史则回退 GitHub）并如实标记降级；
//! - 更新失败**不得影响日志查看主流程**（调用方只把结果显示在设置面板里）。
//!
//! 签名门禁由 `tauri-plugin-updater` + 内置公钥保证：**验签不通过一律拒绝安装**。

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use url::Url;

use crate::models::{
    AppVersionInfo, CheckUpdateResult, InstallUpdateResult, ProbeSourceResult, SourceProbe,
    MANUAL_DOWNLOAD_URL, UPDATE_ENDPOINT_GITEE, UPDATE_ENDPOINT_GITHUB,
};
use crate::AppState;

/// 探测结果缓存时长
const PROBE_TTL: Duration = Duration::from_secs(300);
/// 单源探测超时
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);

fn probe_url(url: &str) -> SourceProbe {
    let start = Instant::now();
    match ureq::get(url).timeout(PROBE_TIMEOUT).call() {
        Ok(_) => SourceProbe {
            reachable: true,
            latency_ms: Some(start.elapsed().as_millis() as u64),
        },
        // 服务器有响应（哪怕是 4xx/5xx）说明网络可达，与「连不上」是两回事
        Err(ureq::Error::Status(_, _)) => SourceProbe {
            reachable: true,
            latency_ms: Some(start.elapsed().as_millis() as u64),
        },
        Err(_) => SourceProbe {
            reachable: false,
            latency_ms: None,
        },
    }
}

/// 并发实测两个端点（并行可避免串行累加超时）
fn probe_both() -> (SourceProbe, SourceProbe) {
    std::thread::scope(|scope| {
        let github = scope.spawn(|| probe_url(UPDATE_ENDPOINT_GITHUB));
        let gitee = scope.spawn(|| probe_url(UPDATE_ENDPOINT_GITEE));
        let gitee_result = gitee.join().unwrap_or(SourceProbe {
            reachable: false,
            latency_ms: None,
        });
        let github_result = github.join().unwrap_or(SourceProbe {
            reachable: false,
            latency_ms: None,
        });
        (gitee_result, github_result)
    })
}

/// 择优：可达者取延迟低者；都不可达则回退 `last_good`（无历史回退 GitHub）并标记降级
fn pick_source(
    gitee: &SourceProbe,
    github: &SourceProbe,
    last_good: Option<&str>,
) -> (String, bool) {
    match (gitee.reachable, github.reachable) {
        (true, true) => {
            let g = gitee.latency_ms.unwrap_or(u64::MAX);
            let h = github.latency_ms.unwrap_or(u64::MAX);
            let picked = if g <= h { "gitee" } else { "github" };
            (picked.to_string(), false)
        }
        (true, false) => ("gitee".to_string(), false),
        (false, true) => ("github".to_string(), false),
        (false, false) => {
            let fallback = match last_good {
                Some("gitee") => "gitee",
                Some("github") => "github",
                _ => "github",
            };
            (fallback.to_string(), true)
        }
    }
}

fn endpoint_for(source: &str) -> &'static str {
    if source == "gitee" {
        UPDATE_ENDPOINT_GITEE
    } else {
        UPDATE_ENDPOINT_GITHUB
    }
}

/// 取探测结果（TTL 内直接用缓存）
pub fn probe_sources(app: &AppHandle) -> ProbeSourceResult {
    let state = app.state::<AppState>();
    let last_good = state
        .preferences
        .lock()
        .ok()
        .and_then(|p| p.last_good_update_source.clone());

    {
        let cache = state.probe_cache.lock().ok();
        if let Some(guard) = cache {
            if let Some((at, cached)) = guard.as_ref() {
                if at.elapsed() < PROBE_TTL {
                    return ProbeSourceResult {
                        cached: true,
                        ..cached.clone()
                    };
                }
            }
        }
    }

    let (gitee, github) = probe_both();
    let (picked, degraded) = pick_source(&gitee, &github, last_good.as_deref());
    let result = ProbeSourceResult {
        gitee,
        github,
        picked,
        cached: false,
        degraded,
    };
    if let Ok(mut guard) = state.probe_cache.lock() {
        *guard = Some((Instant::now(), result.clone()));
    }
    result
}

/// 具体使用哪个源：自动模式按实测结果，强制模式直接照办
fn resolve_source(requested: &str, probe: &ProbeSourceResult) -> String {
    match requested {
        "gitee" => "gitee".to_string(),
        "github" => "github".to_string(),
        _ => probe.picked.clone(),
    }
}

fn failure_result(current_version: String, message: String) -> CheckUpdateResult {
    CheckUpdateResult {
        available: false,
        current_version,
        version: None,
        notes: None,
        source: None,
        manual_download_url: Some(MANUAL_DOWNLOAD_URL.to_string()),
        error: Some(message),
    }
}

/// 检查更新（不阻塞主流程；失败时给出「手动下载」兜底入口）
pub async fn check_update(app: AppHandle, source: String) -> CheckUpdateResult {
    use tauri_plugin_updater::UpdaterExt;

    let current_version = app.package_info().version.to_string();
    let probe = probe_sources(&app);
    let chosen = resolve_source(&source, &probe);

    let url = match Url::parse(endpoint_for(&chosen)) {
        Ok(u) => u,
        Err(e) => return failure_result(current_version, format!("更新清单地址非法：{e}")),
    };
    let builder = match app.updater_builder().endpoints(vec![url]) {
        Ok(b) => b,
        Err(e) => return failure_result(current_version, format!("构造更新器失败：{e}")),
    };
    let updater = match builder.build() {
        Ok(u) => u,
        Err(e) => return failure_result(current_version, format!("初始化更新器失败：{e}")),
    };

    match updater.check().await {
        Ok(Some(update)) => {
            // 记下「这次能用的源」，供两端都不可达时回退
            remember_source(&app, &chosen);
            CheckUpdateResult {
                available: true,
                current_version,
                version: Some(update.version.clone()),
                notes: update.body.clone(),
                source: Some(chosen),
                manual_download_url: Some(MANUAL_DOWNLOAD_URL.to_string()),
                error: None,
            }
        }
        Ok(None) => {
            remember_source(&app, &chosen);
            CheckUpdateResult {
                available: false,
                current_version,
                version: None,
                notes: None,
                source: Some(chosen),
                manual_download_url: Some(MANUAL_DOWNLOAD_URL.to_string()),
                error: None,
            }
        }
        Err(e) => CheckUpdateResult {
            available: false,
            current_version,
            version: None,
            notes: None,
            source: Some(chosen),
            manual_download_url: Some(MANUAL_DOWNLOAD_URL.to_string()),
            error: Some(e.to_string()),
        },
    }
}

/// 下载并安装更新（Windows 安装器启动后应用会退出；macOS 需重启应用）
pub async fn install_update(app: AppHandle, source: String) -> InstallUpdateResult {
    use tauri_plugin_updater::UpdaterExt;

    let probe = probe_sources(&app);
    let chosen = resolve_source(&source, &probe);
    let url = match Url::parse(endpoint_for(&chosen)) {
        Ok(u) => u,
        Err(e) => {
            return InstallUpdateResult {
                installed: false,
                version: None,
                error: Some(format!("更新清单地址非法：{e}")),
            }
        }
    };
    let updater = match app
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|builder| builder.build())
    {
        Ok(u) => u,
        Err(e) => {
            return InstallUpdateResult {
                installed: false,
                version: None,
                error: Some(format!("初始化更新器失败：{e}")),
            }
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(()) => InstallUpdateResult {
                    installed: true,
                    version: Some(version),
                    error: None,
                },
                Err(e) => InstallUpdateResult {
                    installed: false,
                    version: Some(version),
                    error: Some(format!("安装失败（签名校验不通过时也会在此报错）：{e}")),
                },
            }
        }
        Ok(None) => InstallUpdateResult {
            installed: false,
            version: None,
            error: Some("当前已是最新版本".to_string()),
        },
        Err(e) => InstallUpdateResult {
            installed: false,
            version: None,
            error: Some(e.to_string()),
        },
    }
}

/// 版本信息 + 内置公钥是否已配置（构建期注入，避免运行时读配置文件）
pub fn app_version_info(app: &AppHandle) -> AppVersionInfo {
    AppVersionInfo {
        version: app.package_info().version.to_string(),
        updater_configured: env!("TIANSHU_UPDATER_CONFIGURED") == "true",
    }
}

/// 记录「本次成功使用的更新源」，供两端都不可达时回退
pub fn remember_source(app: &AppHandle, source: &str) {
    let state = app.state::<AppState>();
    if let Ok(mut prefs) = state.preferences.lock() {
        prefs.last_good_update_source = Some(source.to_string());
    }
}

/// 把取消标记复位（搜索开始前调用）
pub fn reset_search_cancel(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.search_cancel.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(reachable: bool, latency: Option<u64>) -> SourceProbe {
        SourceProbe {
            reachable,
            latency_ms: latency,
        }
    }

    #[test]
    fn pick_prefers_lower_latency_when_both_reachable() {
        let (picked, degraded) = pick_source(&probe(true, Some(120)), &probe(true, Some(40)), None);
        assert_eq!(picked, "github");
        assert!(!degraded);
        let (picked2, _) = pick_source(&probe(true, Some(30)), &probe(true, Some(90)), None);
        assert_eq!(picked2, "gitee");
    }

    #[test]
    fn pick_uses_only_reachable_source() {
        assert_eq!(
            pick_source(&probe(false, None), &probe(true, Some(80)), None).0,
            "github"
        );
        assert_eq!(
            pick_source(&probe(true, Some(80)), &probe(false, None), None).0,
            "gitee"
        );
    }

    #[test]
    fn pick_falls_back_and_marks_degraded() {
        let (picked, degraded) =
            pick_source(&probe(false, None), &probe(false, None), Some("gitee"));
        assert_eq!(picked, "gitee");
        assert!(degraded);
        let (picked2, degraded2) = pick_source(&probe(false, None), &probe(false, None), None);
        assert_eq!(picked2, "github");
        assert!(degraded2);
    }

    #[test]
    fn resolve_source_respects_manual_override() {
        let probe = ProbeSourceResult {
            gitee: probe(true, Some(10)),
            github: probe(true, Some(99)),
            picked: "gitee".to_string(),
            cached: false,
            degraded: false,
        };
        assert_eq!(resolve_source("auto", &probe), "gitee");
        assert_eq!(resolve_source("github", &probe), "github");
        assert_eq!(resolve_source("gitee", &probe), "gitee");
    }

    #[test]
    fn endpoint_mapping_is_stable() {
        assert_eq!(endpoint_for("gitee"), UPDATE_ENDPOINT_GITEE);
        assert_eq!(endpoint_for("github"), UPDATE_ENDPOINT_GITHUB);
        assert_eq!(endpoint_for("anything-else"), UPDATE_ENDPOINT_GITHUB);
    }
}
