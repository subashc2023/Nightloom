//! The phones allowed to send from a card (nightshift item 993g, blocker
//! 2359): a tap on the phone's sheet is signed by a key only that phone
//! holds, and the Mac runs a card action only on such a signature.
//!
//! **Why.** The listener's bearer is one secret shared by every paired
//! phone and kept on the Mac; anything on the Mac that held it (a model
//! chat with a shell, a script) could make the tap and the act requests
//! itself. A signature from a key that never leaves the phone cannot be
//! made on the Mac.
//!
//! **The key** is a P-256 key pair made by the phone's browser (WebCrypto,
//! not extractable, kept in the page's IndexedDB). The phone shows its
//! public half to the Mac ([`Keys::ask`], `POST /home/ref/enroll`), which
//! only *asks*: the key waits, with a six-digit code shown **on the phone
//! only**, until **he types that code in the Mac's window and presses
//! Allow** ([`Keys::allow`]). The Mac never shows the code, so an ask a
//! process on the Mac made (with its own key) cannot be allowed by his
//! looking at two matching screens: he has no code for it (review
//! 2026-11-27, finding 1). Three wrong codes drop the ask; asks over the
//! listener are rate-limited per bearer ([`Keys::ask_over_listener`]); a
//! new ask never pushes out a waiting one.
//! No listener route calls `allow`; the window's command is its one caller
//! (`phone_key_allow` in the desktop crate), and a model cannot call a
//! window command.
//!
//! **Where the allowed keys live.** In the Keychain, under the app's own
//! item ([`KeychainStore`]), never a file in the config folder (a chat's
//! shell can write there). A store that cannot be read allows nothing.
//!
//! **What is signed.** [`tap_message`]: the tap's id and the challenge the
//! Mac made for that tap, both fresh and one-time ([`crate::ref_gate`]).

use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use std::sync::Mutex;

/// How many phones may be allowed at once.
pub const MAX_ALLOWED: usize = 8;
/// How many asks wait at once; while this many wait, a new one is refused
/// (the oldest is kept: a spam ask never pushes out his real one).
pub const MAX_ASKED: usize = 3;
/// Wrong codes typed on the Mac before an ask is dropped.
pub const MAX_MISSES: u8 = 3;
/// Asks over the listener, per bearer: at most one a minute ...
pub const ASKS_PER_MINUTE: usize = 1;
/// ... and five a day.
pub const ASKS_PER_DAY: usize = 5;
/// How long a store that could not be read (a locked Keychain) is not
/// asked again: a burst of the phone's requests reads it once.
pub const REFUSAL_SECS: u64 = 30;
/// How long an ask waits for his Allow.
pub const ASK_HOURS: i64 = 24;

/// What a refused tap says when the phone is not allowed to send.
pub const NOT_ALLOWED: &str = "This phone is not allowed to send yet. Press \"Allow this phone to send\" on the phone, then Allow on your Mac.";
/// What a refused act says when the signature is not this phone's.
pub const BAD_SIGNATURE: &str = "This was not signed by a phone you allowed, so nothing was sent.";

/// A phone he allowed.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PhoneKey {
    /// The SHA-256 of the public key, in hex: what a tap names.
    pub id: String,
    /// What the phone called itself ("iPhone · Home Screen app").
    pub name: String,
    /// The public key: the uncompressed P-256 point, base64url.
    pub public: String,
    pub added: DateTime<Utc>,
}

/// A phone waiting for his Allow on the Mac.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Asked {
    pub id: String,
    pub name: String,
    /// Six digits, shown **on the phone only** ([`Standing::Waiting`]); he
    /// types them on the Mac to allow it. Never serialized and not `pub`
    /// outside this crate, so the Mac's window cannot show it.
    #[serde(skip)]
    pub(crate) code: String,
    pub asked: DateTime<Utc>,
    #[serde(skip)]
    public: String,
    /// Wrong codes typed for this ask so far.
    #[serde(skip)]
    misses: u8,
}

