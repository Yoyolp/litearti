//! Bangumi metadata: season calendars and trending subjects.
//!
//! ## Why this is a separate module from `net.rs`
//!
//! `net.rs` exists for one purpose — fetching pages on behalf of a source the person
//! added. Its rules are shaped by that: 10 MB cap, response headers filtered to an
//! allowlist, no cookie jar. None of those fit a public metadata API, and mixing the
//! two would make `net.rs`'s narrow contract harder to state.
//!
//! What they share is the important part: **this is still the Rust side of the
//! network**. The frontend never calls `fetch` against Bangumi directly, so the
//! "network only through Rust" rule survives intact.
//!
//! ## The mirror
//!
//! Bangumi's own hosts (`api.bgm.tv`, `next.bgm.tv`) are not reachable from every
//! network, and were not reachable from where this was written. `api.kazumi.fyi`
//! proxies two endpoints — the season calendar and the popular list — and was
//! verified to work. That is why this module speaks the mirror's shapes and not the
//! upstream ones; see `docs/bangumi.md`.
//!
//! The mirror does **not** proxy subject details or keyword search. That is a real
//! limitation, not an oversight: it means the app shows what the list response
//! carries (summary, rating, tags, cover) and nothing else.
//!
//! ## Rate limiting and caching
//!
//! Bangumi's public terms ask for one request per second. The mirror is someone
//! else's server and deserves at least that much courtesy; being a good citizen here
//! is also what keeps the mirror available. A single global gate enforces it.
//!
//! Caching is on disk because the values are stable on human timescales: a season
//! calendar does not change inside six hours, and the trending list is a
//! recommendation, not a ticker. Caching is what makes the rate limit compatible with
//! a UI that switches tabs.

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The mirror that actually serves the endpoints this app needs.
const MIRROR: &str = "https://api.kazumi.fyi";

/// Season calendar: every show airing in a date range, grouped by weekday.
const CALENDAR_PATH: &str = "/kazumi/v1/calendar/season";

/// Trending subjects: what people are watching now.
const POPULAR_PATH: &str = "/kazumi/v1/popular/subjects";

/// Identifies this app to the mirror's operator.
///
/// Not optional and not a browser UA: if this ever shows up in someone's logs, they
/// should be able to tell what it is and where it came from.
const USER_AGENT: &str = concat!("litearti/", env!("CARGO_PKG_VERSION"));

/// Minimum gap between requests, per Bangumi's published guidance.
const MIN_INTERVAL: Duration = Duration::from_secs(1);

/// One request's timeout. The calendar payload is a few hundred kilobytes.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);

/// Ceiling on a response body. The real calendar is under 300 KB; this leaves room
/// for a bigger season without allowing an unbounded read.
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// How long a cached calendar stays usable.
const CALENDAR_TTL: Duration = Duration::from_secs(6 * 60 * 60);

/// How long a cached popular page stays usable.
const POPULAR_TTL: Duration = Duration::from_secs(60 * 60);

/// Where cached responses live, relative to the data directory.
const CACHE_FILE: &str = "bangumi-cache.json";

/// The gate that enforces one request per second across all callers.
static REQUEST_GATE: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// A cached response.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry {
    /// Unix milliseconds when this was stored.
    stored_at: u64,
    /// The raw JSON body, kept as text so a parser change does not need a re-fetch.
    body: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Cache {
    #[serde(default)]
    entries: std::collections::BTreeMap<String, CacheEntry>,
}

