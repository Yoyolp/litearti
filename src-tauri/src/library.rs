use crate::error::{AppError, AppResult};
use crate::model::{Entry, ImportFailure, ImportReport};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// On-disk shape of `library.json`. The version field exists so a future
/// migration can recognize old files instead of guessing.
#[derive(Debug, Serialize, Deserialize)]
struct LibraryFile {
    version: u32,
    #[serde(default)]
    entries: Vec<Entry>,
}

impl Default for LibraryFile {
    fn default() -> Self {
        LibraryFile {
            version: 1,
            entries: Vec::new(),
        }
    }
}

const LIBRARY_VERSION: u32 = 1;

/// The managed library: a metadata file plus a `files/` directory holding the
/// imported copies.
///
/// Importing copies bytes into the managed directory. Nothing here ever reads
/// the original path again, so moving or deleting the source cannot break an
/// entry.
pub struct Library {
    root: PathBuf,
}

impl Library {
    pub fn new(root: PathBuf) -> AppResult<Self> {
        fs::create_dir_all(root.join("files"))?;
        Ok(Library { root })
    }

    fn metadata_path(&self) -> PathBuf {
        self.root.join("library.json")
    }

    pub fn files_dir(&self) -> PathBuf {
        self.root.join("files")
    }

    /// Absolute path of the stored copy for one entry.
    pub fn path_of(&self, entry: &Entry) -> PathBuf {
        self.files_dir().join(&entry.stored_name)
    }

    /// Read the whole library.
    ///
    /// A corrupt metadata file is preserved as `library.corrupt-<ts>.json` and
    /// the library starts empty rather than making the app unlaunchable. The
    /// next successful save therefore cannot silently overwrite the evidence.
    pub fn load(&self) -> AppResult<Vec<Entry>> {
        let path = self.metadata_path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(&path)?;
        // Tolerate a UTF-8 BOM. Editors and PowerShell's `Set-Content -Encoding
        // UTF8` both add one, and serde rejects it as "expected value at line 1
        // column 1" — which would look like corruption to a person who simply
        // edited the file by hand.
        let raw = raw.strip_prefix('\u{feff}').unwrap_or(&raw);
        match serde_json::from_str::<LibraryFile>(raw) {
            Ok(file) => Ok(file.entries),
            Err(error) => {
                let backup = self
                    .root
                    .join(format!("library.corrupt-{}.json", Entry::now_millis()));
                fs::rename(&path, &backup)?;
                eprintln!(
                    "litearti: library.json was unreadable ({error}); moved to {}",
                    backup.display()
                );
                Ok(Vec::new())
            }
        }
    }

    /// Write the whole library atomically.
    ///
    /// The temp file plus rename means an interrupted write leaves either the
    /// old file or the new one, never a truncated mix.
    pub fn save(&self, entries: &[Entry]) -> AppResult<()> {
        let file = LibraryFile {
            version: LIBRARY_VERSION,
            entries: entries.to_vec(),
        };
        let json = serde_json::to_string_pretty(&file)?;
        let target = self.metadata_path();
        let temp = self.root.join("library.json.tmp");
        fs::write(&temp, json)?;
        fs::rename(&temp, &target)?;
        Ok(())
    }

