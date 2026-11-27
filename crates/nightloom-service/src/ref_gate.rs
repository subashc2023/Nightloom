//! One gate on the Mac for a card's actions from both of his screens
//! (nightshift item 993f): the Mac window's card and the phone's sheet.
//!
//! **The phone's tap is his click.** A connector action from the phone
//! takes two requests: `POST /home/ref/tap` when he presses the confirm
//! (for a mail, the start of its 5 s hold) and `POST /home/ref/act` when it
//! is let go. The tap is one-time and bound to the call's exact
//! [`fingerprint`] — the tool, every pinned argument, the SHA-256 of the
//! words — so `/act` runs only the call he tapped, once, only after the
//! hold for a mail and before the tap expires. Without a live tap `/act`
//! runs nothing. What runs then is 993d/993e's own path unchanged: the
//! window crate's one [`crate::ref_action::mint`] caller, the pass, the
//! hook, the guard (blocker 2304).
//!
//! **One send per item across both screens.** One tap per item at a time;
//! one send going per item; a tap minted before the other screen's send for
//! that item finished is refused when redeemed; the Mac window's own send
//! is refused while the phone holds a mail for the item.
//!
//! **The "may have gone" lock** (993e review, finding 4) is kept on disk
//! (`ref-actions/maybe.json`) so both screens show it and either one's "I
//! checked: not sent" clears it.

use crate::ref_action::{Call, Pass};
use chrono::{DateTime, Duration, Utc};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// A mail's hold, as the phone counts it (`mailHold.ts` `MAIL_HOLD_MS`).
pub const HOLD_MS: i64 = 5_000;
/// How much earlier than the hold's end a redeem is still taken (the
/// phone's timer and the request's trip).
pub const HOLD_SLACK_MS: i64 = 400;
/// How long a tap lasts past its hold: a phone that comes back later than
/// this finds its tap gone, and nothing is sent.
pub const TAP_GRACE_MS: i64 = 20_000;

/// The words a refused redeem carries when no tap of his stands behind it.
pub const NO_TAP: &str = "No tap of yours on the phone stands behind this, so nothing was sent.";

/// The call's fingerprint: what a tap is bound to.
pub fn fingerprint(call: &Call) -> String {
    let p = Pass::of(call, Utc::now());
    let pinned = serde_json::to_string(&p.pinned).unwrap_or_default();
    crate::sync::manifest::sha256_hex(
        format!("{}\n{}\n{}", p.tool, pinned, p.words_sha256).as_bytes(),
    )
}

/// A mail that goes (a reply or a forward): what waits for the hold.
pub fn is_mail(call: &Call) -> bool {
    call.sends && (call.tool.ends_with("__reply") || call.tool.ends_with("__forward"))
}

#[derive(Debug, Clone)]
struct Tap {
    key: String,
    fp: String,
    sends: bool,
    at: DateTime<Utc>,
    expires: DateTime<Utc>,
}

/// What a tap is, for the phone.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Tapped {
    pub tap: String,
    /// How long the phone holds a mail before it lets it go (0: not a mail).
    pub hold_ms: i64,
}

/// The gate's state: in memory (a quit forgets the taps, so nothing a tap
/// stood for can run after a restart).
#[derive(Debug, Default)]
pub struct Gate {
    taps: HashMap<String, Tap>,
    going: HashSet<String>,
    last_sent: HashMap<String, DateTime<Utc>>,
}

impl Gate {
    fn sweep(&mut self, now: DateTime<Utc>) {
        self.taps.retain(|_, t| t.expires > now);
    }

    fn live_tap(&self, key: &str) -> bool {
        self.taps.values().any(|t| t.key == key)
    }

    /// His press on the phone's confirm: a one-time tap for exactly `call`.
    pub fn tap(&mut self, key: &str, call: &Call, now: DateTime<Utc>) -> Result<Tapped, String> {
        self.sweep(now);
        if self.going.contains(key) {
            return Err("this is already on its way".into());
        }
        if self.live_tap(key) {
            return Err("a mail for this is already in its hold".into());
        }
        let hold = if is_mail(call) { HOLD_MS } else { 0 };
        let id = uuid::Uuid::new_v4().simple().to_string();
        self.taps.insert(
            id.clone(),
            Tap {
                key: key.to_string(),
                fp: fingerprint(call),
                sends: hold > 0,
                at: now,
                expires: now + Duration::milliseconds(hold + TAP_GRACE_MS),
            },
        );
        Ok(Tapped {
            tap: id,
            hold_ms: hold,
        })
    }

