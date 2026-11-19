//! Deciding what counts as "a link worth opening".
//!
//! A book source has a homepage, and "go look at this site" is a legitimate
//! thing to want from the sources screen. Doing it in the webview would be
//! wrong — the app's own window would navigate away — so the URL is handed to
//! the platform instead.
//!
//! This module is only the *judgement*: which strings may be launched. The
//! launching itself is `tauri-plugin-opener`, which the OS implements per
//! platform (a `startActivity` Intent on Android, the default-browser
//! association on Windows and macOS). Shelling out to `rundll32` or `xdg-open`
//! was the previous approach and simply has no Android equivalent.
//!
//! Scope is deliberately narrow: only `http` and `https`, and only URLs that
//! parse. A book source is user-supplied JSON, so this is the one place a bad
//! value could otherwise become "launch an arbitrary app".

use crate::error::{AppError, AppResult};

/// Reject anything that is not a plain web URL.
///
/// Returns the normalized URL as a string, which is what the opener wants.
pub fn ensure_web_url(raw: &str) -> AppResult<String> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|error| AppError::Invalid(format!("URL 不合法：{error}")))?;
    match url.scheme() {
        "http" | "https" => Ok(url.as_str().to_string()),
        other => Err(AppError::Invalid(format!(
            "只支持 http/https，实际是 {other}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https() {
        assert!(ensure_web_url("https://example.com").is_ok());
        assert!(ensure_web_url("http://example.com/a?b=c").is_ok());
        // Surrounding whitespace from a pasted value is tolerated.
        assert!(ensure_web_url("  https://example.com  ").is_ok());
    }

    #[test]
    fn rejects_other_schemes() {
        for url in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-settings:",
            "cmd:calc",
            "ftp://example.com",
            "content://com.android.providers.downloads.documents/document/1",
        ] {
            assert!(ensure_web_url(url).is_err(), "{url} should be rejected");
        }
    }

    #[test]
    fn rejects_garbage() {
        assert!(ensure_web_url("").is_err());
        assert!(ensure_web_url("not a url").is_err());
    }
}
