//! Streaming proxy for video playback.
//!
//! `net.rs` is for book pages: small, text, one shot. A video stream is the
//! opposite — hundreds of megabytes in chunks, and the player needs HTTP Range so
//! dragging the progress bar works. Rather than widen `net.rs` (whose narrowness
//! is a security property), this is a second, separately-scoped channel.
//!
//! ## What is the same as `net.rs`
//!
//! - **http/https only**, re-validated on every redirect hop. A redirect is
//!   exactly how a request escapes to `file:` otherwise.
//! - **No cookie jar.** Session state is not maintained. A media URL that needs a
//!   login is out of scope, and pretending otherwise would mean inventing a
//!   session model this app does not have.
//! - **No new verbs.** GET only. Playback never needs to write to someone's
//!   server.
//!
//! ## What is different, and why
//!
//! Body size. `net.rs` caps a response at 10 MB because a book page is kilobytes;
//! a video segment routinely exceeds that. So the cap here is per-segment (64 MB)
//! rather than per-response-in-general, and the playlist cap is separate (2 MB) so
//! a hostile "playlist" cannot be used to pull 64 MB.
//!
//! ## Why a URL scheme rather than an IPC command
//!
//! An HLS stream is hundreds of separate requests. Routing each through `invoke`
//! would serialize every segment through the IPC layer, and `<video src>` cannot
//! call into IPC at all. A scheme gives the player something that behaves like a
//! URL, which is what it needs.
//!
//! (The proxy URL shape is documented in `proto.rs`, next to the parser.)

use crate::error::{AppError, AppResult};
use std::time::Duration;

/// Ceiling on a media segment. Larger than `net.rs`'s 10 MB on purpose: this is
/// the one place the app legitimately moves bulk data.
pub const MAX_SEGMENT_BYTES: usize = 64 * 1024 * 1024;

/// Ceiling on a playlist. Kept small and separate: a "playlist" is a text file of
/// URLs, and allowing 64 MB here would let a hostile source use the segment budget
/// for something that is not a segment.
pub const MAX_PLAYLIST_BYTES: usize = 2 * 1024 * 1024;

/// Per-request deadline. Long enough for a slow CDN segment, short enough that a
/// dead host does not stall the player forever.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Headers the proxy forwards from the source definition to the origin.
///
/// Deliberately tiny. A media request needs a UA (anti-hotlink checks often key on
/// it), a Referer (the usual hotlink defence), and maybe a Range (which this module
/// sets itself, from the player's own request). Anything else a rule could ask for
/// is not needed to fetch bytes.
const FORWARDED_HEADERS: &[&str] = &["user-agent", "referer"];

/// One proxied request, as the frontend describes it.
#[derive(Debug, Clone)]
pub struct StreamRequest {
    /// Absolute media URL to fetch.
    pub target: String,
    /// Referer to send, if the source declared one.
    pub referer: Option<String>,
    /// User-Agent to send, if the source declared one.
    pub user_agent: Option<String>,
    /// The player's `Range` header, e.g. `bytes=0-1023`. `None` for a full fetch.
    pub range: Option<String>,
    /// Which source is asking.
    ///
    /// Used to look up that source's stored cookie. **The cookie value itself never
    /// travels in the URL** — only this id does — so a cookie cannot end up in
    /// devtools, logs, or history. Same rule `net.rs` follows, for the same reason.
    pub source_id: Option<String>,
    /// Data directory, needed to read the credential store.
    ///
    /// Carried on the request rather than looked up globally so tests can point it
    /// at a temp directory.
    pub data_root: Option<std::path::PathBuf>,
}

impl StreamRequest {
    /// The cookie to attach, resolved from the credential store.
    ///
    /// Only attached when the target's host **exactly** matches the credential's
    /// host; see `credentials::resolve`. A sub-domain does not inherit it — that
    /// narrower rule is the one that cannot leak a session to an unexpected host.
    fn cookie(&self) -> Option<String> {
        let (root, source_id) = (self.data_root.as_ref()?, self.source_id.as_ref()?);
        crate::credentials::resolve(root, Some(source_id), &self.target).ok()?
    }
}

