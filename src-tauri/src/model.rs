use serde::{Deserialize, Serialize};

/// One item in the library.
///
/// `extension` is stored verbatim (lowercase, no dot) and is the *only* format
/// fact the backend keeps. It deliberately does not classify the file into a
/// "kind": which viewer handles an extension is decided by the frontend viewer
/// registry, so adding a custom format never requires touching Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    /// Display title, derived from the file name at import and editable later.
    pub title: String,
    /// Lowercase extension without the dot. Empty when the file has none.
    pub extension: String,
    /// Size of the stored copy in bytes.
    pub size: u64,
    /// Absolute path the file was imported from. Kept only as a human hint for
    /// "where did this come from"; the library never reads it again.
    pub source_path: String,
    /// File name inside the managed `files/` directory.
    pub stored_name: String,
    /// Import time, milliseconds since the Unix epoch.
    pub added_at: i64,
    /// Last time the entry was opened, milliseconds since the epoch. `None`
    /// until the first open; used to build the "recent" ordering.
    #[serde(default)]
    pub last_opened_at: Option<i64>,
    /// Opaque, viewer-owned resume state.
    ///
    /// The backend never inspects this value — each viewer decides what it
    /// needs to resume (a scroll ratio, a page number, a playback position)
    /// and versions its own payload. This is what keeps custom viewers able to
    /// remember their position without a schema change here.
    #[serde(default)]
    pub progress: Option<serde_json::Value>,
}

impl Entry {
    /// Milliseconds since the Unix epoch, clamped to a sensible floor.
    pub fn now_millis() -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}

/// What the frontend receives from `library_import`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: Vec<Entry>,
    /// Files skipped because an identical source was already in the library.
    pub duplicates: usize,
    /// Per-file failures, so one bad file cannot abort a multi-file import.
    pub failed: Vec<ImportFailure>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub source_path: String,
    pub reason: String,
}

/// The decoded result of reading a text file.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodedText {
    pub text: String,
    /// The encoding actually used, as a WHATWG label (`UTF-8`, `GB18030`, ...).
    pub encoding: String,
    /// Whether a byte-order mark was found and stripped.
    pub had_bom: bool,
    /// True when the decode used replacement characters, i.e. the guess was
    /// probably wrong and the reader should offer a manual encoding choice.
    pub lossy: bool,
}
