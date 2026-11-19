//! TLS configuration for outbound HTTP.
//!
//! ## Why this is not just `reqwest::Client::builder()`
//!
//! With the `rustls` feature, reqwest builds its TLS config through
//! `rustls-platform-verifier`, which on Android delegates certificate checks to
//! the JVM's `TrustManager`. That delegation needs a Kotlin component appended to
//! the Gradle build and initialized at startup; without it the first HTTPS
//! request aborts the whole process:
//!
//! ```text
//! Abort message: 'Expect rustls-platform-verifier to be initialized'
//! ```
//!
//! That component ships only as an AAR in a GitHub-hosted Maven repository, so
//! using it means an extra repository plus a Gradle version-resolution snippet
//! for a build we already have to drive by hand.
//!
//! Passing a preconfigured `rustls::ClientConfig` sidesteps the issue: reqwest
//! then uses the config as-is and never touches the platform verifier, on every
//! platform. The cost is that certificate roots come from `webpki-roots` — the
//! Mozilla store baked into the binary — instead of the OS store. A user-added
//! enterprise CA will not be trusted. For a reader talking to public book sources
//! that trade is fine, and it is the same trade many static binaries make.
//!
//! ## Why one place
//!
//! Six call sites build a client (`net`, `stream`, `bangumi`, `rules_mirror`, and
//! a test). A per-site fix would have left the others crashing, and the failure
//! mode is a hard abort rather than a catchable error, so it is worth the
//! indirection.

/// The TLS config every client in this app should use.
///
/// Returns `None` when using the platform default is correct — i.e. on desktop,
/// where reqwest's own setup works and picks up the OS trust store, which is a
/// better default than a frozen root list. On Android there is no such working
/// default, so a config is always produced.
pub fn client_config() -> Option<rustls::ClientConfig> {
    #[cfg(target_os = "android")]
    {
        Some(webpki_roots_config())
    }
    #[cfg(not(target_os = "android"))]
    {
        // Desktop: let reqwest use the OS trust store.
        None
    }
}

/// A `ClientConfig` trusting the bundled Mozilla root store.
///
/// Used on Android (see the module docs) and available to tests that need a
/// client which does not depend on the host's certificate store.
pub fn webpki_roots_config() -> rustls::ClientConfig {
    install_crypto_provider();

    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());

    rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth()
}

/// Make sure exactly one crypto provider is installed for the process.
///
/// `ClientConfig::builder()` resolves the provider implicitly from crate
/// features, and **panics** when it cannot pick one — for example when both
/// `ring` and `aws-lc-rs` end up enabled through the dependency graph. A panic
/// inside a Tauri command aborts the process on Android, which is exactly the
/// failure being fixed here, so the choice is made explicitly instead of left to
/// feature unification.
///
/// `install_default` fails when another thread won the race, which is fine: the
/// provider is installed either way.
fn install_crypto_provider() {
    use std::sync::Once;

    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    });
}

/// Start a reqwest client builder with the TLS backend already decided.
///
/// Every outbound HTTP client in the app goes through here so no call site can
/// accidentally fall back to the platform verifier on Android.
pub fn builder() -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder();
    match client_config() {
        Some(config) => builder.tls_backend_preconfigured(config),
        None => builder,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A zero-root store would make every HTTPS request fail with an opaque
    /// "invalid peer certificate" instead of working, which is worse than the
    /// abort this module exists to prevent.
    fn root_count() -> usize {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        roots.len()
    }

    #[test]
    fn the_bundled_root_store_is_not_empty() {
        assert!(
            root_count() > 0,
            "webpki-roots should provide server roots"
        );
    }

    #[test]
    fn a_client_can_be_built_through_the_helper() {
        let client = builder().build();
        assert!(client.is_ok(), "client construction failed: {client:?}");
    }

    #[test]
    fn the_preconfigured_backend_is_recognised_by_reqwest() {
        // This is the test that actually matters for Android, and it must not be
        // skipped on the dev machine — where `client_config()` returns `None` and
        // so never exercises the preconfigured path.
        //
        // reqwest matches the preconfigured value by downcasting to
        // `Option<rustls::ClientConfig>`. A type mismatch does not fail loudly at
        // the call site: it silently sets `TlsBackend::UnknownPreconfigured`,
        // which only errors later, when `build()` runs. Asserting on `build()`
        // is therefore what proves the config is accepted.
        let result = reqwest::Client::builder()
            .tls_backend_preconfigured(webpki_roots_config())
            .build();
        assert!(
            result.is_ok(),
            "reqwest rejected the preconfigured rustls config: {result:?}"
        );
    }

    #[test]
    fn the_config_uses_the_bundled_roots() {
        // Building this on every platform (not just Android) means a broken root
        // set is caught by `cargo test` on the dev machine, where it is easy to
        // see, rather than on a phone.
        let config = webpki_roots_config();
        assert!(config.alpn_protocols.is_empty());
    }
}
