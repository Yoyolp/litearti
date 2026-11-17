//! Fetching the community rule catalogue through a mirror.
//!
//! ## Why a mirror at all
//!
//! The rules live in a GitHub repository, and `raw.githubusercontent.com` is not
//! reachable from every network — measured unreachable from where this was written,
//! while two mirrors answered in under a second. Without a mirror, "browse community
//! rules" would be a button that always fails.
//!
//! ## Why the mirrors are an enum and not a URL
//!
//! This module must never become a general HTTP proxy. A URL parameter would mean the
//! frontend could ask Rust to fetch anything, which is exactly the boundary `net.rs`
//! exists to keep. So the frontend chooses from a fixed list, and each variant maps to
//! one base URL that is compiled in.
//!
//! ## What is fetched
//!
//! Only two shapes, both JSON from one repository:
//!
//! - `index.json` — the catalogue: an array of `{ name, version, author, lastUpdate }`.
//! - `<name>.json` — one rule.
//!
//! `name` comes from the catalogue, which means it is remote input and is validated as
//! a filename before use: no separators, no `..`, nothing that could escape the
//! intended URL.

use crate::error::{AppError, AppResult};
use std::path::Path;
use std::time::Duration;

/// Timeout for one catalogue request. Both files are small.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// Ceiling on a rule file. Rules are a few kilobytes; this is generous.
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

/// One request per second, matching the courtesy the Bangumi client pays.
///
/// A mirror operator is doing this project a favour by relaying the repository, and
/// hammering it is how that ends.
const MIN_INTERVAL: Duration = Duration::from_secs(1);

/// A relay for the rules repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mirror {
    /// The upstream repository. Unreachable on some networks; kept as an option
    /// because on others it is the freshest and adds no third party.
    Github,
    /// `gh-proxy.org` relaying raw.githubusercontent.com.
    GhProxy,
    /// GitCode's mirror of the repository. Measured fastest by a wide margin.
    Gitcode,
}

impl Mirror {
    /// Parse a mirror id sent by the frontend.
    ///
    /// Accepts only the known ids. Anything else is rejected rather than silently
    /// falling back, so a typo in the caller does not look like "the mirror is empty".
    pub fn parse(value: &str) -> AppResult<Mirror> {
        match value {
            "github" => Ok(Mirror::Github),
            "ghproxy" => Ok(Mirror::GhProxy),
            "gitcode" => Ok(Mirror::Gitcode),
            other => Err(AppError::Invalid(format!("未知的镜像：{other}"))),
        }
    }

    /// The base URL that files are appended to. Always ends with `/`.
    fn base(self) -> &'static str {
        match self {
            Mirror::Github => "https://raw.githubusercontent.com/Predidit/KazumiRules/main/",
            Mirror::GhProxy => {
                "https://gh-proxy.org/https://raw.githubusercontent.com/Predidit/KazumiRules/main/"
            }
            Mirror::Gitcode => "https://raw.gitcode.com/gh_mirrors/ka/KazumiRules/raw/main/",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Mirror::Github => "github",
            Mirror::GhProxy => "ghproxy",
            Mirror::Gitcode => "gitcode",
        }
    }
}

/// Every mirror, in the order the settings UI shows them.
pub fn all_mirrors() -> Vec<&'static str> {
    vec!["gitcode", "ghproxy", "github"]
}

/// The request gate, shared by every mirror.
static REQUEST_GATE: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

fn wait_for_slot() {
    let mut guard = REQUEST_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(last) = *guard {
        let elapsed = last.elapsed();
        if elapsed < MIN_INTERVAL {
            std::thread::sleep(MIN_INTERVAL - elapsed);
        }
    }
    *guard = Some(std::time::Instant::now());
}

/// A rule name is safe to append to a URL as a file name.
///
/// Remote input being used to build a URL, so the check is explicit rather than
/// relying on `Url::join` behaviour: a name like `../other/thing` would otherwise
/// escape the repository path.
fn is_safe_rule_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        // `..` cannot appear even though `.` is allowed: two dots in a row is the one
        // sequence that can climb a path.
        && !name.contains("..")
        && !name.starts_with('.')
}

