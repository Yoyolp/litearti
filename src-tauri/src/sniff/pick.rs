//! Picking a playable media URL out of what a page did.
//!
//! This module is deliberately **pure and platform-free**: it takes a list of what
//! was observed and returns which one to play. The collection side (a webview,
//! CDP, whatever the platform offers) lives elsewhere. The split matters because
//! the judgement is where the bugs are — "which of these 200 requests is the
//! video" — and keeping it free of a browser makes it testable with plain data.
//!
//! ## The three-way answer
//!
//! The most important thing this module does is **distinguish "found something
//! unplayable" from "found nothing"**:
//!
//! - `NotFound` — the page never produced a media request. Usually means the site
//!   needs a click to start playing, or the sniffing window was throttled.
//! - `Unplayable` — a request exists but cannot become a URL we can hand to a
//!   player. `blob:` means MediaSource; a DRM key means we are locked out.
//!
//! Collapsing those two into one message would tell a person "no address found"
//! when the truth is "this site uses DRM, no address will ever be found". The
//! difference changes what they do next.

use std::time::Instant;

/// Where a URL was noticed.
///
/// Ordered by trustworthiness: an actual network request is stronger evidence than
/// a DOM attribute, which may be set before anything is fetched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SightingSource {
    /// A DOM attribute (`<video src>`, `<source src>`). Weakest: the page may set
    /// it to something that never loads.
    DomAttribute,
    /// `performance.getEntriesByType('resource')`. Retrospective; catches requests
    /// that happened before instrumentation was ready.
    PerformanceEntry,
    /// An actual network request observed by the platform. Strongest.
    Network,
}

/// What kind of media a URL looks like.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    /// An HLS playlist (`.m3u8` / `.m3u`).
    Hls,
    /// A progressive file (`.mp4`, `.m4v`, `.webm`).
    Mp4,
    /// MPEG-DASH manifest. Not supported by the player, but worth naming so the
    /// message can be specific instead of "unknown".
    Dash,
    /// A `blob:` URL: the page is using MediaSource, and the real address is in an
    /// XHR we may or may not have seen.
    Blob,
    Unknown,
}

/// One observed URL.
#[derive(Debug, Clone)]
pub struct MediaSighting {
    pub url: String,
    pub source: SightingSource,
    /// What initiated the request, when the platform reports it. Used only as a
    /// tiebreak; see [`pick_media`].
    pub initiator: Option<String>,
    pub at: Instant,
}

impl MediaSighting {
    pub fn new(url: impl Into<String>, source: SightingSource) -> Self {
        MediaSighting {
            url: url.into(),
            source,
            initiator: None,
            at: Instant::now(),
        }
    }

    pub fn with_initiator(mut self, initiator: impl Into<String>) -> Self {
        self.initiator = Some(initiator.into());
        self
    }

    /// Classify the URL by its path, ignoring the query string.
    pub fn kind(&self) -> MediaKind {
        classify(&self.url)
    }
}

/// Why a URL that was found still cannot be played.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnplayableReason {
    /// MediaSource. The address is `blob:` and there is no fetchable stream.
    Blob,
    /// An HLS key that requires a license exchange (Widevine and friends).
    Drm,
}

impl UnplayableReason {
    /// A message for the person watching.
    pub fn message(self) -> &'static str {
        match self {
            UnplayableReason::Blob => "这个源用了 MSE 播放，拿不到可直接播放的地址。",
            UnplayableReason::Drm => "这个源用了数字版权保护（DRM），无法在应用内播放。",
        }
    }
}

/// The result of looking at a batch of sightings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PickOutcome {
    /// A URL worth trying.
    Found {
        url: String,
        kind: MediaKind,
        /// True when this is a master playlist (offers variant streams).
        master: bool,
    },
    /// Addresses exist but none can be played.
    Unplayable(UnplayableReason),
    /// Nothing that looks like media was seen.
    NotFound,
}

/// Classify a URL by extension, ignoring query and fragment.
///
/// Extension-based rather than content-based on purpose: this runs against URLs
/// before anything is fetched, and a `.m3u8` path is reliable in practice. A CDN
/// that serves playlists from extension-less paths is handled by a later content
/// check inside the proxy, not here.
pub fn classify(url: &str) -> MediaKind {
    if url.starts_with("blob:") {
        return MediaKind::Blob;
    }
    // Strip query and fragment before looking at the extension.
    let path = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .to_ascii_lowercase();
    if path.ends_with(".m3u8") || path.ends_with(".m3u") {
        return MediaKind::Hls;
    }
    if path.ends_with(".mp4") || path.ends_with(".m4v") || path.ends_with(".webm") {
        return MediaKind::Mp4;
    }
    if path.ends_with(".mpd") {
        return MediaKind::Dash;
    }
    MediaKind::Unknown
}