fn cache_file(root: &Path) -> PathBuf {
    root.join(CACHE_FILE)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_cache(root: &Path) -> Cache {
    // A corrupt cache is not an error: it is a cache. Starting empty costs one
    // request, and failing here would break a screen for no reason.
    let Ok(raw) = crate::sources::read_json(&cache_file(root), "{}") else {
        return Cache::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn save_cache(root: &Path, cache: &Cache) {
    // Best-effort: a failed cache write must not fail the request that succeeded.
    if let Ok(json) = serde_json::to_string(cache) {
        let _ = crate::sources::write_json(&cache_file(root), &json);
    }
}

/// A cached body that is still inside its time-to-live.
fn read_fresh(root: &Path, key: &str, ttl: Duration) -> Option<String> {
    let cache = load_cache(root);
    let entry = cache.entries.get(key)?;
    let age = now_millis().saturating_sub(entry.stored_at);
    if age <= ttl.as_millis() as u64 {
        Some(entry.body.clone())
    } else {
        None
    }
}

/// A cached body regardless of age, for use when a live request fails.
fn read_stale(root: &Path, key: &str) -> Option<String> {
    load_cache(root).entries.get(key).map(|entry| entry.body.clone())
}

fn write_cache(root: &Path, key: &str, body: &str) {
    let mut cache = load_cache(root);
    cache.entries.insert(
        key.to_string(),
        CacheEntry {
            stored_at: now_millis(),
            body: body.to_string(),
        },
    );
    save_cache(root, &cache);
}

/// Wait until at least [`MIN_INTERVAL`] has passed since the previous request.
///
/// A blocking sleep under a lock rather than an async delay: the lock is held across
/// the wait on purpose, so two concurrent callers cannot both decide they are under
/// the limit and then both send.
fn wait_for_slot() {
    let mut guard = REQUEST_GATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(last) = *guard {
        let elapsed = last.elapsed();
        if elapsed < MIN_INTERVAL {
            std::thread::sleep(MIN_INTERVAL - elapsed);
        }
    }
    *guard = Some(std::time::Instant::now());
}

/// Fetch a URL through the mirror, honouring the cache and the rate limit.
///
/// `cache_key` identifies the logical request (not the URL, so a query string that
/// changes order does not create a second entry).
async fn fetch_mirror(
    root: &Path,
    url: &str,
    cache_key: &str,
    ttl: Duration,
) -> AppResult<String> {
    if let Some(body) = read_fresh(root, cache_key, ttl) {
        return Ok(body);
    }

    // The gate is blocking, so it runs off the async worker.
    tauri::async_runtime::spawn_blocking(wait_for_slot)
        .await
        .map_err(|_| AppError::Invalid("请求排队失败".to_string()))?;

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| AppError::Invalid(format!("无法创建 HTTP 客户端：{error}")))?;

    let response = match client.get(url).send().await {
        Ok(response) => response,
        Err(error) => {
            // A stale response beats an error screen: the calendar from this morning
            // is more useful than nothing, and the person can tell it is old.
            if let Some(body) = read_stale(root, cache_key) {
                return Ok(body);
            }
            return Err(AppError::Invalid(crate::net::describe_reqwest_error(
                &error,
                REQUEST_TIMEOUT,
            )));
        }
    };

    let status = response.status();
    if !status.is_success() {
        if let Some(body) = read_stale(root, cache_key) {
            return Ok(body);
        }
        return Err(AppError::Invalid(format!(
            "Bangumi 镜像返回 {}",
            status.as_u16()
        )));
    }

    let body = response
        .text()
        .await
        .map_err(|error| AppError::Invalid(format!("读取响应失败：{error}")))?;

    if body.len() > MAX_BODY_BYTES {
        return Err(AppError::Invalid(format!(
            "响应过大（{} 字节），上限 {}",
            body.len(),
            MAX_BODY_BYTES
        )));
    }

    // An empty body is a failure, not an empty list: caching it would hide the
    // problem for the whole TTL.
    if body.trim().is_empty() {
        if let Some(stale) = read_stale(root, cache_key) {
            return Ok(stale);
        }
        return Err(AppError::Invalid("Bangumi 镜像返回了空响应".to_string()));
    }

    write_cache(root, cache_key, &body);
    Ok(body)
}

/// Fetch the weekly calendar for a season.
///
/// `start` and `end` are ISO dates (`YYYY-MM-DD`). The mirror groups the result by
/// weekday in the same shape Bangumi uses.
pub async fn season_calendar(root: &Path, start: &str, end: &str) -> AppResult<String> {
    if !is_iso_date(start) || !is_iso_date(end) {
        return Err(AppError::Invalid(format!(
            "日期格式应为 YYYY-MM-DD，实际是 {start} / {end}"
        )));
    }
    let url = format!("{MIRROR}{CALENDAR_PATH}?start={start}&end={end}");
    // The cache key carries the range, because a different season is a different
    // answer.
    let key = format!("calendar:{start}:{end}");
    fetch_mirror(root, &url, &key, CALENDAR_TTL).await
}

/// Fetch one page of trending subjects.
pub async fn popular(root: &Path, limit: u32, offset: u32) -> AppResult<String> {
    // Clamped rather than trusted: the caller is the frontend, and an unbounded limit
    // is a way to make the mirror send a very large response.
    let limit = limit.clamp(1, 50);
    let url = format!("{MIRROR}{POPULAR_PATH}?limit={limit}&offset={offset}");
    let key = format!("popular:{limit}:{offset}");
    fetch_mirror(root, &url, &key, POPULAR_TTL).await
}

/// Whether a string looks like `YYYY-MM-DD`.
///
/// Deliberately shallow: the server validates properly, and this only exists to stop
/// a malformed value becoming a malformed URL.
fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

/// The date a season starts and ends, for a given year and quarter.
///
/// Anime seasons are quarters: winter (Jan), spring (Apr), summer (Jul), autumn (Oct).
/// Returns `(start, end)` as ISO dates, where `end` is the last day of the season.
pub fn season_range(year: i32, quarter: u8) -> (String, String) {
    let (start_month, end_month, end_day) = match quarter {
        1 => (1, 3, 31),
        2 => (4, 6, 30),
        3 => (7, 9, 30),
        _ => (10, 12, 31),
    };
    (
        format!("{year}-{start_month:02}-01"),
        format!("{year}-{end_month:02}-{end_day:02}"),
    )
}

/// Clear the cache. Used by the settings page's cleanup.
pub fn clear_cache(root: &Path) -> AppResult<()> {
    let path = cache_file(root);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|error| AppError::Invalid(format!("无法删除缓存：{error}")))?;
    }
    Ok(())
}