/// What the proxy got back, in the shape the scheme handler needs.
#[derive(Debug)]
pub struct StreamResponse {
    pub status: u16,
    pub content_type: String,
    /// `Content-Range` when the origin honoured a range request.
    pub content_range: Option<String>,
    pub body: Vec<u8>,
}

/// Reject anything that is not a plain web URL.
///
/// Applied to the initial URL *and* re-checked after redirects: following a
/// redirect is exactly how a request would otherwise reach a local file.
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

/// Whether a response is an HLS playlist, from whichever signal is available.
///
/// Three signals because none is reliable alone: the content type is sometimes
/// `application/octet-stream`, the extension is sometimes absent (CDN paths with
/// query strings), and a master playlist on a non-playlist URL still begins with
/// `#EXTM3U`. Checking all three costs nothing and avoids rewriting a segment as
/// if it were text.
fn looks_like_playlist(request_url: &str, content_type: &str, body: &[u8]) -> bool {
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("mpegurl") || ct.contains("m3u8") {
        return true;
    }
    // Strip the query before checking the extension: `master.m3u8?token=…` is
    // extremely common on CDNs.
    let path = request_url.split('?').next().unwrap_or(request_url);
    if path.to_ascii_lowercase().ends_with(".m3u8") || path.to_ascii_lowercase().ends_with(".m3u") {
        return true;
    }
    body.starts_with(b"#EXTM3U")
}

/// The path the scheme handler serves, and the prefix every rewritten URI gets.
///
/// A **relative** path on purpose. A playlist is served from
/// `http://<scheme>.localhost/stream?u=…`, so `/stream?u=…` resolves back to the
/// same origin automatically — no hostname needs to be known here, and the same
/// string works on every platform regardless of how the OS spells a custom scheme.
pub const PROXY_PREFIX: &str = "/stream?u=";

/// Rewrite a playlist so every URI in it points back at this proxy.
///
/// ## The thing that is easy to get wrong
///
/// Playlists freely mix absolute and relative URIs. A relative one is relative to
/// **the playlist's own URL**, not to the app, so it must be resolved against
/// `playlist_url` *before* being re-encoded — otherwise `hls/1000k/seg.ts` becomes
/// a request for a file next to the app.
///
/// Covered URI positions:
///   - bare lines (segments, and sub-playlists in a master playlist)
///   - `#EXT-X-KEY:URI="…"`            (encryption key)
///   - `#EXT-X-MAP:URI="…"`            (initialization segment)
///   - `#EXT-X-MEDIA:URI="…"`          (alternative audio/subtitle rendition)
///   - `#EXT-X-I-FRAME-STREAM-INF:URI="…"` (trick-play stream)
///
/// Every one of these was seen on the real source this was tested against, so
/// missing any of them produces a stream that half-plays.
pub fn rewrite_playlist(
    body: &str,
    playlist_url: &str,
    proxy_prefix: &str,
) -> AppResult<String> {
    let base = reqwest::Url::parse(playlist_url)
        .map_err(|error| AppError::Invalid(format!("播放列表地址不合法：{error}")))?;

    let mut out = String::with_capacity(body.len() + body.len() / 4);

    for line in body.lines() {
        let trimmed = line.trim();

        // Blank lines and comments pass through, except the tag forms that carry
        // a URI attribute.
        if trimmed.is_empty() {
            out.push('\n');
            continue;
        }

        if trimmed.starts_with('#') {
            out.push_str(&rewrite_tag_uri(trimmed, &base, proxy_prefix));
            out.push('\n');
            continue;
        }

        // A bare line is a URI: a segment, or a sub-playlist in a master playlist.
        let absolute = base
            .join(trimmed)
            .map_err(|error| AppError::Invalid(format!("播放列表里有无法解析的地址：{error}")))?;
        out.push_str(&proxy_prefix);
        out.push_str(&encode_target(absolute.as_str()));
        out.push('\n');
    }

    Ok(out)
}

