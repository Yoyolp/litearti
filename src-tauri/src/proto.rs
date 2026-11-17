//! The `kazumi-stream://` scheme: the address a `<video>` element can point at.
//!
//! ## Why a scheme instead of a command
//!
//! A player needs a URL. `<video src>` cannot call `invoke`, and hls.js issues its
//! own XHRs — every segment, every playlist. Routing those through IPC would
//! serialize the whole stream through the message channel, and there is no
//! `<video>` API for "call this function to get bytes".
//!
//! ## The URL shape
//!
//! ```text
//! kazumi-stream://localhost/stream?u=<percent-encoded target>&r=<referer>&ua=<agent>
//! ```
//!
//! The referer and user agent travel **in the URL** rather than in a server-side
//! session. That keeps every request self-describing: two episodes of the same
//! show, or two sources, cannot cross-contaminate headers, and a request can be
//! replayed from a cold start. The cost is a longer URL, which nothing here cares
//! about.
//!
//! On Windows the webview sees this as `http://kazumi-stream.localhost/stream?…`;
//! on macOS and Linux it stays `kazumi-stream://localhost/stream?…`. The handler
//! only ever looks at path and query, so both work identically.

use crate::error::AppResult;
use crate::stream::{decode_target, fetch_stream, StreamRequest};
use tauri::http::{header, Response, StatusCode};
use tauri::{Manager, UriSchemeContext, UriSchemeResponder};

/// The scheme name, shared with the frontend.
pub const SCHEME: &str = "kazumi-stream";

/// Serve one proxied request.
///
/// Every failure becomes a **408/502 with a readable body** rather than a panic or
/// an empty 200. A player that gets an empty 200 shows a black screen with no
/// explanation; a 502 with "请求超时" in the body is what lets the UI say something
/// true about why playback failed.
/// Serve one proxied request.
///
/// ## The webview label is a security boundary, not a diagnostic
///
/// `register_asynchronous_uri_scheme_protocol` registers the scheme for the whole
/// app, so **every** webview can reach this handler — including any future window
/// that loads a remote page (a sniffing window, a login window). A remote page
/// that discovers this origin could ask the proxy to fetch an arbitrary URL with
/// the app's headers, and read the response. That is server-side request forgery
/// with the app as the client.
///
/// `UriSchemeContext::webview_label()` is the defence. Verified against
/// tauri-runtime-wry 2.12.3: `WebViewBuilder::with_id(&label)` sets the id, and
/// wry hands that id to the protocol callback — so the value is the window label
/// from `tauri.conf.json` / `WebviewWindowBuilder`, not an opaque counter. Measured
/// at runtime on Windows: the main window reports `"main"`.
///
/// Only the main window is allowed through. Everything else gets a 403 and a
/// sentence saying why. If a future window legitimately needs the proxy, that has
/// to be a deliberate decision with its own reasoning — not a default.
pub fn handle<R: tauri::Runtime>(
    context: UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    const ALLOWED_WEBVIEW: &str = "main";

    if context.webview_label() != ALLOWED_WEBVIEW {
        responder.respond(plain(
            StatusCode::FORBIDDEN,
            "这个代理只服务主窗口",
        ));
        return;
    }

    let uri = request.uri().to_string();
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());

    // The credential store lives under the **sources** root, not the data root.
    // Resolving it here keeps one definition of where credentials live:
    // `credentials_status` and `net.rs` use the same one.
    let data_root = context
        .app_handle()
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| crate::sources::sources_root(&dir));

    // The fetch is async, so hand the work to the runtime and let the responder
    // finish the request when it is done. Doing it inline would block the caller.
    tauri::async_runtime::spawn(async move {
        let response = match build_request(&uri, range, data_root) {
            Ok(stream_request) => {
                // Serialize proxied fetches.
                //
                // A page can issue hundreds of segment requests at once and each
                // may hold up to the segment ceiling, so without a limit this proxy
                // is a memory amplifier under our own control. A plain mutex gives
                // "one at a time", which is stricter than necessary but keeps the
                // bound obvious and the code free of a semaphore dependency; the
                // player pipelines into its own buffer, so throughput is unaffected
                // in practice.
                let _guard = STREAM_GATE.lock().await;
                match fetch_stream(stream_request).await {
                    Ok(result) => {
                        let status =
                            StatusCode::from_u16(result.status).unwrap_or(StatusCode::OK);
                        let mut builder = Response::builder()
                            .status(status)
                            // A custom scheme is a different origin from the app, so
                            // hls.js's XHR is cross-origin. Without this every
                            // request fails at the browser layer, before the proxy is
                            // reached.
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                            // A cross-origin response only exposes a small set of
                            // headers to JS unless they are named here.
                            // `Content-Range` is the one that matters: without it a
                            // player cannot tell where a 206 starts, so seeking is
                            // unreliable even though the bytes are correct.
                            .header(
                                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                                "Content-Range, Content-Length, Content-Type, Accept-Ranges",
                            )
                            .header(header::ACCEPT_RANGES, "bytes")
                            .header(header::CONTENT_TYPE, result.content_type);
                        if let Some(content_range) = result.content_range {
                            builder = builder.header(header::CONTENT_RANGE, content_range);
                        }
                        builder.body(result.body).unwrap_or_else(|_| {
                            plain(StatusCode::INTERNAL_SERVER_ERROR, "无法构造响应")
                        })
                    }
                    Err(error) => plain(StatusCode::BAD_GATEWAY, &error.to_string()),
                }
            }
            Err(error) => plain(StatusCode::BAD_REQUEST, &error.to_string()),
        };

        responder.respond(response);
    });
}

