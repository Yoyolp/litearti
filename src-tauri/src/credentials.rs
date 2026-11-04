//! Storage for book-source login credentials.
//!
//! Cookies live here rather than in a book source's JSON on purpose: a source
//! file is something people share and re-import, and a login cookie must never
//! travel with it. Keeping them apart also means deleting a source does not
//! require touching anyone's secrets, and a future "export sources" feature
//! cannot leak them by accident.
//!
//! ## What callers can see
//!
//! [`status`] returns metadata only — host, timestamps, whether a cookie exists.
//! There is no command that hands a cookie to the frontend. Only [`resolve`],
//! called from the network layer, ever reads the value, so a compromised
//! renderer has nothing to steal even if it can call IPC freely.
//!
//! ## Host scoping
//!
//! A credential is bound to one host and is attached only when a request goes to
//! exactly that host. Sub-domains are *not* covered: `cdn.example.com` gets
//! nothing from a credential for `example.com`. That is stricter than a browser
//! cookie jar, and deliberately so — the narrower rule is the one that cannot
//! leak a session to an unexpected host.

use crate::crypto;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Ceiling for one cookie header.
///
/// Real sessions are a few hundred bytes. The cap exists so a pathological
/// login (or a bug that captures a whole jar) fails loudly at save time instead
/// of quietly inflating every request.
const MAX_COOKIE_BYTES: usize = 16 * 1024;

fn credentials_file(root: &Path) -> PathBuf {
    root.join("credentials.json")
}

/// One stored login.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialEntry {
    /// Host the cookie may be sent to, normalised (lowercase, no port).
    pub host: String,
    /// Sealed value — see [`crate::crypto`].
    cookie: String,
    /// Unix milliseconds. Stored as a number so this module needs no date crate.
    pub updated_at: u64,
    /// How it got here: `login` (captured window) or `paste` (reserved).
    pub origin: String,
}

/// Metadata about a credential, with the secret omitted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialStatus {
    pub host: String,
    pub updated_at: u64,
    pub origin: String,
    pub has_cookie: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Credentials {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub entries: BTreeMap<String, CredentialEntry>,
}

fn default_version() -> u32 {
    1
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Normalise a host for comparison: lowercase, no port, no trailing dot.
///
/// Cookies are not port-scoped, so the port is dropped rather than compared; a
/// trailing dot (`example.com.`) is the same host and must match.
pub fn normalize_host(raw: &str) -> String {
    let trimmed = raw.trim().to_ascii_lowercase();
    // Drop a port if one was written.
    let without_port = match trimmed.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host.to_string(),
        _ => trimmed,
    };
    without_port.trim_end_matches('.').to_string()
}

pub fn load(root: &Path) -> AppResult<Credentials> {
    if !credentials_file(root).exists() {
        return Ok(Credentials {
            version: default_version(),
            entries: BTreeMap::new(),
        });
    }
    let raw = crate::sources::read_json(&credentials_file(root), "{}")?;
    let parsed = serde_json::from_str::<Credentials>(&raw)
        .map_err(|error| AppError::Invalid(format!("凭证文件损坏：{error}")))?;
    Ok(parsed)
}

pub fn save(root: &Path, credentials: &Credentials) -> AppResult<()> {
    let json = serde_json::to_string_pretty(credentials)?;
    crate::sources::write_json(&credentials_file(root), &json)
}

/// Metadata for every stored credential, safe to hand to the UI.
pub fn status(root: &Path) -> AppResult<BTreeMap<String, CredentialStatus>> {
    let credentials = load(root)?;
    Ok(credentials
        .entries
        .into_iter()
        .map(|(id, entry)| {
            (
                id,
                CredentialStatus {
                    host: entry.host,
                    updated_at: entry.updated_at,
                    origin: entry.origin,
                    has_cookie: !entry.cookie.is_empty(),
                },
            )
        })
        .collect())
}

/// Store (or replace) the credential for one source.
pub fn put(root: &Path, source_id: &str, host: &str, cookie: &str, origin: &str) -> AppResult<()> {
    let host = normalize_host(host);
    if host.is_empty() {
        return Err(AppError::Invalid("凭证缺少 host".to_string()));
    }
    if cookie.len() > MAX_COOKIE_BYTES {
        // Failing here is intentional: truncating would produce a cookie that
        // looks valid and silently fails to authenticate.
        return Err(AppError::Invalid(format!(
            "Cookie 过长（{} 字节），上限 {} 字节",
            cookie.len(),
            MAX_COOKIE_BYTES
        )));
    }

    let mut credentials = load(root)?;
    credentials.entries.insert(
        source_id.to_string(),
        CredentialEntry {
            host,
            cookie: crypto::seal(cookie),
            updated_at: now_millis(),
            origin: origin.to_string(),
        },
    );
    save(root, &credentials)
}

/// Remove one source's credential.
pub fn clear(root: &Path, source_id: &str) -> AppResult<()> {
    let mut credentials = load(root)?;
    if credentials.entries.remove(source_id).is_some() {
        save(root, &credentials)?;
    }
    Ok(())
}

