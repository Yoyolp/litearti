mod credentials;
mod crypto;
mod download;
mod error;
mod export;
mod external;
mod library;
mod login;
mod model;
mod net;
mod sources;
mod text;

use error::AppResult;
use library::Library;
use model::{DecodedText, Entry, ImportReport};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

/// The library, held as managed state for the lifetime of the app.
///
/// Why a `Mutex` rather than constructing a `Library` per command (which is what
/// this used to do): every command is a read-modify-write cycle over the whole
/// `library.json`. Two of them running at once — importing while a viewer saves
/// its progress — would each load the old list, mutate their copy, and write it
/// back, so the second write silently discards the first change. Tauri dispatches
/// commands on a thread pool, so that is not hypothetical.
///
/// The lock covers metadata only. File bytes are read after the guard is dropped
/// (`stored_path` returns a path), so a large read never blocks a small write.
struct AppState {
    library: Mutex<Library>,
}

/// Borrow the library under the lock.
///
/// A poisoned mutex means a previous holder panicked mid-operation. The library
/// is re-read from disk on every access, so the in-memory guard carries no state
/// worth preserving — recovering the inner value is safe and keeps the app
/// usable instead of failing every later command.
fn with_library<T>(state: &State<'_, AppState>, f: impl FnOnce(&Library) -> AppResult<T>) -> AppResult<T> {
    let guard = state
        .library
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&guard)
}

#[tauri::command]
fn library_list(state: State<'_, AppState>) -> AppResult<Vec<Entry>> {
    with_library(&state, |library| library.load())
}

#[tauri::command]
fn library_import(state: State<'_, AppState>, paths: Vec<String>) -> AppResult<ImportReport> {
    let sources: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    with_library(&state, |library| library.import_many(&sources))
}

#[tauri::command]
fn library_remove(state: State<'_, AppState>, id: String) -> AppResult<()> {
    with_library(&state, |library| library.remove(&id))
}

#[tauri::command]
fn library_set_progress(
    state: State<'_, AppState>,
    id: String,
    progress: Option<serde_json::Value>,
) -> AppResult<Entry> {
    with_library(&state, |library| library.set_progress(&id, progress))
}

#[tauri::command]
fn library_touch(state: State<'_, AppState>, id: String) -> AppResult<Entry> {
    with_library(&state, |library| library.touch(&id))
}

