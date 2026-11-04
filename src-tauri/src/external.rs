//! Opening a URL in the system browser.
//!
//! A book source has a homepage, and "go look at this site" is a legitimate
//! thing to want from the sources screen. Doing it in the webview would be
//! wrong — the app's own window would navigate away — so the URL is handed to
//! the OS instead.
//!
//! Scope is deliberately narrow: only `http` and `https`, and only URLs that
//! parse. A book source is user-supplied JSON, so this is the one place a bad
//! value could otherwise become "launch an arbitrary program".

use crate::error::{AppError, AppResult};
use std::process::Command;

/// Reject anything that is not a plain web URL.
fn ensure_web_url(raw: &str) -> AppResult<reqwest::Url> {
    let url = reqwest::Url::parse(raw.trim())
        .map_err(|error| AppError::Invalid(format!("URL 不合法：{error}")))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        other => Err(AppError::Invalid(format!(
            "只支持 http/https，实际是 {other}"
        ))),
    }
}

/// Open `url` in the platform's default browser.
///
/// The URL is passed as a separate argument to the launcher rather than through
/// a shell string, so characters like `&` in a query string cannot start a
/// second command.
pub fn open_in_browser(url: &str) -> AppResult<()> {
    let parsed = ensure_web_url(url)?;
    let target = parsed.as_str();

    #[cfg(target_os = "windows")]
    let status = Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", target])
        .status();

    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(target).status();

    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(target).status();

    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(AppError::Invalid(format!(
            "无法打开浏览器（退出码 {}）",
            status.code().unwrap_or(-1)
        ))),
        Err(error) => Err(AppError::Invalid(format!("无法打开浏览器：{error}"))),
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
