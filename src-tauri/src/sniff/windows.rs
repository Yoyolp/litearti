//! Windows media sniffing over the WebView2 DevTools Protocol.
//!
//! ## Why CDP and not injected JavaScript
//!
//! Injecting a script into the page can only see requests the *page's own* frame
//! makes. Nearly every site that needs sniffing puts the player in a cross-origin
//! iframe, and the parent cannot reach into it. `Network.requestWillBeSent` is
//! reported by the browser for every frame, so it sees through that.
//!
//! ## Threading
//!
//! WebView2 is COM and apartment-bound: calls must happen on the thread that owns
//! the webview, and callbacks only arrive while that thread pumps messages. The
//! pattern used throughout this crate (see `login.rs`) is therefore:
//!
//! 1. `with_webview(...)` runs a closure on the webview thread;
//! 2. inside it, start the async COM operation with a completion handler;
//! 3. the handler sends its result down an `mpsc` channel;
//! 4. the **waiting side** blocks on `recv_timeout` while the webview thread
//!    continues to pump.
//!
//! The one thing that must not happen is pumping the message loop from a thread
//! that is already waiting on it. So nothing in this file calls `wait_with_pump`
//! from a task; the subscription is fire-and-forget and the events arrive on the
//! webview thread into a shared buffer.
//!
//! ## The throttling trap
//!
//! WebView2 throttles timers and rendering for a window that is not visible. A
//! hidden window may therefore never load the video at all, and the symptom is the
//! worst kind: it works sometimes. So the window is created **visible but off
//! screen** — see [`OFFSCREEN_POSITION`].
//!
//! ## Capability isolation
//!
//! The sniffing window loads a remote page, so it must be treated as untrusted:
//!
//! - a unique label per session (never `main`), so it inherits no capability;
//! - `proto.rs` refuses to serve the stream proxy to any label but `main`, which
//!   stops a hostile page from using the proxy as an SSRF client.

use super::{CookieRecord, MediaSniffer, MediaSighting, SniffOutcome, SniffRequest};
use crate::error::{AppError, AppResult};
use crate::sniff::pick::SightingSource;
use std::pin::Pin;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Where the sniffing window is placed: on screen coordinates, off any real
/// display, so the OS does not mark it occluded or hidden and throttle it.
const OFFSCREEN_POSITION: (f64, f64) = (-20000.0, -20000.0);

/// The sniffing window's size. Some players refuse to start in a zero-sized
/// viewport, so this is a real (if invisible) size rather than 0.
const WINDOW_SIZE: (f64, f64) = (1024.0, 720.0);

/// How often the waiting loop wakes to check the deadline.
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// How long to wait for `Network.enable` to be accepted.
///
/// Short: this is a local COM call, not a network one. A hang here means the
/// webview is broken, and waiting the full sniff timeout would just delay the
/// error.
const ATTACH_TIMEOUT: Duration = Duration::from_secs(5);

/// Shared state written by the webview thread, read by the waiting task.
#[derive(Default)]
struct EventBuffer {
    sightings: Vec<MediaSighting>,
    error: Option<String>,
}

pub struct CdpSniffer {
    buffer: Arc<Mutex<EventBuffer>>,
}

impl CdpSniffer {
    pub fn new() -> Self {
        CdpSniffer {
            buffer: Arc::new(Mutex::new(EventBuffer::default())),
        }
    }
}

impl Default for CdpSniffer {
    fn default() -> Self {
        Self::new()
    }
}

impl MediaSniffer for CdpSniffer {
    fn sniff<'a>(
        &'a self,
        request: SniffRequest,
    ) -> Pin<Box<dyn std::future::Future<Output = AppResult<SniffOutcome>> + Send + 'a>> {
        Box::pin(async move { self.run(request).await })
    }
}

