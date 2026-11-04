use serde::{Serialize, Serializer};
use std::fmt;

/// Every failure the frontend can observe, normalized into one shape.
///
/// The frontend only ever receives the `Display` string, so each variant
/// carries a message written for a person, not for a log file.
#[derive(Debug)]
pub enum AppError {
    Io(std::io::Error),
    Json(serde_json::Error),
    NotFound(String),
    Invalid(String),
    Tauri(tauri::Error),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Io(e) => write!(f, "文件操作失败：{e}"),
            AppError::Json(e) => write!(f, "数据文件损坏：{e}"),
            AppError::NotFound(what) => write!(f, "找不到{what}"),
            AppError::Invalid(why) => write!(f, "{why}"),
            AppError::Tauri(e) => write!(f, "系统调用失败：{e}"),
        }
    }
}

impl std::error::Error for AppError {}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::Io(value)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        AppError::Json(value)
    }
}

impl From<tauri::Error> for AppError {
    fn from(value: tauri::Error) -> Self {
        AppError::Tauri(value)
    }
}

pub type AppResult<T> = Result<T, AppError>;