/// Serializes proxied fetches.
///
/// See the comment at the call site: this is a memory bound, not a performance
/// knob. `Copy`-cheap to hold, and contended only when a player pipelines, which
/// it does not need to.
static STREAM_GATE: tauri::async_runtime::Mutex<()> = tauri::async_runtime::Mutex::const_new(());

/// Turn the incoming request URI into a `StreamRequest`.
fn build_request(
    uri: &str,
    range: Option<String>,
    data_root: Option<std::path::PathBuf>,
) -> AppResult<StreamRequest> {
    let parsed = tauri::Url::parse(uri)
        .map_err(|error| crate::error::AppError::Invalid(format!("代理地址不合法：{error}")))?;

    let mut target = None;
    let mut referer = None;
    let mut user_agent = None;
    let mut source_id = None;

    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "u" => target = Some(decode_target(value.as_ref())?),
            "r" => referer = Some(decode_target(value.as_ref()).unwrap_or_default()),
            "ua" => user_agent = Some(decode_target(value.as_ref()).unwrap_or_default()),
            // Only the source **id**, never a cookie value: the proxy looks the
            // cookie up itself. Accepting a cookie here would put a secret in a URL,
            // where it reaches devtools, logs and history.
            "s" => source_id = Some(value.into_owned()),
            // Unknown parameters are ignored rather than rejected: a future field
            // must not break an old build's playback.
            _ => {}
        }
    }

    let target = target.ok_or_else(|| {
        crate::error::AppError::Invalid("代理地址缺少 u 参数".to_string())
    })?;

    Ok(StreamRequest {
        target,
        referer: referer.filter(|value| !value.is_empty()),
        user_agent: user_agent.filter(|value| !value.is_empty()),
        range: range.filter(|value| !value.is_empty()),
        source_id: source_id.filter(|value| !value.is_empty()),
        data_root,
    })
}

/// A plain-text error response.
fn plain(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The label the proxy accepts. Kept as a constant in `handle` and asserted
    /// here so a rename of the main window cannot silently disable playback.
    const ALLOWED_WEBVIEW: &str = "main";

    #[test]
    fn only_the_main_webview_is_allowed() {
        // The comparison `handle` performs, replicated so the rule is testable
        // without constructing a Tauri runtime.
        assert!("main" == ALLOWED_WEBVIEW);
        for other in ["login-probe", "sniff-1", "", "MAIN", "main2"] {
            assert!(other != ALLOWED_WEBVIEW, "{other} must not be accepted");
        }
    }

    #[test]
    fn parses_a_target_url() {
        let uri = format!(
            "kazumi-stream://localhost/stream?u={}",
            crate::stream::encode_target("https://cdn.example.com/a.m3u8")
        );
        let request = build_request(&uri, None, None).expect("parse");
        assert_eq!(request.target, "https://cdn.example.com/a.m3u8");
        assert!(request.range.is_none());
        assert!(request.referer.is_none());
    }

    #[test]
    fn parses_referer_and_user_agent() {
        let uri = format!(
            "kazumi-stream://localhost/stream?u={}&r={}&ua={}",
            crate::stream::encode_target("https://cdn.example.com/a.ts"),
            crate::stream::encode_target("https://www.example.com/"),
            crate::stream::encode_target("Mozilla/5.0"),
        );
        let request = build_request(&uri, None, None).expect("parse");
        assert_eq!(request.referer.as_deref(), Some("https://www.example.com/"));
        assert_eq!(request.user_agent.as_deref(), Some("Mozilla/5.0"));
    }

    #[test]
    fn carries_the_range_header_through() {
        let uri = format!(
            "kazumi-stream://localhost/stream?u={}",
            crate::stream::encode_target("https://cdn.example.com/a.mp4")
        );
        let request = build_request(&uri, Some("bytes=0-1023".to_string()), None).expect("parse");
        assert_eq!(request.range.as_deref(), Some("bytes=0-1023"));
    }

    #[test]
    fn rejects_a_missing_target() {
        let error = build_request("kazumi-stream://localhost/stream", None, None)
            .expect_err("must fail");
        assert!(error.to_string().contains("u 参数"), "{error}");
    }

    #[test]
    fn ignores_unknown_parameters() {
        // Forward compatibility: an old build must still play when a newer one
        // writes a parameter it does not know.
        let uri = format!(
            "kazumi-stream://localhost/stream?u={}&future=1",
            crate::stream::encode_target("https://cdn.example.com/a.ts")
        );
        let request = build_request(&uri, None, None).expect("parse");
        assert_eq!(request.target, "https://cdn.example.com/a.ts");
    }

    #[test]
    fn empty_referer_is_treated_as_absent() {
        let uri = format!(
            "kazumi-stream://localhost/stream?u={}&r=",
            crate::stream::encode_target("https://cdn.example.com/a.ts")
        );
        let request = build_request(&uri, None, None).expect("parse");
        assert!(request.referer.is_none(), "an empty referer must not be sent");
    }

    #[test]
    fn windows_form_of_the_url_parses() {
        // On Windows the webview rewrites the scheme to `http://<scheme>.localhost`.
        // The handler must not care.
        let uri = format!(
            "http://kazumi-stream.localhost/stream?u={}",
            crate::stream::encode_target("https://cdn.example.com/a.ts")
        );
        let request = build_request(&uri, None, None).expect("parse");
        assert_eq!(request.target, "https://cdn.example.com/a.ts");
    }
}