impl CdpSniffer {
    async fn run(&self, request: SniffRequest) -> AppResult<SniffOutcome> {
        if request.page_url.trim().is_empty() {
            return Err(AppError::Invalid("嗅探地址为空".to_string()));
        }

        let app = current_app_handle()?;
        let label = new_window_label();

        {
            let mut guard = self.buffer.lock().unwrap_or_else(|p| p.into_inner());
            *guard = EventBuffer::default();
        }

        let url = request
            .page_url
            .parse::<tauri::Url>()
            .map_err(|error| AppError::Invalid(format!("嗅探地址不合法：{error}")))?;

        let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
            .title("litearti")
            .inner_size(WINDOW_SIZE.0, WINDOW_SIZE.1)
            // Off screen rather than hidden: a hidden window gets throttled and may
            // never start playing. See the module docs.
            .position(OFFSCREEN_POSITION.0, OFFSCREEN_POSITION.1)
            .visible(true)
            .focused(false)
            .skip_taskbar(true)
            .build()
            .map_err(|error| AppError::Invalid(format!("无法打开嗅探窗口：{error}")))?;

        // Attach the CDP subscription, waiting for confirmation so an immediate
        // failure is reported now rather than after the full timeout.
        let attach_result = attach_network_listener(&window, Arc::clone(&self.buffer));
        if let Err(error) = attach_result {
            let _ = window.close();
            return Err(error);
        }

        // Collect for the whole timeout rather than stopping at the first hit: a
        // pre-roll ad is usually the first HLS request on a page, so stopping early
        // reliably picks the ad.
        let deadline = Instant::now() + request.timeout;
        while Instant::now() < deadline {
            // Sleep in slices so a close request from another path is noticed; the
            // loop condition is the only exit besides the error check below.
            tokio_sleep(POLL_INTERVAL).await;
            let failed = {
                let guard = self.buffer.lock().unwrap_or_else(|p| p.into_inner());
                guard.error.is_some()
            };
            if failed {
                break;
            }
        }

        // Read cookies while the window is still alive: closing first would destroy
        // the very session we need to hand back.
        let cookies = read_cookies(&window);

        let (sightings, error) = {
            let mut guard = self.buffer.lock().unwrap_or_else(|p| p.into_inner());
            (guard.sightings.clone(), guard.error.take())
        };

        // Always close: the remote page must not keep running after its one job.
        let _ = window.close();

        if let Some(error) = error {
            return Err(AppError::Invalid(error));
        }

        Ok(SniffOutcome { sightings, cookies })
    }
}

/// Sleep without depending on `tokio` directly.
///
/// `tokio` is a dev-dependency here (the app runs on Tauri's runtime), so the
/// runtime's own timer is used instead of adding a dependency for one call.
async fn tokio_sleep(duration: Duration) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration))
        .await
        .ok();
}

/// A unique, non-`main` label for one sniffing session.
fn new_window_label() -> String {
    format!("sniff-{}", uuid::Uuid::new_v4())
}

/// Access the running app handle.
///
/// The process has exactly one, installed in `lib.rs::run`; Tauri keeps it alive
/// for the process lifetime, so the lookup cannot dangle.
fn current_app_handle() -> AppResult<tauri::AppHandle> {
    // `AppHandle::try_from` on the managed state is not stable API; the supported
    // route is the global handle Tauri stores when `run` is called.
    match APP_HANDLE.lock().unwrap_or_else(|p| p.into_inner()).clone() {
        Some(handle) => Ok(handle),
        None => Err(AppError::Invalid(
            "嗅探需要应用已启动（没有记录到应用句柄）".to_string(),
        )),
    }
}

/// The process-wide app handle, recorded in `lib.rs::run`.
///
/// A global rather than plumbing an `AppHandle` through [`MediaSniffer`]: the trait
/// is used from the engine's async code, which has no handle either, and threading
/// one through would make every caller carry a Tauri type for no benefit.
pub static APP_HANDLE: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);

/// Record the app handle so [`current_app_handle`] can find it.
pub fn install_app_handle(handle: tauri::AppHandle) {
    let mut slot = APP_HANDLE.lock().unwrap_or_else(|p| p.into_inner());
    *slot = Some(handle);
}