    /// The tap let go: spent here, whatever comes of the call. `Ok` means
    /// the call may run now, and the item is marked going until [`end`].
    pub fn redeem(
        &mut self,
        id: &str,
        key: &str,
        call: &Call,
        now: DateTime<Utc>,
    ) -> Result<(), String> {
        self.sweep(now);
        let Some(t) = self.taps.get(id).cloned() else {
            return Err(NO_TAP.into());
        };
        if t.key != key || t.fp != fingerprint(call) {
            // Not the call he tapped: refused, and the tap stays his.
            return Err(format!(
                "This is not what you tapped, so nothing was sent. {NO_TAP}"
            ));
        }
        if t.sends && now < t.at + Duration::milliseconds(HOLD_MS - HOLD_SLACK_MS) {
            return Err("The hold had not ended, so nothing was sent.".into());
        }
        self.taps.remove(id);
        if self.going.contains(key) {
            return Err("this is already on its way".into());
        }
        if self.last_sent.get(key).is_some_and(|s| *s >= t.at) {
            return Err(
                "This went from your other screen while you held it, so nothing more was sent."
                    .into(),
            );
        }
        self.going.insert(key.to_string());
        Ok(())
    }

    /// His Undo on the phone: the tap goes (a lost Undo changes nothing:
    /// the tap expires unspent).
    pub fn undo(&mut self, id: &str) {
        self.taps.remove(id);
    }

    /// The Mac window's own click (its hold is in the window): refused
    /// while the phone holds a mail for the item or one is going.
    pub fn begin_here(&mut self, key: &str, now: DateTime<Utc>) -> Result<(), String> {
        self.sweep(now);
        if self.going.contains(key) {
            return Err("this is already on its way".into());
        }
        if self.taps.values().any(|t| t.key == key && t.sends) {
            return Err("a mail for this is in its hold on your phone".into());
        }
        self.going.insert(key.to_string());
        Ok(())
    }

    /// A call for `key` ended; `done` when the connector said it went.
    pub fn end(&mut self, key: &str, done: bool, now: DateTime<Utc>) {
        self.going.remove(key);
        if done {
            self.last_sent.insert(key.to_string(), now);
        }
    }

    /// Whether a send for `key` is going or held on the phone.
    pub fn busy(&mut self, key: &str, now: DateTime<Utc>) -> (bool, bool) {
        self.sweep(now);
        (self.going.contains(key), self.live_tap(key))
    }
}

/// The one gate of this process.
pub fn gate() -> &'static Mutex<Gate> {
    static GATE: OnceLock<Mutex<Gate>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(Gate::default()))
}

/// Run `f` on the one gate.
pub fn with<T>(f: impl FnOnce(&mut Gate) -> T) -> T {
    let mut g = gate().lock().unwrap_or_else(|p| p.into_inner());
    f(&mut g)
}

fn maybe_file(config: &Path) -> PathBuf {
    config.join("ref-actions").join("maybe.json")
}