/// Where a phone's key stands.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Standing {
    /// He allowed it on the Mac.
    Allowed { id: String },
    /// Asked; waiting for his Allow. `code` is for the phone's screen (the
    /// listener answers this to the phone that asked).
    Waiting { id: String, code: String },
    /// Never asked, refused, revoked or expired.
    None { id: String },
}

/// Where the allowed keys are kept.
pub trait Store: Send + Sync {
    /// Every allowed key; `Err` when the store could not be read (a locked
    /// Keychain), which allows nothing.
    fn load(&self) -> Result<Vec<PhoneKey>, String>;
    fn save(&self, keys: &[PhoneKey]) -> Result<(), String>;
}

/// Kept in memory only: the tests' store, and a dev home's (a dev build
/// never reaches the installed app's Keychain; its phones last until quit).
#[derive(Default)]
pub struct MemoryStore(Mutex<Vec<PhoneKey>>);

impl Store for MemoryStore {
    fn load(&self) -> Result<Vec<PhoneKey>, String> {
        Ok(self.0.lock().unwrap_or_else(|p| p.into_inner()).clone())
    }
    fn save(&self, keys: &[PhoneKey]) -> Result<(), String> {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = keys.to_vec();
        Ok(())
    }
}

/// The Keychain, under the app's own item (`credentials::phone_keys`).
pub struct KeychainStore;

impl Store for KeychainStore {
    fn load(&self) -> Result<Vec<PhoneKey>, String> {
        match crate::credentials::phone_keys() {
            Ok(None) => Ok(Vec::new()),
            Ok(Some(json)) => serde_json::from_str(&json)
                .map_err(|e| format!("the allowed phones in the Keychain did not read: {e}")),
            Err(e) => Err(format!(
                "Your Mac's Keychain could not be read ({e}), so no phone can send until it can."
            )),
        }
    }
    fn save(&self, keys: &[PhoneKey]) -> Result<(), String> {
        let json = serde_json::to_string(keys).map_err(|e| e.to_string())?;
        crate::credentials::set_phone_keys(&json).map_err(|e| e.to_string())
    }
}

/// The phones of one Mac: the allowed ones (in the store) and the asks
/// waiting for his click (in memory: a quit forgets them, and the phone
/// asks again).
pub struct Keys {
    store: Box<dyn Store>,
    /// The store as last read or written here, so a tap does not read the
    /// Keychain each time.
    known: Mutex<Option<Vec<PhoneKey>>>,
    /// The store's last refusal and when: not asked again for
    /// `refusal_for` (a locked Keychain is read once per burst, review
    /// finding 7).
    refused: Mutex<Option<(std::time::Instant, String)>>,
    refusal_for: std::time::Duration,
    asked: Mutex<Vec<Asked>>,
    /// When each bearer's asks over the listener were taken (by the
    /// bearer's SHA-256), for the rate limit.
    asks_by: Mutex<std::collections::HashMap<String, Vec<DateTime<Utc>>>>,
}