/// Whether a sighting is even a candidate.
///
/// `.ts` segments and `.key` files are *results* of playing, not entry points;
/// treating them as candidates would mean handing the player a fragment and
/// getting a two-second clip.
fn is_candidate(sighting: &MediaSighting) -> bool {
    matches!(
        sighting.kind(),
        MediaKind::Hls | MediaKind::Mp4 | MediaKind::Dash | MediaKind::Blob
    )
}

/// Score a candidate. Higher wins.
///
/// The weights encode a simple set of beliefs, each learned from a real site:
///
/// - **A network observation beats a DOM attribute.** A `<video src>` can be set
///   to a URL that is never fetched; a request means the page meant it.
/// - **HLS beats MP4** for an anime site: they almost all stream HLS, and an MP4
///   on the page is usually a trailer.
/// - **A `blob:` is last among candidates**: it cannot be played, but its presence
///   is still useful evidence (it proves the page is playing *something*).
/// - **An initiator mentioning the player or the main frame** is a hint that this
///   is the real stream rather than an ad. Weak — kept because it costs nothing.
/// - **Earlier is slightly better**: a pre-roll ad fires *before* the feature, so
///   this one points the wrong way. It is included because there is no better
///   signal available and the alternative (ignoring time) is strictly worse.
fn score(sighting: &MediaSighting) -> i32 {
    let mut value = match sighting.source {
        SightingSource::Network => 30,
        SightingSource::PerformanceEntry => 20,
        SightingSource::DomAttribute => 5,
    };

    value += match sighting.kind() {
        MediaKind::Hls => 40,
        MediaKind::Mp4 => 15,
        MediaKind::Dash => 5,
        MediaKind::Blob => 0,
        MediaKind::Unknown => 0,
    };

    if let Some(initiator) = &sighting.initiator {
        let lower = initiator.to_ascii_lowercase();
        // The page itself, or a player library, is a much better sign than an ad
        // SDK. Both are common in `initiator` values across engines.
        if lower.contains("hls") || lower.contains("player") || lower.contains("media") {
            value += 10;
        }
        if lower.contains("ad") || lower.contains("analytics") || lower.contains("track") {
            value -= 20;
        }
    }

    value
}

/// Choose the media URL to play.
///
/// `playlist_bodies` supplies the text of any playlists already fetched, keyed by
/// URL. It is optional because fetching is the caller's job; when a body is
/// present, a `#EXT-X-STREAM-INF` line marks the URL as a **master** playlist,
/// which is worth preferring (variant streams, so quality selection works).
pub fn pick_media(
    sightings: &[MediaSighting],
    playlist_bodies: &std::collections::HashMap<String, String>,
) -> PickOutcome {
    let candidates: Vec<&MediaSighting> = sightings.iter().filter(|s| is_candidate(s)).collect();

    if candidates.is_empty() {
        return PickOutcome::NotFound;
    }

    // A DRM key is decisive: if any playlist declares one, no amount of retrying
    // will help, and saying so is more useful than picking a URL that 404s on the
    // key request later.
    for candidate in &candidates {
        if let Some(body) = playlist_bodies.get(&candidate.url) {
            if declares_drm(body) {
                return PickOutcome::Unplayable(UnplayableReason::Drm);
            }
        }
    }

    let mut ranked: Vec<&MediaSighting> = candidates
        .iter()
        .copied()
        .filter(|s| s.kind() != MediaKind::Blob)
        .collect();

    // Only blob sightings: the page plays through MediaSource and we never saw the
    // XHR that feeds it. That is `Unplayable`, not `NotFound` — the distinction the
    // module exists to preserve.
    if ranked.is_empty() {
        return PickOutcome::Unplayable(UnplayableReason::Blob);
    }

    ranked.sort_by(|a, b| {
        score(b)
            .cmp(&score(a))
            // Ties: prefer the more trustworthy source, then the earlier sighting.
            .then_with(|| a.source.cmp(&b.source).reverse())
            .then_with(|| a.at.cmp(&b.at))
    });

    // Prefer a master playlist when several HLS candidates exist.
    if let Some(master) = ranked.iter().find(|s| {
        s.kind() == MediaKind::Hls
            && playlist_bodies
                .get(&s.url)
                .is_some_and(|body| is_master_playlist(body))
    }) {
        return PickOutcome::Found {
            url: master.url.clone(),
            kind: MediaKind::Hls,
            master: true,
        };
    }

    let best = ranked[0];
    PickOutcome::Found {
        url: best.url.clone(),
        kind: best.kind(),
        master: playlist_bodies
            .get(&best.url)
            .is_some_and(|body| is_master_playlist(body)),
    }
}

