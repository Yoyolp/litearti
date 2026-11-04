//! Storage for book sources and their reading progress.
//!
//! Kept apart from `library.rs` on purpose: sources are configuration, not
//! library content. Deleting a source must not touch imported files, and
//! `library.json` has a schema the reader depends on — mixing foreign data into
//! it would make every future migration harder.
//!
//! Both files use the same atomic-write discipline as the library (temp file
//! plus rename), because the failure mode is identical: an interrupted write
//! must not leave a truncated JSON that makes the app lose every source.

use crate::error::{AppError, AppResult};
use std::fs;
use std::path::{Path, PathBuf};

/// Root of the source data, under the same app-data directory as the library.
pub fn sources_root(app_data: &Path) -> PathBuf {
    app_data.join("sources")
}

fn sources_file(root: &Path) -> PathBuf {
    root.join("sources.json")
}

fn progress_file(root: &Path) -> PathBuf {
    root.join("progress.json")
}

/// Write a JSON file atomically, creating its directory if needed.
///
/// `pub(crate)` so [`crate::credentials`] gets the same atomicity instead of
/// growing a second copy of it: an interrupted write must not be able to lose
/// every stored login any more than it may lose every source.
pub(crate) fn write_json(path: &Path, json: &str) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, json)?;
    if let Err(error) = fs::rename(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(error.into());
    }
    Ok(())
}

/// Read a JSON file, treating "not there yet" as an empty document.
pub(crate) fn read_json(path: &Path, empty: &str) -> AppResult<String> {
    if !path.exists() {
        return Ok(empty.to_string());
    }
    let raw = fs::read_to_string(path)?;
    // Tolerate a BOM for the same reason `library.rs` does: a hand-edited file
    // saved by an editor that adds one is not corruption.
    let raw = raw.strip_prefix('\u{feff}').unwrap_or(&raw).to_string();
    if raw.trim().is_empty() {
        return Ok(empty.to_string());
    }
    Ok(raw)
}

pub fn load_sources(root: &Path) -> AppResult<serde_json::Value> {
    let raw = read_json(&sources_file(root), "[]")?;
    serde_json::from_str(&raw)
        .map_err(|error| AppError::Invalid(format!("书源文件损坏：{error}")))
}

pub fn save_sources(root: &Path, value: &serde_json::Value) -> AppResult<()> {
    let json = serde_json::to_string_pretty(value)?;
    write_json(&sources_file(root), &json)
}

pub fn load_progress(root: &Path) -> AppResult<serde_json::Value> {
    let raw = read_json(&progress_file(root), "{}")?;
    serde_json::from_str(&raw)
        .map_err(|error| AppError::Invalid(format!("书源进度文件损坏：{error}")))
}

pub fn save_progress(root: &Path, value: &serde_json::Value) -> AppResult<()> {
    let json = serde_json::to_string_pretty(value)?;
    write_json(&progress_file(root), &json)
}

/// Read a UTF-8 text file the person picked.
///
/// Exists so the frontend does not need `plugin-fs` just to read one JSON file.
/// The path comes from a native open dialog, so it is a file the person chose;
/// this is not a general file-reading API.
///
/// The size cap is not about disk protection but about honesty: a book source is
/// kilobytes, and a 500 MB file picked by mistake should be rejected with a
/// clear message rather than loaded into memory and then fail to parse.
pub fn read_text_file(path: &Path) -> AppResult<String> {
    const MAX_BYTES: u64 = 8 * 1024 * 1024;

    let metadata = fs::metadata(path)?;
    if !metadata.is_file() {
        return Err(AppError::Invalid(format!("{} 不是文件", path.display())));
    }
    if metadata.len() > MAX_BYTES {
        return Err(AppError::Invalid(format!(
            "文件过大（{} 字节），上限 {} 字节",
            metadata.len(),
            MAX_BYTES
        )));
    }

    let bytes = fs::read(path)?;
    // Strip a BOM so a file saved by an editor that adds one still parses.
    let text = String::from_utf8(bytes)
        .map_err(|_| AppError::Invalid("文件不是 UTF-8 编码".to_string()))?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("litearti-sources-{tag}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn missing_files_read_as_empty() {
        let root = temp_root("empty");
        assert_eq!(load_sources(&root).unwrap(), serde_json::json!([]));
        assert_eq!(load_progress(&root).unwrap(), serde_json::json!({}));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn sources_round_trip() {
        let root = temp_root("roundtrip");
        let value = serde_json::json!([{ "id": "a", "name": "A" }]);
        save_sources(&root, &value).unwrap();
        assert_eq!(load_sources(&root).unwrap(), value);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn progress_round_trip() {
        let root = temp_root("progress");
        let value = serde_json::json!({ "a::url": { "ratio": 0.5 } });
        save_progress(&root, &value).unwrap();
        assert_eq!(load_progress(&root).unwrap(), value);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn save_creates_directory() {
        let root = temp_root("mkdir");
        let nested = root.join("deep").join("deeper");
        save_sources(&nested, &serde_json::json!([])).unwrap();
        assert!(sources_file(&nested).exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bom_is_tolerated() {
        let root = temp_root("bom");
        fs::create_dir_all(&root).unwrap();
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(br#"[{"id":"a"}]"#);
        fs::write(sources_file(&root), bytes).unwrap();
        let loaded = load_sources(&root).unwrap();
        assert_eq!(loaded.as_array().unwrap().len(), 1);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn corrupt_file_is_reported_not_silently_dropped() {
        let root = temp_root("corrupt");
        fs::create_dir_all(&root).unwrap();
        fs::write(sources_file(&root), b"{ not json").unwrap();
        // Losing every source silently would be worse than an error the person
        // can act on, so this must be an error rather than an empty list.
        assert!(load_sources(&root).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn atomic_write_leaves_no_temp_file() {
        let root = temp_root("atomic");
        save_sources(&root, &serde_json::json!([{ "id": "x" }])).unwrap();
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp file should be renamed away");
        fs::remove_dir_all(&root).ok();
    }
}