// --- Cover cache -----------------------------------------------------------

/// Directory holding cached cover images, under the sources root.
const COVER_DIR: &str = "bangumi-covers";

/// Record of URLs that failed to download.
const COVER_FAILURES: &str = "bangumi-cover-failures.json";

/// How long a failed cover stays failed before it is retried.
///
/// Covers come from `api.bgm.tv`, which is unreachable from some networks. Without
/// this, every render of a 24-card grid fires 24 requests that each hang until the
/// timeout — the grid looks fine but the app spends a minute doing nothing useful.
/// An hour is short enough that fixing the network takes effect on the next launch,
/// and long enough that browsing does not re-attempt constantly.
const COVER_FAILURE_TTL: Duration = Duration::from_secs(60 * 60);

/// Ceiling for one cover. Real covers are 30–200 KB.
const MAX_COVER_BYTES: usize = 3 * 1024 * 1024;

/// Timeout for one cover download. Shorter than a metadata fetch: a cover is small
/// and the UI has a fallback, so waiting long for it is pure loss.
const COVER_TIMEOUT: Duration = Duration::from_secs(10);

/// Stable 64-bit FNV-1a hash, used to name cache files.
///
/// A hash rather than a sanitised URL: URLs contain characters no filesystem wants,
/// and can exceed the path length limit. Collisions are theoretically possible but
/// this is a cache of cover art — a collision would show the wrong thumbnail, and
/// writing a full digest would need a crate for no real benefit.
fn fnv1a(input: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn cover_dir(root: &Path) -> PathBuf {
    root.join(COVER_DIR)
}

/// Pick a file extension from a content type.
fn extension_for(content_type: &str) -> &'static str {
    let value = content_type.to_ascii_lowercase();
    if value.contains("png") {
        "png"
    } else if value.contains("webp") {
        "webp"
    } else if value.contains("gif") {
        "gif"
    } else if value.contains("avif") {
        "avif"
    } else {
        // JPEG is Bangumi's default and the safe assumption for an unlabelled image.
        "jpg"
    }
}

