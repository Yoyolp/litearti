//! In-app login: open the site, let the person log in, capture the cookies.
//!
//! Book sites that need a session cannot be scraped anonymously, and asking
//! people to paste a cookie from devtools is both error-prone and unpleasant.
//! Instead the site opens in a real webview — it can run its own JavaScript,
//! show a captcha, whatever it needs — and the cookies it sets are read out
//! through WebView2 once the person closes the window.
//!
//! ## Why the capture is not done in the close handler
//!
//! `on_window_event` runs on the **main thread**, and `with_webview` dispatches
//! work to the webview thread while the COM completion callback needs the main
//! thread to pump messages. Blocking in the close handler would therefore
//! deadlock, so the handler only raises a flag and a worker thread does the
//! reading while the window is still alive.
//!
//! ## Platform scope
//!
//! Capturing uses WebView2's cookie manager, so it is Windows-only. The stored
//! credential and its injection are platform-independent; another platform only
//! needs its own capture implementation, which is why the error message for
//! that case names the limitation rather than pretending it is broken.

use crate::credentials;
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};

/// Emitted when a login attempt finishes, successfully or not.
pub const FINISHED_EVENT: &str = "source-login-finished";

/// How long the cookie read may take before we give up on it.
#[cfg(target_os = "windows")]
const CAPTURE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginFinished {
    source_id: String,
    ok: bool,
    message: String,
    cookie_count: usize,
}

/// Where to send the person, and which host the cookies belong to.
#[derive(Debug)]
struct LoginTarget {
    url: String,
    host: String,
}

/// Read the source's `auth` block and work out the login URL and cookie scope.
fn read_target(root: &Path, source_id: &str) -> AppResult<LoginTarget> {
    let sources = crate::sources::load_sources(root)?;
    let list = sources
        .as_array()
        .ok_or_else(|| AppError::Invalid("书源文件格式异常".to_string()))?;
    let source = list
        .iter()
        .find(|item| item.get("id").and_then(|v| v.as_str()) == Some(source_id))
        .ok_or_else(|| AppError::NotFound(format!("书源 {source_id}")))?;

    let auth = source
        .get("auth")
        .ok_or_else(|| AppError::Invalid("这个书源没有声明 auth，无法登录".to_string()))?;
    let kind = auth.get("type").and_then(|v| v.as_str()).unwrap_or_default();
    if kind != "cookie" {
        return Err(AppError::Invalid(format!("不支持的鉴权类型：{kind}")));
    }

    let homepage = source
        .get("homepage")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let url = auth
        .get("loginUrl")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| homepage.to_string());

    let parsed = tauri::Url::parse(&url)
        .map_err(|error| AppError::Invalid(format!("登录地址不合法：{error}")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::Invalid(format!(
            "登录地址只支持 http/https，实际是 {}",
            parsed.scheme()
        )));
    }

    // An explicit `auth.host` wins; otherwise the login page's own host is the
    // only sensible default.
    let host = auth
        .get("host")
        .and_then(|v| v.as_str())
        .map(credentials::normalize_host)
        .filter(|host| !host.is_empty())
        .or_else(|| parsed.host_str().map(credentials::normalize_host))
        .ok_or_else(|| AppError::Invalid("无法确定凭证的 host".to_string()))?;

    Ok(LoginTarget { url, host })
}