/// Subscribe to `Network.requestWillBeSent` and begin feeding the buffer.
fn attach_network_listener(
    window: &tauri::WebviewWindow,
    buffer: Arc<Mutex<EventBuffer>>,
) -> AppResult<()> {
    let (tx, rx) = mpsc::channel::<Result<(), String>>();

    window
        .with_webview(move |platform| {
            let outcome = (|| -> windows_core::Result<()> {
                use webview2_com::Microsoft::Web::WebView2::Win32::{
                    ICoreWebView2, ICoreWebView2DevToolsProtocolEventReceiver,
                };

                let controller = platform.controller();
                let core: ICoreWebView2 = unsafe { controller.CoreWebView2()? };

                // Enable network events; without this nothing is reported at all.
                enable_network(&core)?;

                // One receiver per event name, then a handler on it. Both calls are
                // asynchronous COM, so each is driven to completion by pumping —
                // which is legitimate here because this closure runs on the webview
                // thread, not on a thread that is waiting for it.
                let receiver: ICoreWebView2DevToolsProtocolEventReceiver = unsafe {
                    core.GetDevToolsProtocolEventReceiver(&windows_core::HSTRING::from(
                        "Network.requestWillBeSent",
                    ))?
                };

                let buffer_for_handler = Arc::clone(&buffer);
                let handler = webview2_com::DevToolsProtocolEventReceivedEventHandler::create(
                    Box::new(move |_sender, args| {
                        // A missing args is not an error worth reporting; CDP
                        // occasionally delivers an event with no payload.
                        if let Some(args) = args {
                            let mut json = windows_core::PWSTR::null();
                            let _ = unsafe { args.ParameterObjectAsJson(&mut json) };
                            let body = unsafe { json.to_string() }.unwrap_or_default();
                            if let Some(sighting) =
                                parse_cdp_event("Network.requestWillBeSent", &body)
                            {
                                let mut guard = buffer_for_handler
                                    .lock()
                                    .unwrap_or_else(|p| p.into_inner());
                                guard.sightings.push(sighting);
                            }
                        }
                        Ok(())
                    }),
                );

                let mut token = 0i64;
                unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token)? };
                Ok(())
            })();

            match outcome {
                Ok(()) => {
                    let _ = tx.send(Ok(()));
                }
                Err(error) => {
                    let message = format!("无法连接调试协议：{error}");
                    {
                        let mut guard = buffer.lock().unwrap_or_else(|p| p.into_inner());
                        guard.error = Some(message.clone());
                    }
                    let _ = tx.send(Err(message));
                }
            }
        })
        .map_err(|error| AppError::Invalid(format!("无法挂载调试协议：{error}")))?;

    match rx.recv_timeout(ATTACH_TIMEOUT) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(message)) => Err(AppError::Invalid(message)),
        Err(_) => Err(AppError::Invalid(
            "连接调试协议超时（窗口可能没有正常创建）".to_string(),
        )),
    }
}

/// Call `Network.enable` and wait for the completion.
///
/// Must run on the webview thread. The completion handler sends through a channel
/// and the same thread pumps until it arrives — safe precisely because it is the
/// pumping thread.
/// Ask the browser to start reporting network events.
///
/// Fire-and-forget, deliberately. The completion handler exists but is not waited
/// on, because **waiting here would deadlock**: this function runs on the webview
/// thread (inside `with_webview`), the completion callback is delivered by that
/// same thread's message loop, and `recv_timeout` blocks it. The pattern `login.rs`
/// uses — start the async operation, return, let the callback fire on its own — is
/// the only sound shape. If `Network.enable` fails, no events arrive, the sniff
/// times out empty, and the caller reports "nothing found", which is honest even if
/// not maximally specific.
fn enable_network(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) -> windows_core::Result<()> {
    // The handler must outlive this call; dropping it would unregister the
    // completion. Sending into a channel nobody reads is fine — the send is
    // buffered and the receiver is dropped on purpose.
    let (tx, _rx) = mpsc::channel::<()>();
    let handler = webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
        move |_result, _body: String| {
            // Deliberately ignored: see the doc comment. The send only exists to
            // keep `tx` alive for the lifetime of the callback.
            let _ = tx.send(());
            Ok(())
        },
    ));

    unsafe {
        core.CallDevToolsProtocolMethod(
            &windows_core::HSTRING::from("Network.enable"),
            &windows_core::HSTRING::from("{}"),
            &handler,
        )
    }
}