/// Read the negative cache, dropping entries older than the TTL.
fn load_failures(root: &Path) -> std::collections::BTreeMap<String, u64> {
    let Ok(raw) = crate::sources::read_json(&cover_dir(root).join(COVER_FAILURES), "{}") else {
        return Default::default();
    };
    let parsed: std::collections::BTreeMap<String, u64> =
        serde_json::from_str(&raw).unwrap_or_default();
    let now = now_millis();
    parsed
        .into_iter()
        .filter(|(_, at)| now.saturating_sub(*at) <= COVER_FAILURE_TTL.as_millis() as u64)
        .collect()
}

fn save_failures(root: &Path, failures: &std::collections::BTreeMap<String, u64>) {
    if let Ok(json) = serde_json::to_string(failures) {
        let _ = crate::sources::write_json(&cover_dir(root).join(COVER_FAILURES), &json);
    }
}

/// Get a local path for a cover, downloading it the first time.
///
/// Returns `Ok(None)` when the image cannot be fetched — that is **not an error**.
/// The UI has a typographic fallback, and a missing thumbnail is a cosmetic problem;
/// surfacing it as an error would put a banner over a working screen.
///
/// Failures are remembered for [`COVER_FAILURE_TTL`] so a grid of cards does not
/// re-attempt every unreachable URL on every render.
pub async fn cover(root: &Path, url: &str) -> AppResult<Option<String>> {
    // Only http(s). A cover URL comes from a remote API, so it is not trusted; a
    // `file:` URL here would turn this into a local file reader.
    let parsed = reqwest::Url::parse(url)
        .map_err(|error| AppError::Invalid(format!("封面地址不合法：{error}")))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::Invalid(format!(
            "封面只支持 http/https，实际是 {}",
            parsed.scheme()
        )));
    }

    let dir = cover_dir(root);
    let stem = format!("{:016x}", fnv1a(url));

    // A hit is a file that already exists under any supported extension.
    for extension in ["jpg", "png", "webp", "gif", "avif"] {
        let candidate = dir.join(format!("{stem}.{extension}"));
        if candidate.is_file() {
            return Ok(Some(candidate.to_string_lossy().to_string()));
        }
    }

    // Recently failed: do not retry yet.
    if load_failures(root).contains_key(url) {
        return Ok(None);
    }

    let client = match reqwest::Client::builder()
        .timeout(COVER_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
    {
        Ok(client) => client,
        Err(_) => return Ok(None),
    };

    let response = match client.get(parsed).send().await {
        Ok(response) => response,
        Err(_) => {
            let mut failures = load_failures(root);
            failures.insert(url.to_string(), now_millis());
            save_failures(root, &failures);
            return Ok(None);
        }
    };

    if !response.status().is_success() {
        let mut failures = load_failures(root);
        failures.insert(url.to_string(), now_millis());
        save_failures(root, &failures);
        return Ok(None);
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();

    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };

    if bytes.is_empty() || bytes.len() > MAX_COVER_BYTES {
        let mut failures = load_failures(root);
        failures.insert(url.to_string(), now_millis());
        save_failures(root, &failures);
        return Ok(None);
    }

    if let Err(error) = std::fs::create_dir_all(&dir) {
        return Err(AppError::Invalid(format!("无法创建封面目录：{error}")));
    }

    let path = dir.join(format!("{stem}.{}", extension_for(&content_type)));
    if let Err(error) = std::fs::write(&path, &bytes) {
        return Err(AppError::Invalid(format!("无法写入封面：{error}")));
    }

    // Success: forget the failure record, so a transient outage does not keep the
    // image hidden for the rest of the TTL.
    let mut failures = load_failures(root);
    if failures.remove(url).is_some() {
        save_failures(root, &failures);
    }

    Ok(Some(path.to_string_lossy().to_string()))
}