/// Open the login window. Returns as soon as it is up.
pub fn start(app: &tauri::AppHandle, root: &Path, source_id: &str) -> AppResult<()> {
    let target = read_target(root, source_id)?;
    let label = format!("login-{source_id}");

    // Re-clicking the login button should focus the window that already exists
    // rather than stacking a second one.
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = tauri::Url::parse(&target.url)
        .map_err(|error| AppError::Invalid(format!("登录地址不合法：{error}")))?;

    let mut builder =
        tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::External(url))
            .title("登录 — 完成后关闭此窗口")
            .inner_size(1000.0, 780.0)
            .min_inner_size(480.0, 400.0);

    // Debug builds keep devtools so a source author can inspect the page; a
    // shipped build should not invite poking at a site's session.
    #[cfg(not(debug_assertions))]
    {
        builder = builder.devtools(false);
    }

    let window = builder
        .build()
        .map_err(|error| AppError::Invalid(format!("无法打开登录窗口：{error}")))?;

    let should_close = Arc::new(AtomicBool::new(false));
    let flag = should_close.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // Do not let the window die yet: the cookie manager is only readable
            // while the webview exists. Ask the worker to finish first.
            api.prevent_close();
            flag.store(true, Ordering::SeqCst);
        }
    });

    let app_handle = app.clone();
    let root_owned: PathBuf = root.to_path_buf();
    let source_owned = source_id.to_string();
    let host = target.host;
    std::thread::spawn(move || {
        // Read cookies **while the window is alive**, not when it closes.
        //
        // Attempting the read during shutdown fails with ERROR_INVALID_STATE
        // (0x8007139F): WebView2 has already begun tearing the profile down even
        // though `prevent_close` kept the window on screen. Polling during the
        // session avoids that state entirely, and has the side benefit that a
        // person who logs in and closes quickly still gets their cookies — the
        // last successful read happened before the close.
        let mut latest: Option<Vec<(String, String)>> = None;
        let mut last_error = String::new();
        let mut consecutive_errors = 0u32;

        loop {
            if app_handle.get_webview_window(&label).is_some() {
                match capture_cookies(&window, &host) {
                    Ok(cookies) if !cookies.is_empty() => {
                        consecutive_errors = 0;
                        latest = Some(cookies);
                        last_error.clear();
                    }
                    Ok(_) => {
                        consecutive_errors = 0;
                        // No cookies yet: normal before the person logs in.
                    }
                    Err(error) => {
                        consecutive_errors += 1;
                        last_error = error.to_string();
                        // A window closed from inside the page (`window.close()`,
                        // a "close" button on the site) does not raise
                        // CloseRequested, and its webview object survives in the
                        // registry while the content is already gone — every read
                        // then fails with ERROR_INVALID_STATE forever. Treating a
                        // run of failures as "the session is over" is what lets
                        // the captured cookies still be saved.
                        if consecutive_errors >= 3 && latest.is_some() {
                            break;
                        }
                    }
                }
            }

            // Wait in slices rather than one long sleep so closing stays
            // responsive; roughly one capture per second is plenty.
            for _ in 0..10 {
                std::thread::sleep(std::time::Duration::from_millis(60));
                if should_close.load(Ordering::SeqCst) {
                    break;
                }
            }
            if should_close.load(Ordering::SeqCst) {
                break;
            }
            if app_handle.get_webview_window(&label).is_none() {
                break;
            }
        }

        let payload = match latest {
            Some(cookies) => persist(&root_owned, &source_owned, &host, cookies),
            None => LoginFinished {
                source_id: source_owned.clone(),
                ok: false,
                message: if last_error.is_empty() {
                    "没有获取到 Cookie，可能没有完成登录".to_string()
                } else {
                    format!("没有获取到 Cookie：{last_error}")
                },
                cookie_count: 0,
            },
        };
        let _ = app_handle.emit(FINISHED_EVENT, payload);
        let _ = window.destroy();
    });

    Ok(())
}

/// Store a captured cookie set and describe the outcome.
fn persist(
    root: &Path,
    source_id: &str,
    host: &str,
    cookies: Vec<(String, String)>,
) -> LoginFinished {
    let fail = |message: String| LoginFinished {
        source_id: source_id.to_string(),
        ok: false,
        message,
        cookie_count: 0,
    };

    // Only name/value pairs go into the header; attributes like HttpOnly are
    // meaningful to a browser, not to a request.
    let header = cookies
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ");

    if let Err(error) = credentials::put(root, source_id, host, &header, "login") {
        return fail(error.to_string());
    }

    LoginFinished {
        source_id: source_id.to_string(),
        ok: true,
        message: format!("已保存 {host} 的登录凭证"),
        cookie_count: cookies.len(),
    }
}

