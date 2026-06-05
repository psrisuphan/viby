use serde::Serialize;
use thiserror::Error;

/// Unified error type returned by all Tauri commands.
/// Serialized as `{ kind: "...", message: "..." }` so the frontend can
/// distinguish error categories and display appropriate messages.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("Database error: {0}")]
    Database(String),

    #[error("Audio error: {0}")]
    Audio(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("IO error: {0}")]
    Io(String),

    #[error("Scan already in progress")]
    ScanBusy,

    #[error("{0}")]
    Other(String),
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::Database(e.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}
