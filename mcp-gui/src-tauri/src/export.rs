//! 导出：单文件原文 + 任务整包 zip（可排除体积大的原始日志）。
//!
//! 安全边界：**只能导出数据目录内的文件**（经 `resolve_rel` 校验）；
//! 目标路径由用户在原生保存对话框中选择，不由业务数据推导。

use std::io::Write;
use std::path::Path;

use zip::write::SimpleFileOptions;

use crate::data_home::resolve_rel;
use crate::models::{ExportFileRequest, ExportResult, ExportTaskZipRequest};

fn is_heavy_log(name: &str) -> bool {
    (name.starts_with("agent-") && name.ends_with(".log"))
        || (name.starts_with("verify-") && name.ends_with(".log"))
}

/// 导出单个文件原文（按字节复制，不做任何转码）
pub fn export_file(home: &Path, req: &ExportFileRequest) -> Result<ExportResult, String> {
    let source = resolve_rel(home, &req.rel_path)?;
    if !source.is_file() {
        return Err(format!("源文件不存在：{}", req.rel_path));
    }
    let target = Path::new(&req.target_path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!("目标目录不存在：{}", parent.display()));
        }
    }
    let bytes = std::fs::copy(&source, target).map_err(|e| format!("写入失败：{e}"))?;
    Ok(ExportResult {
        target_path: target.to_string_lossy().to_string(),
        bytes,
        excluded: 0,
    })
}

/// 把整个任务目录打包为 zip
pub fn export_task_zip(home: &Path, req: &ExportTaskZipRequest) -> Result<ExportResult, String> {
    let task_dir = home.join("tasks").join(&req.task_id);
    if !task_dir.is_dir() {
        return Err(format!("任务目录不存在：{}", req.task_id));
    }
    let target = Path::new(&req.target_path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!("目标目录不存在：{}", parent.display()));
        }
    }

    let file = std::fs::File::create(target).map_err(|e| format!("创建压缩包失败：{e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let entries = std::fs::read_dir(&task_dir).map_err(|e| format!("读取任务目录失败：{e}"))?;
    let mut excluded: i64 = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if req.exclude_heavy_logs && is_heavy_log(&name) {
            excluded += 1;
            continue;
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("读取 {name} 失败：{e}"))?;
        zip.start_file(name, options)
            .map_err(|e| format!("写入压缩包条目失败：{e}"))?;
        zip.write_all(&bytes)
            .map_err(|e| format!("写入压缩包内容失败：{e}"))?;
    }
    zip.finish().map_err(|e| format!("收尾压缩包失败：{e}"))?;

    let size = std::fs::metadata(target).map(|m| m.len()).unwrap_or(0);
    Ok(ExportResult {
        target_path: target.to_string_lossy().to_string(),
        bytes: size,
        excluded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_task(home: &Path) {
        let dir = home.join("tasks/tsk_zip");
        std::fs::create_dir_all(&dir).expect("建目录");
        std::fs::write(dir.join("task.json"), "{}").expect("写快照");
        std::fs::write(dir.join("task.jsonl"), "{}\n").expect("写事件流");
        std::fs::write(dir.join("agent-0.log"), "很长的原始日志").expect("写日志");
        std::fs::write(dir.join("report-0.md"), "# 报告").expect("写报告");
    }

    #[test]
    fn export_file_copies_bytes() {
        let home = std::env::temp_dir().join("tianshu-gui-export-file-test");
        let _ = std::fs::remove_dir_all(&home);
        make_task(&home);
        let target = home.join("out.md");
        let res = export_file(
            &home,
            &ExportFileRequest {
                data_home: home.to_string_lossy().to_string(),
                rel_path: "tasks/tsk_zip/report-0.md".to_string(),
                target_path: target.to_string_lossy().to_string(),
            },
        )
        .expect("导出成功");
        assert!(res.bytes > 0);
        assert_eq!(std::fs::read_to_string(&target).expect("读回"), "# 报告");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn export_file_rejects_escape() {
        let home = std::env::temp_dir().join("tianshu-gui-export-escape-test");
        let _ = std::fs::remove_dir_all(&home);
        make_task(&home);
        let err = export_file(
            &home,
            &ExportFileRequest {
                data_home: home.to_string_lossy().to_string(),
                rel_path: "../../etc/passwd".to_string(),
                target_path: home.join("x").to_string_lossy().to_string(),
            },
        );
        assert!(err.is_err());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn zip_excludes_heavy_logs_on_request() {
        let home = std::env::temp_dir().join("tianshu-gui-zip-test");
        let _ = std::fs::remove_dir_all(&home);
        make_task(&home);
        let target = home.join("bundle.zip");
        let res = export_task_zip(
            &home,
            &ExportTaskZipRequest {
                data_home: home.to_string_lossy().to_string(),
                task_id: "tsk_zip".to_string(),
                target_path: target.to_string_lossy().to_string(),
                exclude_heavy_logs: true,
            },
        )
        .expect("打包成功");
        assert_eq!(res.excluded, 1);
        assert!(res.bytes > 0);
        // 压缩包内不应包含被排除的原始日志
        let file = std::fs::File::open(&target).expect("打开压缩包");
        let mut archive = zip::ZipArchive::new(file).expect("解析压缩包");
        let names: Vec<String> = (0..archive.len())
            .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
            .collect();
        assert!(names.iter().any(|n| n == "task.json"));
        assert!(!names.iter().any(|n| n == "agent-0.log"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn heavy_log_classification() {
        assert!(is_heavy_log("agent-3.log"));
        assert!(is_heavy_log("verify-0.log"));
        assert!(!is_heavy_log("report-0.md"));
        assert!(!is_heavy_log("task.jsonl"));
    }
}