/// Read the session cookies for the window's current URL.
///
/// Best-effort by design: a cookie read failure must not fail the sniff. The caller
/// keeps the credential it already had, and a stale cookie surfaces later as a 403
/// from the origin rather than as a phantom sniff failure with no explanation.
fn read_cookies(window: &tauri::WebviewWindow) -> Vec<CookieRecord> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2_2, ICoreWebView2CookieList,
    };
    use webview2_com::GetCookiesCompletedHandler;
    use windows_core::{Interface, HSTRING, PWSTR};

    /// Copy one cookie list into records.
    ///
    /// Each string COM returns must be freed; `CoTaskMemPWSTR` does that on drop,
    /// and converting straight out of the raw pointer would leak.
    unsafe fn collect(list: &ICoreWebView2CookieList) -> Vec<CookieRecord> {
        let mut out = Vec::new();
        let mut count = 0u32;
        if list.Count(&mut count).is_err() {
            return out;
        }
        for index in 0..count {
            // `GetValueAtIndex` returns the cookie directly rather than through an
            // out-parameter, which is why there is nothing to null-initialise here.
            let Ok(cookie) = list.GetValueAtIndex(index) else {
                continue;
            };

            let name = read_pwstr(|p| cookie.Name(p)).unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            let value = read_pwstr(|p| cookie.Value(p)).unwrap_or_default();
            let domain = read_pwstr(|p| cookie.Domain(p)).unwrap_or_default();
            let path = read_pwstr(|p| cookie.Path(p)).unwrap_or_default();
            out.push(CookieRecord {
                name,
                value,
                domain,
                path: if path.is_empty() { "/".to_string() } else { path },
            });
        }
        out
    }

    /// Run a `getter(&mut PWSTR) -> Result<()>` and copy the string out.
    unsafe fn read_pwstr(
        getter: impl FnOnce(*mut PWSTR) -> windows_core::Result<()>,
    ) -> Option<String> {
        let mut raw = PWSTR::null();
        getter(&mut raw).ok()?;
        raw.to_string().ok()
    }

    let (tx, rx) = mpsc::channel::<Vec<CookieRecord>>();

    let _ = window.with_webview(move |platform| {
        let start = (|| -> windows_core::Result<()> {
            let controller = platform.controller();
            let core: ICoreWebView2 = unsafe { controller.CoreWebView2()? };
            let core2: ICoreWebView2_2 = core.cast()?;
            let manager = unsafe { core2.CookieManager()? };

            let mut uri = PWSTR::null();
            let _ = unsafe { core.Source(&mut uri) };
            let source = unsafe { uri.to_string() }.unwrap_or_default();
            if source.is_empty() {
                return Ok(());
            }

            let sender = tx.clone();
            let handler = GetCookiesCompletedHandler::create(Box::new(
                move |_result, list: Option<ICoreWebView2CookieList>| {
                    let cookies = list.map(|list| unsafe { collect(&list) }).unwrap_or_default();
                    let _ = sender.send(cookies);
                    Ok(())
                },
            ));
            unsafe { manager.GetCookies(&HSTRING::from(source), &handler)? };
            Ok(())
        })();

        if start.is_err() {
            // An empty send unblocks the waiter; the caller treats an empty list as
            // "no cookies to write back" and keeps what it had.
            let _ = tx.send(Vec::new());
        }
    });

    rx.recv_timeout(ATTACH_TIMEOUT).unwrap_or_default()
}

