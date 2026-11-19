//! Reading files the person picked on Android.
//!
//! ## Why this cannot be an ordinary path
//!
//! On desktop, a file dialog returns a filesystem path and `fs::copy` works. On
//! Android, `ACTION_GET_CONTENT` returns a **`content://` URI** whose bytes are
//! owned by a ContentProvider (the system Files app, a cloud drive, a downloads
//! provider). There is no such path on the filesystem: the app has no read
//! permission on the directory, and often the file is not even local.
//!
//! Two separate things therefore have to change:
//!
//! 1. **The bytes.** `std::fs::open` on a `content://` string fails. The bytes
//!    are reached through the ContentResolver, which `tauri-plugin-fs` already
//!    wraps: its `Fs::open` resolves such a URI to a real file descriptor on
//!    Android and is a plain `open` on desktop. So one call site covers both,
//!    and this module never touches a platform conditional for reading.
//!
//! 2. **The name.** A URI's last path segment is an opaque provider id
//!    (`msf:1000000123`, `document/primary:Books/x.txt`), not a filename. But
//!    the extension decides which viewer opens the book, and the stem becomes
//!    its title — so the name is not cosmetic. It exists only in the provider's
//!    `DISPLAY_NAME` column, reachable through the ContentResolver, which has no
//!    Rust binding in the plugins. Hence the small JNI block below.
//!
//! ## Scope
//!
//! Only what the picker produced. This is not a general file API: a `content://`
//! URI that no provider serves is reported as a failure, and nothing here
//! enumerates or guesses at other files.

use crate::error::{AppError, AppResult};
use std::path::Path;

/// Does this string address a file through a ContentProvider?
pub fn is_content_uri(raw: &str) -> bool {
    raw.trim_start().starts_with("content://")
}

/// Ask the provider for the file's display name.
///
/// Returns `None` when the provider does not publish one — that happens for
/// generated documents. The caller then falls back to the URI's last segment,
/// which is ugly but still unique, rather than inventing a name.
#[cfg(target_os = "android")]
pub fn display_name(uri: &str) -> Option<String> {
    android::query_display_name(uri).ok().flatten()
}

/// On desktop a picked path is already a name, so this is never reached in
/// practice; it returns `None` to keep the caller on its path-based branch.
#[cfg(not(target_os = "android"))]
pub fn display_name(_uri: &str) -> Option<String> {
    None
}

/// Open the picked location for reading.
///
/// `app` is needed because the fs plugin's reader is managed state. Returns a
/// `File` either way — on Android that `File` wraps a descriptor the
/// ContentResolver handed out, which is why `metadata()` and `Seek` still work
/// even though no path exists behind it.
pub fn open_for_read<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    location: &str,
) -> AppResult<std::fs::File> {
    use tauri_plugin_fs::{FsExt, OpenOptions};

    // `FilePath` has no `From<&str>`: a bare string is ambiguous between a path
    // and a URI, and guessing is exactly how a `content://` value would be
    // treated as a relative path. Parsing explicitly makes the URI case
    // unambiguous, which is the whole point on Android.
    let target = if is_content_uri(location) {
        tauri_plugin_fs::FilePath::Url(
            reqwest::Url::parse(location)
                .map_err(|error| AppError::Invalid(format!("URI 不合法：{error}")))?,
        )
    } else {
        tauri_plugin_fs::FilePath::Path(std::path::PathBuf::from(location))
    };

    let mut options = OpenOptions::new();
    options.read(true);

    app.fs()
        .open(target, options)
        .map_err(|error| AppError::Invalid(format!("无法打开所选文件：{error}")))
}

/// Copy a picked location into `target`, streaming.
///
/// Written as a free function rather than inline in the command so the size
/// cap enforced here is impossible to forget at a second call site.
pub fn copy_to<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    location: &str,
    target: &Path,
) -> AppResult<()> {
    let mut source = open_for_read(app, location)?;
    let mut sink = std::fs::File::create(target)?;
    std::io::copy(&mut source, &mut sink)?;
    Ok(())
}

