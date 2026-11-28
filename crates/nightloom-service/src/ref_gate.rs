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
//! **The tap is signed by the phone** (item 993g, blocker 2359). The
//! bearer both requests carry is shared and kept on the Mac, so it cannot
//! say the press was his. A tap is minted only for a phone he allowed on
//! the Mac ([`crate::phone_keys`]), with a fresh challenge; `/act` runs
//! only with that phone's signature over the tap's id and the challenge.
//! A tap is spent when redeemed, so a signature works once; a tap that
//! expired takes its challenge with it.
//!
//! **One send per item across both screens.** One tap per item at a time;
//! one send going per item; a tap minted before the other screen's send for
//! that item finished is refused when redeemed; the Mac window's own send
//! is refused while the phone holds a mail for the item.
//!
//! **The "may have gone" lock** (993e review, finding 4) is kept on disk
//! (`ref-actions/maybe.json`) so both screens show it and either one's "I
//! checked: not sent" clears it. **Only his own screens clear it** (review
//! 2026-11-27, finding 3): the Mac window's command, or the phone's
//! signature over the item and a fresh challenge ([`Gate::check`]); the
//! bearer alone can only add one. A copy is kept in memory too, so a shell
//! that deletes the file does not clear a lock this run set or read.
//!
//! **A dropped `/act`** (the phone's connection gone mid-call, so the
//! route's future is dropped) leaves no item "going" for good: [`Going`]
//! settles it to the "may have gone" lock once the hold and the call's
//! deadline have passed (review finding 4).

use crate::ref_action::{Call, Pass};
use chrono::{DateTime, Duration, Utc};
use std::collections::{BTreeMap, HashMap};
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

/// How long a "may have gone" check challenge lasts.
pub const CHECK_SECS: i64 = 60;
/// How long after a dropped `/act` its item is settled: a mail's hold and
/// the call's own deadline ([`crate::ref_action::TURN_SECS`]), so a call
/// still running somewhere is never raced by a second send.
pub const SETTLE_MS: u64 = HOLD_MS as u64 + crate::ref_action::TURN_SECS * 1000;
/// What the lock says for an item whose `/act` was dropped mid-call.
pub const DROPPED: &str = "Your phone lost your Mac while this was going, so it may have gone. Check Sent in Gmail before sending again.";

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
    /// The allowed phone this tap was minted for: only its signature
    /// redeems it (993g).
    phone: String,
    /// What that phone signs, beside the tap's id; made here, never reused.
    challenge: String,
    sends: bool,
    at: DateTime<Utc>,
    expires: DateTime<Utc>,
}

/// What a tap is, for the phone.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Tapped {
    pub tap: String,
    /// The Mac's challenge for this tap: the phone signs
    /// [`crate::phone_keys::tap_message`] of the two (993g).
    pub challenge: String,
    /// How long the phone holds a mail before it lets it go (0: not a mail).
    pub hold_ms: i64,
}

/// The gate's state: in memory (a quit forgets the taps, so nothing a tap
/// stood for can run after a restart).
#[derive(Debug, Default)]
pub struct Gate {
    taps: HashMap<String, Tap>,
    /// The items with a send going, each with its run (so a late settle
    /// of one run never ends a newer one).
    going: HashMap<String, u64>,
    runs: u64,
    last_sent: HashMap<String, DateTime<Utc>>,
    /// The "I checked" challenges out, by challenge.
    checks: HashMap<String, Check>,
}

#[derive(Debug, Clone)]
struct Check {
    key: String,
    phone: String,
    expires: DateTime<Utc>,
}

impl Gate {
    fn sweep(&mut self, now: DateTime<Utc>) {
        self.taps.retain(|_, t| t.expires > now);
        self.checks.retain(|_, c| c.expires > now);
    }

    fn start(&mut self, key: &str) -> u64 {
        self.runs += 1;
        self.going.insert(key.to_string(), self.runs);
        self.runs
    }

    fn live_tap(&self, key: &str) -> bool {
        self.taps.values().any(|t| t.key == key)
    }