impl Keys {
    pub fn new(store: Box<dyn Store>) -> Self {
        Self {
            store,
            known: Mutex::new(None),
            refused: Mutex::new(None),
            refusal_for: std::time::Duration::from_secs(REFUSAL_SECS),
            asked: Mutex::new(Vec::new()),
            asks_by: Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// The keys of this Mac: the Keychain, or memory where the Keychain is
    /// not this build's to use (a dev home, the env token).
    pub fn for_this_mac() -> Self {
        if crate::credentials::phone_keys_in_keychain() {
            Self::new(Box::new(KeychainStore))
        } else {
            Self::new(Box::<MemoryStore>::default())
        }
    }

    /// Every phone he allowed. Read from the store once and kept; a
    /// refusal (a locked Keychain) is kept for [`REFUSAL_SECS`], so the
    /// phone's requests in that time do not each read the Keychain again.
    pub fn allowed(&self) -> Result<Vec<PhoneKey>, String> {
        let mut known = self.known.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(k) = known.as_ref() {
            return Ok(k.clone());
        }
        let mut refused = self.refused.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((at, why)) = refused.as_ref()
            && at.elapsed() < self.refusal_for
        {
            return Err(why.clone());
        }
        match self.store.load() {
            Ok(read) => {
                *refused = None;
                *known = Some(read.clone());
                Ok(read)
            }
            Err(why) => {
                *refused = Some((std::time::Instant::now(), why.clone()));
                Err(why)
            }
        }
    }

    fn keep(&self, keys: Vec<PhoneKey>) -> Result<(), String> {
        self.store.save(&keys)?;
        *self.known.lock().unwrap_or_else(|p| p.into_inner()) = Some(keys);
        *self.refused.lock().unwrap_or_else(|p| p.into_inner()) = None;
        Ok(())
    }

    /// The asks waiting for his click.
    pub fn asked(&self, now: DateTime<Utc>) -> Vec<Asked> {
        let mut a = self.asked.lock().unwrap_or_else(|p| p.into_inner());
        a.retain(|x| x.asked + Duration::hours(ASK_HOURS) > now);
        a.clone()
    }

    /// Where the phone holding `public` stands.
    pub fn standing(&self, public: &str, now: DateTime<Utc>) -> Result<Standing, String> {
        let id = key_id(public)?;
        if self.allowed()?.iter().any(|k| k.id == id) {
            return Ok(Standing::Allowed { id });
        }
        Ok(match self.asked(now).into_iter().find(|a| a.id == id) {
            Some(a) => Standing::Waiting { id, code: a.code },
            None => Standing::None { id },
        })
    }

    /// The phone asks to be allowed. **Nothing is allowed by this**: the
    /// key waits for [`Keys::allow`]. The same key asking again keeps its
    /// code. `Ok(Some(_))` is a new ask, for the Mac to show. While
    /// [`MAX_ASKED`] asks wait, a new one is refused (the waiting ones
    /// stay). The listener's route goes through [`Keys::ask_over_listener`].
    pub fn ask(
        &self,
        public: &str,
        name: &str,
        now: DateTime<Utc>,
    ) -> Result<(Standing, Option<Asked>), Refused> {
        self.ask_inner(public, name, None, now)
    }

    /// [`Keys::ask`] from the listener, limited per bearer (`bearer`, the
    /// token the request carried): at most [`ASKS_PER_MINUTE`] new ask a
    /// minute and [`ASKS_PER_DAY`] a day. Asking again for a key already
    /// waiting is not a new ask and is not counted.
    pub fn ask_over_listener(
        &self,
        bearer: &str,
        public: &str,
        name: &str,
        now: DateTime<Utc>,
    ) -> Result<(Standing, Option<Asked>), Refused> {
        let who = crate::sync::manifest::sha256_hex(bearer.as_bytes());
        self.ask_inner(public, name, Some(&who), now)
    }

    fn ask_inner(
        &self,
        public: &str,
        name: &str,
        bearer: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<(Standing, Option<Asked>), Refused> {
        let standing = self.standing(public, now).map_err(Refused::Store)?;
        let Standing::None { id } = standing else {
            return Ok((standing, None));
        };
        let mut a = self.asked.lock().unwrap_or_else(|p| p.into_inner());
        a.retain(|x| x.asked + Duration::hours(ASK_HOURS) > now);
        if a.len() >= MAX_ASKED {
            return Err(Refused::Limit(format!(
                "{MAX_ASKED} phones are asking already. Allow or refuse them on your Mac (Settings → Phone), then ask again."
            )));
        }
        if let Some(who) = bearer {
            let mut by = self.asks_by.lock().unwrap_or_else(|p| p.into_inner());
            let times = by.entry(who.to_string()).or_default();
            times.retain(|t| *t + Duration::days(1) > now);
            if times
                .iter()
                .filter(|t| **t + Duration::minutes(1) > now)
                .count()
                >= ASKS_PER_MINUTE
            {
                return Err(Refused::Limit(
                    "Your Mac was asked a moment ago. Wait a minute, then ask again.".into(),
                ));
            }
            if times.len() >= ASKS_PER_DAY {
                return Err(Refused::Limit(format!(
                    "Your Mac was asked {ASKS_PER_DAY} times today. Ask again tomorrow, or allow the phone that is asking."
                )));
            }
            times.push(now);
        }
        let code = format!("{:06}", uuid::Uuid::new_v4().as_u128() % 1_000_000);
        let ask = Asked {
            id: id.clone(),
            name: clean_name(name),
            code: code.clone(),
            asked: now,
            public: public.to_string(),
            misses: 0,
        };
        a.push(ask.clone());
        Ok((Standing::Waiting { id, code }, Some(ask)))
    }

    /// **He typed his phone's code in the Mac's window and pressed Allow**,
    /// and nothing else: the ask `id` becomes an allowed phone, kept in the
    /// store, only when `code` is the one the phone shows. A wrong code is
    /// counted; the [`MAX_MISSES`]th drops the ask. The window's command is
    /// the one caller; no listener route reaches this.
    pub fn allow(&self, id: &str, code: &str, now: DateTime<Utc>) -> Result<PhoneKey, String> {
        const GONE: &str =
            "That phone is no longer asking. Press \"Allow this phone to send\" on it again.";
        let typed: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
        let ask = {
            let mut a = self.asked.lock().unwrap_or_else(|p| p.into_inner());
            a.retain(|x| x.asked + Duration::hours(ASK_HOURS) > now);
            let i = a.iter().position(|x| x.id == id).ok_or(GONE)?;
            if !same_code(&typed, &a[i].code) {
                a[i].misses += 1;
                if a[i].misses >= MAX_MISSES {
                    a.remove(i);
                    return Err(format!(
                        "That was not the code {MAX_MISSES} times, so this ask is gone. If it was your phone, press \"Allow this phone to send\" on it again."
                    ));
                }
                let left = MAX_MISSES - a[i].misses;
                return Err(format!(
                    "That is not the code this phone shows. Type the six digits on your phone's screen ({left} {} left).",
                    if left == 1 { "try" } else { "tries" }
                ));
            }
            a[i].clone()
        };
        let mut keys = self.allowed()?;
        if keys.len() >= MAX_ALLOWED {
            return Err(format!(
                "{MAX_ALLOWED} phones are allowed already. Remove one first."
            ));
        }
        let key = PhoneKey {
            id: ask.id.clone(),
            name: ask.name.clone(),
            public: ask.public.clone(),
            added: now,
        };
        keys.retain(|k| k.id != key.id);
        keys.push(key.clone());
        self.keep(keys)?;
        self.deny(id);
        Ok(key)
    }

    /// His "Don't allow": the ask goes.
    pub fn deny(&self, id: &str) {
        self.asked
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|a| a.id != id);
    }

    /// He removed a phone on the Mac: its taps are refused from now on,
    /// one already in its hold included (the act reads the keys again).
    pub fn revoke(&self, id: &str) -> Result<(), String> {
        let mut keys = self.allowed()?;
        keys.retain(|k| k.id != id);
        self.keep(keys)
    }

    /// Every phone and every ask goes (the token was regenerated: every
    /// phone pairs again, and asks again).
    pub fn clear(&self) -> Result<(), String> {
        self.asked.lock().unwrap_or_else(|p| p.into_inner()).clear();
        self.keep(Vec::new())
    }

    /// Whether `id` is an allowed phone now.
    pub fn is_allowed(&self, id: &str) -> Result<bool, String> {
        Ok(self.allowed()?.iter().any(|k| k.id == id))
    }

    /// Whether `signature` (base64url, the 64 bytes r‖s WebCrypto makes) is
    /// the allowed phone `id`'s over `message`.
    pub fn verify(&self, id: &str, message: &str, signature: &str) -> Result<(), String> {
        let keys = self.allowed()?;
        let key = keys.iter().find(|k| k.id == id).ok_or(NOT_ALLOWED)?;
        let public = unb64(&key.public).ok_or(BAD_SIGNATURE)?;
        let sig = unb64(signature).ok_or(BAD_SIGNATURE)?;
        ring::signature::UnparsedPublicKey::new(&ring::signature::ECDSA_P256_SHA256_FIXED, public)
            .verify(message.as_bytes(), &sig)
            .map_err(|_| BAD_SIGNATURE.to_string())
    }
}

/// What the phone signs for one tap: the tap's id and the Mac's challenge
/// for it (`phoneKey.ts` `tapMessage`).
pub fn tap_message(tap: &str, challenge: &str) -> String {
    format!("nightloom-tap-v1\n{tap}\n{challenge}")
}

/// What the phone signs for "I checked: not sent" on an item: the item's
/// key and the Mac's challenge for it (`phoneKey.ts` `checkedMessage`).
/// Clearing the "may have gone" lock needs this (review finding 3).
pub fn checked_message(key: &str, challenge: &str) -> String {
    format!("nightloom-checked-v1\n{key}\n{challenge}")
}

/// Why an ask was refused: the store could not be read, or a limit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    Store(String),
    Limit(String),
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refused::Store(s) | Refused::Limit(s) => f.write_str(s),
        }
    }
}

