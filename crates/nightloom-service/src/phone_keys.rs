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
//! only *asks*: the key waits, with a six-digit code shown on both
//! screens, until **his Allow click in the Mac's window** ([`Keys::allow`]).
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
/// How many asks wait at once; a newer one pushes out the oldest.
pub const MAX_ASKED: usize = 3;
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
    /// Six digits, shown on the phone and on the Mac: he allows only the
    /// ask whose code his phone shows.
    pub code: String,
    pub asked: DateTime<Utc>,
    #[serde(skip)]
    public: String,
}

/// Where a phone's key stands.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Standing {
    /// He allowed it on the Mac.
    Allowed { id: String },
    /// Asked; waiting for his Allow.
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
    asked: Mutex<Vec<Asked>>,
}

impl Keys {
    pub fn new(store: Box<dyn Store>) -> Self {
        Self {
            store,
            known: Mutex::new(None),
            asked: Mutex::new(Vec::new()),
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

    /// Every phone he allowed.
    pub fn allowed(&self) -> Result<Vec<PhoneKey>, String> {
        let mut known = self.known.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(k) = known.as_ref() {
            return Ok(k.clone());
        }
        let read = self.store.load()?;
        *known = Some(read.clone());
        Ok(read)
    }

    fn keep(&self, keys: Vec<PhoneKey>) -> Result<(), String> {
        self.store.save(&keys)?;
        *self.known.lock().unwrap_or_else(|p| p.into_inner()) = Some(keys);
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
    /// code. `Ok(Some(_))` is a new ask, for the Mac to show.
    pub fn ask(
        &self,
        public: &str,
        name: &str,
        now: DateTime<Utc>,
    ) -> Result<(Standing, Option<Asked>), String> {
        let standing = self.standing(public, now)?;
        let Standing::None { id } = standing else {
            return Ok((standing, None));
        };
        let code = format!("{:06}", uuid::Uuid::new_v4().as_u128() % 1_000_000);
        let ask = Asked {
            id: id.clone(),
            name: clean_name(name),
            code: code.clone(),
            asked: now,
            public: public.to_string(),
        };
        let mut a = self.asked.lock().unwrap_or_else(|p| p.into_inner());
        while a.len() >= MAX_ASKED {
            a.remove(0);
        }
        a.push(ask.clone());
        Ok((Standing::Waiting { id, code }, Some(ask)))
    }

    /// **His Allow click in the Mac's window**, and nothing else: the ask
    /// `id` becomes an allowed phone, kept in the store. The window's
    /// command is the one caller; no listener route reaches this.
    pub fn allow(&self, id: &str, now: DateTime<Utc>) -> Result<PhoneKey, String> {
        let ask = self.asked(now).into_iter().find(|a| a.id == id).ok_or(
            "That phone is no longer asking. Press \"Allow this phone to send\" on it again.",
        )?;
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
        let key = k.allow(&p.id(), t0()).unwrap();
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
        k.allow(&mine.id(), t0()).unwrap();
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
        k.allow(&id, t0()).unwrap();
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
        assert!(k.allow(&p.id(), late).is_err());
        k.ask(&p.public(), "p", t0()).unwrap();
        k.allow(&p.id(), t0()).unwrap();
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
        assert!(k.allow(&p.id(), t0()).is_err());
        // A regenerated token: every phone and ask goes.
        k.ask(&p.public(), "p", t0()).unwrap();
        k.allow(&p.id(), t0()).unwrap();
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
        for p in &phones {
            k.ask(&p.public(), "x\u{7}\n", t0()).unwrap();
        }
        let waiting = k.asked(t0());
        assert_eq!(waiting.len(), MAX_ASKED);
        assert!(waiting.iter().all(|a| a.id != phones[0].id()));
        assert!(waiting.iter().all(|a| a.name == "x"));
    }
}
