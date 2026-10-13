//! A phone's resend, recognised (wave 4, task C1).
//!
//! The phone cannot tell a request that never arrived from one whose
//! reply was lost: both are an `Unreachable`. It keeps the message (a held
//! message is sent again when the host is back; a new item's draft stays
//! for another Create), so a lost reply used to mean a second turn, a
//! second chat, or a second item. Now the phone sends a `nonce` with each
//! message, the same one on every try of it, and the listener remembers
//! the nonces it took for [`REMEMBER_FOR`]: a try it has seen gets the
//! first try's answer and does nothing again. The Mac's listener and
//! `serve` share this router, so both recognise it.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// How long a nonce is remembered: longer than any phone waits before it
/// tries again (a held message goes when the host is next reachable).
pub const REMEMBER_FOR: Duration = Duration::from_secs(30 * 60);
/// At most this many nonces; the oldest go first past it.
const MOST: usize = 2048;
/// A longer nonce is ignored (the request is taken as one without).
const NONCE_MAX: usize = 128;

/// A request body with the phone's optional `nonce` beside its fields, so
/// the hosts' request types do not change.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WithNonce<T> {
    #[serde(flatten)]
    pub req: T,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce: Option<String>,
}

/// What the listener knows of a nonce.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seen<T> {
    /// Not seen: this try is the first, and does the work.
    First,
    /// The first try is still running.
    Running,
    /// The first try's answer.
    Done(T),
}

/// The nonces taken lately, with each one's answer once it has one.
#[derive(Debug)]
pub struct Resent<T> {
    seen: Mutex<HashMap<String, (Instant, Option<T>)>>,
}

impl<T> Default for Resent<T> {
    fn default() -> Self {
        Self {
            seen: Mutex::new(HashMap::new()),
        }
    }
}

/// The nonce as a key, or `None` for a request without a usable one.
fn key(kind: &str, nonce: Option<&str>) -> Option<String> {
    let n = nonce?.trim();
    (!n.is_empty() && n.len() <= NONCE_MAX).then(|| format!("{kind}:{n}"))
}

impl<T: Clone> Resent<T> {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, (Instant, Option<T>)>> {
        self.seen.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Look `nonce` up for a `kind` of request; when unseen, mark it
    /// running (so a try that lands while the first runs does not run it
    /// again). A request without a nonce is always [`Seen::First`].
    pub fn claim(&self, kind: &str, nonce: Option<&str>) -> Seen<T> {
        let Some(k) = key(kind, nonce) else {
            return Seen::First;
        };
        let now = Instant::now();
        let mut seen = self.lock();
        seen.retain(|_, (at, _)| now.duration_since(*at) < REMEMBER_FOR);
        if let Some((_, answer)) = seen.get(&k) {
            return match answer {
                Some(a) => Seen::Done(a.clone()),
                None => Seen::Running,
            };
        }
        if seen.len() >= MOST
            && let Some(oldest) = seen
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
        {
            seen.remove(&oldest);
        }
        seen.insert(k, (now, None));
        Seen::First
    }

    /// The first try's outcome: an answer is kept for the next try; a
    /// refusal forgets the nonce, so trying again really tries again
    /// (nothing was done).
    pub fn settle<E>(&self, kind: &str, nonce: Option<&str>, outcome: &Result<T, E>) {
        let Some(k) = key(kind, nonce) else {
            return;
        };
        let mut seen = self.lock();
        match outcome {
            Ok(answer) => {
                seen.insert(k, (Instant::now(), Some(answer.clone())));
            }
            Err(_) => {
                seen.remove(&k);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_try_gets_the_first_answer_and_a_refusal_is_forgotten() {
        let r: Resent<u32> = Resent::default();
        assert_eq!(r.claim("send", Some("n1")), Seen::First);
        assert_eq!(r.claim("send", Some("n1")), Seen::Running);
        r.settle::<()>("send", Some("n1"), &Ok(7));
        assert_eq!(r.claim("send", Some("n1")), Seen::Done(7));
        // Another kind with the same nonce is another request.
        assert_eq!(r.claim("new", Some("n1")), Seen::First);
        // A refusal: the next try runs.
        assert_eq!(r.claim("send", Some("n2")), Seen::First);
        r.settle::<&str>("send", Some("n2"), &Err("refused"));
        assert_eq!(r.claim("send", Some("n2")), Seen::First);
    }

    #[test]
    fn no_nonce_or_a_blank_or_oversized_one_is_always_first() {
        let r: Resent<u32> = Resent::default();
        for n in [None, Some(""), Some("  ")] {
            assert_eq!(r.claim("send", n), Seen::First);
            assert_eq!(r.claim("send", n), Seen::First);
        }
        let long = "x".repeat(NONCE_MAX + 1);
        assert_eq!(r.claim("send", Some(&long)), Seen::First);
        assert_eq!(r.claim("send", Some(&long)), Seen::First);
    }

    #[test]
    fn the_oldest_nonce_goes_past_the_cap() {
        let r: Resent<u32> = Resent::default();
        for i in 0..MOST {
            assert_eq!(r.claim("send", Some(&format!("n{i}"))), Seen::First);
        }
        assert_eq!(r.claim("send", Some("one more")), Seen::First);
        assert_eq!(r.lock().len(), MOST);
        assert_eq!(r.claim("send", Some("one more")), Seen::Running);
    }

    #[test]
    fn the_nonce_rides_beside_the_hosts_fields() {
        let w: WithNonce<super::super::SendRequest> =
            serde_json::from_str(r#"{"text":"hi","nonce":"abc","spoken":true}"#).unwrap();
        assert_eq!(w.nonce.as_deref(), Some("abc"));
        assert_eq!(w.req.text, "hi");
        assert!(w.req.spoken);
        let w: WithNonce<super::super::SendRequest> =
            serde_json::from_str(r#"{"text":"hi"}"#).unwrap();
        assert_eq!(w.nonce, None);
    }
}
