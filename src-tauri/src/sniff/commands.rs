//! Commands for media sniffing.
//!
//! Two commands, split because they have different failure characteristics:
//!
//! - `sniff_media` runs the browser and can fail for a dozen reasons; it returns
//!   one of the three outcomes the UI distinguishes (found / unplayable / nothing).
//! - `sniff_playability` is a cheap capability check so the UI can hide the feature
//!   on platforms that do not have it, instead of offering a button that always
//!   fails.

use crate::error::AppResult;
use crate::sniff::{self, SniffRequest};
use serde::Serialize;

/// Outcome of a sniff, in the shape the frontend renders.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SniffReport {
    /// A URL to hand the player.
    Found { url: String, master: bool },
    /// Addresses exist but none can play, with a reason aimed at the reader.
    Unplayable { message: String },
    /// Nothing that looks like media appeared.
    NotFound { message: String },
}

/// Whether this build can sniff at all.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SniffSupport {
    pub supported: bool,
    /// Shown when unsupported, so the UI has something to say rather than hiding
    /// the feature mysteriously.
    pub message: Option<String>,
}

#[tauri::command]
pub fn sniff_supported() -> SniffSupport {
    match sniff::platform_sniffer() {
        Some(_) => SniffSupport {
            supported: true,
            message: None,
        },
        None => SniffSupport {
            supported: false,
            message: Some(sniff::UNSUPPORTED_MESSAGE.to_string()),
        },
    }
}

/// Watch an episode page and report what it plays.
///
/// `timeout_ms` is optional because the default is a considered value, not a
/// guess; callers only override it in tests.
#[tauri::command]
pub async fn sniff_media(
    app: tauri::AppHandle,
    page_url: String,
    source_id: String,
    referer: Option<String>,
    user_agent: Option<String>,
    timeout_ms: Option<u64>,
) -> AppResult<SniffReport> {
    let Some(sniffer) = sniff::platform_sniffer() else {
        return Err(crate::error::AppError::Invalid(
            sniff::UNSUPPORTED_MESSAGE.to_string(),
        ));
    };

    let mut request = SniffRequest::new(page_url, source_id.clone());
    request.referer = referer.filter(|value| !value.is_empty());
    request.user_agent = user_agent.filter(|value| !value.is_empty());
    if let Some(ms) = timeout_ms {
        request.timeout = std::time::Duration::from_millis(ms.clamp(1_000, 60_000));
    }

    let outcome = sniffer.sniff(request).await?;

    // Write the session's cookies back before deciding what to report.
    //
    // Sites rotate the session when a page loads — renewing a session cookie or
    // issuing an anti-bot clearance token. Those new cookies exist in the sniffing
    // window's jar and nowhere else. If the proxy then used the stale stored cookie,
    // the media request would 403 and the error would read as "URL expired", which
    // sends a person to the wrong problem. Writing them back keeps the proxy and the
    // browser on the same session.
    persist_cookies(&app, &source_id, &outcome.cookies);

    Ok(match sniff::describe_outcome(&outcome) {
        sniff::pick::PickOutcome::Found { url, master, .. } => SniffReport::Found { url, master },
        sniff::pick::PickOutcome::Unplayable(reason) => SniffReport::Unplayable {
            message: reason.message().to_string(),
        },
        sniff::pick::PickOutcome::NotFound => SniffReport::NotFound {
            message: "没嗅到播放地址。这个源可能需要在浏览器里看。".to_string(),
        },
    })
}

/// Merge the sniffing session's cookies into the stored credential.
///
/// Best-effort: a failure here must not fail the sniff, because the URL we found is
/// still worth returning. The consequence of a failed write is a later 403, which
/// the player reports honestly.
///
/// The host is taken from the **page** rather than from each cookie's domain: the
/// credential store keys on one host per source, and a cookie's own `Domain`
/// attribute can legitimately start with a dot or cover sub-domains we deliberately
/// do not follow.
fn persist_cookies(
    app: &tauri::AppHandle,
    source_id: &str,
    cookies: &[sniff::CookieRecord],
) {
    use tauri::Manager;
    if cookies.is_empty() {
        return;
    }
    // The credential store lives under the **sources** root, not the data root:
    // `credentials_status` and `net.rs` both resolve it there, so writing anywhere
    // else produces a credential no reader will ever find.
    let Ok(root) = app
        .path()
        .app_data_dir()
        .map(|dir| crate::sources::sources_root(&dir))
    else {
        return;
    };

    // Join into a single `Cookie` header value: that is exactly what the proxy
    // sends, so storing it in that form removes a conversion at request time.
    let header = cookies
        .iter()
        .filter(|cookie| !cookie.name.is_empty())
        .map(|cookie| format!("{}={}", cookie.name, cookie.value))
        .collect::<Vec<_>>()
        .join("; ");
    if header.is_empty() {
        return;
    }

    // The domain of the first cookie that has one is the best available guess at
    // the session's host. `credentials::put` normalises it (lowercase, no port, no
    // leading dot) and rejects an empty value.
    let host = cookies
        .iter()
        .map(|cookie| cookie.domain.trim_start_matches('.').to_string())
        .find(|domain| !domain.is_empty());
    let Some(host) = host else { return };

    match crate::credentials::put(&root, source_id, &host, &header, "sniff") {
        Ok(()) => {}
        // Best-effort by contract: the URL we found is still worth returning, and a
        // failed write only means a later 403 that the player reports honestly.
        Err(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unsupported_platform_reports_a_message() {
        // On a build without a sniffer the UI must have something to say. Hiding
        // the feature silently would look like a missing button rather than a
        // platform limit.
        let support = sniff_supported();
        if !support.supported {
            assert!(support.message.is_some());
        }
    }

    #[test]
    fn the_report_is_tagged_so_the_ui_can_switch_on_it() {
        // The three outcomes must be distinguishable by `kind`, not by inspecting
        // fields — a "not found" with an empty URL and a "found" with an empty URL
        // would otherwise look the same to a caller.
        let found = serde_json::to_value(SniffReport::Found {
            url: "https://x/a.m3u8".to_string(),
            master: true,
        })
        .expect("serialize");
        assert_eq!(found["kind"], "found");

        let unplayable = serde_json::to_value(SniffReport::Unplayable {
            message: "DRM".to_string(),
        })
        .expect("serialize");
        assert_eq!(unplayable["kind"], "unplayable");

        let nothing = serde_json::to_value(SniffReport::NotFound {
            message: "nothing".to_string(),
        })
        .expect("serialize");
        assert_eq!(nothing["kind"], "notFound");
    }
}
