//! Protection for stored book-source credentials.
//!
//! Login cookies are the first genuinely sensitive value this app persists. They
//! are stored on disk, and the storage format has to survive encryption being
//! added later without a migration — so every value is written through `seal`
//! and read through `unseal` from the start, even though `seal` currently does
//! not encrypt anything.
//!
//! ## The prefix convention
//!
//! `seal` always writes a scheme prefix:
//!
//! ```text
//! plain:       stored as-is (current implementation)
//! enc:v1:      encrypted payload (reserved; unseal rejects it for now)
//! ```
//!
//! The prefix is what makes the format forward-compatible: when `seal` grows a
//! real cipher it starts emitting `enc:v1:`, and existing `plain:` records keep
//! working. Nothing needs to be rewritten, and there is no "which version is
//! this file" guesswork.
//!
//! Because `seal` adds exactly one prefix and `unseal` strips exactly one, a
//! secret whose own text starts with `plain:` still round-trips correctly.
//!
//! ## What this module must never do
//!
//! It must not log, and it must not put a secret into an error message. Callers
//! treat the returned string as opaque; only the network layer sees it, and only
//! to build a `Cookie` header.

use crate::error::{AppError, AppResult};

/// Marks a value stored without encryption.
const PLAIN_PREFIX: &str = "plain:";

/// Reserved for a future encrypted format. Recognised so that a record written
/// by a newer build produces an honest error instead of silently decoding to
/// garbage.
const SEALED_PREFIX: &str = "enc:v1:";

/// Prepare a secret for storage.
///
/// Today this only tags the value. When real encryption lands, this is the one
/// function to change — the storage format already accommodates the result.
pub fn seal(plain: &str) -> String {
    // TODO(security): replace with authenticated encryption (e.g. DPAPI on
    // Windows, a keyring on other platforms). The output must keep the
    // `enc:v1:` prefix so `unseal` can tell the two formats apart.
    format!("{PLAIN_PREFIX}{plain}")
}

/// Read a secret produced by [`seal`].
///
/// Errors are deliberately vague about the value itself: a message that echoed
/// the payload would defeat the point of storing it carefully.
pub fn unseal(stored: &str) -> AppResult<String> {
    if let Some(rest) = stored.strip_prefix(PLAIN_PREFIX) {
        return Ok(rest.to_string());
    }
    if stored.starts_with(SEALED_PREFIX) {
        // A record from a build that encrypts. We cannot read it, and pretending
        // otherwise would silently send a garbage cookie and look like a broken
        // login.
        return Err(AppError::Invalid(
            "凭证由更新版本加密，请升级应用后再使用".to_string(),
        ));
    }
    Err(AppError::Invalid(
        "凭证格式无法识别，请重新登录".to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_cookie() {
        let cookie = "sid=abc123; token=xyz";
        assert_eq!(unseal(&seal(cookie)).unwrap(), cookie);
    }

    #[test]
    fn round_trips_an_empty_value() {
        assert_eq!(unseal(&seal("")).unwrap(), "");
    }

    #[test]
    fn stored_form_is_tagged() {
        // The tag is not cosmetic: it is what lets a future encrypted format be
        // distinguished without inspecting the file's other fields.
        assert!(seal("x").starts_with(PLAIN_PREFIX));
    }

    #[test]
    fn round_trips_a_value_that_looks_prefixed() {
        // `seal` adds one prefix and `unseal` removes one, so a secret that
        // happens to start with the tag survives unchanged.
        let tricky = "plain:plain:already-tagged";
        assert_eq!(unseal(&seal(tricky)).unwrap(), tricky);
    }

    #[test]
    fn rejects_an_encrypted_record_from_a_newer_build() {
        let error = unseal("enc:v1:AAAA").expect_err("must not silently decode");
        assert!(error.to_string().contains("升级"), "{error}");
    }

    #[test]
    fn rejects_an_unknown_format() {
        let error = unseal("b64:AAAA").expect_err("must not guess");
        assert!(error.to_string().contains("重新登录"), "{error}");
    }

    #[test]
    fn error_messages_do_not_echo_the_value() {
        // A careless message here would leak the very secret being protected.
        let secret = "enc:v1:THIS-IS-THE-SECRET";
        let error = unseal(secret).expect_err("must fail");
        assert!(!error.to_string().contains("THIS-IS-THE-SECRET"), "{error}");
    }
}
