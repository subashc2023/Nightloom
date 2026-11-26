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
    /// The phone token comes from `NIGHTLOOM_REMOTE_TOKEN`, so it cannot be
    /// replaced from the app (item 1003).
    #[error("the phone token comes from NIGHTLOOM_REMOTE_TOKEN; change it there")]
    FromEnv,
    /// A scratch home (`NIGHTLOOM_HOME`) with no `NIGHTLOOM_REMOTE_TOKEN`:
    /// the real keychain entry is never touched (item 1003).
    #[error(
        "this is a dev home (NIGHTLOOM_HOME is set): the phone page needs NIGHTLOOM_REMOTE_TOKEN here, and the keychain's real token is never used"
    )]
    DevHome,
    /// `NIGHTLOOM_REMOTE_TOKEN` is not 16–128 hex characters: the phone page
    /// reads only a hex `#token=` (client.ts `tokenFromHash`), so it could
    /// never pair (item 1014, the 740 Simulator audit).
    #[error(
        "NIGHTLOOM_REMOTE_TOKEN must be 16 to 128 hex characters (0-9, a-f) — the phone page reads no other token, so this one could never pair; make one with `openssl rand -hex 32`"
    )]
    EnvNotHex,
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

    /// A stored secret, `Ok(None)` when there is none, and `Err` when the
    /// store could not say — a locked keychain, a denied prompt after a
    /// re-signed build. For the one caller that would *replace* a secret
    /// it cannot read (the remote token: a regenerated token un-pairs
    /// every phone; review 2026-09-17 FA4, backlog 132), where "absent"
    /// and "could not read" must not be the same answer.
    pub(super) fn try_get(entry: &str) -> Result<Option<String>, CredentialError> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, entry)
            .map_err(|e| CredentialError::Store(e.to_string()))?;
        match entry.get_password() {
            Ok(k) => {
                let k = k.trim().to_string();
                Ok((!k.is_empty()).then_some(k))
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(CredentialError::Store(e.to_string())),
        }
    }

    /// [`try_get`] without the trim (item 826: a master password may
    /// begin or end with a space).
    pub(super) fn try_get_raw(entry: &str) -> Result<Option<String>, CredentialError> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, entry)
            .map_err(|e| CredentialError::Store(e.to_string()))?;
        match entry.get_password() {
            Ok(k) => Ok((!k.is_empty()).then_some(k)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(CredentialError::Store(e.to_string())),
        }
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

    /// No store: nothing is stored, and that is known for certain.
    pub(super) fn try_get(_entry: &str) -> Result<Option<String>, CredentialError> {
        Ok(None)
    }

    pub(super) fn try_get_raw(_entry: &str) -> Result<Option<String>, CredentialError> {
        Ok(None)
    }

    pub(super) fn set(_entry: &str, _key: &str) -> Result<(), CredentialError> {
        Err(CredentialError::Unsupported)
    }

    pub(super) fn clear(_entry: &str) -> Result<(), CredentialError> {
        Err(CredentialError::Unsupported)
    }
}

/// Item 826: the Keychain entry holding his Bitwarden master password,
/// read only after Touch ID (`bitwarden_unlock`).
const BITWARDEN_MASTER: &str = "bitwarden-master";

/// The stored Bitwarden master password (item 826), untrimmed. Callers
/// confirm presence (Touch ID) first; never logged.
pub fn bitwarden_master() -> Result<Option<String>, CredentialError> {
    store::try_get_raw(BITWARDEN_MASTER)
}

/// Keep the Bitwarden master password (item 826, set up once).
pub fn set_bitwarden_master(password: &str) -> Result<(), CredentialError> {
    store::set(BITWARDEN_MASTER, password)
}

