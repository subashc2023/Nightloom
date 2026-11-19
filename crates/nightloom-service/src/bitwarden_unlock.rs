//! Unlock Bitwarden with Touch ID, and pre-arm a run (nightshift item 826;
//! his answer on blocker 2102, 2026-11-17: "a Nightloom button, Touch ID
//! releases the master password from the Keychain, Nightloom unlocks bw
//! itself, vault open until quit / sleep / screen lock").
//!
//! Two seams keep this testable with nobody at the Mac: [`Presence`] is
//! "confirm it is him" (the desktop's LocalAuthentication sheet — Touch ID,
//! falling back to the login password), and [`MasterStore`] is where the
//! master password lives (the Keychain, [`KeychainMaster`]). Tests use
//! stand-ins for both and a stand-in `bw`; nothing here can raise a system
//! dialog by itself.
//!
//! The master password goes: Keychain → this process → the one `bw unlock`
//! child's environment ([`crate::bitwarden::PASSWORD_ENV`]). Never argv, a
//! file, a log, an event to the window, or the model's view. Set up is the
//! one time he types it (Settings or the card); it is stored only once `bw`
//! has accepted it. A small marker file (`bitwarden-touchid.json`, no
//! secret in it) says it is stored, so the window can draw the right button
//! without reading the Keychain.

use std::path::Path;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::bitwarden::{ArmView, Ready, Rule, Vault};

/// The marker in the config directory: stored or not, never the password.
pub const MARKER_FILE: &str = "bitwarden-touchid.json";

/// Why "confirm it is him" did not pass.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PresenceError {
    /// He pressed Cancel (or the system cancelled the sheet).
    Cancelled,
    /// This Mac cannot ask (no Touch ID and no login password, or no
    /// LocalAuthentication).
    Unavailable(String),
    /// Asked, and it failed (a wrong password three times …).
    Failed(String),
}

impl PresenceError {
    /// The card's words.
    pub fn words(&self) -> String {
        match self {
            PresenceError::Cancelled => "Touch ID was cancelled: Bitwarden stays locked.".into(),
            PresenceError::Unavailable(why) => {
                format!("This Mac cannot confirm it is you ({why}): Bitwarden stays locked.")
            }
            PresenceError::Failed(why) => format!("Touch ID did not pass ({why})."),
        }
    }
}

/// "Confirm it is him": Touch ID, falling back to the login password.
pub trait Presence: Send + Sync {
    /// Ask, with `reason` on the system sheet ("Nightloom wants to …").
    fn confirm(&self, reason: &str) -> Result<(), PresenceError>;
}

/// Where the master password lives.
pub trait MasterStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn put(&self, password: &str) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

/// The Keychain ([`crate::credentials::bitwarden_master`]).
#[derive(Debug, Default, Clone, Copy)]
pub struct KeychainMaster;

