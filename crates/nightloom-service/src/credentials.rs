//! API keys, from the OS credential store or the environment.
//!
//! This lives here rather than in either shell because both shells need the
//! *same* answer. It began in the desktop's `main.rs`, next to the settings
//! UI that writes it, which left the CLI with no way to read a key the
//! desktop had stored — env or nothing. The failure that produces is the
//! confusing kind: a key set in one shell, a 401 in the other, and nothing
//! on screen connecting the two.
//!
//! So the resolution order is one function rather than two that agree today,
//! the same argument `store::SessionSummary::label` makes for a chat's name.
//! **Stored wins over the environment** in both shells: an entry in the
//! credential store was put there deliberately, where a stray
//! `ANTHROPIC_API_KEY` left in a shell profile is usually forgotten.
//!
//! It is not in `nightloom-providers` because that crate is wire formats and
//! an OS keychain is not a wire format; and not in a crate of its own
//! because [`env_search_key`] — the environment half of this same question —
//! is already here, and splitting one question across two crates is what
//! this module exists to stop.
//!
//! # The store is optional, and never blocks
//!
//! The CLI runs where there is no credential store: over SSH, in a
//! container, in CI. There is no D-Bus session and no unlocked login
//! keyring, and a lookup that popped a GUI unlock dialog on a headless box
//! would be worse than no store at all. Every read here is therefore
//! `Option`-shaped and swallows its error — a store that is absent, locked
//! or broken reads as "no stored key" and resolution falls through to the
//! environment, which stays a first-class path rather than a deprecated one.
//! Only the *writes* report failure, because a `set` that silently did
//! nothing would be indefensible.
//!
//! Building without the `keyring` feature drops the dependency entirely:
//! reads return `None` and writes return [`CredentialError::Unsupported`].

use crate::tools::{SearchBackend, env_search_key};
use nightloom_providers::ProviderKind;

/// The keyring service name every entry is filed under. One service for the
/// whole app, which is why [`search_entry`] namespaces its half.
pub const KEYRING_SERVICE: &str = "nightloom";

/// Where a key came from.
///
/// Reported rather than the key itself: a settings pane needs to show that a
/// provider is configured, and showing *which* of the two routes supplied it
/// is what lets a user work out why the key they just typed is being ignored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeySource {
    /// The OS credential store.
    Stored,
    /// An environment variable.
    Env,
}

impl KeySource {
    pub fn label(self) -> &'static str {
        match self {
            Self::Stored => "stored",
            Self::Env => "env",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    /// The store rejected the operation, or there is no store to reject it.
    #[error("the credential store is unavailable: {0}")]
    Store(String),
    /// Built without the `keyring` feature.
    #[error("this build has no credential store (compiled without the `keyring` feature)")]
    Unsupported,
}

/// The credential-store entry for a search backend.
///
/// Namespaced rather than stored under the bare name: provider labels and
/// backend names share one keyring service, and a future provider called
/// "brave" would otherwise silently read a search key as its API key.
fn search_entry(backend: SearchBackend) -> String {
    format!("search:{}", backend.name())
}

// ---------------------------------------------------------------------------
// The store itself — the one place `keyring` is touched.
// ---------------------------------------------------------------------------

#[cfg(feature = "keyring")]
mod store {
    use super::{CredentialError, KEYRING_SERVICE};

    /// A stored secret, or `None` for every reason a store can fail.
    ///
    /// Deliberately lossy: a missing entry, a locked keyring and an absent
    /// D-Bus session are all "no stored key" to a caller that is about to
    /// try the environment next. The distinction would matter if this
    /// blocked or prompted, and it does neither.
    pub(super) fn get(entry: &str) -> Option<String> {
        keyring::Entry::new(KEYRING_SERVICE, entry)
            .ok()
            .and_then(|e| e.get_password().ok())
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
    }

    pub(super) fn set(entry: &str, key: &str) -> Result<(), CredentialError> {
        keyring::Entry::new(KEYRING_SERVICE, entry)
            .and_then(|e| e.set_password(key))
            .map_err(|e| CredentialError::Store(e.to_string()))
    }

    /// Removing an entry that is not there is success, not an error: `clear`
    /// is asked for to reach a state, and that state is already the case.
    pub(super) fn clear(entry: &str) -> Result<(), CredentialError> {
        let entry = match keyring::Entry::new(KEYRING_SERVICE, entry) {
            Ok(entry) => entry,
            Err(e) => return Err(CredentialError::Store(e.to_string())),
        };
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(CredentialError::Store(e.to_string())),
        }
    }
}

#[cfg(not(feature = "keyring"))]
mod store {
    use super::CredentialError;

    pub(super) fn get(_entry: &str) -> Option<String> {
        None
    }

    pub(super) fn set(_entry: &str, _key: &str) -> Result<(), CredentialError> {
        Err(CredentialError::Unsupported)
    }

    pub(super) fn clear(_entry: &str) -> Result<(), CredentialError> {
        Err(CredentialError::Unsupported)
    }
}

