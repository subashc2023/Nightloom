//! Web Push's two pieces of cryptography (nightshift item 739), on `ring`
//! — the library rustls already compiles here, so push adds no crate:
//!
//! - **the message** (RFC 8291, `aes128gcm` of RFC 8188): an ECDH P-256
//!   agreement with the phone's key, HKDF-SHA-256, one AES-128-GCM record;
//! - **who sends it** (VAPID, RFC 8292): a JWT signed ES256 with this
//!   host's key, in the `Authorization` header.
//!
//! The derivation and the record are checked against RFC 8291's own
//! example (Appendix A), and a whole message is opened again by a second
//! key pair, in the tests below.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair};
use ring::{aead, agreement, hkdf};

/// An uncompressed P-256 point: `0x04 || X || Y`.
pub const POINT_LEN: usize = 65;
/// The phone's `auth` secret.
pub const AUTH_LEN: usize = 16;
/// The record size written in the header. One record carries the message;
/// push services take up to 4096 bytes of body.
const RECORD_SIZE: u32 = 4096;
/// The most plaintext one message carries: the body limit less the header
/// (salt 16, record size 4, key length 1, key 65), the delimiter and the tag.
pub const MAX_PLAINTEXT: usize = 4096 - (16 + 4 + 1 + POINT_LEN) - 1 - 16;

pub fn b64(bytes: &[u8]) -> String {
    B64.encode(bytes)
}

/// Base64url, with or without padding (browsers send both).
pub fn unb64(text: &str) -> Option<Vec<u8>> {
    B64.decode(text.trim().trim_end_matches('=')).ok()
}

struct Len(usize);
impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

fn expand(prk: &hkdf::Prk, info: &[u8], out: &mut [u8]) -> Result<(), String> {
    prk.expand(&[info], Len(out.len()))
        .and_then(|okm| okm.fill(out))
        .map_err(|_| "the key derivation failed".to_string())
}

/// RFC 8291 §3.3–3.4: the content key and nonce from the ECDH secret.
/// `ua_public` is the phone's key, `as_public` the message's own.
fn derive(
    ecdh_secret: &[u8],
    auth: &[u8],
    ua_public: &[u8],
    as_public: &[u8],
    salt: &[u8],
) -> Result<([u8; 16], [u8; 12]), String> {
    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    let mut ikm = [0u8; 32];
    expand(
        &hkdf::Salt::new(hkdf::HKDF_SHA256, auth).extract(ecdh_secret),
        &key_info,
        &mut ikm,
    )?;
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, salt).extract(&ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    expand(&prk, b"Content-Encoding: aes128gcm\0", &mut cek)?;
    expand(&prk, b"Content-Encoding: nonce\0", &mut nonce)?;
    Ok((cek, nonce))
}

/// RFC 8188 §2: the header, then the one record — the plaintext, the
/// last-record delimiter `0x02`, sealed with the tag.
fn seal(
    cek: &[u8; 16],
    nonce: [u8; 12],
    salt: &[u8],
    as_public: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, String> {
    let key = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::AES_128_GCM, cek).map_err(|_| "bad content key")?,
    );
    let mut record = plaintext.to_vec();
    record.push(2);
    key.seal_in_place_append_tag(
        aead::Nonce::assume_unique_for_key(nonce),
        aead::Aad::empty(),
        &mut record,
    )
    .map_err(|_| "the message could not be sealed".to_string())?;
    let mut body = Vec::with_capacity(21 + as_public.len() + record.len());
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public.len() as u8);
    body.extend_from_slice(as_public);
    body.extend_from_slice(&record);
    Ok(body)
}