/// Whether the typed code is the ask's, without stopping at the first
/// different digit.
fn same_code(typed: &str, code: &str) -> bool {
    typed.len() == code.len()
        && typed
            .bytes()
            .zip(code.bytes())
            .fold(0u8, |d, (a, b)| d | (a ^ b))
            == 0
}

fn unb64(s: &str) -> Option<Vec<u8>> {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s.trim_end_matches('='))
        .ok()
}

/// The id of a public key (its SHA-256, hex), or why it is not one: an
/// uncompressed P-256 point is 65 bytes beginning 0x04.
pub fn key_id(public: &str) -> Result<String, String> {
    let bytes = unb64(public).ok_or("that is not a phone's key")?;
    if bytes.len() != 65 || bytes[0] != 4 {
        return Err("that is not a phone's key".into());
    }
    Ok(crate::sync::manifest::sha256_hex(&bytes))
}

/// A phone's name for the Mac's list: one short line, no control
/// characters (it is the phone's own claim; the code is what he checks).
fn clean_name(name: &str) -> String {
    let s: String = name
        .chars()
        .filter(|c| !c.is_control())
        .take(60)
        .collect::<String>()
        .trim()
        .to_string();
    if s.is_empty() { "A phone".into() } else { s }
}

/// A phone for tests, here and in the listener's: a real P-256 key that
/// signs as WebCrypto does.
#[cfg(test)]
pub(crate) mod test_phone {
    use base64::Engine as _;
    use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};

    pub(crate) struct Phone {
        pair: EcdsaKeyPair,
        rng: ring::rand::SystemRandom,
    }

    impl Phone {
        pub(crate) fn new() -> Self {
            let rng = ring::rand::SystemRandom::new();
            let doc = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
            let pair =
                EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, doc.as_ref(), &rng)
                    .unwrap();
            Self { pair, rng }
        }
        pub(crate) fn public(&self) -> String {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(self.pair.public_key().as_ref())
        }
        pub(crate) fn id(&self) -> String {
            super::key_id(&self.public()).unwrap()
        }
        pub(crate) fn sign(&self, message: &str) -> String {
            let sig = self.pair.sign(&self.rng, message.as_bytes()).unwrap();
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.as_ref())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_phone::Phone;
    use super::*;

    fn t0() -> DateTime<Utc> {
        "2026-11-27T15:00:00Z".parse().unwrap()
    }
    fn keys() -> Keys {
        Keys::new(Box::<MemoryStore>::default())
    }
    /// The code the phone `id` shows (only the phone is ever told it).
    fn code_of(k: &Keys, id: &str) -> String {
        k.asked(t0())
            .into_iter()
            .find(|a| a.id == id)
            .map(|a| a.code)
            .unwrap()
    }

    #[test]
    fn asking_allows_nothing_until_his_allow() {
        let k = keys();
        let p = Phone::new();
        assert_eq!(
            k.standing(&p.public(), t0()).unwrap(),
            Standing::None { id: p.id() }
        );
        let (s, new) = k.ask(&p.public(), "iPhone · Safari", t0()).unwrap();
        let Standing::Waiting { code, .. } = s.clone() else {
            panic!("{s:?}")
        };
        assert_eq!(code.len(), 6);
        assert_eq!(new.unwrap().code, code);
        // Asking again changes nothing: the same code, no second ask.
        let (again, new) = k.ask(&p.public(), "iPhone · Safari", t0()).unwrap();
        assert_eq!(again, s);
        assert!(new.is_none());
        assert!(!k.is_allowed(&p.id()).unwrap());
        let msg = tap_message("tap", "challenge");
        assert_eq!(
            k.verify(&p.id(), &msg, &p.sign(&msg)).unwrap_err(),
            NOT_ALLOWED
        );
        // His click on the Mac.
        let key = k.allow(&p.id(), &code_of(&k, &p.id()), t0()).unwrap();
        assert_eq!(key.name, "iPhone · Safari");
        assert!(k.asked(t0()).is_empty());
        assert_eq!(
            k.standing(&p.public(), t0()).unwrap(),
            Standing::Allowed { id: p.id() }
        );
        k.verify(&p.id(), &msg, &p.sign(&msg)).unwrap();
    }

    #[test]
    fn a_signature_is_only_the_allowed_phones_own_over_exactly_the_message() {
        let k = keys();
        let (mine, other) = (Phone::new(), Phone::new());
        k.ask(&mine.public(), "mine", t0()).unwrap();
        k.allow(&mine.id(), &code_of(&k, &mine.id()), t0()).unwrap();
        let msg = tap_message("t1", "c1");
        // Another key's signature under his phone's id.
        assert_eq!(
            k.verify(&mine.id(), &msg, &other.sign(&msg)).unwrap_err(),
            BAD_SIGNATURE
        );
        // His phone's signature over another tap or another challenge.
        for m in [tap_message("t2", "c1"), tap_message("t1", "c2")] {
            assert_eq!(
                k.verify(&mine.id(), &msg, &mine.sign(&m)).unwrap_err(),
                BAD_SIGNATURE
            );
        }
        // Not a signature at all; an empty one.
        for s in ["", "AAAA", "not base64 !!"] {
            assert_eq!(k.verify(&mine.id(), &msg, s).unwrap_err(), BAD_SIGNATURE);
        }
    }

    /// The signature WebCrypto makes (`crypto.subtle.sign` with ECDSA P-256
    /// and SHA-256: 64 bytes r‖s) over [`tap_message`] is what `ring`
    /// verifies. The vector was made with Node's WebCrypto, the same API
    /// the phone's browser has.
    #[test]
    fn a_webcrypto_signature_verifies() {
        let public = include_str!("phone_keys_vector.txt")
            .lines()
            .next()
            .unwrap()
            .trim();
        let sig = include_str!("phone_keys_vector.txt")
            .lines()
            .nth(1)
            .unwrap()
            .trim();
        let k = keys();
        k.ask(public, "node", t0()).unwrap();
        let id = key_id(public).unwrap();
        k.allow(&id, &code_of(&k, &id), t0()).unwrap();
        k.verify(&id, &tap_message("tap-vector", "challenge-vector"), sig)
            .unwrap();
        assert!(
            k.verify(&id, &tap_message("tap-vector", "another"), sig)
                .is_err()
        );
    }

    #[test]
    fn a_revoked_phone_signs_nothing_and_asks_expire() {
        let k = keys();
        let p = Phone::new();
        k.ask(&p.public(), "p", t0()).unwrap();
        // An ask he never answered is gone after a day.
        let late = t0() + Duration::hours(ASK_HOURS) + Duration::seconds(1);
        assert!(k.allow(&p.id(), "000000", late).is_err());
        k.ask(&p.public(), "p", t0()).unwrap();
        k.allow(&p.id(), &code_of(&k, &p.id()), t0()).unwrap();
        let msg = tap_message("t", "c");
        k.verify(&p.id(), &msg, &p.sign(&msg)).unwrap();
        k.revoke(&p.id()).unwrap();
        assert_eq!(
            k.verify(&p.id(), &msg, &p.sign(&msg)).unwrap_err(),
            NOT_ALLOWED
        );
        // Don't allow: the ask goes and cannot be allowed afterwards.
        k.ask(&p.public(), "p", t0()).unwrap();
        k.deny(&p.id());
        assert!(k.allow(&p.id(), "000000", t0()).is_err());
        // A regenerated token: every phone and ask goes.
        k.ask(&p.public(), "p", t0()).unwrap();
        k.allow(&p.id(), &code_of(&k, &p.id()), t0()).unwrap();
        k.clear().unwrap();
        assert!(k.allowed().unwrap().is_empty());
    }

    struct Locked;
    impl Store for Locked {
        fn load(&self) -> Result<Vec<PhoneKey>, String> {
            Err("locked".into())
        }
        fn save(&self, _: &[PhoneKey]) -> Result<(), String> {
            Err("locked".into())
        }
    }

    /// A Keychain that cannot be read allows nothing: no standing, no
    /// allow, no signature taken.
    #[test]
    fn a_store_that_cannot_be_read_allows_nothing() {
        let k = Keys::new(Box::new(Locked));
        let p = Phone::new();
        assert!(k.standing(&p.public(), t0()).is_err());
        assert!(k.ask(&p.public(), "p", t0()).is_err());
        assert!(k.is_allowed(&p.id()).is_err());
        let msg = tap_message("t", "c");
        assert!(k.verify(&p.id(), &msg, &p.sign(&msg)).is_err());
    }

    #[test]
    fn only_a_p256_point_is_a_key_and_asks_are_capped() {
        assert!(key_id("AAAA").is_err());
        assert!(key_id("").is_err());
        let k = keys();
        let phones: Vec<Phone> = (0..MAX_ASKED + 1).map(|_| Phone::new()).collect();
        for p in &phones[..MAX_ASKED] {
            k.ask(&p.public(), "x\u{7}\n", t0()).unwrap();
        }
        // Review 2026-11-27 finding 1: a new ask while three wait is
        // refused, and the oldest (his real one, say) is kept.
        assert!(matches!(
            k.ask(&phones[MAX_ASKED].public(), "spam", t0()),
            Err(Refused::Limit(_))
        ));
        let waiting = k.asked(t0());
        assert_eq!(waiting.len(), MAX_ASKED);
        assert!(waiting.iter().any(|a| a.id == phones[0].id()));
        assert!(waiting.iter().all(|a| a.id != phones[MAX_ASKED].id()));
        assert!(waiting.iter().all(|a| a.name == "x"));
        // One answered makes room again.
        k.deny(&phones[1].id());
        k.ask(&phones[MAX_ASKED].public(), "late", t0()).unwrap();
    }

    /// Review 2026-11-27 finding 1: the code is shown only on the phone
    /// (the Mac's list carries none), he types it on the Mac to allow, and
    /// three wrong codes drop that ask.
    #[test]
    fn allowing_needs_the_code_the_phone_shows_and_three_misses_drop_the_ask() {
        let k = keys();
        let p = Phone::new();
        let (s, new) = k.ask(&p.public(), "iPhone · Safari", t0()).unwrap();
        let Standing::Waiting { code: shown, .. } = s else {
            panic!("{s:?}")
        };
        // What the Mac's window gets of an ask has no code in it.
        let wire = serde_json::to_value(new.unwrap()).unwrap();
        assert!(wire.get("code").is_none(), "{wire}");
        assert!(!wire.to_string().contains(&shown), "{wire}");
        let wrong = if shown == "000000" {
            "111111"
        } else {
            "000000"
        };
        assert!(
            k.allow(&p.id(), wrong, t0())
                .unwrap_err()
                .contains("2 tries left")
        );
        assert!(
            k.allow(&p.id(), "", t0())
                .unwrap_err()
                .contains("1 try left")
        );
        assert!(!k.is_allowed(&p.id()).unwrap());
        // The right code with spaces, as the phone shows it, works.
        let spaced = format!("{} {}", &shown[..3], &shown[3..]);
        k.allow(&p.id(), &spaced, t0()).unwrap();
        assert!(k.is_allowed(&p.id()).unwrap());

        let q = Phone::new();
        k.ask(&q.public(), "q", t0()).unwrap();
        let right = code_of(&k, &q.id());
        for _ in 0..MAX_MISSES {
            assert!(k.allow(&q.id(), "12345x", t0()).is_err());
        }
        assert!(k.asked(t0()).is_empty(), "three misses drop the ask");
        assert!(
            k.allow(&q.id(), &right, t0())
                .unwrap_err()
                .contains("no longer asking")
        );
        assert!(!k.is_allowed(&q.id()).unwrap());
    }

    /// Review 2026-11-27 finding 1: over the listener, one new ask a
    /// minute and five a day per bearer; re-asking for a waiting key is
    /// not counted; another bearer has its own count.
    #[test]
    fn asks_over_the_listener_are_limited_per_bearer() {
        let k = keys();
        let mut t = t0();
        let one = Phone::new();
        k.ask_over_listener("bearer-a", &one.public(), "a", t)
            .unwrap();
        // The same key again: no new ask, not refused.
        let (s, new) = k
            .ask_over_listener("bearer-a", &one.public(), "a", t)
            .unwrap();
        assert!(matches!(s, Standing::Waiting { .. }) && new.is_none());
        k.deny(&one.id());
        let two = Phone::new();
        assert!(matches!(
            k.ask_over_listener("bearer-a", &two.public(), "b", t + Duration::seconds(30)),
            Err(Refused::Limit(m)) if m.contains("minute")
        ));
        // Another bearer is counted on its own.
        k.ask_over_listener("bearer-b", &two.public(), "b", t)
            .unwrap();
        k.deny(&two.id());
        // Five a day for one bearer.
        for _ in 1..ASKS_PER_DAY {
            t += Duration::minutes(2);
            let p = Phone::new();
            k.ask_over_listener("bearer-a", &p.public(), "p", t)
                .unwrap();
            k.deny(&p.id());
        }
        t += Duration::minutes(2);
        assert!(matches!(
            k.ask_over_listener("bearer-a", &Phone::new().public(), "p", t),
            Err(Refused::Limit(m)) if m.contains("today")
        ));
        // A day after the first, room again.
        k.ask_over_listener(
            "bearer-a",
            &Phone::new().public(),
            "p",
            t0() + Duration::days(1) + Duration::seconds(1),
        )
        .unwrap();
    }

    /// Review 2026-11-27 finding 7: a store that refused is not read again
    /// for a while, so a burst of requests reads a locked Keychain once.
    #[test]
    fn a_refusing_store_is_read_once_per_burst() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Counting(Arc<AtomicUsize>);
        impl Store for Counting {
            fn load(&self) -> Result<Vec<PhoneKey>, String> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Err("locked".into())
            }
            fn save(&self, _: &[PhoneKey]) -> Result<(), String> {
                Err("locked".into())
            }
        }
        use std::sync::Arc;
        let reads = Arc::new(AtomicUsize::new(0));
        let mut k = Keys::new(Box::new(Counting(reads.clone())));
        let p = Phone::new();
        let msg = tap_message("t", "c");
        for _ in 0..10 {
            assert_eq!(k.allowed().unwrap_err(), "locked");
            assert!(k.is_allowed(&p.id()).is_err());
            assert!(k.verify(&p.id(), &msg, &p.sign(&msg)).is_err());
            assert!(k.standing(&p.public(), t0()).is_err());
        }
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        // Past the window it is read again (and refuses again).
        k.refusal_for = std::time::Duration::ZERO;
        assert!(k.allowed().is_err());
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }
}