/// Whether this build can store a key at all. A shell offering a `set`
/// command that can only ever fail should say so up front instead.
pub const fn store_available() -> bool {
    cfg!(feature = "keyring")
}

// ---------------------------------------------------------------------------
// Provider keys
// ---------------------------------------------------------------------------

/// This provider's key as stored in-app, ignoring the environment.
///
/// `openai-chat` falls back to `openai`'s stored entry, mirroring the shared
/// `OPENAI_API_KEY` the two already read from the environment.
pub fn stored_provider_key(kind: ProviderKind) -> Option<String> {
    store::get(kind.label()).or_else(|| match kind {
        ProviderKind::OpenaiChat => store::get(ProviderKind::Openai.label()),
        _ => None,
    })
}

/// The key this provider will actually connect with: stored first, then the
/// environment.
///
/// This is the function both shells call. Passing the result to
/// [`crate::connect`] as an explicit `api_key` — rather than letting the
/// registry reach for the environment itself — is what keeps the order
/// stated in one place; the registry's own fallback then only ever runs for
/// a caller that has not asked this question at all.
pub fn provider_key(kind: ProviderKind) -> Option<String> {
    stored_provider_key(kind).or_else(|| kind.key_from_env())
}

/// Where this provider's key comes from, or `None` if it has none.
pub fn provider_key_source(kind: ProviderKind) -> Option<KeySource> {
    if stored_provider_key(kind).is_some() {
        Some(KeySource::Stored)
    } else if kind.key_from_env().is_some() {
        Some(KeySource::Env)
    } else {
        None
    }
}

/// Store this provider's key. An empty key clears the entry instead, so a UI
/// that submits a blanked box means what it looks like it means.
pub fn set_provider_key(kind: ProviderKind, key: &str) -> Result<(), CredentialError> {
    let key = key.trim();
    if key.is_empty() {
        return clear_provider_key(kind);
    }
    store::set(kind.label(), key)
}

pub fn clear_provider_key(kind: ProviderKind) -> Result<(), CredentialError> {
    store::clear(kind.label())
}

// ---------------------------------------------------------------------------
// Search-backend keys
// ---------------------------------------------------------------------------

/// This backend's key as stored in-app, ignoring the environment.
pub fn stored_search_key(backend: SearchBackend) -> Option<String> {
    store::get(&search_entry(backend))
}

/// The key this backend will actually query with: stored first, then the
/// environment.
///
/// The order matters more here than it does for providers, for a reason that
/// has nothing to do with preference: a desktop process inherits whatever
/// environment its launcher had, which on Windows is usually nothing at all,
/// so the store is the only route that works for an app started from a
/// Start-menu shortcut.
pub fn search_key(backend: SearchBackend) -> Option<String> {
    stored_search_key(backend).or_else(|| env_search_key(backend))
}

/// Where this backend's key comes from, or `None` if it has none.
pub fn search_key_source(backend: SearchBackend) -> Option<KeySource> {
    if stored_search_key(backend).is_some() {
        Some(KeySource::Stored)
    } else if env_search_key(backend).is_some() {
        Some(KeySource::Env)
    } else {
        None
    }
}

/// Store a search backend's key. An empty key clears the entry.
pub fn set_search_key(backend: SearchBackend, key: &str) -> Result<(), CredentialError> {
    let key = key.trim();
    if key.is_empty() {
        return clear_search_key(backend);
    }
    store::set(&search_entry(backend), key)
}

pub fn clear_search_key(backend: SearchBackend) -> Result<(), CredentialError> {
    store::clear(&search_entry(backend))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The namespacing is the whole defence against a provider and a search
    /// backend colliding on one name, so it is worth pinning against someone
    /// "simplifying" it back to the bare name.
    #[test]
    fn a_search_entry_cannot_collide_with_a_provider_label() {
        for backend in SearchBackend::ALL {
            let entry = search_entry(backend);
            assert!(entry.starts_with("search:"));
            assert!(
                ProviderKind::ALL.iter().all(|k| k.label() != entry),
                "search entry {entry} collides with a provider label"
            );
        }
    }

    /// Reads must not panic when there is no store, no session bus and no
    /// unlocked keyring — the ordinary state in CI, and the state this whole
    /// module is `Option`-shaped for.
    #[test]
    fn a_missing_store_reads_as_no_key_rather_than_a_panic() {
        for kind in ProviderKind::ALL {
            let _ = stored_provider_key(kind);
            let _ = provider_key_source(kind);
        }
        for backend in SearchBackend::ALL {
            let _ = stored_search_key(backend);
            let _ = search_key_source(backend);
        }
    }

    /// The two share an environment variable, so the store is not the one
    /// place they should stop agreeing.
    #[test]
    fn openai_chat_shares_openais_credentials() {
        assert_eq!(
            ProviderKind::OpenaiChat.env_key(),
            ProviderKind::Openai.env_key()
        );
    }
}