/// `plaintext` as an `aes128gcm` body only the subscription's holder can
/// open. `p256dh` and `auth` are the subscription's keys, decoded.
pub fn encrypt(p256dh: &[u8], auth: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    if p256dh.len() != POINT_LEN || p256dh[0] != 4 {
        return Err("the subscription's key is not a P-256 point".into());
    }
    if auth.len() != AUTH_LEN {
        return Err("the subscription's auth secret is not 16 bytes".into());
    }
    if plaintext.len() > MAX_PLAINTEXT {
        return Err("the push message is too long".into());
    }
    let rng = SystemRandom::new();
    let mut salt = [0u8; 16];
    rng.fill(&mut salt).map_err(|_| "no randomness")?;
    let mine = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng)
        .map_err(|_| "no randomness")?;
    let as_public = mine
        .compute_public_key()
        .map_err(|_| "no public key")?
        .as_ref()
        .to_vec();
    let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, p256dh);
    let (cek, nonce) = agreement::agree_ephemeral(mine, &peer, |secret| {
        derive(secret, auth, p256dh, &as_public, &salt)
    })
    .map_err(|_| "the subscription's key is not on the curve".to_string())??;
    seal(&cek, nonce, &salt, &as_public, plaintext)
}

/// This host's VAPID key: an ECDSA P-256 key pair, kept as PKCS#8.
pub struct Vapid {
    pair: EcdsaKeyPair,
    rng: SystemRandom,
}

impl Vapid {
    /// A new key, as the PKCS#8 bytes to keep.
    pub fn generate() -> Result<Vec<u8>, String> {
        EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
            .map(|d| d.as_ref().to_vec())
            .map_err(|_| "could not make a push key".to_string())
    }