    /// His press on the phone's confirm: a one-time tap for exactly `call`,
    /// for the allowed phone `phone` (the caller checked it is allowed).
    pub fn tap(
        &mut self,
        key: &str,
        call: &Call,
        phone: &str,
        now: DateTime<Utc>,
    ) -> Result<Tapped, String> {
        self.sweep(now);
        if self.going.contains_key(key) {
            return Err("this is already on its way".into());
        }
        if self.live_tap(key) {
            return Err("a mail for this is already in its hold".into());
        }
        let hold = if is_mail(call) { HOLD_MS } else { 0 };
        let id = uuid::Uuid::new_v4().simple().to_string();
        let challenge = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.taps.insert(
            id.clone(),
            Tap {
                key: key.to_string(),
                fp: fingerprint(call),
                phone: phone.to_string(),
                challenge: challenge.clone(),
                sends: hold > 0,
                at: now,
                expires: now + Duration::milliseconds(hold + TAP_GRACE_MS),
            },
        );
        Ok(Tapped {
            tap: id,
            challenge,
            hold_ms: hold,
        })
    }

    /// The tap let go: spent here, whatever comes of the call. `Ok(run)`
    /// means the call may run now, and the item is marked going until
    /// [`Gate::end`] (or [`Gate::settle`] of `run`).
    ///
    /// `signed(phone, message)` says whether the request carries the
    /// allowed phone's signature over `message` (the tap's id and its
    /// challenge, [`crate::phone_keys::tap_message`]); it is asked only for
    /// a live tap for exactly this call, and a refusal leaves the tap his.
    pub fn redeem(
        &mut self,
        id: &str,
        key: &str,
        call: &Call,
        now: DateTime<Utc>,
        signed: impl FnOnce(&str, &str) -> Result<(), String>,
    ) -> Result<u64, String> {
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
        signed(&t.phone, &crate::phone_keys::tap_message(id, &t.challenge))?;
        if t.sends && now < t.at + Duration::milliseconds(HOLD_MS - HOLD_SLACK_MS) {
            return Err("The hold had not ended, so nothing was sent.".into());
        }
        self.taps.remove(id);
        if self.going.contains_key(key) {
            return Err("this is already on its way".into());
        }
        if self.last_sent.get(key).is_some_and(|s| *s >= t.at) {
            return Err(
                "This went from your other screen while you held it, so nothing more was sent."
                    .into(),
            );
        }
        Ok(self.start(key))
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
        if self.going.contains_key(key) {
            return Err("this is already on its way".into());
        }
        if self.taps.values().any(|t| t.key == key && t.sends) {
            return Err("a mail for this is in its hold on your phone".into());
        }
        self.start(key);
        Ok(())
    }

    /// A call for `key` ended; `done` when the connector said it went.
    pub fn end(&mut self, key: &str, done: bool, now: DateTime<Utc>) {
        self.going.remove(key);
        if done {
            self.last_sent.insert(key.to_string(), now);
        }
    }

    /// The run `run` of `key` was dropped and never ended: it ends now.
    /// `true` when it was still going (the caller then sets the lock);
    /// `false` when it ended already or a newer run is going.
    pub fn settle(&mut self, key: &str, run: u64) -> bool {
        if self.going.get(key) == Some(&run) {
            self.going.remove(key);
            true
        } else {
            false
        }
    }

    /// Whether a send for `key` is going or held on the phone.
    pub fn busy(&mut self, key: &str, now: DateTime<Utc>) -> (bool, bool) {
        self.sweep(now);
        (self.going.contains_key(key), self.live_tap(key))
    }

    /// A one-time challenge for the allowed phone `phone` to sign
    /// ([`crate::phone_keys::checked_message`]) when he says he checked
    /// `key` (the caller checked the phone is allowed).
    pub fn check(&mut self, key: &str, phone: &str, now: DateTime<Utc>) -> String {
        self.sweep(now);
        let challenge = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.checks.insert(
            challenge.clone(),
            Check {
                key: key.to_string(),
                phone: phone.to_string(),
                expires: now + Duration::seconds(CHECK_SECS),
            },
        );
        challenge
    }

    /// The challenge spent: the phone it was made for, if it is live and
    /// for `key`. Spent whatever the signature turns out to be.
    pub fn take_check(&mut self, challenge: &str, key: &str, now: DateTime<Utc>) -> Option<String> {
        self.sweep(now);
        let c = self.checks.remove(challenge)?;
        (c.key == key).then_some(c.phone)
    }
}

/// An `/act` call under way. Dropped before [`Going::ended`] (the phone's
/// connection went, so the route's future was dropped mid-call), it
/// settles the run after [`SETTLE_MS`]: the item stops being "going" and,
/// for a mail, gets the "may have gone" lock (review finding 4).
pub struct Going {
    key: String,
    run: u64,
    config: Option<PathBuf>,
    mail: bool,
    after: std::time::Duration,
    armed: bool,
}