    /// Copy one source file into the managed directory.
    ///
    /// Returns the new entry; the caller owns merging it into the list.
    ///
    /// `title_override` exists for downloads: the temp file is named with a UUID
    /// to avoid collisions, so deriving the title from the filename would store
    /// `书名-<uuid>` as the display title. The caller knows the real title and
    /// passes it here.
    pub fn import_one(
        &self,
        source: &Path,
        existing: &[Entry],
        title_override: Option<&str>,
    ) -> AppResult<Option<Entry>> {
        let metadata = fs::metadata(source)?;
        if !metadata.is_file() {
            return Err(AppError::Invalid(format!(
                "{} 不是文件",
                source.display()
            )));
        }

        let size = metadata.len();
        let source_path = source.to_string_lossy().to_string();

        // Duplicate = same original path and same size. Cheap, predictable, and
        // it never mistakes two different files for one another.
        let duplicate = existing
            .iter()
            .any(|e| e.source_path == source_path && e.size == size);
        if duplicate {
            return Ok(None);
        }

        let id = uuid::Uuid::new_v4().to_string();
        let extension = source
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let stored_name = if extension.is_empty() {
            id.clone()
        } else {
            format!("{id}.{extension}")
        };

        let target = self.files_dir().join(&stored_name);
        fs::copy(source, &target)?;

        let title = title_override
            .map(|title| title.trim().to_string())
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| {
                source
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| "未命名".to_string())
            });

        Ok(Some(Entry {
            id,
            title,
            extension,
            size,
            source_path,
            stored_name,
            added_at: Entry::now_millis(),
            last_opened_at: None,
            progress: None,
        }))
    }

    /// Import many files, reporting partial failure instead of aborting.
    pub fn import_many(&self, sources: &[PathBuf]) -> AppResult<ImportReport> {
        self.import_many_titled(sources, None)
    }

    /// Import many files, optionally overriding the display title.
    ///
    /// The override applies to a single-file import (a download); for a batch it
    /// is ignored, because there is no single title to apply.
    pub fn import_many_titled(
        &self,
        sources: &[PathBuf],
        title_override: Option<&str>,
    ) -> AppResult<ImportReport> {
        let mut entries = self.load()?;
        let mut imported = Vec::new();
        let mut duplicates = 0usize;
        let mut failed = Vec::new();

        for source in sources {
            match self.import_one(source, &entries, title_override) {
                Ok(Some(entry)) => {
                    entries.push(entry.clone());
                    imported.push(entry);
                }
                Ok(None) => duplicates += 1,
                Err(error) => failed.push(ImportFailure {
                    source_path: source.to_string_lossy().to_string(),
                    reason: error.to_string(),
                }),
            }
        }

        if !imported.is_empty() {
            if let Err(error) = self.save(&entries) {
                // The copies are already in `files/` but the metadata write
                // failed, so they would become invisible orphans that only grow
                // the folder. Undo the copies before reporting the failure —
                // a failed import should leave no trace.
                for entry in &imported {
                    let path = self.path_of(entry);
                    if path.exists() {
                        let _ = fs::remove_file(&path);
                    }
                }
                return Err(error);
            }
        }

        Ok(ImportReport {
            imported,
            duplicates,
            failed,
        })
    }

    /// Delete one entry and its stored copy.
    ///
    /// The metadata is written **before** the file is unlinked. The two failure
    /// modes are not symmetric:
    ///
    /// - save fails, file already gone → a dangling entry that errors with
    ///   "找不到条目对应的文件" every time it is opened. The user sees a broken
    ///   row they cannot fix.
    /// - save succeeds, unlink fails → an orphan file in `files/`, invisible in
    ///   the UI and reclaimable by a future sweep.
    ///
    /// A failed unlink is therefore reported but does not undo the removal: the
    /// entry is gone from the library either way, and leaving it listed while
    /// its file is about to be deleted would be the worse lie.
    pub fn remove(&self, id: &str) -> AppResult<()> {
        let mut entries = self.load()?;
        let Some(position) = entries.iter().position(|e| e.id == id) else {
            return Err(AppError::NotFound("这个条目".to_string()));
        };
        let entry = entries.remove(position);

        // Persist first: from this point the entry no longer exists as far as
        // the library is concerned.
        self.save(&entries)?;

        let path = self.path_of(&entry);
        if path.exists() {
            if let Err(error) = fs::remove_file(&path) {
                // The row is already gone, so this cannot be surfaced as a
                // failed removal without lying. Log it and let the file be
                // reclaimed later.
                eprintln!(
                    "litearti: entry {} removed but its file could not be deleted ({}): {}",
                    entry.id,
                    error,
                    path.display()
                );
            }
        }
        Ok(())
    }

    /// Absolute path of an entry's stored copy, after checking both that the
    /// entry exists and that its file is present.
    ///
    /// Returns a path rather than bytes on purpose: the caller can then read the
    /// file *outside* the library lock, so opening a 100 MB PDF does not block
    /// a progress write from another command.
    pub fn stored_path(&self, id: &str) -> AppResult<PathBuf> {
        let entries = self.load()?;
        let entry = entries
            .iter()
            .find(|e| e.id == id)
            .ok_or_else(|| AppError::NotFound("这个条目".to_string()))?;
        let path = self.path_of(entry);
        if !path.exists() {
            return Err(AppError::NotFound("条目对应的文件".to_string()));
        }
        Ok(path)
    }

    /// Replace one entry's progress blob.
    pub fn set_progress(&self, id: &str, progress: Option<serde_json::Value>) -> AppResult<Entry> {
        let mut entries = self.load()?;
        let entry = entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| AppError::NotFound("这个条目".to_string()))?;
        entry.progress = progress;
        let snapshot = entry.clone();
        self.save(&entries)?;
        Ok(snapshot)
    }

    /// Record that an entry was opened now.
    pub fn touch(&self, id: &str) -> AppResult<Entry> {
        let mut entries = self.load()?;
        let entry = entries
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| AppError::NotFound("这个条目".to_string()))?;
        entry.last_opened_at = Some(Entry::now_millis());
        let snapshot = entry.clone();
        self.save(&entries)?;
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway library rooted in the temp directory.
    struct TempLibrary {
        library: Library,
        root: PathBuf,
    }

    impl TempLibrary {
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "litearti-library-{tag}-{}",
                uuid::Uuid::new_v4()
            ));
            let library = Library::new(root.clone()).expect("create library");
            TempLibrary { library, root }
        }

        /// Write a source file outside the library and import it.
        fn import(&self, name: &str, body: &[u8]) -> Entry {
            let source = self.root.join(name);
            fs::write(&source, body).expect("write source");
            self.library
                .import_many(&[source])
                .expect("import")
                .imported
                .into_iter()
                .next()
                .expect("one entry")
        }
    }

    impl Drop for TempLibrary {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn starts_empty() {
        let t = TempLibrary::new("empty");
        assert!(t.library.load().expect("load").is_empty());
    }

    #[test]
    fn import_copies_the_file() {
        let t = TempLibrary::new("import");
        let entry = t.import("book.txt", b"hello");

        assert_eq!(entry.title, "book");
        assert_eq!(entry.extension, "txt");
        assert_eq!(entry.size, 5);

        let stored = t.library.path_of(&entry);
        assert!(stored.exists(), "stored copy should exist");
        assert_eq!(fs::read(stored).expect("read"), b"hello");

        // The library list reflects it.
        assert_eq!(t.library.load().expect("load").len(), 1);
    }

    #[test]
    fn import_detects_duplicates_by_path_and_size() {
        let t = TempLibrary::new("dup");
        let source = t.root.join("same.txt");
        fs::write(&source, b"abc").expect("write");

        let first = t.library.import_many(&[source.clone()]).expect("first");
        assert_eq!(first.imported.len(), 1);

        let second = t.library.import_many(&[source]).expect("second");
        assert_eq!(second.imported.len(), 0);
        assert_eq!(second.duplicates, 1);
    }

    #[test]
    fn remove_deletes_entry_and_file() {
        let t = TempLibrary::new("remove");
        let entry = t.import("gone.txt", b"bye");
        let stored = t.library.path_of(&entry);
        assert!(stored.exists());

        t.library.remove(&entry.id).expect("remove");

        assert!(t.library.load().expect("load").is_empty());
        assert!(!stored.exists(), "stored copy should be deleted");
    }

    #[test]
    fn remove_unknown_id_errors() {
        let t = TempLibrary::new("remove-missing");
        assert!(t.library.remove("no-such-id").is_err());
    }

    /// The whole point of saving before unlinking: the metadata must never
    /// reference a file that has already been deleted.
    #[test]
    fn remove_leaves_no_dangling_entry_when_file_is_missing() {
        let t = TempLibrary::new("remove-missing-file");
        let entry = t.import("lost.txt", b"x");

        // Simulate the file disappearing behind the library's back.
        fs::remove_file(t.library.path_of(&entry)).expect("delete file");

        // Removal must still succeed: the entry is what the user asked to
        // remove, and its file being gone is exactly the state we want.
        t.library.remove(&entry.id).expect("remove should succeed");
        assert!(t.library.load().expect("load").is_empty());
    }

    #[test]
    fn remove_does_not_touch_other_entries() {
        let t = TempLibrary::new("remove-others");
        let keep = t.import("keep.txt", b"keep");
        let drop = t.import("drop.txt", b"drop");

        t.library.remove(&drop.id).expect("remove");

        let remaining = t.library.load().expect("load");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, keep.id);
        assert!(t.library.path_of(&keep).exists());
    }

    #[test]
    fn set_progress_round_trips() {
        let t = TempLibrary::new("progress");
        let entry = t.import("p.txt", b"x");

        let payload = serde_json::json!({ "version": 1, "ratio": 0.42 });
        t.library
            .set_progress(&entry.id, Some(payload.clone()))
            .expect("set");

        let stored = t.library.load().expect("load");
        assert_eq!(stored[0].progress, Some(payload));

        t.library.set_progress(&entry.id, None).expect("clear");
        assert_eq!(t.library.load().expect("load")[0].progress, None);
    }

    #[test]
    fn touch_sets_last_opened() {
        let t = TempLibrary::new("touch");
        let entry = t.import("t.txt", b"x");
        assert_eq!(entry.last_opened_at, None);

        let touched = t.library.touch(&entry.id).expect("touch");
        assert!(touched.last_opened_at.is_some());
    }

    #[test]
    fn stored_path_errors_for_unknown_entry() {
        let t = TempLibrary::new("stored-path");
        assert!(t.library.stored_path("nope").is_err());
    }

    #[test]
    fn stored_path_errors_when_file_is_gone() {
        let t = TempLibrary::new("stored-path-missing");
        let entry = t.import("v.txt", b"x");
        fs::remove_file(t.library.path_of(&entry)).expect("delete");

        let error = t.library.stored_path(&entry.id).expect_err("should fail");
        // The message must name the missing thing, not just say "not found".
        assert!(error.to_string().contains("条目对应的文件"), "{error}");
    }

    #[test]
    fn corrupt_metadata_is_backed_up_and_library_starts_empty() {
        let t = TempLibrary::new("corrupt");
        let entry = t.import("c.txt", b"x");
        assert_eq!(t.library.load().expect("load").len(), 1);

        // Overwrite the metadata with something unparseable.
        fs::write(t.root.join("library.json"), b"{ not json").expect("write");

        let entries = t.library.load().expect("load should recover");
        assert!(entries.is_empty(), "corrupt library starts empty");

        // The evidence must survive under a different name.
        let backups: Vec<_> = fs::read_dir(&t.root)
            .expect("read dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("library.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1, "corrupt file should be preserved");
        let _ = entry;
    }

    #[test]
    fn bom_in_metadata_is_tolerated() {
        let t = TempLibrary::new("bom");
        t.import("b.txt", b"x");

        // Re-save with a BOM prepended, as a hand-editing tool might.
        let path = t.root.join("library.json");
        let raw = fs::read(&path).expect("read");
        let mut with_bom = vec![0xEF, 0xBB, 0xBF];
        with_bom.extend_from_slice(&raw);
        fs::write(&path, with_bom).expect("write");

        assert_eq!(t.library.load().expect("load").len(), 1);
    }

    #[test]
    fn import_many_reports_partial_failure() {
        let t = TempLibrary::new("partial");
        let good = t.root.join("good.txt");
        fs::write(&good, b"ok").expect("write");

        let report = t
            .library
            .import_many(&[good, t.root.join("does-not-exist.txt")])
            .expect("import");

        assert_eq!(report.imported.len(), 1);
        assert_eq!(report.failed.len(), 1);
        assert_eq!(t.library.load().expect("load").len(), 1);
    }
}