/// Fetch the catalogue JSON.
pub async fn fetch_index(root: &Path, mirror: Mirror) -> AppResult<String> {
    let url = format!("{}index.json", mirror.base());
    let cache_key = format!("rules-index:{}", mirror.id());
    fetch(root, &url, &cache_key, mirror).await
}

/// Fetch one rule's JSON.
pub async fn fetch_rule(root: &Path, mirror: Mirror, name: &str) -> AppResult<String> {
    if !is_safe_rule_name(name) {
        return Err(AppError::Invalid(format!("规则名不合法：{name}")));
    }
    let url = format!("{}{name}.json", mirror.base());
    let cache_key = format!("rules-rule:{}:{name}", mirror.id());
    fetch(root, &url, &cache_key, mirror).await
}

/// How long a fetched rule file is reused.
///
/// Long, because rules change rarely, and a person who just imported one should not
/// re-download it on the next pane open. A manual refresh bypasses this by asking for
/// the index again after clearing.
const RULE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// The index is refreshed more often: it carries versions and update times, which is
/// exactly what someone opening the pane wants to see current.
const INDEX_TTL: Duration = Duration::from_secs(60 * 60);

fn cache_file(root: &Path) -> std::path::PathBuf {
    root.join("rules-mirror-cache.json")
}

fn read_cached(root: &Path, key: &str, ttl: Duration) -> Option<String> {
    let raw = crate::sources::read_json(&cache_file(root), "{}").ok()?;
    let parsed: std::collections::BTreeMap<String, (u64, String)> =
        serde_json::from_str(&raw).ok()?;
    let (stored_at, body) = parsed.get(key)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if now.saturating_sub(*stored_at) <= ttl.as_millis() as u64 {
        Some(body.clone())
    } else {
        None
    }
}

fn write_cached(root: &Path, key: &str, body: &str) {
    let path = cache_file(root);
    let mut parsed: std::collections::BTreeMap<String, (u64, String)> =
        crate::sources::read_json(&path, "{}")
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    parsed.insert(key.to_string(), (now, body.to_string()));
    if let Ok(json) = serde_json::to_string(&parsed) {
        let _ = crate::sources::write_json(&path, &json);
    }
}