impl MasterStore for KeychainMaster {
    fn get(&self) -> Result<Option<String>, String> {
        crate::credentials::bitwarden_master().map_err(|e| e.to_string())
    }
    fn put(&self, password: &str) -> Result<(), String> {
        crate::credentials::set_bitwarden_master(password).map_err(|e| e.to_string())
    }
    fn clear(&self) -> Result<(), String> {
        crate::credentials::clear_bitwarden_master().map_err(|e| e.to_string())
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Marker {
    #[serde(default)]
    stored: bool,
    #[serde(default)]
    since: Option<String>,
}

/// Whether a master password is stored (by the marker; no Keychain read).
pub fn stored(home: &Path) -> bool {
    std::fs::read(home.join(MARKER_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<Marker>(&b).ok())
        .is_some_and(|m| m.stored)
}

fn write_marker(home: &Path, stored: bool) -> Result<(), String> {
    std::fs::create_dir_all(home).map_err(|e| e.to_string())?;
    let m = Marker {
        stored,
        since: stored.then(|| chrono::Utc::now().to_rfc3339()),
    };
    let bytes = serde_json::to_vec_pretty(&m).map_err(|e| e.to_string())?;
    std::fs::write(home.join(MARKER_FILE), bytes).map_err(|e| e.to_string())
}

/// What the window shows: never a value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TouchStatus {
    /// A master password is stored (Touch ID unlock is set up).
    pub stored: bool,
    /// Nightloom holds an open session now.
    pub session: bool,
    /// The pre-arm, if one runs.
    pub armed: Option<ArmView>,
}

pub fn status(vault: &Vault, home: Option<&Path>) -> TouchStatus {
    TouchStatus {
        stored: home.is_some_and(stored),
        session: vault.holds_session(),
        armed: vault.armed_view(),
    }
}

/// Set up: he typed the master password once. `bw` must accept it (this
/// also opens the vault); only then is it stored and marked.
pub fn set_up(
    vault: &Vault,
    master: &dyn MasterStore,
    home: &Path,
    password: &str,
) -> Result<Ready, String> {
    let ready = vault.unlock_with_password(password).map_err(|e| {
        if e == crate::bitwarden::WRONG_PASSWORD {
            crate::bitwarden::WRONG_TYPED.to_string()
        } else {
            e
        }
    })?;
    if ready != Ready::Unlocked {
        return Ok(ready);
    }
    master
        .put(password)
        .map_err(|e| format!("Unlocked, but the Keychain did not keep it ({e})."))?;
    write_marker(home, true).map_err(|e| format!("Unlocked and kept, but {e}."))?;
    Ok(Ready::Unlocked)
}

/// Forget the stored master password (Settings).
pub fn forget(master: &dyn MasterStore, home: &Path) -> Result<(), String> {
    master.clear()?;
    write_marker(home, false)
}

/// The master password, after Touch ID.
fn released(
    presence: &dyn Presence,
    master: &dyn MasterStore,
    reason: &str,
) -> Result<String, String> {
    presence.confirm(reason).map_err(|e| e.words())?;
    match master.get() {
        Ok(Some(p)) => Ok(p),
        Ok(None) => Err("No master password is kept yet: set up Touch ID unlock first.".into()),
        Err(e) => Err(format!("The Keychain did not give it back ({e}).")),
    }
}

/// *Unlock with Touch ID*: an open session is kept as is (no sheet);
/// otherwise Touch ID, the Keychain, `bw unlock`.
pub fn unlock(
    vault: &Vault,
    presence: &dyn Presence,
    master: &dyn MasterStore,
) -> Result<Ready, String> {
    if vault.holds_session() {
        return Ok(Ready::Unlocked);
    }
    if vault.program().is_none() {
        return Ok(Ready::Missing);
    }
    let password = released(
        presence,
        master,
        "unlock Bitwarden until you quit, sleep or lock the screen",
    )?;
    vault.unlock_with_password(&password)
}

/// The pre-arm: the rules named by id (only Always rules can answer
/// without him, so only they can be armed), until `until`. One Touch ID,
/// `bw unlock`, the values fetched, and the vault locked again at once —
/// even if it was open before.
pub fn arm(
    vault: &Vault,
    presence: &dyn Presence,
    master: &dyn MasterStore,
    home: &Path,
    rule_ids: &[String],
    until: SystemTime,
) -> Result<ArmView, String> {
    let picked: Vec<Rule> = crate::bitwarden::rules(home)
        .into_iter()
        .filter(|r| rule_ids.contains(&r.id))
        .collect();
    if picked.is_empty() {
        return Err("Nothing was picked to pre-arm.".into());
    }
    if until <= SystemTime::now() {
        return Err("That end time has already passed.".into());
    }
    if vault.program().is_none() {
        return Err("Bitwarden's bw is not installed.".into());
    }
    if !vault.holds_session() {
        let n = picked.len();
        let reason = format!(
            "fetch {n} Bitwarden secret{} for tonight's run, then lock the vault",
            if n == 1 { "" } else { "s" }
        );
        let password = released(presence, master, &reason)?;
        match vault.unlock_with_password(&password)? {
            Ready::Unlocked => {}
            Ready::Unauthenticated => {
                return Err("Bitwarden is signed out: run `bw login` in Terminal.".into());
            }
            _ => return Err("Bitwarden did not unlock.".into()),
        }
    }
    vault.arm_from_session(&picked, until)
}

// Unix only: every test here runs a `#!/bin/sh` stand-in made executable
// with a Unix mode, which Windows can neither mark nor run.
#[cfg(all(test, unix))]
#[path = "bitwarden_826_tests.rs"]
mod tests;