impl Going {
    pub fn new(key: &str, run: u64, config: Option<PathBuf>, mail: bool) -> Self {
        Self::after(
            key,
            run,
            config,
            mail,
            std::time::Duration::from_millis(SETTLE_MS),
        )
    }

    /// The same, settling after `after` (the tests' short wait).
    pub fn after(
        key: &str,
        run: u64,
        config: Option<PathBuf>,
        mail: bool,
        after: std::time::Duration,
    ) -> Self {
        Self {
            key: key.to_string(),
            run,
            config,
            mail,
            after,
            armed: true,
        }
    }

    /// The call came back: the route ends it itself.
    pub fn ended(mut self) {
        self.armed = false;
    }
}

/// Settle `run` of `key` now: see [`Going`].
fn settle_now(key: &str, run: u64, config: Option<&Path>, mail: bool) {
    if with(|g| g.settle(key, run))
        && mail
        && let Some(c) = config
    {
        maybe_mark(c, key, DROPPED);
    }
}

impl Drop for Going {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let (key, run, config, mail, after) = (
            std::mem::take(&mut self.key),
            self.run,
            self.config.take(),
            self.mail,
            self.after,
        );
        match tokio::runtime::Handle::try_current() {
            Ok(h) => {
                h.spawn(async move {
                    tokio::time::sleep(after).await;
                    settle_now(&key, run, config.as_deref(), mail);
                });
            }
            // No runtime to wait on: settle at once (the lock is the safe side).
            Err(_) => settle_now(&key, run, config.as_deref(), mail),
        }
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

/// The locks this run set or read, by config folder: kept beside the file
/// so a shell that deletes or edits it does not clear one (finding 3).
fn maybe_kept() -> &'static Mutex<HashMap<PathBuf, BTreeMap<String, String>>> {
    static KEPT: OnceLock<Mutex<HashMap<PathBuf, BTreeMap<String, String>>>> = OnceLock::new();
    KEPT.get_or_init(Default::default)
}

fn maybe_all(config: &Path) -> BTreeMap<String, String> {
    let mut all: BTreeMap<String, String> = std::fs::read_to_string(maybe_file(config))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut kept = maybe_kept().lock().unwrap_or_else(|p| p.into_inner());
    let mine = kept.entry(config.to_path_buf()).or_default();
    for (k, v) in mine.iter() {
        all.entry(k.clone()).or_insert_with(|| v.clone());
    }
    mine.extend(all.iter().map(|(k, v)| (k.clone(), v.clone())));
    all
}