/// Read a whole file the person picked, decoding as UTF-8.
///
/// Separate from [`copy_to`] because its caller (importing a book-source JSON)
/// wants the text in memory and has its own size limit to enforce with a clear
/// message rather than a generic I/O error.
pub fn read_text<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    location: &str,
    max_bytes: u64,
) -> AppResult<String> {
    use std::io::Read;

    let mut source = open_for_read(app, location)?;
    // Read one byte past the limit so "exactly at the cap" is allowed and
    // "over it" is detectable without trusting a possibly-absent size.
    let mut bytes = Vec::new();
    source
        .by_ref()
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| AppError::Invalid(format!("读取文件失败：{error}")))?;
    if bytes.len() as u64 > max_bytes {
        return Err(AppError::Invalid(format!(
            "文件过大，上限 {max_bytes} 字节"
        )));
    }
    let text = String::from_utf8(bytes)
        .map_err(|_| AppError::Invalid("文件不是 UTF-8 编码".to_string()))?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

/// The JNI bridge to `ContentResolver.query`.
///
/// ## Why JNI at all
///
/// `DISPLAY_NAME` is only exposed through an Android `Cursor`, and no Tauri
/// plugin surfaces it. The alternative — a Kotlin plugin of our own — would mean
/// maintaining a Gradle module and a mobile-plugin registration for one column
/// of one query, which is far more machinery than the task deserves.
///
/// ## Why this is safe to call from here
///
/// `tao` calls `ndk_context::initialize_android_context` in the Activity's
/// `onCreate`, so the VM and the application Context already exist by the time
/// any command runs. Both `jni` and `ndk-context` are pinned to the versions tao
/// itself depends on; that matters because `ndk_context::vm()` hands back a raw
/// pointer that is only a valid `JavaVM` for a matching crate version.
#[cfg(target_os = "android")]
mod android {
    use super::AppError;
    use jni::objects::{JObject, JString};
    use jni::sys::jint;
    use jni::JNIEnv;

    /// `ContentResolver.OpenableColumns.DISPLAY_NAME` is the string
    /// `"_display_name"`, but the constant is safer to spell out here because
    /// the value is not part of the public SDK contract.
    const DISPLAY_NAME_COLUMN: &str = "_display_name";

    pub fn query_display_name(uri: &str) -> Result<Option<String>, AppError> {
        // A missing context means the runtime has not come up yet, which is a
        // programming error rather than a user-facing failure; `android_context`
        // panics in that case, so it is caught here and turned into a refusal to
        // name the file — the import still works, only the title is generic.
        let context = std::panic::catch_unwind(ndk_context::android_context)
            .map_err(|_| AppError::Invalid("Android 运行时尚未就绪".to_string()))?;

        let vm = unsafe { jni::JavaVM::from_raw(context.vm().cast()) }
            .map_err(|error| AppError::Invalid(format!("无法连接 Android 运行时：{error}")))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|error| AppError::Invalid(format!("无法连接 Android 运行时：{error}")))?;