/// Turn one CDP event into a sighting, when it looks like media.
///
/// Only `Network.requestWillBeSent` is used. `responseReceived` carries the content
/// type, which would be better evidence, but it arrives after the request and the
/// URL alone is enough to classify — and acting on one event kind keeps the ordering
/// meaningful for the ad heuristic.
fn parse_cdp_event(method: &str, body: &str) -> Option<MediaSighting> {
    if method != "Network.requestWillBeSent" {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let url = value.get("request")?.get("url")?.as_str()?;
    if url.is_empty() || url.starts_with("data:") {
        return None;
    }

    let initiator = value
        .get("initiator")
        .and_then(|i| i.get("url"))
        .and_then(|u| u.as_str())
        .map(str::to_string);

    let mut sighting = MediaSighting::new(url, SightingSource::Network);
    if let Some(initiator) = initiator {
        sighting = sighting.with_initiator(initiator);
    }
    Some(sighting)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_network_request_event() {
        let body = r#"{
            "request": { "url": "https://cdn.example.com/master.m3u8" },
            "initiator": { "type": "script", "url": "https://site/player.js" }
        }"#;
        let sighting = parse_cdp_event("Network.requestWillBeSent", body).expect("a sighting");
        assert_eq!(sighting.url, "https://cdn.example.com/master.m3u8");
        assert_eq!(sighting.initiator.as_deref(), Some("https://site/player.js"));
        assert_eq!(sighting.source, SightingSource::Network);
    }

    #[test]
    fn ignores_other_event_kinds() {
        // Only request events are used; response events would duplicate every
        // sighting and destroy the ordering the ad heuristic needs.
        let body = r#"{ "request": { "url": "https://cdn/x.m3u8" } }"#;
        assert!(parse_cdp_event("Network.responseReceived", body).is_none());
        assert!(parse_cdp_event("Network.loadingFinished", body).is_none());
    }

    #[test]
    fn ignores_data_urls() {
        // Inline `data:` media is not fetchable and would pollute the candidate
        // list with something the proxy cannot reach.
        let body = r#"{ "request": { "url": "data:video/mp4;base64,AAAA" } }"#;
        assert!(parse_cdp_event("Network.requestWillBeSent", body).is_none());
    }

    #[test]
    fn tolerates_a_missing_initiator() {
        let body = r#"{ "request": { "url": "https://cdn/x.m3u8" } }"#;
        let sighting = parse_cdp_event("Network.requestWillBeSent", body).expect("a sighting");
        assert!(sighting.initiator.is_none());
    }

    #[test]
    fn malformed_json_is_ignored_rather_than_panicking() {
        // A CDP payload comes from a remote page's traffic; refusing to panic on
        // garbage is not optional.
        assert!(parse_cdp_event("Network.requestWillBeSent", "{not json").is_none());
        assert!(parse_cdp_event("Network.requestWillBeSent", "").is_none());
        assert!(parse_cdp_event("Network.requestWillBeSent", "{}").is_none());
    }

    #[test]
    fn the_sniffing_window_is_never_labelled_main() {
        // The label is a security boundary: `main` is the only one the stream proxy
        // serves, and this window loads an untrusted page.
        let label = new_window_label();
        assert_ne!(label, "main");
        assert!(label.starts_with("sniff-"));
    }

    #[test]
    fn the_window_is_positioned_off_screen_rather_than_hidden() {
        // Documented invariant: a hidden window gets throttled and may never play,
        // and the failure is intermittent — the hardest kind to diagnose.
        assert!(OFFSCREEN_POSITION.0 < -10000.0 || OFFSCREEN_POSITION.1 < -10000.0);
        assert!(WINDOW_SIZE.0 > 0.0 && WINDOW_SIZE.1 > 0.0);
    }

    #[test]
    fn the_attach_timeout_is_short() {
        // A COM handshake that takes longer than this means a broken webview, not a
        // slow network; waiting the sniff timeout would only delay the error.
        assert!(ATTACH_TIMEOUT <= Duration::from_secs(10));
    }
}
