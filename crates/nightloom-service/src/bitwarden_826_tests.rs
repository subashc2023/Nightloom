//! Item 826's checks, with a stand-in `bw`, a stand-in Touch ID and a
//! stand-in Keychain — nothing here can raise a system dialog: the master
//! password reaches `bw unlock` only through its environment (never argv);
//! the Touch ID session has no idle lapse but goes at a screen lock; a
//! cancelled Touch ID never runs `bw unlock`; set-up stores only a password
//! `bw` accepted; a pre-arm fetches only the picked rules, locks the vault
//! at once, answers a rule with no vault open, survives a screen lock and
//! ends at its time; a locked vault with a rule says so (the third answer).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use super::*;
use crate::bitwarden::{PASSWORD_ENV, Ready, Vault, WRONG_PASSWORD, add_rule, answer_by_rule_full};
use crate::secret::Store;

const MASTER: &str = " master 826 Pass Zq9 ";
const KEY: &str = "fakeSessionKey826AAAAbbbbCCCC==";
const ITEM: &str = "2a0e5c3a-7a2b-4c1d-9e8f-826826826826";
const ITEM2: &str = "3b0e5c3a-7a2b-4c1d-9e8f-826826826827";
const FAKE: &str = "bwFAKE826PassZq9xW2k";
const FAKE2: &str = "npmFAKE826TokenQ8vY3";

fn temp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("nightloom-826-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn item(id: &str, name: &str, pw: &str) -> String {
    serde_json::json!({
        "object": "item", "id": id, "name": name, "type": 1, "notes": null,
        "login": {"username": "u", "password": pw, "uris": []}, "fields": []
    })
    .to_string()
}

/// A stand-in `bw`: `unlock --raw --passwordenv X` prints the key when $X
/// is the master password; `status`/`get` by `BW_SESSION`. Arguments go to
/// `dir/bw-args`; each `get` id to `dir/bw-gets`.
fn fake_bw(dir: &Path) -> Vault {
    let (a, b) = (item(ITEM, "GitHub", FAKE), item(ITEM2, "npm", FAKE2));
    let body = format!(
        r##"#!/bin/sh
echo "$@" >> "{d}/bw-args"
case "$1" in
unlock)
  [ "$2" = "--raw" ] && [ "$3" = "--passwordenv" ] || {{ echo "bad call" >&2; exit 2; }}
  eval "pw=\${{$4}}"
  if [ "$pw" = "{master}" ]; then printf '%s' "{key}"; else echo "Invalid master password." >&2; exit 1; fi ;;
status)
  if [ "$BW_SESSION" = "{key}" ]; then echo '{{"status":"unlocked"}}'; else echo '{{"status":"locked"}}'; fi ;;
get)
  [ "$BW_SESSION" = "{key}" ] || {{ echo "Vault is locked." >&2; exit 1; }}
  echo "$3" >> "{d}/bw-gets"
  if [ "$3" = "{id}" ]; then printf '%s\n' '{a}'; elif [ "$3" = "{id2}" ]; then printf '%s\n' '{b}'; else echo "Not found." >&2; exit 1; fi ;;
esac
"##,
        d = dir.display(),
        master = MASTER,
        key = KEY,
        id = ITEM,
        id2 = ITEM2,
    );
    let path = dir.join("bw");
    std::fs::write(&path, body).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    Vault::on_path(format!("{}:/bin:/usr/bin", dir.display()), vec![])
}

fn args(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("bw-args")).unwrap_or_default()
}

/// A stand-in Touch ID: answers as told, counts the asks.
struct FakeTouch {
    answer: Result<(), PresenceError>,
    asks: Mutex<Vec<String>>,
}

impl FakeTouch {
    fn new(answer: Result<(), PresenceError>) -> Self {
        Self {
            answer,
            asks: Mutex::new(Vec::new()),
        }
    }
    fn count(&self) -> usize {
        self.asks.lock().unwrap().len()
    }
}

impl Presence for FakeTouch {
    fn confirm(&self, reason: &str) -> Result<(), PresenceError> {
        self.asks.lock().unwrap().push(reason.to_string());
        self.answer.clone()
    }
}

/// A stand-in Keychain.
#[derive(Default)]
struct FakeKeychain {
    pw: Mutex<Option<String>>,
    reads: Mutex<usize>,
}

impl MasterStore for FakeKeychain {
    fn get(&self) -> Result<Option<String>, String> {
        *self.reads.lock().unwrap() += 1;
        Ok(self.pw.lock().unwrap().clone())
    }
    fn put(&self, password: &str) -> Result<(), String> {
        *self.pw.lock().unwrap() = Some(password.to_string());
        Ok(())
    }
    fn clear(&self) -> Result<(), String> {
        *self.pw.lock().unwrap() = None;
        Ok(())
    }
}