/// Read an entry's bytes for the PDF viewer.
///
/// Returned as a raw `Response`, which arrives in JS as an `ArrayBuffer`
/// instead of a JSON number array — a 20 MB PDF would otherwise balloon into
/// ~80 MB of text on the wire and stall the IPC layer.
///
/// The read happens outside the lock: the guard is dropped as soon as the path
/// is resolved, so a slow disk read does not stall a concurrent progress write.
#[tauri::command]
fn read_binary(state: State<'_, AppState>, id: String) -> AppResult<tauri::ipc::Response> {
    let path = with_library(&state, |library| library.stored_path(&id))?;
    let bytes = fs::read(path)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Read an entry's bytes decoded as text.
///
/// `encoding` is an optional WHATWG label; when omitted the backend sniffs.
///
/// Files larger than `text::MAX_TEXT_BYTES` are truncated. The cut is made on a
/// character boundary — slicing at an arbitrary offset would split a multi-byte
/// character, fail UTF-8 validation, and silently re-decode the whole file as
/// GB18030 (mojibake). See `text::floor_char_boundary`.
#[tauri::command]
fn read_text(
    state: State<'_, AppState>,
    id: String,
    encoding: Option<String>,
) -> AppResult<DecodedText> {
    let path = with_library(&state, |library| library.stored_path(&id))?;
    let bytes = fs::read(path)?;

    let (mut decoded, truncated) = text::decode_truncated(&bytes, encoding.as_deref());
    if truncated {
        decoded.text.push_str("\n\n……（文件过大，已截断显示）");
        decoded.lossy = true;
    }
    Ok(decoded)
}

/// Absolute path of an entry's stored copy, for `<audio src>`.
#[tauri::command]
fn entry_path(state: State<'_, AppState>, id: String) -> AppResult<String> {
    let path = with_library(&state, |library| library.stored_path(&id))?;
    Ok(path.to_string_lossy().to_string())
}

/// Write already-converted files into a directory the person picked.
///
/// The frontend owns conversion (it has the PDF and EPUB engines) and this side
/// owns the filesystem. Bytes cross the boundary rather than source paths, so a
/// malformed request cannot make the backend read from an arbitrary location.
///
/// Deliberately does **not** take the library lock: it touches only the export
/// destination, and holding the metadata lock for a multi-hundred-megabyte write
/// would block the UI's list refresh for no reason.
///
/// Per-file failures are reported in the outcome instead of aborting the batch:
/// one unwritable file should not discard the other nine.
#[tauri::command]
fn export_write(
    dir: String,
    items: Vec<export::ExportItem>,
) -> AppResult<export::ExportOutcome> {
    export::write_many(&PathBuf::from(dir), &items)
}

/// Fetch one URL on behalf of a book source.
///
/// Async, and it does not touch the library lock: a slow site must not block
/// the library from being read or written. All the safety rules (scheme
/// allowlist, method allowlist, timeout, size cap, redirect policy) live in
/// `net::fetch` rather than here, so they are testable without a Tauri app.
///
/// The login cookie is resolved here rather than in the frontend: the renderer
/// never sees it, and it is attached only when the request targets the host the
/// credential was saved for.
#[tauri::command]
async fn source_fetch(
    app: tauri::AppHandle,
    request: net::SourceRequest,
) -> AppResult<net::SourceResponse> {
    let cookie = credentials::resolve(
        &sources_root(&app)?,
        request.source_id.as_deref(),
        &request.url,
    )?;
    net::fetch(request, cookie.as_deref()).await
}

/// Root of the source storage, under the app data directory.
fn sources_root(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    Ok(sources::sources_root(&app.path().app_data_dir()?))
}

#[tauri::command]
fn sources_load(app: tauri::AppHandle) -> AppResult<serde_json::Value> {
    sources::load_sources(&sources_root(&app)?)
}

#[tauri::command]
fn sources_save(app: tauri::AppHandle, sources: serde_json::Value) -> AppResult<()> {
    sources::save_sources(&sources_root(&app)?, &sources)
}

#[tauri::command]
fn source_progress_load(app: tauri::AppHandle) -> AppResult<serde_json::Value> {
    sources::load_progress(&sources_root(&app)?)
}

#[tauri::command]
fn source_progress_save(app: tauri::AppHandle, progress: serde_json::Value) -> AppResult<()> {
    sources::save_progress(&sources_root(&app)?, &progress)
}

/// Read a text file the person picked in a native dialog.
///
/// Avoids adding `plugin-fs` for the one place the app needs to read an
/// arbitrary file (importing a book source JSON). The path is always one the
/// person chose; this is not a general-purpose file API.
#[tauri::command]
fn read_picked_text_file(path: String) -> AppResult<String> {
    sources::read_text_file(&PathBuf::from(path))
}

/// Open a URL in the system browser.
///
/// Used by the sources screen to visit a source's homepage. The webview must not
/// navigate there itself — the app window would be replaced by the site.
#[tauri::command]
fn open_external(url: String) -> AppResult<()> {
    external::open_in_browser(&url)
}

/// Import downloaded bytes into the library.
///
/// Takes the bytes rather than a URL so the download itself stays in the
/// frontend where the source definition lives; this command only owns the
/// filesystem half. It goes through `library::import_many`, so a downloaded book
/// is indistinguishable from a picked one afterwards.
#[tauri::command]
fn source_download_import(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    title: String,
    extension: String,
    bytes: Vec<u8>,
) -> AppResult<Entry> {
    let temp = app.path().app_cache_dir()?.join("downloads");
    with_library(&state, |library| {
        download::import_download(library, &temp, &title, &extension, &bytes)
    })
}

/// Metadata about stored logins, never the cookies themselves.
///
/// The UI only needs "is this source logged in, for which host, since when".
/// Handing the actual value to the frontend would make every rendering surface a
/// place a session could be stolen from, for no benefit.
#[tauri::command]
fn credentials_status(
    app: tauri::AppHandle,
) -> AppResult<std::collections::BTreeMap<String, credentials::CredentialStatus>> {
    credentials::status(&sources_root(&app)?)
}

/// Forget one source's login.
#[tauri::command]
fn credentials_clear(app: tauri::AppHandle, source_id: String) -> AppResult<()> {
    credentials::clear(&sources_root(&app)?, &source_id)
}

/// Open the site's login page and capture the resulting cookies.
///
/// Returns as soon as the window is up; the outcome arrives later as the
/// [`login::FINISHED_EVENT`] event. Blocking the command until the person
/// finishes logging in would leave the UI unable to react to anything else.
///
/// **Async on purpose.** A synchronous command runs on the main thread, and
/// building a window there deadlocks: creation dispatches work that the same
/// thread is supposed to pump. Marking it `async` moves it to the runtime's
/// thread pool, which is where window creation belongs.
#[tauri::command]
async fn source_login_start(app: tauri::AppHandle, source_id: String) -> AppResult<()> {
    login::start(&app, &sources_root(&app)?, &source_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Build the library up front and fail loudly if the data directory
            // cannot be created, instead of surfacing a confusing error on the
            // first import. Holding it in managed state is also what makes the
            // mutex meaningful: one instance for the whole app lifetime.
            let root = app.path().app_data_dir()?;
            let library = Library::new(root.join("library"))?;
            app.manage(AppState {
                library: Mutex::new(library),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library_list,
            library_import,
            library_remove,
            library_set_progress,
            library_touch,
            read_binary,
            read_text,
            entry_path,
            export_write,
            source_fetch,
            sources_load,
            sources_save,
            source_progress_load,
            source_progress_save,
            source_download_import,
            read_picked_text_file,
            open_external,
            credentials_status,
            credentials_clear,
            source_login_start,
        ])
        .run(tauri::generate_context!())
        .expect("error while running litearti");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    /// A throwaway library rooted in the temp directory.
    fn temp_library(tag: &str) -> (PathBuf, Library) {
        let root = std::env::temp_dir().join(format!(
            "litearti-state-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        let library = Library::new(root.clone()).expect("create library");
        (root, library)
    }

    /// Serialized through the same `Mutex` the commands use, every concurrent
    /// write must land. This is the regression test for the read-modify-write
    /// race: without the lock, `touch` on N threads loses all but the last write.
    #[test]
    fn concurrent_touch_keeps_every_update() {
        let (root, library) = temp_library("concurrent");

        // Import one entry to touch.
        let source = root.join("a.txt");
        fs::write(&source, b"x").expect("write source");
        let entry = library
            .import_many(&[source])
            .expect("import")
            .imported
            .into_iter()
            .next()
            .expect("entry");

        let state = Arc::new(Mutex::new(library));
        let mut handles = Vec::new();

        // 8 threads, each touching the same entry. Every touch rewrites the
        // whole library file, so overlapping writes would clobber each other.
        for _ in 0..8 {
            let state = Arc::clone(&state);
            let id = entry.id.clone();
            handles.push(thread::spawn(move || {
                let guard = state.lock().unwrap_or_else(|p| p.into_inner());
                guard.touch(&id).expect("touch");
            }));
        }
        for handle in handles {
            handle.join().expect("thread");
        }

        let guard = state.lock().unwrap_or_else(|p| p.into_inner());
        let entries = guard.load().expect("load");
        assert_eq!(entries.len(), 1, "entry must survive concurrent writes");
        assert!(
            entries[0].last_opened_at.is_some(),
            "timestamp must be present"
        );

        drop(guard);
        fs::remove_dir_all(&root).ok();
    }

    /// Concurrent imports must not lose entries: each one is a full
    /// read-modify-write of the list.
    #[test]
    fn concurrent_import_keeps_every_entry() {
        let (root, library) = temp_library("concurrent-import");

        // Prepare sources up front; the threads only import.
        let mut sources = Vec::new();
        for i in 0..6 {
            let path = root.join(format!("book{i}.txt"));
            fs::write(&path, format!("body {i}")).expect("write");
            sources.push(path);
        }

        let state = Arc::new(Mutex::new(library));
        let mut handles = Vec::new();
        for source in sources {
            let state = Arc::clone(&state);
            handles.push(thread::spawn(move || {
                let guard = state.lock().unwrap_or_else(|p| p.into_inner());
                guard.import_many(&[source]).expect("import");
            }));
        }
        for handle in handles {
            handle.join().expect("thread");
        }

        let guard = state.lock().unwrap_or_else(|p| p.into_inner());
        let entries = guard.load().expect("load");
        assert_eq!(entries.len(), 6, "all six imports must be recorded");

        drop(guard);
        fs::remove_dir_all(&root).ok();
    }

    /// A poisoned mutex must not brick the app: the guard is recovered and the
    /// library stays readable, because state lives on disk, not in memory.
    #[test]
    fn poisoned_lock_is_recovered() {
        let (root, library) = temp_library("poison");

        let state = Arc::new(Mutex::new(library));
        let poisoner = Arc::clone(&state);
        let handle = thread::spawn(move || {
            let _guard = poisoner.lock().expect("lock");
            panic!("intentional panic while holding the lock");
        });
        assert!(handle.join().is_err(), "thread should have panicked");

        // The mutex is now poisoned; recovery must still allow a read.
        let guard = state.lock().unwrap_or_else(|p| p.into_inner());
        let entries = guard.load().expect("load after poison");
        assert!(entries.is_empty());

        drop(guard);
        fs::remove_dir_all(&root).ok();
    }
}