/// Fetch a file, honouring the cache and the rate limit.
///
/// Unlike the Bangumi client this does **not** fall back to a stale entry on failure:
/// the catalogue is small, and someone opening the rules pane after a network change
/// should see the truth ("cannot reach this mirror") rather than a possibly ancient
/// list. They can pick another mirror, which is the actual remedy.
async fn fetch(root: &Path, url: &str, cache_key: &str, _mirror: Mirror) -> AppResult<String> {
    let ttl = if cache_key.starts_with("rules-index") {
        INDEX_TTL
    } else {
        RULE_TTL
    };
    if let Some(body) = read_cached(root, cache_key, ttl) {
        return Ok(body);
    }

    tauri::async_runtime::spawn_blocking(wait_for_slot)
        .await
        .map_err(|_| AppError::Invalid("请求排队失败".to_string()))?;

    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("litearti/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| AppError::Invalid(format!("无法创建 HTTP 客户端：{error}")))?;

    let response = client.get(url).send().await.map_err(|error| {
        AppError::Invalid(crate::net::describe_reqwest_error(&error, REQUEST_TIMEOUT))
    })?;

    let status = response.status();
    if !status.is_success() {
        return Err(AppError::Invalid(format!(
            "镜像 {} 返回 HTTP {}",
            _mirror.id(),
            status.as_u16()
        )));
    }

    let body = response
        .text()
        .await
        .map_err(|error| AppError::Invalid(format!("读取响应失败：{error}")))?;

    if body.len() > MAX_BODY_BYTES {
        return Err(AppError::Invalid(format!(
            "响应过大（{} 字节）",
            body.len()
        )));
    }

    // A rules file is JSON; refusing anything else catches a mirror that returns an
    // HTML error page with a 200, which would otherwise be parsed as a broken rule.
    if serde_json::from_str::<serde_json::Value>(&body).is_err() {
        return Err(AppError::Invalid(format!(
            "镜像 {} 返回的不是 JSON",
            _mirror.id()
        )));
    }

    write_cached(root, cache_key, &body);
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_mirror_has_exactly_one_id_and_round_trips() {
        for mirror in [Mirror::Github, Mirror::GhProxy, Mirror::Gitcode] {
            assert_eq!(Mirror::parse(mirror.id()).unwrap(), mirror);
            // The base must end with a slash, or the appended file name would fuse
            // onto the last path segment.
            assert!(mirror.base().ends_with('/'), "{}", mirror.base());
        }
        assert_eq!(all_mirrors().len(), 3);
    }

    #[test]
    fn an_unknown_mirror_is_rejected_rather_than_defaulted() {
        // Silently falling back would make a typo look like an empty catalogue.
        assert!(Mirror::parse("").is_err());
        assert!(Mirror::parse("direct").is_err());
        assert!(Mirror::parse("https://evil.example/").is_err());
    }

    #[test]
    fn the_mirrors_point_at_the_same_upstream_repository() {
        // A mirror that relays a different repository would be a supply-chain hole.
        for mirror in [Mirror::Github, Mirror::GhProxy, Mirror::Gitcode] {
            let base = mirror.base();
            let mentions_repo = base.contains("Predidit/KazumiRules")
                || base.contains("gh_mirrors/ka/KazumiRules");
            assert!(mentions_repo, "{} does not point at the rules repo", base);
        }
    }

    #[test]
    fn rule_names_are_validated_before_being_url_built() {
        // Ordinary names.
        assert!(is_safe_rule_name("mxdm"));
        assert!(is_safe_rule_name("dm84"));
        assert!(is_safe_rule_name("7sefun"));
        assert!(is_safe_rule_name("anime-v2"));
        assert!(is_safe_rule_name("rule_1.5"));

        // Path traversal, in the forms that actually matter.
        assert!(!is_safe_rule_name("../other/thing"));
        assert!(!is_safe_rule_name(".."));
        assert!(!is_safe_rule_name("a/b"));
        assert!(!is_safe_rule_name("a\\b"));
        assert!(!is_safe_rule_name(".hidden"));
        assert!(!is_safe_rule_name(""));

        // A query or fragment must not be able to change the request.
        assert!(!is_safe_rule_name("name?x=1"));
        assert!(!is_safe_rule_name("name#frag"));
        assert!(!is_safe_rule_name("name%2f"));

        // Length is bounded so a huge name cannot build a huge URL.
        assert!(!is_safe_rule_name(&"a".repeat(200)));
    }

    #[test]
    fn an_unsafe_rule_name_never_reaches_the_network() {
        let root = std::env::temp_dir().join(format!("litearti-rules-{}", uuid::Uuid::new_v4()));
        // The error is raised before any request, so this passes offline.
        let error = tauri::async_runtime::block_on(fetch_rule(
            &root,
            Mirror::Gitcode,
            "../escape",
        ))
        .expect_err("must reject");
        assert!(error.to_string().contains("规则名"), "{error}");
    }

    #[test]
    fn the_cache_round_trips_per_mirror() {
        let root = std::env::temp_dir().join(format!("litearti-rules2-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();

        // Two mirrors must not share a cache entry: their content can differ.
        write_cached(&root, "rules-index:gitcode", "[{\"name\":\"a\"}]");
        write_cached(&root, "rules-index:ghproxy", "[{\"name\":\"b\"}]");

        assert_eq!(
            read_cached(&root, "rules-index:gitcode", INDEX_TTL).as_deref(),
            Some("[{\"name\":\"a\"}]")
        );
        assert_eq!(
            read_cached(&root, "rules-index:ghproxy", INDEX_TTL).as_deref(),
            Some("[{\"name\":\"b\"}]")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_expired_cache_entry_is_not_returned() {
        let root = std::env::temp_dir().join(format!("litearti-rules3-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        // Stored two days ago, which is past the one-hour index TTL.
        let old = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            - 48 * 60 * 60 * 1000;
        let mut map = std::collections::BTreeMap::new();
        map.insert("rules-index:gitcode".to_string(), (old, "[]".to_string()));
        std::fs::write(cache_file(&root), serde_json::to_string(&map).unwrap()).unwrap();

        assert!(read_cached(&root, "rules-index:gitcode", INDEX_TTL).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_rule_ttl_is_longer_than_the_index_ttl() {
        // Rules change rarely, the catalogue lists versions and should be current.
        assert!(RULE_TTL > INDEX_TTL);
    }
}