/// Whether a playlist body offers variant streams.
///
/// `#EXT-X-STREAM-INF` appears only in master playlists. Detecting it lets the
/// player keep quality selection instead of being handed one fixed rendition.
pub fn is_master_playlist(body: &str) -> bool {
    body.lines()
        .any(|line| line.trim_start().starts_with("#EXT-X-STREAM-INF"))
}

/// Whether a playlist requires a DRM license.
///
/// Two signals: `KEYFORMAT` values that name a DRM system, and a `#EXT-X-SESSION-KEY`
/// with a non-identity key format. A plain `METHOD=AES-128` is **not** DRM — that is
/// ordinary HLS encryption, which hls.js handles, so treating it as DRM would
/// wrongly reject a perfectly playable stream.
pub fn declares_drm(body: &str) -> bool {
    const DRM_MARKERS: &[&str] = &[
        "urn:uuid:edef8ba9", // Widevine
        "urn:uuid:9a04f079", // PlayReady
        "urn:uuid:1077efec", // FairPlay
        "com.apple.streamingkeydelivery",
        "com.widevine",
        "com.microsoft.playready",
    ];

    for line in body.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("#EXT-X-KEY") && !trimmed.starts_with("#EXT-X-SESSION-KEY") {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        // A bare AES-128 key has `METHOD=AES-128` and no `KEYFORMAT`, which is
        // ordinary encryption, not DRM.
        if DRM_MARKERS.iter().any(|marker| lower.contains(marker)) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn no_bodies() -> HashMap<String, String> {
        HashMap::new()
    }

    #[test]
    fn classifies_by_extension_ignoring_the_query() {
        assert_eq!(classify("https://cdn/x/master.m3u8"), MediaKind::Hls);
        assert_eq!(classify("https://cdn/x/master.m3u8?token=1&x=2"), MediaKind::Hls);
        assert_eq!(classify("https://cdn/x/a.M3U8"), MediaKind::Hls);
        assert_eq!(classify("https://cdn/x/a.mp4"), MediaKind::Mp4);
        assert_eq!(classify("https://cdn/x/a.mpd"), MediaKind::Dash);
        assert_eq!(classify("blob:https://site/1234"), MediaKind::Blob);
        assert_eq!(classify("https://cdn/x/a.ts"), MediaKind::Unknown);
    }

    #[test]
    fn a_segment_is_not_a_candidate() {
        // Handing a `.ts` to the player yields a two-second clip, which looks like
        // a broken stream. Segments are results, not entry points.
        let sightings = vec![MediaSighting::new(
            "https://cdn/x/seg1.ts",
            SightingSource::Network,
        )];
        assert_eq!(pick_media(&sightings, &no_bodies()), PickOutcome::NotFound);
    }

    #[test]
    fn picks_hls_over_mp4() {
        let sightings = vec![
            MediaSighting::new("https://cdn/trailer.mp4", SightingSource::Network),
            MediaSighting::new("https://cdn/stream.m3u8", SightingSource::Network),
        ];
        match pick_media(&sightings, &no_bodies()) {
            PickOutcome::Found { url, kind, .. } => {
                assert_eq!(url, "https://cdn/stream.m3u8");
                assert_eq!(kind, MediaKind::Hls);
            }
            other => panic!("expected Hls, got {other:?}"),
        }
    }

    #[test]
    fn prefers_a_network_sighting_over_a_dom_attribute() {
        // The same URL twice is not the point; the point is that a DOM-only
        // candidate loses to a fetched one of the same kind.
        let sightings = vec![
            MediaSighting::new("https://cdn/a.m3u8", SightingSource::DomAttribute),
            MediaSighting::new("https://cdn/b.m3u8", SightingSource::Network),
        ];
        match pick_media(&sightings, &no_bodies()) {
            PickOutcome::Found { url, .. } => assert_eq!(url, "https://cdn/b.m3u8"),
            other => panic!("expected a pick, got {other:?}"),
        }
    }

    #[test]
    fn a_blob_only_page_is_unplayable_not_notfound() {
        // This is the whole reason the three-way outcome exists: the page clearly
        // plays video, but no fetchable stream was seen.
        let sightings = vec![MediaSighting::new(
            "blob:https://site/abcd-1234",
            SightingSource::DomAttribute,
        )];
        assert_eq!(
            pick_media(&sightings, &no_bodies()),
            PickOutcome::Unplayable(UnplayableReason::Blob)
        );
    }

    #[test]
    fn an_empty_page_is_notfound() {
        assert_eq!(pick_media(&[], &no_bodies()), PickOutcome::NotFound);
    }

    #[test]
    fn a_blob_does_not_beat_a_real_stream() {
        let sightings = vec![
            MediaSighting::new("blob:https://site/x", SightingSource::DomAttribute),
            MediaSighting::new("https://cdn/real.m3u8", SightingSource::Network),
        ];
        match pick_media(&sightings, &no_bodies()) {
            PickOutcome::Found { url, .. } => assert_eq!(url, "https://cdn/real.m3u8"),
            other => panic!("expected the real stream, got {other:?}"),
        }
    }

    #[test]
    fn a_master_playlist_is_preferred_and_flagged() {
        let mut bodies = HashMap::new();
        bodies.insert(
            "https://cdn/rendition.m3u8".to_string(),
            "#EXTM3U\n#EXTINF:4,\nseg.ts\n".to_string(),
        );
        bodies.insert(
            "https://cdn/master.m3u8".to_string(),
            "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n".to_string(),
        );
        let sightings = vec![
            MediaSighting::new("https://cdn/rendition.m3u8", SightingSource::Network),
            MediaSighting::new("https://cdn/master.m3u8", SightingSource::Network),
        ];
        match pick_media(&sightings, &bodies) {
            PickOutcome::Found { url, master, .. } => {
                assert_eq!(url, "https://cdn/master.m3u8");
                assert!(master, "a STREAM-INF playlist must be flagged as master");
            }
            other => panic!("expected the master, got {other:?}"),
        }
    }

    #[test]
    fn a_single_rendition_is_not_marked_master() {
        let mut bodies = HashMap::new();
        bodies.insert(
            "https://cdn/r.m3u8".to_string(),
            "#EXTM3U\n#EXTINF:4,\nseg.ts\n".to_string(),
        );
        let sightings = vec![MediaSighting::new("https://cdn/r.m3u8", SightingSource::Network)];
        match pick_media(&sightings, &bodies) {
            PickOutcome::Found { master, .. } => assert!(!master),
            other => panic!("expected a pick, got {other:?}"),
        }
    }

    #[test]
    fn drm_is_detected_and_reported() {
        let mut bodies = HashMap::new();
        bodies.insert(
            "https://cdn/drm.m3u8".to_string(),
            "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://x\",KEYFORMAT=\"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed\"\n#EXTINF:4,\nseg.ts\n"
                .to_string(),
        );
        let sightings = vec![MediaSighting::new("https://cdn/drm.m3u8", SightingSource::Network)];
        assert_eq!(
            pick_media(&sightings, &bodies),
            PickOutcome::Unplayable(UnplayableReason::Drm)
        );
    }

    #[test]
    fn plain_aes_is_not_drm() {
        // Ordinary HLS encryption is handled by hls.js. Calling it DRM would
        // reject a stream that plays perfectly well.
        let body = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\nseg.ts\n";
        assert!(!declares_drm(body));
    }

    #[test]
    fn fairplay_is_drm() {
        let body = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://k\",KEYFORMAT=\"com.apple.streamingkeydelivery\"\n";
        assert!(declares_drm(body));
    }

    #[test]
    fn an_ad_initiator_is_penalised() {
        let sightings = vec![
            MediaSighting::new("https://ads/x.m3u8", SightingSource::Network)
                .with_initiator("https://ads.example/tracker.js"),
            MediaSighting::new("https://cdn/x.m3u8", SightingSource::Network)
                .with_initiator("https://site/player.js"),
        ];
        match pick_media(&sightings, &no_bodies()) {
            PickOutcome::Found { url, .. } => assert_eq!(url, "https://cdn/x.m3u8"),
            other => panic!("expected the non-ad candidate, got {other:?}"),
        }
    }

    #[test]
    fn dash_is_reported_but_not_preferred_over_hls() {
        let sightings = vec![
            MediaSighting::new("https://cdn/a.mpd", SightingSource::Network),
            MediaSighting::new("https://cdn/b.m3u8", SightingSource::Network),
        ];
        match pick_media(&sightings, &no_bodies()) {
            PickOutcome::Found { kind, .. } => assert_eq!(kind, MediaKind::Hls),
            other => panic!("expected Hls, got {other:?}"),
        }
    }

    #[test]
    fn unplayable_reasons_have_distinct_messages() {
        // The messages must not be interchangeable: one says "we can't get an
        // address", the other says "this is protected". Different advice follows.
        assert_ne!(
            UnplayableReason::Blob.message(),
            UnplayableReason::Drm.message()
        );
    }
}
