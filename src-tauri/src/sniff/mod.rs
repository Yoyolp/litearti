//! Media sniffing: finding out what a page actually plays.
//!
//! ## Why this exists
//!
//! Many real sources do not put a playable URL in their HTML. The address is
//! produced by their own JavaScript, sometimes behind a third-party player or an
//! obfuscated iframe, and only exists as a network request after the page runs. The
//! declarative `playback.kind` strategies (`direct`, `page`, `regex`, `api`) cover
//! the sites that expose it; this module covers the ones that do not.
//!
//! ## The shape
//!
//! The work splits in two, and the split is the design:
//!
//! - [`pick`] — pure judgement: given what was seen, which URL should play? No
//!   browser, no async, fully unit-tested.
//! - the collector — platform-specific: open a window, watch the network, report
//!   sightings. Only Windows is implemented; see [`windows`].
//!
//! Keeping the judgement out of the collector is what stops each platform from
//! reimplementing "is this an m3u8" slightly differently.
//!
//! ## Scope
//!
//! Windows only, deliberately. Android would work (its `shouldInterceptRequest`
//! sees more than CDP does), but the app is not yet a mobile app — see
//! `docs/sniffing.md`. On any other platform the collector reports that sniffing is
//! unavailable rather than failing obscurely.

pub mod pick;

#[cfg(all(target_os = "windows", not(test)))]
pub mod windows;

/// Tauri commands. Compiled everywhere so the frontend can call
/// `sniff_supported` on a platform without a sniffer and learn why.
pub mod commands;

use crate::error::{AppError, AppResult};
use pick::{MediaSighting, PickOutcome};
use std::time::Duration;

/// How long to watch a page before giving up.
///
/// Long enough for a slow player to start, short enough that a person waiting on a
/// click does not give up first. Chosen to collect *everything* rather than stop at
/// the first hit — a pre-roll ad is usually the first HLS request on a page, so
/// stopping early reliably picks the ad.
pub const SNIFF_TIMEOUT: Duration = Duration::from_secs(12);

/// What the caller asks for.
#[derive(Debug, Clone)]
pub struct SniffRequest {
    /// The episode page to open.
    pub page_url: String,
    /// The source id, used to look up the cookie this session should carry.
    pub source_id: String,
    /// Referer to send, when the source declares one.
    pub referer: Option<String>,
    /// User-Agent to send, when the source declares one.
    pub user_agent: Option<String>,
    /// How long to watch. Defaults to [`SNIFF_TIMEOUT`].
    pub timeout: Duration,
}

impl SniffRequest {
    pub fn new(page_url: impl Into<String>, source_id: impl Into<String>) -> Self {
        SniffRequest {
            page_url: page_url.into(),
            source_id: source_id.into(),
            referer: None,
            user_agent: None,
            timeout: SNIFF_TIMEOUT,
        }
    }
}

/// What the collector reports back.
#[derive(Debug, Clone)]
pub struct SniffOutcome {
    /// Everything that looked like media, in the order it was seen.
    pub sightings: Vec<MediaSighting>,
    /// Cookies the session ended up with.
    ///
    /// Not a diagnostic: sites routinely rotate the session when a page loads
    /// (renewing a session cookie, issuing an anti-bot clearance token). If the
    /// proxy then uses a stale cookie the media request 403s and the error reads
    /// as "URL expired", which sends a person to the wrong place. The caller writes
    /// these back so the proxy and the browser agree.
    pub cookies: Vec<CookieRecord>,
}

/// One cookie from the sniffing session.
#[derive(Debug, Clone)]
pub struct CookieRecord {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
}

/// Watch a page and report what media it requests.
///
/// One implementation per platform. The trait exists so the engine can call it
/// without knowing whether it is talking to CDP, `shouldInterceptRequest`, or a
/// test double.
///
/// Written with an explicit boxed future rather than `async_trait`: this project has
/// been deliberate about adding crates (five Rust dependencies, all load-bearing),
/// and one method with no generic parameters does not earn a proc-macro dependency.
pub trait MediaSniffer: Send + Sync {
    fn sniff<'a>(
        &'a self,
        request: SniffRequest,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<SniffOutcome>> + Send + 'a>>;
}

/// The sniffer for this build, or `None` when the platform has none.
///
/// Returning `Option` rather than a stub that fails makes the unsupported case a
/// fact the caller has to handle, instead of an error they discover at runtime.
pub fn platform_sniffer() -> Option<Box<dyn MediaSniffer>> {
    #[cfg(all(target_os = "windows", not(test)))]
    {
        Some(Box::new(windows::CdpSniffer::new()))
    }
    #[cfg(not(all(target_os = "windows", not(test))))]
    {
        None
    }
}

/// The message shown when the platform cannot sniff.
pub const UNSUPPORTED_MESSAGE: &str =
    "这个平台还不支持嗅探播放。可以在浏览器里打开这个源观看。";

/// Turn an outcome into the player-facing answer, with the message the UI shows.
///
/// Kept here rather than in the UI so the wording and the three-way distinction
/// live next to the logic that produces it.
pub fn describe_outcome(outcome: &SniffOutcome) -> PickOutcome {
    // Bodies are not fetched by the collector: that is the proxy's job, and
    // fetching here would double every request. Without bodies the DRM check falls
    // back to "no evidence of DRM", and the player reports the real problem when a
    // key request fails.
    pick::pick_media(&outcome.sightings, &std::collections::HashMap::new())
}

/// Failure to sniff, in the words the UI uses.
pub fn describe_error(error: &AppError) -> String {
    match error {
        AppError::Invalid(message) => message.clone(),
        other => format!("嗅探失败：{other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pick::{MediaKind, SightingSource};

    #[test]
    fn a_request_carries_a_sane_default_timeout() {
        let request = SniffRequest::new("https://x/play/1", "src");
        // Long enough for a player to start; short enough that a waiting person
        // does not give up first.
        assert!(request.timeout >= Duration::from_secs(8));
        assert!(request.timeout <= Duration::from_secs(20));
    }

    #[test]
    fn describe_outcome_maps_a_hit_to_found() {
        let outcome = SniffOutcome {
            sightings: vec![MediaSighting::new(
                "https://cdn/x.m3u8",
                SightingSource::Network,
            )],
            cookies: Vec::new(),
        };
        match describe_outcome(&outcome) {
            PickOutcome::Found { kind, .. } => assert_eq!(kind, MediaKind::Hls),
            other => panic!("expected Found, got {other:?}"),
        }
    }

    #[test]
    fn describe_outcome_maps_an_empty_session_to_not_found() {
        let outcome = SniffOutcome {
            sightings: Vec::new(),
            cookies: Vec::new(),
        };
        assert_eq!(describe_outcome(&outcome), PickOutcome::NotFound);
    }

    #[test]
    fn the_unsupported_message_says_what_to_do_instead() {
        // "Not supported" alone leaves a person stuck; naming the fallback is the
        // difference between a dead end and a workaround.
        assert!(UNSUPPORTED_MESSAGE.contains("浏览器"));
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn no_sniffer_on_other_platforms() {
        assert!(platform_sniffer().is_none());
    }
}