/// Forget the stored Bitwarden master password (item 826).
pub fn clear_bitwarden_master() -> Result<(), CredentialError> {
    store::clear(BITWARDEN_MASTER)
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

// ---------------------------------------------------------------------------
// The phone page's bearer token (nightshift backlog 091, 2026-09-16)
// ---------------------------------------------------------------------------

/// The credential-store entry for the remote listener's token. Namespaced
/// like the search keys, for the same reason: one keyring service for the
/// app, and `remote` must never read as a provider label.
const REMOTE_TOKEN_ENTRY: &str = "remote:token";

/// The environment variable that gives the phone token directly (item
/// 1003, blocker 2333). Read before the keychain; never written anywhere.
pub const REMOTE_TOKEN_ENV: &str = "NIGHTLOOM_REMOTE_TOKEN";

/// Where the phone token comes from, decided from three plain facts so a
/// test needs no keychain and no process environment (item 1003).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteTokenSource {
    /// `NIGHTLOOM_REMOTE_TOKEN` is set: use it, store nothing.
    Env(String),
    /// The normal app: the keychain entry.
    Keychain,
    /// A set `NIGHTLOOM_HOME` without the env token: a dev build must never
    /// reach the installed app's keychain token, so there is none.
    DevHomeWithoutToken,
    /// `NIGHTLOOM_REMOTE_TOKEN` is set but not a token the page can read
    /// (item 1014): refused at the listener's start, never served.
    EnvNotHex,
}

/// A token the phone page's `#token=` accepts: 16 to 128 hex characters
/// (`tokenFromHash` in `apps/desktop/src/remote/client.ts`; item 1014).
pub fn is_page_token(t: &str) -> bool {
    (16..=128).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The pure decision: the env token wins (blank counts as unset); else a
/// set home refuses; else the keychain.
pub fn remote_token_source(home_set: bool, env: Option<&str>) -> RemoteTokenSource {
    match env.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) if is_page_token(t) => RemoteTokenSource::Env(t.to_string()),
        Some(_) => RemoteTokenSource::EnvNotHex,
        None if home_set => RemoteTokenSource::DevHomeWithoutToken,
        None => RemoteTokenSource::Keychain,
    }
}

fn current_remote_source() -> RemoteTokenSource {
    let home_set = std::env::var_os("NIGHTLOOM_HOME").is_some_and(|h| !h.is_empty());
    remote_token_source(home_set, std::env::var(REMOTE_TOKEN_ENV).ok().as_deref())
}

/// The sentence for a dev home with no env token, for the listener's
/// start; `None` when the phone page may start here.
pub fn remote_listener_refusal() -> Option<String> {
    match current_remote_source() {
        RemoteTokenSource::DevHomeWithoutToken => Some(CredentialError::DevHome.to_string()),
        RemoteTokenSource::EnvNotHex => Some(CredentialError::EnvNotHex.to_string()),
        RemoteTokenSource::Env(_) | RemoteTokenSource::Keychain => None,
    }
}

/// The token the phone page must present, if one has been generated. No
/// environment fallback for the keychain case: a token is made by the app.
/// The env token (item 1003) is the one exception, and a dev home never
/// reads the keychain.
pub fn remote_token() -> Option<String> {
    match current_remote_source() {
        RemoteTokenSource::Env(t) => Some(t),
        RemoteTokenSource::Keychain => store::get(REMOTE_TOKEN_ENTRY),
        RemoteTokenSource::DevHomeWithoutToken | RemoteTokenSource::EnvNotHex => None,
    }
}

/// The token, with "none stored" told apart from "the store could not be
/// read": the listener's start and the Regenerate button must keep the
/// token he has on the latter rather than mint one (review 2026-09-17
/// FA4 — a keychain the OS would not open regenerated the token and
/// un-paired every phone). A dev home without the env token is an error,
/// so nothing mints or stores one.
pub fn try_remote_token() -> Result<Option<String>, CredentialError> {
    match current_remote_source() {
        RemoteTokenSource::Env(t) => Ok(Some(t)),
        RemoteTokenSource::Keychain => store::try_get(REMOTE_TOKEN_ENTRY),
        RemoteTokenSource::DevHomeWithoutToken => Err(CredentialError::DevHome),
        RemoteTokenSource::EnvNotHex => Err(CredentialError::EnvNotHex),
    }
}