/// The cookie to attach to a request, if one applies.
///
/// Returns `None` — never an error — when there is no credential, or when the
/// request targets a different host. A missing login is an ordinary state (the
/// user has not logged in yet), not an exceptional one.
pub fn resolve(root: &Path, source_id: Option<&str>, url: &str) -> AppResult<Option<String>> {
    let Some(source_id) = source_id else {
        return Ok(None);
    };

    let host = match reqwest::Url::parse(url) {
        Ok(parsed) => parsed.host_str().map(normalize_host),
        Err(_) => None,
    };
    let Some(request_host) = host else {
        return Ok(None);
    };

    let credentials = load(root)?;
    let Some(entry) = credentials.entries.get(source_id) else {
        return Ok(None);
    };

    // Exact host only. See the module docs for why sub-domains are excluded.
    if entry.host != request_host {
        return Ok(None);
    }
    if entry.cookie.is_empty() {
        return Ok(None);
    }

    Ok(Some(crypto::unseal(&entry.cookie)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("litearti-creds-{tag}-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let root = temp_root("empty");
        assert!(load(&root).unwrap().entries.is_empty());
        fs_cleanup(&root);
    }

    #[test]
    fn put_then_resolve_returns_the_cookie() {
        let root = temp_root("roundtrip");
        put(&root, "src", "example.com", "sid=abc", "login").unwrap();

        let cookie = resolve(&root, Some("src"), "https://example.com/a/b").unwrap();
        assert_eq!(cookie.as_deref(), Some("sid=abc"));
        fs_cleanup(&root);
    }

    #[test]
    fn status_never_exposes_the_cookie() {
        let root = temp_root("status");
        put(&root, "src", "example.com", "sid=secret", "login").unwrap();

        let json = serde_json::to_string(&status(&root).unwrap()).unwrap();
        // The single most important property of this module.
        assert!(!json.contains("secret"), "{json}");
        assert!(json.contains("hasCookie"), "{json}");
        fs_cleanup(&root);
    }

    #[test]
    fn resolve_is_scoped_to_the_exact_host() {
        let root = temp_root("scope");
        put(&root, "src", "example.com", "sid=abc", "login").unwrap();

        assert!(resolve(&root, Some("src"), "https://example.com/x").unwrap().is_some());
        // A different host must never receive the cookie.
        assert!(resolve(&root, Some("src"), "https://evil.com/x").unwrap().is_none());
        // Nor may a sub-domain inherit it.
        assert!(resolve(&root, Some("src"), "https://cdn.example.com/x").unwrap().is_none());
        fs_cleanup(&root);
    }

    #[test]
    fn host_matching_is_case_and_dot_insensitive() {
        let root = temp_root("case");
        put(&root, "src", "Example.COM.", "sid=abc", "login").unwrap();
        assert!(resolve(&root, Some("src"), "https://example.com/x").unwrap().is_some());
        fs_cleanup(&root);
    }

    #[test]
    fn port_is_ignored() {
        let root = temp_root("port");
        put(&root, "src", "example.com:8443", "sid=abc", "login").unwrap();
        assert!(resolve(&root, Some("src"), "https://example.com:8443/x").unwrap().is_some());
        assert!(resolve(&root, Some("src"), "https://example.com/x").unwrap().is_some());
        fs_cleanup(&root);
    }

    #[test]
    fn unknown_source_or_missing_id_resolves_to_none() {
        let root = temp_root("unknown");
        put(&root, "src", "example.com", "sid=abc", "login").unwrap();
        assert!(resolve(&root, Some("other"), "https://example.com/x").unwrap().is_none());
        assert!(resolve(&root, None, "https://example.com/x").unwrap().is_none());
        fs_cleanup(&root);
    }

    #[test]
    fn clear_removes_the_entry() {
        let root = temp_root("clear");
        put(&root, "src", "example.com", "sid=abc", "login").unwrap();
        clear(&root, "src").unwrap();
        assert!(resolve(&root, Some("src"), "https://example.com/x").unwrap().is_none());
        assert!(status(&root).unwrap().is_empty());
        fs_cleanup(&root);
    }

    #[test]
    fn oversized_cookie_is_rejected_not_truncated() {
        let root = temp_root("long");
        let cookie = "a".repeat(MAX_COOKIE_BYTES + 1);
        let error = put(&root, "src", "example.com", &cookie, "login").expect_err("must reject");
        assert!(error.to_string().contains("过长"), "{error}");
        fs_cleanup(&root);
    }

    #[test]
    fn atomic_write_leaves_no_temp_file() {
        let root = temp_root("atomic");
        put(&root, "src", "example.com", "sid=abc", "login").unwrap();
        let leftovers: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp file should be renamed away");
        fs_cleanup(&root);
    }

    #[test]
    fn corrupt_file_is_reported() {
        let root = temp_root("corrupt");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(credentials_file(&root), b"{ not json").unwrap();
        assert!(load(&root).is_err());
        fs_cleanup(&root);
    }

    fn fs_cleanup(root: &Path) {
        std::fs::remove_dir_all(root).ok();
    }
}