fn maybe_all(config: &Path) -> BTreeMap<String, String> {
    std::fs::read_to_string(maybe_file(config))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn maybe_write(config: &Path, all: &BTreeMap<String, String>) {
    let path = maybe_file(config);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string_pretty(all) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// A send for `key` may have gone: `why`, until he says he checked.
pub fn maybe_mark(config: &Path, key: &str, why: &str) {
    let mut all = maybe_all(config);
    all.insert(key.to_string(), why.to_string());
    maybe_write(config, &all);
}

/// The kept "may have gone" lock of `key`, if any.
pub fn maybe_of(config: &Path, key: &str) -> Option<String> {
    maybe_all(config).remove(key)
}

/// He checked Gmail's Sent: the lock goes.
pub fn maybe_clear(config: &Path, key: &str) {
    let mut all = maybe_all(config);
    if all.remove(key).is_some() {
        maybe_write(config, &all);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ref_action::{Act, Item, Recipients, call_for};

    fn item(id: &str) -> Item {
        Item {
            kind: "email".into(),
            id: id.into(),
            src: "claude.ai Gmail 2117773e".into(),
            cal: None,
            name: "Speaker confirmation".into(),
        }
    }
    fn reply(body: &str) -> Act {
        Act::Send {
            mode: "reply".into(),
            to: "Client Co".into(),
            body: body.into(),
            recipients: Some(Recipients {
                to: vec!["client@co.example".into()],
                cc: vec![],
            }),
        }
    }
    fn t0() -> DateTime<Utc> {
        "2026-11-27T14:00:00Z".parse().unwrap()
    }
    const KEY: &str = "email:claude.ai Gmail 2117773e:m1";

    #[test]
    fn a_redeem_needs_his_tap_for_exactly_that_call_after_the_hold() {
        let it = item("m1");
        let call = call_for(&it, &reply("Yes, Thursday works.")).unwrap();
        let mut g = Gate::default();
        // No tap at all: nothing runs.
        assert_eq!(g.redeem("made-up", KEY, &call, t0()).unwrap_err(), NO_TAP);
        let t = g.tap(KEY, &call, t0()).unwrap();
        assert_eq!(t.hold_ms, HOLD_MS);
        // Another body under his tap: refused, the tap stays his.
        let other = call_for(&it, &reply("Yes, Friday works.")).unwrap();
        let s = t0() + Duration::seconds(6);
        assert!(
            g.redeem(&t.tap, KEY, &other, s)
                .unwrap_err()
                .contains("not what you tapped")
        );
        // Before the hold ended: refused.
        assert!(
            g.redeem(&t.tap, KEY, &call, t0() + Duration::seconds(2))
                .is_err()
        );
        // After it: once.
        g.redeem(&t.tap, KEY, &call, s).unwrap();
        assert!(g.redeem(&t.tap, KEY, &call, s).is_err());
        g.end(KEY, true, s);
    }

    #[test]
    fn an_undone_or_expired_tap_sends_nothing() {
        let call = call_for(&item("m2"), &reply("ok")).unwrap();
        let key = "email:claude.ai Gmail 2117773e:m2";
        let mut g = Gate::default();
        let t = g.tap(key, &call, t0()).unwrap();
        g.undo(&t.tap);
        assert_eq!(
            g.redeem(&t.tap, key, &call, t0() + Duration::seconds(6))
                .unwrap_err(),
            NO_TAP
        );
        // A phone that comes back after the tap's grace finds it gone.
        let t = g.tap(key, &call, t0()).unwrap();
        let late = t0() + Duration::milliseconds(HOLD_MS + TAP_GRACE_MS + 1);
        assert_eq!(g.redeem(&t.tap, key, &call, late).unwrap_err(), NO_TAP);
    }

    #[test]
    fn one_send_per_item_across_the_mac_and_the_phone() {
        let call = call_for(&item("m3"), &reply("ok")).unwrap();
        let key = "email:claude.ai Gmail 2117773e:m3";
        let mut g = Gate::default();
        let t = g.tap(key, &call, t0()).unwrap();
        // A second tap while the first is held: refused.
        assert!(g.tap(key, &call, t0()).is_err());
        // The Mac's own send while the phone holds one: refused.
        assert!(g.begin_here(key, t0()).unwrap_err().contains("phone"));
        g.undo(&t.tap);
        // The phone taps, then the Mac's send goes first (begun before the
        // tap in real life: its own hold ran in the window).
        let mut g = Gate::default();
        g.begin_here(key, t0()).unwrap();
        assert!(g.tap(key, &call, t0()).is_err(), "a send is going");
        g.end(key, true, t0() + Duration::seconds(1));
        let t = g.tap(key, &call, t0()).unwrap();
        // A tap minted before the other screen's send ended is refused.
        assert!(
            g.redeem(&t.tap, key, &call, t0() + Duration::seconds(6))
                .is_err()
        );
    }

    #[test]
    fn the_maybe_lock_is_kept_on_disk_until_he_checked() {
        let dir = std::env::temp_dir().join(format!("ref-gate-{}", uuid::Uuid::new_v4()));
        assert_eq!(maybe_of(&dir, KEY), None);
        maybe_mark(&dir, KEY, "It may have gone.");
        assert_eq!(maybe_of(&dir, KEY).as_deref(), Some("It may have gone."));
        maybe_clear(&dir, KEY);
        assert_eq!(maybe_of(&dir, KEY), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