fn keychain_with(pw: &str) -> FakeKeychain {
    let k = FakeKeychain::default();
    k.put(pw).unwrap();
    k
}

#[test]
fn the_master_password_reaches_bw_only_through_its_environment() {
    let d = temp("env");
    let vault = fake_bw(&d).with_idle(Duration::from_millis(1));
    assert_eq!(vault.unlock_with_password(MASTER).unwrap(), Ready::Unlocked);
    let a = args(&d);
    assert!(
        a.contains(&format!(
            "unlock --raw --passwordenv {PASSWORD_ENV} --nointeraction"
        )),
        "{a}"
    );
    assert!(!a.contains("Zq9"), "the password is on a command line: {a}");
    // No idle lapse for a Touch ID session (an idle of 1 ms has passed).
    std::thread::sleep(Duration::from_millis(20));
    assert!(vault.holds_session());
    assert_eq!(vault.ready(), Ready::Unlocked);
    // Sleep / screen lock forgets it at once.
    vault.on_screen_lock();
    assert!(!vault.holds_session());
}

#[test]
fn a_refused_password_holds_nothing_and_says_so() {
    let d = temp("wrong");
    let vault = fake_bw(&d);
    assert_eq!(
        vault.unlock_with_password("nope").unwrap_err(),
        WRONG_PASSWORD
    );
    assert!(!vault.holds_session());
    // The error never carries the password.
    assert!(!WRONG_PASSWORD.contains("nope"));
}

#[test]
fn a_cancelled_touch_id_never_reads_the_keychain_or_runs_unlock() {
    let d = temp("cancel");
    let vault = fake_bw(&d);
    let touch = FakeTouch::new(Err(PresenceError::Cancelled));
    let keys = keychain_with(MASTER);
    let e = unlock(&vault, &touch, &keys).unwrap_err();
    assert!(e.contains("cancelled"), "{e}");
    assert_eq!(*keys.reads.lock().unwrap(), 0);
    assert!(!args(&d).contains("unlock"));
    assert!(!vault.holds_session());
    // No biometry and no login password: said plainly.
    let none = FakeTouch::new(Err(PresenceError::Unavailable(
        "no Touch ID or login password".into(),
    )));
    assert!(
        unlock(&vault, &none, &keys)
            .unwrap_err()
            .contains("cannot confirm")
    );
}

#[test]
fn touch_id_unlocks_once_and_an_open_vault_asks_no_more() {
    let d = temp("touch");
    let vault = fake_bw(&d);
    let touch = FakeTouch::new(Ok(()));
    let keys = keychain_with(MASTER);
    assert_eq!(unlock(&vault, &touch, &keys).unwrap(), Ready::Unlocked);
    assert_eq!(unlock(&vault, &touch, &keys).unwrap(), Ready::Unlocked);
    assert_eq!(touch.count(), 1);
    // Nothing kept yet: told to set up.
    let empty = FakeKeychain::default();
    vault.on_screen_lock();
    assert!(
        unlock(&vault, &touch, &empty)
            .unwrap_err()
            .contains("set up")
    );
}

#[test]
fn set_up_stores_only_a_password_bw_accepted() {
    let d = temp("setup");
    let home = d.join("home");
    let vault = fake_bw(&d);
    let keys = FakeKeychain::default();
    assert!(set_up(&vault, &keys, &home, "wrong").is_err());
    assert!(keys.pw.lock().unwrap().is_none());
    assert!(!stored(&home));
    assert_eq!(
        set_up(&vault, &keys, &home, MASTER).unwrap(),
        Ready::Unlocked
    );
    assert_eq!(keys.pw.lock().unwrap().as_deref(), Some(MASTER));
    assert!(stored(&home));
    // The marker never holds it.
    let marker = std::fs::read_to_string(home.join(MARKER_FILE)).unwrap();
    assert!(!marker.contains("Zq9"), "{marker}");
    forget(&keys, &home).unwrap();
    assert!(!stored(&home));
    assert!(keys.pw.lock().unwrap().is_none());
}

