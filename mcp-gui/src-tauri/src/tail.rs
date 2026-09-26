//! 字节窗口读取（尾部窗口 / 任意区间）。
//!
//! 与前端 `src/core/bytes.ts` 同口径：偏移是**字节**而非字符；
//! 切片切断多字节字符时，边界残片（U+FFFD）被裁掉而不是留给界面。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::models::DEFAULT_WINDOW_BYTES;

pub struct ByteWindow {
    pub text: String,
    pub from: u64,
    pub to: u64,
    pub total: u64,
}

fn decode_lossy_trimmed(bytes: &[u8]) -> String {
    let raw = String::from_utf8_lossy(bytes).into_owned();
    raw.trim_start_matches('\u{FFFD}')
        .trim_end_matches('\u{FFFD}')
        .to_string()
}

/// 读取绝对字节区间 `[from, to)`；越界自动收敛。文件不存在返回 Err。
pub fn read_range(path: &Path, from: u64, to: u64) -> Result<ByteWindow, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取文件信息失败：{e}"))?;
    let total = meta.len();
    let start = from.min(total);
    let end = to.min(total).max(start);
    let mut file = File::open(path).map_err(|e| format!("打开文件失败：{e}"))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("定位失败：{e}"))?;
    let mut buf: Vec<u8> = Vec::new();
    file.take(end - start)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取失败：{e}"))?;
    Ok(ByteWindow {
        text: decode_lossy_trimmed(&buf),
        from: start,
        to: end,
        total,
    })
}

/// 读取尾部窗口 `[total - window, total)`
pub fn read_tail(path: &Path, window: u64) -> Result<ByteWindow, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("读取文件信息失败：{e}"))?;
    let total = meta.len();
    let win = window.max(1);
    read_range(path, total.saturating_sub(win), total)
}

/// 读取整个文件（用于中小文件，例如报告）
pub fn read_whole(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("读取失败：{e}"))
}

/// 尾窗默认值（供命令层引用）
pub fn default_window() -> u64 {
    DEFAULT_WINDOW_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_file(name: &str, content: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("tianshu-gui-tail-test");
        std::fs::create_dir_all(&dir).expect("建目录");
        let path = dir.join(name);
        std::fs::write(&path, content).expect("写文件");
        path
    }

    #[test]
    fn read_tail_returns_last_window() {
        let path = tmp_file("a.log", "0123456789");
        let w = read_tail(&path, 4).expect("读取成功");
        assert_eq!(w.text, "6789");
        assert_eq!(w.from, 6);
        assert_eq!(w.to, 10);
        assert_eq!(w.total, 10);
    }

    #[test]
    fn read_tail_on_empty_file() {
        let path = tmp_file("b.log", "");
        let w = read_tail(&path, 100).expect("读取成功");
        assert_eq!(w.text, "");
        assert_eq!(w.total, 0);
    }

    #[test]
    fn read_range_clamps_out_of_bounds() {
        let path = tmp_file("c.log", "abcdef");
        let w = read_range(&path, 0, 999).expect("读取成功");
        assert_eq!(w.text, "abcdef");
        let w2 = read_range(&path, 999, 1000).expect("读取成功");
        assert_eq!(w2.text, "");
        assert_eq!(w2.from, 6);
    }

    #[test]
    fn multibyte_boundary_has_no_replacement_char() {
        let path = tmp_file("d.log", "中文中文");
        // 尾部 7 字节起点落在「文」的第三字节
        let w = read_tail(&path, 7).expect("读取成功");
        assert!(!w.text.contains('\u{FFFD}'));
        assert_eq!(w.text, "中文");
    }

    #[test]
    fn missing_file_is_error() {
        let path = std::env::temp_dir().join("tianshu-gui-tail-test/does-not-exist.log");
        assert!(read_tail(&path, 10).is_err());
    }
}