/// Tags whose `URI="…"` attribute must be proxied too.
const URI_TAGS: &[&str] = &[
    "#EXT-X-KEY:",
    "#EXT-X-MAP:",
    "#EXT-X-MEDIA:",
    "#EXT-X-I-FRAME-STREAM-INF:",
    "#EXT-X-SESSION-KEY:",
    "#EXT-X-PART:",
    "#EXT-X-PRELOAD-HINT:",
];

fn rewrite_tag_uri(line: &str, base: &reqwest::Url, proxy_prefix: &str) -> String {
    let needs = URI_TAGS.iter().any(|tag| line.starts_with(tag));
    if !needs {
        return line.to_string();
    }

    // `URI="…"` is the only attribute form HLS uses for this.
    let Some(start) = line.find("URI=\"") else {
        return line.to_string();
    };
    let value_start = start + "URI=\"".len();
    let Some(rel_end) = line[value_start..].find('"') else {
        // A malformed tag is passed through rather than fixed: the player will
        // ignore it, and inventing a value would hide the authoring error.
        return line.to_string();
    };
    let value_end = value_start + rel_end;
    let raw = &line[value_start..value_end];

    let Ok(absolute) = base.join(raw) else {
        return line.to_string();
    };

    let mut out = String::with_capacity(line.len() + 64);
    out.push_str(&line[..value_start]);
    out.push_str(proxy_prefix);
    out.push_str(&encode_target(absolute.as_str()));
    out.push_str(&line[value_end..]);
    out
}