#[test]
fn a_pre_arm_fetches_only_the_picked_rules_and_locks_at_once() {
    let d = temp("arm");
    let home = d.join("home");
    let vault = fake_bw(&d);
    let touch = FakeTouch::new(Ok(()));
    let keys = keychain_with(MASTER);
    let gh = add_rule(
        &home,
        "GITHUB_TOKEN",
        ITEM,
        "GitHub",
        "password",
        "gh release create v1",
    )
    .unwrap();
    let _npm = add_rule(&home, "NPM_TOKEN", ITEM2, "npm", "password", "npm publish").unwrap();
    let until = SystemTime::now() + Duration::from_secs(3600);
    let view = arm(
        &vault,
        &touch,
        &keys,
        &home,
        std::slice::from_ref(&gh.id),
        until,
    )
    .unwrap();
    assert_eq!(view.names, vec!["GITHUB_TOKEN".to_string()]);
    assert_eq!(touch.count(), 1);
    // Only the picked item was read, and the vault is locked again.
    let gets = std::fs::read_to_string(d.join("bw-gets")).unwrap();
    assert_eq!(gets.trim(), ITEM);
    assert!(!vault.holds_session());
    // A rule answers from the pre-arm with no vault open …
    let store = Store::at(d.join("store"));
    let (rule, _, locked) = answer_by_rule_full(
        &vault,
        &store,
        Some(&home),
        "c1",
        "GITHUB_TOKEN",
        Some("gh release create v2"),
    );
    assert!(rule.is_some() && locked.is_none());
    assert_eq!(store.held("c1", "GITHUB_TOKEN").unwrap().value(), FAKE);
    // … a rule not armed waits on the card and is named (never silent) …
    let (rule, _, locked) = answer_by_rule_full(
        &vault,
        &store,
        Some(&home),
        "c1",
        "NPM_TOKEN",
        Some("npm publish"),
    );
    assert!(rule.is_none());
    assert_eq!(locked.unwrap().name, "NPM_TOKEN");
    // … a screen lock keeps the pre-arm, End now drops it.
    vault.on_screen_lock();
    assert!(vault.armed_view().is_some());
    vault.disarm();
    assert!(vault.armed_view().is_none());
    let (rule, _, locked) = answer_by_rule_full(
        &vault,
        &store,
        Some(&home),
        "c2",
        "GITHUB_TOKEN",
        Some("gh release create v3"),
    );
    assert!(rule.is_none() && locked.is_some());
}

#[test]
fn a_pre_arm_ends_at_its_time_and_refuses_a_bad_one() {
    let d = temp("arm-time");
    let home = d.join("home");
    let vault = fake_bw(&d);
    let touch = FakeTouch::new(Ok(()));
    let keys = keychain_with(MASTER);
    let gh = add_rule(
        &home,
        "GITHUB_TOKEN",
        ITEM,
        "GitHub",
        "password",
        "gh release create",
    )
    .unwrap();
    let ids = vec![gh.id.clone()];
    let past = SystemTime::now() - Duration::from_secs(1);
    assert!(arm(&vault, &touch, &keys, &home, &ids, past).is_err());
    let far = SystemTime::now() + Duration::from_secs(48 * 3600);
    assert!(
        arm(&vault, &touch, &keys, &home, &ids, far)
            .unwrap_err()
            .contains("a day")
    );
    assert!(!vault.holds_session(), "a refused pre-arm still locks");
    assert!(arm(&vault, &touch, &keys, &home, &[], far).is_err());
    let soon = SystemTime::now() + Duration::from_millis(300);
    arm(&vault, &touch, &keys, &home, &ids, soon).unwrap();
    assert!(vault.armed_view().is_some());
    std::thread::sleep(Duration::from_millis(400));
    assert!(vault.armed_view().is_none());
    // A cancelled Touch ID arms nothing.
    let no = FakeTouch::new(Err(PresenceError::Cancelled));
    let later = SystemTime::now() + Duration::from_secs(60);
    assert!(arm(&vault, &no, &keys, &home, &ids, later).is_err());
    assert!(vault.armed_view().is_none());
}

/// Review 2026-11-18: a `bw unlock` still running when the Mac sleeps or
/// locks must not leave the vault open behind the lock.
#[test]
fn a_lock_during_bw_unlock_keeps_nothing() {
    let d = temp("race");
    let body = format!("#!/bin/sh\nsleep 1\nprintf '%s' \"{KEY}\"\n");
    let path = d.join("bw");
    std::fs::write(&path, body).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let vault = std::sync::Arc::new(Vault::on_path(
        format!("{}:/bin:/usr/bin", d.display()),
        vec![],
    ));
    let v = vault.clone();
    let t = std::thread::spawn(move || v.unlock_with_password(MASTER));
    std::thread::sleep(Duration::from_millis(300));
    vault.on_screen_lock();
    assert_eq!(
        t.join().unwrap().unwrap_err(),
        crate::bitwarden::LOCKED_MEANWHILE
    );
    assert!(!vault.holds_session());
    // With no lock in between, the same stand-in opens it.
    assert_eq!(vault.unlock_with_password(MASTER).unwrap(), Ready::Unlocked);
}

/// Review 2026-11-18: at set-up nothing is kept yet, so a refused password
/// is not called "the master password Nightloom keeps".
#[test]
fn set_up_names_a_refused_typed_password_plainly() {
    let d = temp("typed");
    let vault = fake_bw(&d);
    let keys = FakeKeychain::default();
    let e = set_up(&vault, &keys, &d, "nope").unwrap_err();
    assert_eq!(e, crate::bitwarden::WRONG_TYPED);
    assert!(keys.pw.lock().unwrap().is_none());
    assert!(!stored(&d));
}