/// Store the token. An empty one clears the entry, as the key setters do.
/// Refused under the env token and in a dev home, before the keychain is
/// reached (item 1003).
pub fn set_remote_token(token: &str) -> Result<(), CredentialError> {
    match current_remote_source() {
        RemoteTokenSource::Env(_) | RemoteTokenSource::EnvNotHex => {
            return Err(CredentialError::FromEnv);
        }
        RemoteTokenSource::DevHomeWithoutToken => return Err(CredentialError::DevHome),
        RemoteTokenSource::Keychain => {}
    }
    let token = token.trim();
    if token.is_empty() {
        return store::clear(REMOTE_TOKEN_ENTRY);
    }
    store::set(REMOTE_TOKEN_ENTRY, token)
}

// ---------------------------------------------------------------------------
// The Notion integration's token (nightshift backlog 319, 2026-10-06)
// ---------------------------------------------------------------------------

/// The credential-store entry for the read-only Notion integration's token:
/// service `nightloom`, account `notion:token` in the macOS keychain.
pub const NOTION_TOKEN_ENTRY: &str = "notion:token";

/// The environment variable read when the store has no token.
pub const NOTION_TOKEN_ENV: &str = "NIGHTLOOM_NOTION_TOKEN";

/// The Notion token, stored first, then the environment — the order every
/// other key here follows. Read only by the Notion tools, at the moment a
/// call needs it, and never written anywhere: no setter exists, because
/// he stores it himself (the keychain entry above) and the app must never
/// show or copy it.
pub fn notion_token() -> Option<String> {
    store::get(NOTION_TOKEN_ENTRY).or_else(|| {
        std::env::var(NOTION_TOKEN_ENV)
            .ok()
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
    })
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

    /// Item 1003: the env token wins, a blank one is unset, a set home
    /// without it refuses, and only the plain app reaches the keychain.
    #[test]
    fn the_remote_token_source_never_reaches_the_keychain_from_a_dev_home() {
        use RemoteTokenSource::*;
        assert_eq!(remote_token_source(false, None), Keychain);
        assert_eq!(remote_token_source(false, Some("  ")), Keychain);
        assert_eq!(remote_token_source(true, None), DevHomeWithoutToken);
        assert_eq!(remote_token_source(true, Some("")), DevHomeWithoutToken);
        let hex = "0123456789abcdef0123456789ABCDEF";
        assert_eq!(
            remote_token_source(true, Some(&format!(" {hex} "))),
            Env(hex.into())
        );
        assert_eq!(remote_token_source(false, Some(hex)), Env(hex.into()));
    }

    /// Item 1014 (740 audit): a token the phone page cannot read is refused
    /// at the start, with a sentence that says what shape it must have.
    #[test]
    fn a_non_hex_env_token_is_refused_not_served() {
        use RemoteTokenSource::*;
        // url-safe base64, as `secrets.token_urlsafe` makes: never pairs.
        assert_eq!(
            remote_token_source(true, Some("q3Zx-_8kPq3Zx-_8kPq3Zx-_8kPq3Zx")),
            EnvNotHex
        );
        assert_eq!(remote_token_source(false, Some("t")), EnvNotHex);
        assert_eq!(remote_token_source(true, Some("abc123")), EnvNotHex); // too short
        assert_eq!(remote_token_source(true, Some(&"a".repeat(129))), EnvNotHex);
        assert!(is_page_token(&"a".repeat(16)));
        assert!(is_page_token(&"F".repeat(128)));
        assert!(is_page_token(&crate::remote::token::generate()));
        let why = CredentialError::EnvNotHex.to_string();
        assert!(why.contains(REMOTE_TOKEN_ENV) && why.contains("hex"));
    }

    #[test]
    fn the_refusal_sentences_name_the_variable() {
        assert!(
            CredentialError::DevHome
                .to_string()
                .contains(REMOTE_TOKEN_ENV)
        );
        assert!(
            CredentialError::FromEnv
                .to_string()
                .contains(REMOTE_TOKEN_ENV)
        );
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