/// Bytes and file count of the cover cache, for the settings page.
///
/// The failure record lives in the same directory but is **not** a cached cover: it is
/// a bookkeeping file a few dozen bytes long. Counting it would make an empty cache
/// report "1 file", which reads as a bug to anyone looking at the number.
pub fn cover_cache_size(root: &Path) -> AppResult<(u64, usize)> {
    let dir = cover_dir(root);
    if !dir.is_dir() {
        return Ok((0, 0));
    }
    let mut bytes = 0u64;
    let mut files = 0usize;
    let entries = std::fs::read_dir(&dir)
        .map_err(|error| AppError::Invalid(format!("无法读取封面目录：{error}")))?;
    for entry in entries.flatten() {
        if entry.file_name() == std::ffi::OsStr::new(COVER_FAILURES) {
            continue;
        }
        if let Ok(metadata) = entry.metadata() {
            if metadata.is_file() {
                bytes += metadata.len();
                files += 1;
            }
        }
    }
    Ok((bytes, files))
}

/// Delete every cached cover.
pub fn clear_covers(root: &Path) -> AppResult<()> {
    let dir = cover_dir(root);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir)
            .map_err(|error| AppError::Invalid(format!("无法删除封面缓存：{error}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("litearti-bgm-{tag}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn iso_dates_are_checked_only_shallowly() {
        assert!(is_iso_date("2025-10-01"));
        assert!(is_iso_date("2026-01-31"));
        assert!(!is_iso_date("2025-1-1"));
        assert!(!is_iso_date("2025/10/01"));
        assert!(!is_iso_date("not-a-date"));
        assert!(!is_iso_date(""));
    }

    #[test]
    fn seasons_cover_the_right_quarters() {
        assert_eq!(season_range(2025, 1), ("2025-01-01".into(), "2025-03-31".into()));
        assert_eq!(season_range(2025, 2), ("2025-04-01".into(), "2025-06-30".into()));
        assert_eq!(season_range(2025, 3), ("2025-07-01".into(), "2025-09-30".into()));
        assert_eq!(season_range(2025, 4), ("2025-10-01".into(), "2025-12-31".into()));
        // An out-of-range quarter falls back to autumn rather than panicking: the only
        // caller is a UI picker, and a wrong season is better than a crash.
        assert_eq!(season_range(2025, 9), ("2025-10-01".into(), "2025-12-31".into()));
    }

    #[test]
    fn a_bad_date_is_rejected_before_a_request_is_made() {
        let root = temp_root("baddate");
        let error = tauri::async_runtime::block_on(season_calendar(&root, "2025/10/01", "2026-01-01"))
            .expect_err("must reject");
        assert!(error.to_string().contains("YYYY-MM-DD"), "{error}");
    }

    #[test]
    fn the_cache_round_trips() {
        let root = temp_root("cache");
        std::fs::create_dir_all(&root).unwrap();
        write_cache(&root, "calendar:2025-10-01:2026-01-01", "{\"1\":[]}");
        let fresh = read_fresh(&root, "calendar:2025-10-01:2026-01-01", CALENDAR_TTL);
        assert_eq!(fresh.as_deref(), Some("{\"1\":[]}"));
        // A different key is a different entry.
        assert!(read_fresh(&root, "popular:24:0", CALENDAR_TTL).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_expired_entry_is_not_fresh_but_is_still_available() {
        let root = temp_root("expired");
        std::fs::create_dir_all(&root).unwrap();
        let mut cache = Cache::default();
        cache.entries.insert(
            "k".to_string(),
            CacheEntry {
                // Older than any TTL under test.
                stored_at: now_millis().saturating_sub(48 * 60 * 60 * 1000),
                body: "old".to_string(),
            },
        );
        save_cache(&root, &cache);

        // Not fresh: the caller must go to the network.
        assert!(read_fresh(&root, "k", CALENDAR_TTL).is_none());
        // But available as a fallback when the network fails. This is the behaviour
        // that keeps the timeline usable offline.
        assert_eq!(read_stale(&root, "k").as_deref(), Some("old"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_corrupt_cache_file_is_treated_as_empty() {
        let root = temp_root("corrupt");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(cache_file(&root), "{not json").unwrap();
        // Reading must not panic, and must report nothing cached.
        assert!(read_fresh(&root, "k", CALENDAR_TTL).is_none());
        // Writing must repair it rather than fail.
        write_cache(&root, "k", "fresh");
        assert_eq!(read_fresh(&root, "k", CALENDAR_TTL).as_deref(), Some("fresh"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn clearing_the_cache_removes_the_file() {
        let root = temp_root("clear");
        std::fs::create_dir_all(&root).unwrap();
        write_cache(&root, "k", "v");
        assert!(cache_file(&root).exists());
        clear_cache(&root).unwrap();
        assert!(!cache_file(&root).exists());
        // Clearing again is not an error.
        clear_cache(&root).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_cache_key_distinguishes_seasons() {
        // Two different seasons must not share an entry: the whole point of a cache
        // keyed on the request is that a wrong hit is invisible.
        let root = temp_root("keys");
        std::fs::create_dir_all(&root).unwrap();
        write_cache(&root, "calendar:2025-01-01:2025-03-31", "winter");
        write_cache(&root, "calendar:2025-10-01:2025-12-31", "autumn");
        assert_eq!(
            read_fresh(&root, "calendar:2025-01-01:2025-03-31", CALENDAR_TTL).as_deref(),
            Some("winter")
        );
        assert_eq!(
            read_fresh(&root, "calendar:2025-10-01:2025-12-31", CALENDAR_TTL).as_deref(),
            Some("autumn")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_user_agent_identifies_the_app() {
        // Not a browser string on purpose: the mirror's operator should be able to
        // see who is calling.
        assert!(USER_AGENT.starts_with("litearti/"));
        assert!(!USER_AGENT.contains("Mozilla"));
    }

    #[test]
    fn the_rate_limit_is_at_most_one_request_per_second() {
        // A guard on the constant, not on timing: sleeping in a unit test would make
        // the suite slow and flaky for no extra confidence.
        assert!(MIN_INTERVAL >= Duration::from_millis(1000));
    }

    #[test]
    fn the_cover_hash_is_stable_and_avoids_unsafe_characters() {
        // The hash names a file, so it must be pure hex: no slashes, no colons, no
        // characters a filesystem rejects.
        let left = fnv1a("https://api.bgm.tv/v0/subjects/1/image?type=grid");
        let right = fnv1a("https://api.bgm.tv/v0/subjects/1/image?type=grid");
        assert_eq!(left, right, "the same URL must hash the same way");
        assert_ne!(left, fnv1a("https://api.bgm.tv/v0/subjects/2/image?type=grid"));

        let name = format!("{left:016x}");
        assert_eq!(name.len(), 16);
        assert!(name.chars().all(|c| c.is_ascii_hexdigit()), "{name}");
    }

    #[test]
    fn the_extension_follows_the_content_type() {
        assert_eq!(extension_for("image/png"), "png");
        assert_eq!(extension_for("image/jpeg"), "jpg");
        assert_eq!(extension_for("IMAGE/WEBP"), "webp");
        assert_eq!(extension_for("image/avif"), "avif");
        // An unlabelled image is almost always a JPEG here.
        assert_eq!(extension_for("application/octet-stream"), "jpg");
        assert_eq!(extension_for(""), "jpg");
    }

    #[test]
    fn a_cover_url_must_be_http() {
        let root = temp_root("cover");
        let error = tauri::async_runtime::block_on(cover(&root, "file:///etc/passwd"))
            .expect_err("must reject");
        assert!(error.to_string().contains("http"), "{error}");
        // A failed scheme check must not leave a cache directory behind.
        assert!(!cover_dir(&root).exists());
    }

    #[test]
    fn a_cached_cover_is_found_without_a_request() {
        let root = temp_root("coverhit");
        let dir = cover_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();

        let url = "https://api.bgm.tv/v0/subjects/1/image?type=grid";
        let expected = dir.join(format!("{:016x}.jpg", fnv1a(url)));
        std::fs::write(&expected, b"not really a jpeg").unwrap();

        // The path is returned from the existing file, so no network is touched — the
        // test passes with no connectivity, which is the point.
        let found = tauri::async_runtime::block_on(cover(&root, url)).unwrap();
        assert_eq!(found.as_deref(), Some(expected.to_string_lossy().as_ref()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_recent_failure_is_not_retried() {
        // This is what stops a 24-card grid from firing 24 doomed requests on every
        // render when the image host is unreachable.
        let root = temp_root("coverfail");
        let dir = cover_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();

        let url = "https://api.bgm.tv/v0/subjects/1/image?type=grid";
        let mut failures = std::collections::BTreeMap::new();
        failures.insert(url.to_string(), now_millis());
        save_failures(&root, &failures);

        assert!(load_failures(&root).contains_key(url));
        // The call returns None immediately rather than attempting a request.
        let result = tauri::async_runtime::block_on(cover(&root, url)).unwrap();
        assert!(result.is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_expired_failure_is_forgotten() {
        let root = temp_root("coverexpire");
        let dir = cover_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();

        let url = "https://api.bgm.tv/x.jpg";
        let mut failures = std::collections::BTreeMap::new();
        // Older than the TTL.
        failures.insert(url.to_string(), now_millis().saturating_sub(2 * 60 * 60 * 1000));
        save_failures(&root, &failures);

        // Reading prunes it, so the next attempt happens after the network is fixed.
        assert!(!load_failures(&root).contains_key(url));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_cover_cache_reports_its_size_and_clears() {
        let root = temp_root("coversize");
        let dir = cover_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.jpg"), vec![0u8; 1000]).unwrap();
        std::fs::write(dir.join("b.png"), vec![0u8; 500]).unwrap();

        let (bytes, files) = cover_cache_size(&root).unwrap();
        assert_eq!(files, 2);
        assert_eq!(bytes, 1500);

        clear_covers(&root).unwrap();
        assert_eq!(cover_cache_size(&root).unwrap(), (0, 0));
        // Clearing twice is not an error.
        clear_covers(&root).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_failure_record_is_not_counted_as_a_cached_cover() {
        // The bookkeeping file lives beside the images. Counting it would make an
        // empty cache report "1 file", which looks like a bug in the number.
        let root = temp_root("covercount");
        let dir = cover_dir(&root);
        std::fs::create_dir_all(&dir).unwrap();
        save_failures(&root, &[("https://x/y.jpg".to_string(), now_millis())].into_iter().collect());

        assert_eq!(cover_cache_size(&root).unwrap(), (0, 0));

        std::fs::write(dir.join("c.jpg"), vec![0u8; 42]).unwrap();
        assert_eq!(cover_cache_size(&root).unwrap(), (42, 1));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_absent_cover_directory_is_not_an_error() {
        let root = temp_root("coversize2");
        // No directory was ever created: a fresh install, before any cover loaded.
        assert_eq!(cover_cache_size(&root).unwrap(), (0, 0));
    }
}