fn maybe_write(config: &Path, all: &BTreeMap<String, String>) {
    maybe_kept()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(config.to_path_buf(), all.clone());
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

/// He checked Gmail's Sent: the lock goes. Callers: the Mac window's own
/// command, and the phone's `/checked` with its signature; never the
/// bearer alone.
pub fn maybe_clear(config: &Path, key: &str) {
    let mut all = maybe_all(config);
    if let Some(mine) = maybe_kept()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_mut(config)
    {
        mine.remove(key);
    }
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
    /// The allowed phone the taps here are minted for.
    const PHONE: &str = "phone-1";
    /// A request that carries the phone's signature.
    fn yes(_: &str, _: &str) -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn a_redeem_needs_his_tap_for_exactly_that_call_after_the_hold() {
        let it = item("m1");
        let call = call_for(&it, &reply("Yes, Thursday works.")).unwrap();
        let mut g = Gate::default();
        // No tap at all: nothing runs.
        assert_eq!(
            g.redeem("made-up", KEY, &call, t0(), yes).unwrap_err(),
            NO_TAP
        );
        let t = g.tap(KEY, &call, PHONE, t0()).unwrap();
        assert_eq!(t.hold_ms, HOLD_MS);
        // Another body under his tap: refused, the tap stays his.
        let other = call_for(&it, &reply("Yes, Friday works.")).unwrap();
        let s = t0() + Duration::seconds(6);
        assert!(
            g.redeem(&t.tap, KEY, &other, s, yes)
                .unwrap_err()
                .contains("not what you tapped")
        );
        // Before the hold ended: refused.
        assert!(
            g.redeem(&t.tap, KEY, &call, t0() + Duration::seconds(2), yes)
                .is_err()
        );
        // After it: once.
        g.redeem(&t.tap, KEY, &call, s, yes).unwrap();
        assert!(g.redeem(&t.tap, KEY, &call, s, yes).is_err());
        g.end(KEY, true, s);
    }

    #[test]
    fn an_undone_or_expired_tap_sends_nothing() {
        let call = call_for(&item("m2"), &reply("ok")).unwrap();
        let key = "email:claude.ai Gmail 2117773e:m2";
        let mut g = Gate::default();
        let t = g.tap(key, &call, PHONE, t0()).unwrap();
        g.undo(&t.tap);
        assert_eq!(
            g.redeem(&t.tap, key, &call, t0() + Duration::seconds(6), yes)
                .unwrap_err(),
            NO_TAP
        );
        // A phone that comes back after the tap's grace finds it gone.
        let t = g.tap(key, &call, PHONE, t0()).unwrap();
        let late = t0() + Duration::milliseconds(HOLD_MS + TAP_GRACE_MS + 1);
        assert_eq!(g.redeem(&t.tap, key, &call, late, yes).unwrap_err(), NO_TAP);
    }

    #[test]
    fn one_send_per_item_across_the_mac_and_the_phone() {
        let call = call_for(&item("m3"), &reply("ok")).unwrap();
        let key = "email:claude.ai Gmail 2117773e:m3";
        let mut g = Gate::default();
        let t = g.tap(key, &call, PHONE, t0()).unwrap();
        // A second tap while the first is held: refused.
        assert!(g.tap(key, &call, PHONE, t0()).is_err());
        // The Mac's own send while the phone holds one: refused.
        assert!(g.begin_here(key, t0()).unwrap_err().contains("phone"));
        g.undo(&t.tap);
        // The phone taps, then the Mac's send goes first (begun before the
        // tap in real life: its own hold ran in the window).
        let mut g = Gate::default();
        g.begin_here(key, t0()).unwrap();
        assert!(g.tap(key, &call, PHONE, t0()).is_err(), "a send is going");
        g.end(key, true, t0() + Duration::seconds(1));
        let t = g.tap(key, &call, PHONE, t0()).unwrap();
        // A tap minted before the other screen's send ended is refused.
        assert!(
            g.redeem(&t.tap, key, &call, t0() + Duration::seconds(6), yes)
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

    /// Item 993g: a redeem runs only with the signature of the phone the
    /// tap was minted for, over that tap's id and its own challenge; the
    /// tap is one-time, so the same signature never works twice, and an
    /// expired tap's challenge is gone with it.
    #[test]
    fn a_redeem_needs_the_phones_signature_over_this_tap_and_its_challenge() {
        let call = call_for(&item("m5"), &reply("ok")).unwrap();
        let key = "email:claude.ai Gmail 2117773e:m5";
        let mut g = Gate::default();
        let t = g.tap(key, &call, PHONE, t0()).unwrap();
        assert_eq!(t.challenge.len(), 64);
        let s = t0() + Duration::seconds(6);
        // No signature (the bearer alone): refused, and the tap is still his.
        let no = |_: &str, _: &str| Err::<(), String>("not signed".into());
        assert_eq!(
            g.redeem(&t.tap, key, &call, s, no).unwrap_err(),
            "not signed"
        );
        // The signature is asked for this phone, over this tap and challenge.
        let mut asked = None;
        g.redeem(&t.tap, key, &call, s, |phone, msg| {
            asked = Some((phone.to_string(), msg.to_string()));
            Ok(())
        })
        .unwrap();
        assert_eq!(
            asked.unwrap(),
            (
                PHONE.to_string(),
                crate::phone_keys::tap_message(&t.tap, &t.challenge)
            )
        );
        // Replayed: the tap is spent, the signature is never even asked for.
        let never = |_: &str, _: &str| -> Result<(), String> { panic!("a spent tap asks nothing") };
        assert_eq!(g.redeem(&t.tap, key, &call, s, never).unwrap_err(), NO_TAP);
        g.end(key, false, s);
        // A new tap has a new challenge.
        let t2 = g.tap(key, &call, PHONE, s).unwrap();
        assert_ne!(t2.challenge, t.challenge);
        // Stale: past the tap's life its challenge signs nothing.
        let late = s + Duration::milliseconds(HOLD_MS + TAP_GRACE_MS + 1);
        assert_eq!(
            g.redeem(&t2.tap, key, &call, late, never).unwrap_err(),
            NO_TAP
        );
    }

    /// Review 2026-11-27 finding 4: a run that was dropped is settled once,
    /// and a late settle never ends a newer run.
    #[test]
    fn a_dropped_run_is_settled_and_never_a_newer_one() {
        let call = call_for(&item("m6"), &reply("ok")).unwrap();
        let key = "email:claude.ai Gmail 2117773e:m6";
        let mut g = Gate::default();
        let t = g.tap(key, &call, PHONE, t0()).unwrap();
        let s = t0() + Duration::seconds(6);
        let run = g.redeem(&t.tap, key, &call, s, yes).unwrap();
        assert_eq!(g.busy(key, s), (true, false));
        assert!(g.tap(key, &call, PHONE, s).is_err(), "going");
        assert!(g.settle(key, run));
        assert_eq!(g.busy(key, s), (false, false));
        assert!(!g.settle(key, run), "once");
        // A newer run is not ended by an older settle.
        g.begin_here(key, s).unwrap();
        assert!(!g.settle(key, run));
        assert_eq!(g.busy(key, s), (true, false));
    }

    /// Review 2026-11-27 finding 4: the `/act` guard, dropped mid-call,
    /// ends the item's run after its wait and locks a mail as "may have
    /// gone"; one that ended is left alone.
    #[tokio::test]
    async fn a_dropped_act_settles_to_the_may_have_gone_lock() {
        let dir = std::env::temp_dir().join(format!("ref-gate-{}", uuid::Uuid::new_v4()));
        let key = format!(
            "email:claude.ai Gmail 2117773e:{}",
            uuid::Uuid::new_v4().simple()
        );
        let call = call_for(&item("m7"), &reply("ok")).unwrap();
        let now = Utc::now();
        let t = with(|g| g.tap(&key, &call, PHONE, now)).unwrap();
        let s = now + Duration::seconds(6);
        let run = with(|g| g.redeem(&t.tap, &key, &call, s, yes)).unwrap();
        let wait = std::time::Duration::from_millis(30);
        drop(Going::after(&key, run, Some(dir.clone()), true, wait));
        // Not before its wait: still going, no lock.
        assert!(with(|g| g.busy(&key, s)).0);
        assert_eq!(maybe_of(&dir, &key), None);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(!with(|g| g.busy(&key, s)).0, "no longer stuck going");
        assert_eq!(maybe_of(&dir, &key).as_deref(), Some(DROPPED));
        // A call that came back: the guard does nothing.
        maybe_clear(&dir, &key);
        with(|g| g.begin_here(&key, s)).unwrap();
        Going::after(&key, 0, Some(dir.clone()), true, wait).ended();
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(with(|g| g.busy(&key, s)).0);
        assert_eq!(maybe_of(&dir, &key), None);
        with(|g| g.end(&key, false, s));
        let _ = std::fs::remove_dir_all(dir);
        assert!(SETTLE_MS >= (HOLD_MS as u64) + crate::ref_action::TURN_SECS * 1000);
    }

    /// Review 2026-11-27 finding 3: a check challenge is one-time, for one
    /// item, and short-lived.
    #[test]
    fn a_check_challenge_is_one_time_for_one_item() {
        let mut g = Gate::default();
        let c = g.check(KEY, PHONE, t0());
        assert_eq!(g.take_check(&c, "another", t0()), None, "another item");
        let c = g.check(KEY, PHONE, t0());
        assert_eq!(g.take_check(&c, KEY, t0()).as_deref(), Some(PHONE));
        assert_eq!(g.take_check(&c, KEY, t0()), None, "spent");
        let c = g.check(KEY, PHONE, t0());
        let late = t0() + Duration::seconds(CHECK_SECS + 1);
        assert_eq!(g.take_check(&c, KEY, late), None, "stale");
    }

    /// Review 2026-11-27 finding 3: a lock this run knows survives its
    /// file being deleted or emptied by a shell; only `maybe_clear` clears it.
    #[test]
    fn a_kept_lock_survives_its_file_being_deleted() {
        let dir = std::env::temp_dir().join(format!("ref-gate-{}", uuid::Uuid::new_v4()));
        maybe_mark(&dir, KEY, "It may have gone.");
        std::fs::remove_file(maybe_file(&dir)).unwrap();
        assert_eq!(maybe_of(&dir, KEY).as_deref(), Some("It may have gone."));
        std::fs::write(maybe_file(&dir), "{}").unwrap();
        assert_eq!(maybe_of(&dir, KEY).as_deref(), Some("It may have gone."));
        maybe_clear(&dir, KEY);
        assert_eq!(maybe_of(&dir, KEY), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