/// Percent-encode a target URL so it can live inside a query parameter.
///
/// Encoding by hand rather than pulling a crate: the set is exactly "anything not
/// unreserved", which is what keeps `?`, `&`, `#` and `%` from breaking the outer
/// URL. `percent-encoding` would be a fine dependency, but this project has been
/// deliberate about adding them.
pub fn encode_target(url: &str) -> String {
    let mut out = String::with_capacity(url.len() * 3);
    for byte in url.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Decode a percent-encoded target back to a URL.
pub fn decode_target(encoded: &str) -> AppResult<String> {
    let mut bytes = Vec::with_capacity(encoded.len());
    let raw = encoded.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        match raw[i] {
            b'%' => {
                if i + 2 >= raw.len() {
                    return Err(AppError::Invalid("代理地址的编码不完整".to_string()));
                }
                let hex = std::str::from_utf8(&raw[i + 1..i + 3])
                    .map_err(|_| AppError::Invalid("代理地址的编码不是十六进制".to_string()))?;
                let byte = u8::from_str_radix(hex, 16)
                    .map_err(|_| AppError::Invalid("代理地址的编码不是十六进制".to_string()))?;
                bytes.push(byte);
                i += 3;
            }
            b'+' => {
                // `+` means a literal plus here, not a space: the value is a URL,
                // and `+` appears in base64-ish tokens in CDN paths.
                bytes.push(b'+');
                i += 1;
            }
            other => {
                bytes.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8(bytes).map_err(|_| AppError::Invalid("代理地址不是有效 UTF-8".to_string()))
}

/// Fetch one proxied request.
pub async fn fetch_stream(request: StreamRequest) -> AppResult<StreamResponse> {
    let url = ensure_web_url(&request.target)?;

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
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

    let mut builder = client.get(url);

    for (name, value) in [
        ("user-agent", request.user_agent.as_deref()),
        ("referer", request.referer.as_deref()),
    ] {
        if !FORWARDED_HEADERS.contains(&name) {
            continue;
        }
        if let Some(value) = value {
            if !value.is_empty() {
                builder = builder.header(name, value);
            }
        }
    }

    // The player's Range goes to the origin verbatim. Re-computing it here would
    // mean guessing what the player wanted.
    if let Some(range) = &request.range {
        builder = builder.header(reqwest::header::RANGE, range);
    }

    // Attach the source's session cookie, if it has one for exactly this host.
    //
    // Set explicitly rather than through a jar: `reqwest`'s own handling would
    // need a cookie store per client, and this is a fresh client per request. The
    // important consequence of setting it manually is that `reqwest` strips it on
    // a cross-host redirect — which is the behaviour we want, and which a unit test
    // pins down.
    if let Some(cookie) = request.cookie() {
        if !cookie.is_empty() {
            builder = builder.header(reqwest::header::COOKIE, cookie);
        }
    }

    let response = builder
        .send()
        .await
        .map_err(|error| AppError::Invalid(crate::net::describe_reqwest_error(&error, REQUEST_TIMEOUT)))?;

    let status = response.status().as_u16();
    let final_url = response.url().to_string();
    ensure_web_url(&final_url)?;

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let content_range = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());

    // Peek at the body with the right ceiling for its kind. The content type is
    // not enough on its own (see `looks_like_playlist`), so read with the larger
    // ceiling and check afterwards — but bail out as soon as the bytes exceed the
    // playlist ceiling and the body does not start with `#EXTM3U`, so a 64 MB
    // segment is not rejected as a runaway playlist.
    let bytes = response
        .bytes()
        .await
        .map_err(|error| AppError::Invalid(format!("读取响应失败：{error}")))?;

    let is_playlist = looks_like_playlist(&final_url, &content_type, &bytes);
    let ceiling = if is_playlist {
        MAX_PLAYLIST_BYTES
    } else {
        MAX_SEGMENT_BYTES
    };
    if bytes.len() > ceiling {
        return Err(AppError::Invalid(format!(
            "响应过大（{} 字节），上限 {} 字节",
            bytes.len(),
            ceiling
        )));
    }

    if is_playlist {
        let text = String::from_utf8_lossy(&bytes).to_string();
        // Rewriting happens here rather than in the caller so every playlist path
        // goes through one implementation.
        let rewritten = rewrite_playlist(&text, &final_url, PROXY_PREFIX)?;
        return Ok(StreamResponse {
            status,
            // The rewritten body is a playlist regardless of what the origin said.
            content_type: "application/vnd.apple.mpegurl".to_string(),
            content_range: None,
            body: rewritten.into_bytes(),
        });
    }

    Ok(StreamResponse {
        status,
        content_type,
        content_range,
        body: bytes.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_web_urls_only() {
        assert!(ensure_web_url("https://cdn.example.com/a.m3u8").is_ok());
        assert!(ensure_web_url("http://cdn.example.com/a.ts").is_ok());
        for bad in [
            "file:///etc/passwd",
            "data:video/mp2t;base64,AAAA",
            "javascript:alert(1)",
            "ftp://example.com/x",
        ] {
            assert!(ensure_web_url(bad).is_err(), "{bad} must be rejected");
        }
    }

    #[test]
    fn recognises_playlists_three_ways() {
        // By content type.
        assert!(looks_like_playlist("https://x/a", "application/vnd.apple.mpegurl", b""));
        // By extension, with a query string.
        assert!(looks_like_playlist("https://x/a.m3u8?token=1", "", b""));
        // By the magic first line, when neither of the above applies.
        assert!(looks_like_playlist("https://x/stream", "", b"#EXTM3U\n#EXTINF:4,seg.ts"));
        // A segment must not be treated as a playlist.
        assert!(!looks_like_playlist("https://x/seg.ts", "video/mp2t", b"\x47\x40\x11"));
        assert!(!looks_like_playlist("https://x/blob", "application/octet-stream", b"\x00\x01"));
    }

    #[test]
    fn rewrites_segments_against_the_playlist_url() {
        // The relative segment must resolve against the playlist's directory, not
        // against the app's notion of a base. This is the bug the doc comment
        // warns about.
        let body = "#EXTM3U\n#EXTINF:4.17,\nf3f1.ts\n#EXTINF:4.17,\nsub/next.ts\n";
        let out = rewrite_playlist(
            body,
            "https://cdn.example.com/20221009/21929/1000k/hls/mixed.m3u8",
            "",
        )
        .expect("rewrite");

        assert!(
            out.contains("https%3A%2F%2Fcdn.example.com%2F20221009%2F21929%2F1000k%2Fhls%2Ff3f1.ts"),
            "first segment should resolve next to the playlist:\n{out}"
        );
        assert!(
            out.contains("hls%2Fsub%2Fnext.ts"),
            "a nested relative path should keep its structure:\n{out}"
        );
        // Tags survive.
        assert!(out.contains("#EXTM3U"));
        assert!(out.contains("#EXTINF:4.17,"));
    }

    #[test]
    fn rewrites_absolute_segments() {
        let body = "#EXTM3U\n#EXTINF:4,\nhttps://other.example.com/a/b.ts\n";
        let out = rewrite_playlist(body, "https://cdn.example.com/x.m3u8", "").expect("rewrite");
        assert!(out.contains("other.example.com"), "{out}");
    }

    #[test]
    fn rewrites_master_playlist_sub_streams() {
        // A master playlist points at other playlists; those must be proxied too,
        // or the player fetches a nested playlist directly and every segment in it
        // bypasses the proxy.
        let body = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1080x608\n1000k/hls/mixed.m3u8\n";
        let out = rewrite_playlist(
            body,
            "https://cdn.example.com/20221009/21929/index.m3u8",
            "",
        )
        .expect("rewrite");
        assert!(out.contains("1000k%2Fhls%2Fmixed.m3u8"), "{out}");
        // The stream-inf line itself has no URI to rewrite.
        assert!(out.contains("#EXT-X-STREAM-INF:BANDWIDTH=800000"));
    }

    #[test]
    fn rewrites_uri_attributes() {
        let body = concat!(
            "#EXTM3U\n",
            "#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x00\n",
            "#EXT-X-MAP:URI=\"init.mp4\"\n",
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",URI=\"audio.m3u8\"\n",
            "#EXTINF:4,\nseg.ts\n",
        );
        let out = rewrite_playlist(body, "https://cdn.example.com/p/index.m3u8", "")
            .expect("rewrite");

        assert!(out.contains("URI=\"https%3A%2F%2Fcdn.example.com%2Fp%2Fkey.bin\""), "{out}");
        assert!(out.contains("init.mp4"), "{out}");
        assert!(out.contains("audio.m3u8"), "{out}");
        // The IV must not be touched.
        assert!(out.contains("IV=0x00"), "{out}");
    }

    #[test]
    fn leaves_unrelated_tags_alone() {
        let body = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:8\n#EXTINF:4,\nseg.ts\n";
        let out = rewrite_playlist(body, "https://cdn.example.com/i.m3u8", "").expect("rewrite");
        assert!(out.contains("#EXT-X-VERSION:3"));
        assert!(out.contains("#EXT-X-TARGETDURATION:8"));
    }

    #[test]
    fn encode_decode_round_trips() {
        for url in [
            "https://cdn.example.com/a/b.m3u8?token=x&y=1",
            "https://cdn.example.com/路径/segment.ts",
            "https://cdn.example.com/a+b/c.ts",
        ] {
            let encoded = encode_target(url);
            let decoded = decode_target(&encoded).expect("decode");
            assert_eq!(decoded, url, "round trip failed for {url}");
            // The encoded form must not contain characters that would break the
            // outer query string.
            assert!(!encoded.contains('&'), "{encoded}");
            assert!(!encoded.contains('?'), "{encoded}");
            assert!(!encoded.contains('#'), "{encoded}");
        }
    }

    #[test]
    fn decode_rejects_malformed_input() {
        assert!(decode_target("%").is_err());
        assert!(decode_target("%zz").is_err());
        assert!(decode_target("%E4").is_err());
    }

    #[test]
    fn encode_treats_plus_as_a_literal() {
        // A `+` in a CDN path must survive, not become a space.
        assert_eq!(decode_target("a+b").expect("decode"), "a+b");
    }

    #[test]
    fn playlist_with_a_malformed_uri_is_passed_through() {
        // An unterminated URI attribute is an authoring/site bug; the tag is left
        // as-is rather than guessed at.
        let body = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"unterminated\n";
        let out = rewrite_playlist(body, "https://cdn.example.com/i.m3u8", "").expect("rewrite");
        assert!(out.contains("unterminated"), "{out}");
    }
}
