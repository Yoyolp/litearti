//! HTTP access for sources.
//!
//! This module talks to the network on behalf of a source the person added, and it
//! exists because a source needs it: a browser `fetch` from the webview would be
//! blocked by CORS for essentially every site worth scraping.
//!
//! **It is not the only module that reaches the network.** [`crate::bangumi`]
//! fetches public metadata for the discover screen. The two are separate because
//! their contracts differ: this one is shaped by scraping (10 MB cap, filtered
//! headers, no cookie jar), while Bangumi's is a documented public API with its own
//! rate limit and cache. What they share is the rule that matters — the frontend
//! never calls `fetch` against either; both go through Rust.
//!
//! The command is deliberately narrow rather than a general proxy:
//!
//! - **Only GET and POST.** A source has no business issuing PUT or DELETE
//!   against someone else's server.
//! - **Only http/https.** Redirects to `file:`, `data:` or a custom scheme are
//!   rejected, so a hostile source cannot turn the fetcher into a local file
//!   reader.
//! - **Bounded.** A hard timeout and a response-size cap, both enforced here
//!   rather than trusted from the caller.
//! - **No cookie jar.** Session state is not maintained here. A login cookie is
//!   resolved separately (see [`crate::credentials`]) and attached by the caller
//!   for one host only; `Set-Cookie` is never harvested. Pretending to run a
//!   cookie jar would imply a session model this app does not have.
//!
//! Response headers are filtered to a small allowlist. Returning everything
//! would leak `Set-Cookie` and other transport detail into the frontend for no
//! benefit.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Hard ceiling on a response body. A book page or chapter is kilobytes; a
/// 10 MB cap catches the case where a source points at a binary by mistake
/// without letting the app balloon.
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;

/// Ceiling on the caller-requested timeout, regardless of what the source says.
const MAX_TIMEOUT_MS: u64 = 60_000;

/// Headers a book source may set. Everything else is dropped.
const ALLOWED_REQUEST_HEADERS: &[&str] = &[
    "user-agent",
    "accept",
    "accept-language",
    "referer",
    "content-type",
];

/// Response headers worth passing through.
const ALLOWED_RESPONSE_HEADERS: &[&str] = &["content-type", "content-length", "location"];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRequest {
    pub url: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// Which book source is asking. Used to look up that source's login cookie;
    /// absent means an anonymous request.
    #[serde(default)]
    pub source_id: Option<String>,
}

fn default_method() -> String {
    "GET".to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceResponse {
    pub status: u16,
    /// Final URL after redirects; a source may need it to resolve relative links.
    pub url: String,
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
}

/// Reject anything that is not a plain web URL.
///
/// Applied to the initial URL *and* checked again after redirects, because
/// following a redirect is exactly how a request would otherwise escape to a
/// local file.
fn ensure_web_url(raw: &str) -> AppResult<reqwest::Url> {
    let url = reqwest::Url::parse(raw)
        .map_err(|error| AppError::Invalid(format!("URL 不合法：{error}")))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        other => Err(AppError::Invalid(format!(
            "只支持 http/https，实际是 {other}"
        ))),
    }
}

/// Turn a `reqwest` failure into a sentence that names the likely cause.
///
/// `reqwest`'s own `Display` for a transport error is the unhelpful
/// "error sending request for url (…)" — the actual reason lives in the source
/// chain, and the frontend cannot walk that chain over IPC. Without this, a
/// timeout, a DNS failure and a refused connection all look identical in the UI,
/// which sends people to edit the rule instead of checking the network.
///
/// `pub(crate)` because the stream proxy reports failures the same way: a media
/// request that times out should say "超时", not "请求失败".
pub(crate) fn describe_reqwest_error(error: &reqwest::Error, timeout: Duration) -> String {
    if error.is_timeout() {
        return format!("请求超时（{} 秒）", timeout.as_secs_f32().round() as u64);
    }
    if error.is_connect() {
        return format!("无法连接到网站：{error}");
    }
    if error.is_redirect() {
        return format!("重定向失败：{error}");
    }
    // Fall back to the full chain rather than the outer message: `{error}` alone
    // drops the cause, and the cause is the only part a person can act on.
    let mut detail = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        detail.push_str("：");
        detail.push_str(&cause.to_string());
        source = cause.source();
    }
    format!("请求失败：{detail}")
}

