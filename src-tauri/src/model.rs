use serde::{Deserialize, Serialize};

/// What a library entry points at.
///
/// Two shapes in one list, deliberately: a person thinks of "the things I can open"
/// as one shelf, not as two. The file fields are empty for `Online`, and the ref
/// fields are `None` for `File`, so a caller that ignores `kind` sees blanks rather
/// than an error — which is what keeps an older library.json loading unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    /// A managed copy of an imported file.
    #[default]
    File,
    /// A title that lives on a source, referenced rather than copied.
    Online,
}

/// Where an online entry came from.
///
/// The source *name* is stored alongside the id so a deleted source can still be
/// named in the UI, instead of showing an opaque id to someone who just wants to
/// know which site this was.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryRef {
    pub source_id: String,
    /// Display name at the time it was added. Survives the source being deleted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    /// The title's detail page on that source.
    pub detail_url: String,
    /// Cover URL, when the source provided one. Display only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    /// Episode count when it was added, for the subtitle line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub episode_count: Option<u32>,
    /// True once the source was found missing or disabled.
    ///
    /// Set when a lookup fails, cleared when one succeeds. The entry is **never
    /// removed automatically**: someone can still see what they added, and deleting
    /// their record because a site went away is data loss dressed up as tidiness.
    #[serde(default)]
    pub invalid: bool,
}

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
    /// What this entry points at. Defaults to `File`, so a library written before
    /// online entries existed loads unchanged.
    #[serde(default)]
    pub kind: EntryKind,
    /// Display title, derived from the file name at import and editable later.
    pub title: String,
    /// Lowercase extension without the dot. Empty when the file has none, and empty
    /// for every online entry: inventing one would make the format filter claim a
    /// video file exists.
    #[serde(default)]
    pub extension: String,
    /// Size of the stored copy in bytes. Zero for online entries.
    #[serde(default)]
    pub size: u64,
    /// Absolute path the file was imported from. Kept only as a human hint for
    /// "where did this come from"; the library never reads it again.
    #[serde(default)]
    pub source_path: String,
    /// File name inside the managed `files/` directory. Empty for online entries.
    #[serde(default)]
    pub stored_name: String,
    /// Import time, milliseconds since the Unix epoch.
    pub added_at: i64,
    /// Last time the entry was opened, milliseconds since the epoch. `None`
    /// until the first open; used to build the "recent" ordering.
    #[serde(default)]
    pub last_opened_at: Option<i64>,
    /// A display name typed over `title`.
    ///
    /// Kept separate from `title` rather than overwriting it: `title` is the
    /// only remaining link to the original file name, and clearing this field is
    /// the undo for a rename. Empty or whitespace-only is normalized to `None`
    /// on write, so "renamed to nothing" and "never renamed" are one state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rename: Option<String>,
    /// Group this entry belongs to, e.g. the source it was downloaded from.
    /// `None` for hand-imported files, which is the common case.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// Where an online entry came from. `None` for files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<EntryRef>,
    /// Opaque, viewer-owned resume state.
    ///
    /// The backend never inspects this value — each viewer decides what it
    /// needs to resume (a scroll ratio, a page number, a playback position)
    /// and versions its own payload. This is what keeps custom viewers able to
    /// remember their position without a schema change here.
    ///
    /// For online entries this is the **only** store of playback position. There is
    /// deliberately no second copy elsewhere: two stores for one fact is how a
    /// library ends up saying "episode 3" while the player says "episode 5".
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