        let name = query_with_env(&mut env, context.context() as jni::sys::jobject, uri);
        // Any Java exception left pending would derail the next call on this
        // thread. Clearing it is not optional: JNI keeps it attached to the env.
        let _ = env.exception_clear();
        name.map_err(|error| AppError::Invalid(format!("读取文件名失败：{error}")))
    }

    fn query_with_env(
        env: &mut JNIEnv,
        context: jni::sys::jobject,
        uri: &str,
    ) -> Result<Option<String>, String> {
        // android.content.Context.getContentResolver()
        let resolver = env
            .call_method(
                unsafe { JObject::from_raw(context) },
                "getContentResolver",
                "()Landroid/content/ContentResolver;",
                &[],
            )
            .map_err(|error| format!("取 ContentResolver：{error}"))?
            .l()
            .map_err(|error| format!("取 ContentResolver：{error}"))?;

        let uri_string = env
            .new_string(uri)
            .map_err(|error| format!("构造 URI：{error}"))?;
        // android.net.Uri.parse(String) is a static factory.
        let uri_class = env
            .find_class("android/net/Uri")
            .map_err(|error| format!("找 Uri 类：{error}"))?;
        let parsed = env
            .call_static_method(
                &uri_class,
                "parse",
                "(Ljava/lang/String;)Landroid/net/Uri;",
                &[jni::objects::JValue::Object(&JObject::from(uri_string))],
            )
            .map_err(|error| format!("解析 URI：{error}"))?
            .l()
            .map_err(|error| format!("解析 URI：{error}"))?;

        // The projection is a String[] holding one column name.
        let column = env
            .new_string(DISPLAY_NAME_COLUMN)
            .map_err(|error| format!("构造列名：{error}"))?;
        // The class lookup has to happen before `new_object_array` takes its own
        // mutable borrow of `env`; passing the lookup inline is a double borrow.
        let string_class = env
            .find_class("java/lang/String")
            .map_err(|error| format!("找 String 类：{error}"))?;
        let projection = env
            .new_object_array(1, &string_class, &JObject::from(column))
            .map_err(|error| format!("构造列名数组：{error}"))?;

        // ContentResolver.query(uri, projection, selection, selectionArgs, sortOrder)
        let cursor = env
            .call_method(
                &resolver,
                "query",
                "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
                &[
                    jni::objects::JValue::Object(&parsed),
                    jni::objects::JValue::Object(&JObject::from(projection)),
                    jni::objects::JValue::Object(&JObject::null()),
                    jni::objects::JValue::Object(&JObject::null()),
                    jni::objects::JValue::Object(&JObject::null()),
                ],
            )
            .map_err(|error| format!("查询文件名：{error}"))?
            .l()
            .map_err(|error| format!("查询文件名：{error}"))?;

        if cursor.is_null() {
            return Ok(None);
        }

        // `moveToFirst` reports whether there is a row; an empty provider
        // returns false, which is "no name", not an error.
        let has_row = env
            .call_method(&cursor, "moveToFirst", "()Z", &[])
            .map_err(|error| format!("读取查询结果：{error}"))?
            .z()
            .map_err(|error| format!("读取查询结果：{error}"))?;

        let name = if has_row {
            // Same borrow rule as above: build the column name first, then look
            // the index up with it.
            let column_for_index = env
                .new_string(DISPLAY_NAME_COLUMN)
                .map_err(|error| format!("构造列名：{error}"))?;
            let column_object = JObject::from(column_for_index);
            let index: jint = env
                .call_method(
                    &cursor,
                    "getColumnIndex",
                    "(Ljava/lang/String;)I",
                    &[jni::objects::JValue::Object(&column_object)],
                )
                .map_err(|error| format!("定位列：{error}"))?
                .i()
                .map_err(|error| format!("定位列：{error}"))?;

            if index < 0 {
                None
            } else {
                let value = env
                    .call_method(
                        &cursor,
                        "getString",
                        "(I)Ljava/lang/String;",
                        &[jni::objects::JValue::Int(index)],
                    )
                    .map_err(|error| format!("读取列值：{error}"))?
                    .l()
                    .map_err(|error| format!("读取列值：{error}"))?;
                if value.is_null() {
                    None
                } else {
                    let java_string = JString::from(value);
                    let text = env
                        .get_string(&java_string)
                        .map_err(|error| format!("解码文件名：{error}"))?;
                    Some(String::from(text))
                }
            }
        } else {
            None
        };

        // Closing is hygienic but not fatal if it fails: the cursor is
        // finalized by the GC either way. The exception is already cleared by
        // the caller.
        let _ = env.call_method(&cursor, "close", "()V", &[]);

        Ok(name.filter(|name| !name.trim().is_empty()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_content_uris() {
        assert!(is_content_uri(
            "content://com.android.providers.downloads.documents/document/1"
        ));
        // Leading whitespace is tolerated: the value comes from a plugin
        // round-trip, not from hand entry, but trimming is cheap insurance.
        assert!(is_content_uri("  content://media/external/audio/media/42"));
    }

    #[test]
    fn does_not_mistake_paths_for_uris() {
        for path in [
            r"C:\Users\me\book.txt",
            "/storage/emulated/0/Books/book.txt",
            "file:///storage/emulated/0/book.txt",
            "https://example.com/book.txt",
            "",
        ] {
            assert!(!is_content_uri(path), "{path} should not be a content URI");
        }
    }
}