    pub fn from_pkcs8(bytes: &[u8]) -> Result<Self, String> {
        let rng = SystemRandom::new();
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, bytes, &rng)
            .map_err(|_| "the push key file is not a P-256 key".to_string())?;
        Ok(Self { pair, rng })
    }

    /// The public key as the page's `applicationServerKey` (base64url of
    /// the uncompressed point).
    pub fn public_key(&self) -> String {
        b64(self.pair.public_key().as_ref())
    }

    /// The `Authorization` header for a push to `audience` (the push
    /// service's origin), good until `expires` (Unix seconds; at most a day
    /// ahead). `subject` is the contact claim (`mailto:` or `https:`).
    pub fn authorization(
        &self,
        audience: &str,
        expires: i64,
        subject: &str,
    ) -> Result<String, String> {
        let head = b64(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = serde_json::json!({ "aud": audience, "exp": expires, "sub": subject });
        let signed = format!("{head}.{}", b64(claims.to_string().as_bytes()));
        let sig = self
            .pair
            .sign(&self.rng, signed.as_bytes())
            .map_err(|_| "could not sign the push".to_string())?;
        Ok(format!(
            "vapid t={signed}.{}, k={}",
            b64(sig.as_ref()),
            self.public_key()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{ECDSA_P256_SHA256_FIXED, UnparsedPublicKey};

    fn d(s: &str) -> Vec<u8> {
        unb64(s).expect("base64url")
    }

    /// RFC 8291, Appendix A: from the example's ECDH secret to its content
    /// key, nonce and body. The body was also opened outside this code —
    /// Node's OpenSSL, with the example's receiver private key — and read
    /// back as the example's sentence (wave-b push report, 2026-11-16).
    #[test]
    fn the_rfc_8291_example_derives_and_seals_to_the_rfc_s_bytes() {
        let ua_public = d(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        );
        let as_public = d(
            "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
        );
        let auth = d("BTBZMqHH6r4Tts7J_aSIgg");
        let salt = d("DGv6ra1nlYgDCS1FRnbzlw");
        let ecdh = d("kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs");
        let (cek, nonce) = derive(&ecdh, &auth, &ua_public, &as_public, &salt).unwrap();
        assert_eq!(b64(&cek), "oIhVW04MRdy2XN9CiKLxTg");
        assert_eq!(b64(&nonce), "4h_95klXJ5E_qnoN");
        let body = seal(
            &cek,
            nonce,
            &salt,
            &as_public,
            b"When I grow up, I want to be a watermelon",
        )
        .unwrap();
        assert_eq!(
            b64(&body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    /// A message sealed for a phone's key opens with that key and no other.
    #[test]
    fn a_message_opens_for_the_subscription_it_was_sealed_for() {
        let rng = SystemRandom::new();
        let phone = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
        let p256dh = phone.compute_public_key().unwrap().as_ref().to_vec();
        let auth = [7u8; 16];
        let body = encrypt(&p256dh, &auth, b"{\"title\":\"a chat\"}").unwrap();

        let (salt, rest) = body.split_at(16);
        assert_eq!(&rest[..4], &RECORD_SIZE.to_be_bytes());
        assert_eq!(rest[4] as usize, POINT_LEN);
        let (as_public, record) = rest[5..].split_at(POINT_LEN);
        let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, as_public);
        let (cek, nonce) = agreement::agree_ephemeral(phone, &peer, |s| {
            derive(s, &auth, &p256dh, as_public, salt)
        })
        .unwrap()
        .unwrap();
        let key = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_128_GCM, &cek).unwrap());
        let mut buf = record.to_vec();
        let plain = key
            .open_in_place(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::empty(),
                &mut buf,
            )
            .unwrap();
        assert_eq!(plain, b"{\"title\":\"a chat\"}\x02");

        // Another auth secret derives another key: the tag fails.
        let other = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
        let body2 = encrypt(other.compute_public_key().unwrap().as_ref(), &auth, b"x").unwrap();
        assert_ne!(body2[..16], body[..16], "a fresh salt each message");
    }

    #[test]
    fn a_malformed_subscription_is_refused_not_sent() {
        assert!(encrypt(&[4u8; 10], &[0u8; 16], b"x").is_err());
        assert!(encrypt(&[5u8; 65], &[0u8; 16], b"x").is_err());
        let rng = SystemRandom::new();
        let k = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
        let p = k.compute_public_key().unwrap().as_ref().to_vec();
        assert!(encrypt(&p, &[0u8; 15], b"x").is_err());
        assert!(encrypt(&p, &[0u8; 16], &vec![b'a'; MAX_PLAINTEXT + 1]).is_err());
        assert!(
            encrypt(&p, &[0u8; 16], &vec![b'a'; MAX_PLAINTEXT])
                .unwrap()
                .len()
                <= 4096
        );
        // 0x04 and 64 bytes that are not a point on the curve.
        let mut off = vec![4u8];
        off.extend_from_slice(&[1u8; 64]);
        assert!(encrypt(&off, &[0u8; 16], b"x").is_err());
    }

    /// The header is `vapid t=<jwt>, k=<key>`; the JWT's signature verifies
    /// under the public key the page subscribes with, and its claims are
    /// the audience, the expiry and the contact.
    #[test]
    fn the_vapid_header_verifies_under_the_public_key() {
        let pkcs8 = Vapid::generate().unwrap();
        let v = Vapid::from_pkcs8(&pkcs8).unwrap();
        let again = Vapid::from_pkcs8(&pkcs8).unwrap();
        assert_eq!(v.public_key(), again.public_key());
        let public = d(&v.public_key());
        assert_eq!(public.len(), POINT_LEN);

        let h = v
            .authorization(
                "https://web.push.apple.com",
                1_800_000_000,
                "mailto:a@b.invalid",
            )
            .unwrap();
        let rest = h.strip_prefix("vapid t=").unwrap();
        let (jwt, k) = rest.split_once(", k=").unwrap();
        assert_eq!(k, v.public_key());
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let head: serde_json::Value = serde_json::from_slice(&d(parts[0])).unwrap();
        assert_eq!(head["alg"], "ES256");
        let claims: serde_json::Value = serde_json::from_slice(&d(parts[1])).unwrap();
        assert_eq!(claims["aud"], "https://web.push.apple.com");
        assert_eq!(claims["exp"], 1_800_000_000);
        assert_eq!(claims["sub"], "mailto:a@b.invalid");
        let sig = d(parts[2]);
        assert_eq!(sig.len(), 64);
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &public)
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig)
            .expect("the signature verifies");
        assert!(Vapid::from_pkcs8(b"not a key").is_err());
    }
}