/// Fetch one URL for a book source.
///
/// `cookie` is resolved by the caller from the credential store and is attached
/// only after the header allowlist, so a book source can never supply a `Cookie`
/// header through its own `request.headers` map — that would let a shared source
/// file carry someone's session.
///
/// Cross-host redirects are safe: `reqwest` strips `Cookie`, `Authorization` and
/// friends when the host, port or scheme changes, so a redirect cannot carry a
/// session to a third party. If the redirect policy is ever loosened, that
/// guarantee moves into this function and must be re-implemented.
pub async fn fetch(request: SourceRequest, cookie: Option<&str>) -> AppResult<SourceResponse> {
    let url = ensure_web_url(&request.url)?;

    let method = request.method.to_uppercase();
    if method != "GET" && method != "POST" {
        return Err(AppError::Invalid(format!(
            "只支持 GET / POST，实际是 {method}"
        )));
    }

    let timeout = Duration::from_millis(
        request
            .timeout_ms
            .unwrap_or(15_000)
            .clamp(1_000, MAX_TIMEOUT_MS),
    );

    let client = reqwest::Client::builder()
        .timeout(timeout)
        // Redirects are followed, but each hop is re-validated by the policy
        // below; reqwest's own limit also caps the chain.
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("重定向次数过多");
            }
            match attempt.url().scheme() {
                "http" | "https" => attempt.follow(),
                _ => attempt.error("重定向到非 http(s) 地址，已拒绝"),
            }
        }))
        .build()
        .map_err(|error| AppError::Invalid(format!("无法创建 HTTP 客户端：{error}")))?;

    let mut builder = if method == "POST" {
        let body = request.body.clone().unwrap_or_default();
        client.post(url).body(body)
    } else {
        client.get(url)
    };

    for (name, value) in &request.headers {
        // Case-insensitive allowlist: sources are written by hand and the
        // capitalisation of a header name is not meaningful.
        if ALLOWED_REQUEST_HEADERS.contains(&name.to_lowercase().as_str()) {
            builder = builder.header(name, value);
        }
    }

    // After the loop, never before: a source-provided `Cookie` header is dropped
    // by the allowlist above, and only the credential store can set this.
    if let Some(cookie) = cookie {
        if !cookie.is_empty() {
            builder = builder.header(reqwest::header::COOKIE, cookie);
        }
    }

    let response = builder
        .send()
        .await
        .map_err(|error| AppError::Invalid(describe_reqwest_error(&error, timeout)))?;

    let status = response.status().as_u16();
    let final_url = response.url().to_string();

    // Re-check after redirects. The policy above already rejects non-web
    // schemes, but a final URL that is somehow not http(s) must not be used as
    // a base for relative links.
    ensure_web_url(&final_url)?;

    let mut headers = std::collections::HashMap::new();
    for (name, value) in response.headers() {
        let key = name.as_str().to_lowercase();
        if ALLOWED_RESPONSE_HEADERS.contains(&key.as_str()) {
            if let Ok(text) = value.to_str() {
                headers.insert(key, text.to_string());
            }
        }
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|error| AppError::Invalid(format!("读取响应失败：{error}")))?;

    if bytes.len() > MAX_BODY_BYTES {
        return Err(AppError::Invalid(format!(
            "响应过大（{} 字节），上限 {} 字节",
            bytes.len(),
            MAX_BODY_BYTES
        )));
    }

    // Book sites are overwhelmingly UTF-8, and the pages that are not are still
    // readable through the app's own text decoding later. Lossy here beats
    // failing the whole request over one bad byte.
    let body = String::from_utf8_lossy(&bytes).to_string();

    Ok(SourceResponse {
        status,
        url: final_url,
        headers,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https() {
        assert!(ensure_web_url("https://example.com/a").is_ok());
        assert!(ensure_web_url("http://example.com").is_ok());
    }

    #[test]
    fn rejects_other_schemes() {
        for url in [
            "file:///etc/passwd",
            "data:text/html,<script>",
            "ftp://example.com/x",
            "javascript:alert(1)",
        ] {
            assert!(ensure_web_url(url).is_err(), "{url} should be rejected");
        }
    }

    #[test]
    fn rejects_malformed_url() {
        assert!(ensure_web_url("not a url").is_err());
        assert!(ensure_web_url("").is_err());
    }

    #[tokio::test]
    async fn rejects_non_get_post_methods() {
        let request = SourceRequest {
            url: "https://example.com".into(),
            method: "DELETE".into(),
            body: None,
            headers: Default::default(),
            timeout_ms: None,
            source_id: None,
        };
        let error = fetch(request, None).await.expect_err("DELETE must be rejected");
        assert!(error.to_string().contains("GET"), "{error}");
    }

    #[tokio::test]
    async fn rejects_non_web_url_before_connecting() {
        let request = SourceRequest {
            url: "file:///etc/passwd".into(),
            method: "GET".into(),
            body: None,
            headers: Default::default(),
            timeout_ms: None,
            source_id: None,
        };
        let error = fetch(request, None).await.expect_err("file: must be rejected");
        assert!(error.to_string().contains("http"), "{error}");
    }

    #[test]
    fn sources_cannot_set_a_cookie_header() {
        // The credential store is the only path to a `Cookie` header. If this
        // ever fails, a shared source file could carry someone's session.
        assert!(!ALLOWED_REQUEST_HEADERS.contains(&"cookie"));
    }

    #[test]
    fn timeout_is_named_in_the_error() {
        // Drive a real reqwest timeout against a socket that accepts but never
        // answers, so the assertion is about the actual error classification
        // rather than a string literal.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            // Accept and hold: the connection succeeds, the response never comes.
            for stream in listener.incoming() {
                if stream.is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_secs(5));
            }
        });

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let error = runtime.block_on(async {
            reqwest::Client::builder()
                .timeout(Duration::from_millis(200))
                .build()
                .expect("client")
                .get(format!("http://127.0.0.1:{port}/"))
                .send()
                .await
                .expect_err("must time out")
        });

        let text = describe_reqwest_error(&error, Duration::from_secs(15));
        assert!(text.contains("超时"), "expected a timeout message, got: {text}");
        assert!(text.contains("秒"), "expected the deadline, got: {text}");
    }

    #[test]
    fn allowlist_is_case_insensitive_by_lowering() {
        // `fetch` lowers the name before checking, so a source writing `Cookie`
        // must hit the same rejection as one writing `cookie`.
        assert!(!ALLOWED_REQUEST_HEADERS.contains(&"Cookie".to_lowercase().as_str()));
    }
}