#[cfg(target_os = "windows")]
fn capture_cookies(window: &tauri::WebviewWindow, host: &str) -> AppResult<Vec<(String, String)>> {
    use std::sync::mpsc;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2CookieList, ICoreWebView2_2,
    };
    use webview2_com::{CoTaskMemPWSTR, GetCookiesCompletedHandler};
    use windows_core::{Interface, HSTRING, PWSTR};

    /// Read every cookie in the list into `(name, value)` pairs.
    ///
    /// Each returned string is allocated by COM, so it is wrapped in
    /// `CoTaskMemPWSTR` which frees it on drop — converting straight out of the
    /// raw pointer would leak.
    unsafe fn collect(list: &ICoreWebView2CookieList) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let mut count = 0u32;
        if list.Count(&mut count).is_err() {
            return out;
        }
        for index in 0..count {
            let Ok(cookie) = list.GetValueAtIndex(index) else {
                continue;
            };
            let mut name = PWSTR::null();
            let mut value = PWSTR::null();
            if cookie.Name(&mut name).is_err() || cookie.Value(&mut value).is_err() {
                continue;
            }
            out.push((
                CoTaskMemPWSTR::from(name).to_string(),
                CoTaskMemPWSTR::from(value).to_string(),
            ));
        }
        out
    }

    let uri = format!("https://{host}/");
    let (tx, rx) = mpsc::channel::<Result<Vec<(String, String)>, String>>();

    let sender_for_closure = tx.clone();
    window
        .with_webview(move |platform| {
            let start = (|| -> windows_core::Result<()> {
                let controller = platform.controller();
                let core = unsafe { controller.CoreWebView2()? };
                // `CookieManager` lives on the versioned interface, not on the
                // base one; every WebView2 runtime that ships today has it.
                let core2: ICoreWebView2_2 = core.cast()?;
                let manager = unsafe { core2.CookieManager()? };
                let sender = sender_for_closure.clone();
                let handler = GetCookiesCompletedHandler::create(Box::new(
                    move |_result, list: Option<ICoreWebView2CookieList>| {
                        let cookies = list.map(|list| unsafe { collect(&list) }).unwrap_or_default();
                        let _ = sender.send(Ok(cookies));
                        Ok(())
                    },
                ));
                unsafe { manager.GetCookies(&HSTRING::from(uri.as_str()), &handler)? };
                Ok(())
            })();

            if let Err(error) = start {
                let _ = sender_for_closure.send(Err(error.to_string()));
            }
        })
        .map_err(|error| AppError::Invalid(format!("无法访问登录窗口：{error}")))?;

    match rx.recv_timeout(CAPTURE_TIMEOUT) {
        Ok(Ok(cookies)) => Ok(cookies),
        Ok(Err(message)) => Err(AppError::Invalid(format!("读取 Cookie 失败：{message}"))),
        Err(_) => Err(AppError::Invalid("读取 Cookie 超时".to_string())),
    }
}

#[cfg(not(target_os = "windows"))]
fn capture_cookies(_window: &tauri::WebviewWindow, _host: &str) -> AppResult<Vec<(String, String)>> {
    Err(AppError::Invalid(
        "当前平台不支持自动获取登录凭证；凭证存储与发送仍然可用".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root_with(sources: serde_json::Value) -> PathBuf {
        let root = std::env::temp_dir().join(format!("litearti-login-{}", uuid::Uuid::new_v4()));
        crate::sources::save_sources(&root, &sources).unwrap();
        root
    }

    #[test]
    fn login_url_defaults_to_homepage() {
        let root = root_with(serde_json::json!([{
            "id": "s", "homepage": "https://example.com/", "auth": { "type": "cookie" }
        }]));
        let target = read_target(&root, "s").unwrap();
        assert_eq!(target.url, "https://example.com/");
        assert_eq!(target.host, "example.com");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn explicit_login_url_and_host_win() {
        let root = root_with(serde_json::json!([{
            "id": "s", "homepage": "https://example.com/",
            "auth": {
                "type": "cookie",
                "loginUrl": "https://passport.example.com/login",
                "host": "passport.example.com"
            }
        }]));
        let target = read_target(&root, "s").unwrap();
        assert_eq!(target.url, "https://passport.example.com/login");
        assert_eq!(target.host, "passport.example.com");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_auth_is_reported() {
        let root = root_with(serde_json::json!([{
            "id": "s", "homepage": "https://example.com/"
        }]));
        let error = read_target(&root, "s").expect_err("must reject");
        assert!(error.to_string().contains("auth"), "{error}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unknown_auth_type_is_rejected() {
        let root = root_with(serde_json::json!([{
            "id": "s", "homepage": "https://example.com/", "auth": { "type": "oauth" }
        }]));
        let error = read_target(&root, "s").expect_err("must reject");
        assert!(error.to_string().contains("oauth"), "{error}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn non_web_login_url_is_rejected() {
        let root = root_with(serde_json::json!([{
            "id": "s", "homepage": "https://example.com/",
            "auth": { "type": "cookie", "loginUrl": "file:///C:/Windows/win.ini" }
        }]));
        let error = read_target(&root, "s").expect_err("must reject");
        assert!(error.to_string().contains("http"), "{error}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unknown_source_is_reported() {
        let root = root_with(serde_json::json!([]));
        let error = read_target(&root, "nope").expect_err("must reject");
        assert!(error.to_string().contains("nope"), "{error}");
        std::fs::remove_dir_all(&root).ok();
    }
}
