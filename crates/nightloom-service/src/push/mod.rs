//! Push notifications for the phone page (nightshift item 739).
//!
//! The phone page is a Home Screen web app; since iOS 16.4 such a page can
//! be sent real pushes (Lock Screen, badge) through Apple's push service
//! with no native app. This module is a host's whole part in that:
//!
//! - **the key** ([`crypto::Vapid`]): one ECDSA P-256 key pair, made the
//!   first time a phone asks and kept as `vapid.pk8` in `<home>/remote/push/`
//!   (mode 0600). Its public half is what the page subscribes with. The Mac
//!   and the away server must sign with the *same* key — a phone holds one
//!   subscription, tied to one key — so the Mac's sync pass hands its key to
//!   the away server ([`Push::adopt`]); the key is never logged or shown.
//! - **the subscriptions** (`subscriptions.json`, same folder, 0600): what
//!   the page's Subscribe button sent — an endpoint at the push service and
//!   the phone's two keys. An endpoint is taken only at a known push
//!   service over HTTPS, so the token cannot be used to make this host call
//!   an arbitrary address.
//! - **the sender** ([`Push::notify`]): one message per subscription,
//!   sealed for that phone ([`crypto::encrypt`]) and signed by the key. A
//!   subscription the service says is gone (404, 410) is dropped.
//!
//! **What a push says** (blocker 2011, its default taken): the chat's name
//! and its state — "Finished", "Waiting for your approval" — and nothing of
//! the reply, a tool's input or an error's text. The body is sealed for the
//! phone, but the default is that no reply text leaves his machines.
//!
//! **When** — a turn ended, failed, or was paused by the plan's limit; an
//! approval or a question is waiting — and **not while he is at the Mac**:
//! the caller says so ([`Note::at_the_mac`]) and such a note is not sent.
//!
//! **The badge** is the number of chats waiting on him: a chat is added by
//! each push about it and taken off when it is opened or answered from the
//! phone, sent to, or heard of while he is at the Mac ([`Push::seen`]).

pub mod crypto;

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crypto::Vapid;

/// The most phones (subscriptions) one host keeps; the oldest goes first.
pub const MAX_SUBSCRIPTIONS: usize = 16;
/// How long the push service keeps a message for a phone that is off.
const TTL_SECS: u32 = 4 * 3600;
/// How long one VAPID token is good for (the services allow a day).
const TOKEN_SECS: i64 = 12 * 3600;
/// A "finished" this soon after the same chat's "failed" or "paused by the
/// limit" is the same turn's end said twice, and is not sent.
const SAME_END: Duration = Duration::from_secs(10);
/// The VAPID contact claim when `<dir>/subject` does not name one. A push
/// service uses it to reach a sender that misbehaves; it must be a
/// `mailto:` or `https:` URI, and his own address is never put here by
/// default.
const DEFAULT_SUBJECT: &str = "mailto:push@nightloom.invalid";
/// The longest chat name a push carries.
const NAME_MAX: usize = 80;

/// What [`Push::subscribe`] answers when the page subscribed with another
/// host's key (the phone page shows it; it clears after the Mac's next sync).
pub const KEY_DIFFERS: &str = "this host's push key is not the one the phone subscribed with — it will match after the Mac's next sync";

/// What happened in a chat.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum What {
    /// The turn ended.
    Done,
    /// The turn failed.
    Failed,
    /// The plan's usage limit paused the turn.
    Limit,
    /// A tool call waits for Allow or Deny.
    Approval,
    /// A question (or a plan) waits for his answer.
    Question,
}

impl What {
    /// The push's second line: the state, in words. Never the reply.
    pub fn words(self) -> &'static str {
        match self {
            What::Done => "Finished",
            What::Failed => "Failed",
            What::Limit => "Paused by the usage limit",
            What::Approval => "Waiting for your approval",
            What::Question => "Has a question for you",
        }
    }

    /// The kind for a `tool-approval` prompt by its tool's name: a question
    /// form or a plan is an answer he writes, the rest an Allow or Deny.
    pub fn for_prompt(tool: &str) -> Self {
        match tool {
            "AskUserQuestion" | "ExitPlanMode" => What::Question,
            _ => What::Approval,
        }
    }
}

/// One thing to tell the phone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub what: What,
    /// The chat's id; the tap opens it.
    #[serde(default)]
    pub chat: Option<String>,
    /// The chat's name as its lists show it.
    #[serde(default)]
    pub label: Option<String>,
    /// The chat's project, for the tap.
    #[serde(default)]
    pub project: Option<String>,
    /// He is at the Mac: nothing is sent, and the chat stops waiting.
    #[serde(default)]
    pub at_the_mac: bool,
}

/// What became of one [`Push::notify`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Sent {
    /// Phones the push service took the message for.
    pub sent: usize,
    /// Subscriptions the service said are gone, now forgotten.
    pub dropped: usize,
    /// Sends that failed (kept; the next note tries again).
    pub failed: usize,
    /// Why nothing was tried, when nothing was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<&'static str>,
}

/// A phone's subscription, as the page's `PushSubscription.toJSON()` plus
/// the key it subscribed with.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscribeRequest {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
    /// The `applicationServerKey` the page used (base64url).
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Subscription {
    endpoint: String,
    p256dh: String,
    auth: String,
    added: DateTime<Utc>,
}

/// `GET /api/push`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Status {
    /// This host's public key — the page's `applicationServerKey`.
    pub key: String,
    /// How many phones are subscribed here.
    pub subscriptions: usize,
    /// Chats waiting on him: the badge.
    pub waiting: usize,
}

/// One row of `GET /api/push/feed` (item 741): the last thing that happened
/// in a chat he has not opened since — the phone's home screen sorts these
/// into "needs you" (an approval, a question) and "done since you looked"
/// (finished, failed, paused). Kept whether or not a phone is subscribed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FeedRow {
    pub what: What,
    pub chat: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    /// When it happened, unix milliseconds.
    pub at: i64,
}

/// The most chats the feed holds; the oldest row goes first.
pub const FEED_MAX: usize = 200;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// One request to a push service. A trait so the tests send nowhere.
#[async_trait::async_trait]
pub trait Transport: Send + Sync + 'static {
    /// POST `body` to `endpoint`; the HTTP status, or why there was none.
    async fn post(
        &self,
        endpoint: &str,
        authorization: &str,
        topic: &str,
        body: Vec<u8>,
    ) -> Result<u16, String>;
}

struct Https(reqwest::Client);

#[async_trait::async_trait]
impl Transport for Https {
    async fn post(
        &self,
        endpoint: &str,
        authorization: &str,
        topic: &str,
        body: Vec<u8>,
    ) -> Result<u16, String> {
        let mut req = self
            .0
            .post(endpoint)
            .header("Authorization", authorization)
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header("TTL", TTL_SECS.to_string())
            .header("Urgency", "high");
        if !topic.is_empty() {
            req = req.header("Topic", topic);
        }
        // The error's own text may carry the endpoint (a capability URL):
        // say only that the request did not complete.
        req.body(body)
            .send()
            .await
            .map(|r| r.status().as_u16())
            .map_err(|e| {
                if e.is_timeout() {
                    "the push service did not answer in time".to_string()
                } else {
                    "the push service could not be reached".to_string()
                }
            })
    }
}

#[derive(Default)]
struct Inner {
    vapid: Option<Arc<Vapid>>,
    subs: Option<Vec<Subscription>>,
    waiting: BTreeSet<String>,
    /// Item 741: the last note per chat he has not opened since.
    feed: HashMap<String, FeedRow>,
    /// The last note sent per chat, for [`SAME_END`].
    last: HashMap<String, (What, Instant)>,
}

/// One host's push state. Cheap to share (`Arc`); every method locks
/// briefly and none holds the lock across a request.
pub struct Push {
    dir: PathBuf,
    /// `mac` or `away`: which host the tap should open the chat on.
    role: &'static str,
    transport: Arc<dyn Transport>,
    inner: Mutex<Inner>,
}

impl Push {
    /// Push state under `dir` (`<home>/remote/push`). Nothing is read or
    /// made until a phone asks.
    pub fn open(dir: PathBuf, role: &'static str) -> Arc<Self> {
        let http = client().unwrap_or_default();
        Self::with_transport(dir, role, Arc::new(Https(http)))
    }

    pub fn with_transport(
        dir: PathBuf,
        role: &'static str,
        transport: Arc<dyn Transport>,
    ) -> Arc<Self> {
        Arc::new(Self {
            dir,
            role,
            transport,
            inner: Mutex::new(Inner::default()),
        })
    }

    /// The folder push keeps its two files in, under a host's home.
    pub fn dir_under(home: &Path) -> PathBuf {
        home.join("remote").join("push")
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn key_path(&self) -> PathBuf {
        self.dir.join("vapid.pk8")
    }

    fn subs_path(&self) -> PathBuf {
        self.dir.join("subscriptions.json")
    }

    /// The key, read from disk or made now.
    fn vapid(&self, inner: &mut Inner) -> Result<Arc<Vapid>, String> {
        if let Some(v) = &inner.vapid {
            return Ok(v.clone());
        }
        let path = self.key_path();
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let b = Vapid::generate()?;
                write_private(&path, &b)?;
                b
            }
            // Unreadable is not "absent": a new key would orphan every
            // phone's subscription.
            Err(e) => return Err(format!("the push key could not be read: {e}")),
        };
        let v = Arc::new(Vapid::from_pkcs8(&bytes)?);
        inner.vapid = Some(v.clone());
        Ok(v)
    }

    fn subs<'a>(&self, inner: &'a mut Inner) -> &'a mut Vec<Subscription> {
        inner.subs.get_or_insert_with(|| {
            std::fs::read(self.subs_path())
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_default()
        })
    }

    fn save_subs(&self, subs: &[Subscription]) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(subs).map_err(|e| e.to_string())?;
        write_private(&self.subs_path(), &bytes)
    }

    /// This host's public key, made on the first ask.
    pub fn public_key(&self) -> Result<String, String> {
        let mut inner = self.lock();
        Ok(self.vapid(&mut inner)?.public_key())
    }

    pub fn status(&self) -> Result<Status, String> {
        let mut inner = self.lock();
        let key = self.vapid(&mut inner)?.public_key();
        let subscriptions = self.subs(&mut inner).len();
        Ok(Status {
            key,
            subscriptions,
            waiting: inner.waiting.len(),
        })
    }

    /// The key as PKCS#8, for the Mac to hand its away server
    /// ([`Push::adopt`]). Only ever put in a request body to that server.
    pub fn export_key(&self) -> Result<Vec<u8>, String> {
        let mut inner = self.lock();
        self.vapid(&mut inner)?;
        std::fs::read(self.key_path()).map_err(|e| format!("the push key could not be read: {e}"))
    }

    /// Take another host's key as this one's (the away server, from the
    /// Mac). `false` when it is already the key here. Subscriptions were
    /// made under the old key and cannot be sent to with the new one: they
    /// are forgotten, and the page subscribes again on its next open.
    pub fn adopt(&self, pkcs8: &[u8]) -> Result<bool, String> {
        let new = Arc::new(Vapid::from_pkcs8(pkcs8)?);
        let mut inner = self.lock();
        let have = match std::fs::read(self.key_path()) {
            Ok(b) => Vapid::from_pkcs8(&b).ok().map(|v| v.public_key()),
            Err(_) => None,
        };
        if have.as_deref() == Some(new.public_key().as_str()) {
            inner.vapid = Some(new);
            return Ok(false);
        }
        write_private(&self.key_path(), pkcs8)?;
        inner.vapid = Some(new);
        inner.subs = Some(Vec::new());
        self.save_subs(&[])?;
        Ok(true)
    }

    /// Keep a phone's subscription (again: the same endpoint replaces its
    /// row). Refused unless it was made with this host's key and points at
    /// a push service.
    pub fn subscribe(&self, req: SubscribeRequest) -> Result<(), String> {
        push_origin(&req.endpoint)?;
        let p256dh = crypto::unb64(&req.keys.p256dh).unwrap_or_default();
        let auth = crypto::unb64(&req.keys.auth).unwrap_or_default();
        if p256dh.len() != crypto::POINT_LEN || p256dh[0] != 4 || auth.len() != crypto::AUTH_LEN {
            return Err("the subscription's keys are not a push subscription's".into());
        }
        let mut inner = self.lock();
        let mine = self.vapid(&mut inner)?.public_key();
        if crypto::unb64(&req.key) != crypto::unb64(&mine) {
            return Err(KEY_DIFFERS.into());
        }
        let subs = self.subs(&mut inner);
        subs.retain(|s| s.endpoint != req.endpoint);
        subs.push(Subscription {
            endpoint: req.endpoint,
            p256dh: crypto::b64(&p256dh),
            auth: crypto::b64(&auth),
            added: Utc::now(),
        });
        while subs.len() > MAX_SUBSCRIPTIONS {
            subs.remove(0);
        }
        let all = subs.clone();
        self.save_subs(&all)
    }

    /// Forget a phone's subscription (the page's off switch). `true` when
    /// there was one.
    pub fn unsubscribe(&self, endpoint: &str) -> Result<bool, String> {
        let mut inner = self.lock();
        let subs = self.subs(&mut inner);
        let before = subs.len();
        subs.retain(|s| s.endpoint != endpoint);
        if subs.len() == before {
            return Ok(false);
        }
        let all = subs.clone();
        self.save_subs(&all)?;
        Ok(true)
    }

    /// He opened, answered or wrote in `chat`: it no longer waits on him.
    pub fn seen(&self, chat: &str) {
        let mut inner = self.lock();
        inner.waiting.remove(chat);
        inner.feed.remove(chat);
    }

    /// The home screen's rows (item 741): the last note of every chat he
    /// has not opened since, newest first.
    pub fn feed(&self) -> Vec<FeedRow> {
        let mut rows: Vec<FeedRow> = self.lock().feed.values().cloned().collect();
        rows.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.chat.cmp(&b.chat)));
        rows
    }

    /// Whether any phone is subscribed — a caller's cheap way to skip the
    /// work of composing a note.
    pub fn any(&self) -> bool {
        let mut inner = self.lock();
        !self.subs(&mut inner).is_empty()
    }

    /// Tell every subscribed phone. Never fails: what happened is in
    /// [`Sent`], and a push that could not go is not worth failing a turn.
    pub async fn notify(&self, note: Note) -> Sent {
        let chat = note.chat.clone().unwrap_or_default();
        let (vapid, subs, badge) = {
            let mut inner = self.lock();
            if note.at_the_mac {
                inner.waiting.remove(&chat);
                inner.feed.remove(&chat);
                return Sent {
                    skipped: Some("he is at the Mac"),
                    ..Sent::default()
                };
            }
            if note.what == What::Done
                && inner.last.get(&chat).is_some_and(|(w, at)| {
                    matches!(w, What::Failed | What::Limit) && at.elapsed() < SAME_END
                })
            {
                return Sent {
                    skipped: Some("the same turn's end, already said"),
                    ..Sent::default()
                };
            }
            // Item 741: the home screen's row, subscribed phone or none.
            if !chat.is_empty() {
                if inner.feed.len() >= FEED_MAX && !inner.feed.contains_key(&chat) {
                    let oldest = inner
                        .feed
                        .values()
                        .min_by_key(|r| r.at)
                        .map(|r| r.chat.clone());
                    if let Some(oldest) = oldest {
                        inner.feed.remove(&oldest);
                    }
                }
                inner.feed.insert(
                    chat.clone(),
                    FeedRow {
                        what: note.what,
                        chat: chat.clone(),
                        label: note.label.clone(),
                        project: note.project.clone(),
                        at: now_ms(),
                    },
                );
            }
            if self.subs(&mut inner).is_empty() {
                return Sent {
                    skipped: Some("no phone is subscribed"),
                    ..Sent::default()
                };
            }
            let Ok(vapid) = self.vapid(&mut inner) else {
                return Sent {
                    skipped: Some("the push key could not be read"),
                    ..Sent::default()
                };
            };
            if !chat.is_empty() {
                inner.waiting.insert(chat.clone());
                inner.last.insert(chat.clone(), (note.what, Instant::now()));
            }
            let subs = self.subs(&mut inner).clone();
            (vapid, subs, inner.waiting.len())
        };
        let payload = self.payload(&note, badge);
        self.deliver(&vapid, subs, &payload, &topic_for(&chat))
            .await
    }

    /// A push that says only that push works — the page's "Send a test".
    pub async fn test(&self) -> Sent {
        let (vapid, subs, badge) = {
            let mut inner = self.lock();
            if self.subs(&mut inner).is_empty() {
                return Sent {
                    skipped: Some("no phone is subscribed"),
                    ..Sent::default()
                };
            }
            let Ok(vapid) = self.vapid(&mut inner) else {
                return Sent {
                    skipped: Some("the push key could not be read"),
                    ..Sent::default()
                };
            };
            let subs = self.subs(&mut inner).clone();
            (vapid, subs, inner.waiting.len())
        };
        let payload = serde_json::json!({
            "title": "Nightloom",
            "body": format!("Notifications are on ({})", if self.role == "away" { "Away" } else { "the Mac" }),
            "tag": "nightloom-test",
            "host": self.role,
            "badge": badge,
            "kind": "test",
        })
        .to_string();
        self.deliver(&vapid, subs, &payload, "nightloomtest").await
    }

    /// What the phone's service worker is handed: the chat's name, the
    /// state in words, where a tap goes, the badge. Nothing of the reply.
    fn payload(&self, note: &Note, badge: usize) -> String {
        let name = note
            .label
            .as_deref()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .unwrap_or("A chat");
        let title: String = if name.chars().count() > NAME_MAX {
            let mut t: String = name.chars().take(NAME_MAX - 1).collect();
            t.push('…');
            t
        } else {
            name.to_string()
        };
        serde_json::json!({
            "title": title,
            "body": note.what.words(),
            "tag": note.chat.as_deref().unwrap_or("nightloom"),
            "chat": note.chat,
            "project": note.project,
            "host": self.role,
            "badge": badge,
            "kind": note.what,
        })
        .to_string()
    }

    async fn deliver(
        &self,
        vapid: &Vapid,
        subs: Vec<Subscription>,
        payload: &str,
        topic: &str,
    ) -> Sent {
        let mut out = Sent::default();
        let mut gone = Vec::new();
        let expires = Utc::now().timestamp() + TOKEN_SECS;
        let subject = self.subject();
        for s in subs {
            let sealed = push_origin(&s.endpoint).and_then(|aud| {
                let body = crypto::encrypt(
                    &crypto::unb64(&s.p256dh).unwrap_or_default(),
                    &crypto::unb64(&s.auth).unwrap_or_default(),
                    payload.as_bytes(),
                )?;
                Ok((vapid.authorization(&aud, expires, &subject)?, body))
            });
            let Ok((authorization, body)) = sealed else {
                // A row that can never be sent to (a hand-edited file).
                gone.push(s.endpoint);
                out.dropped += 1;
                continue;
            };
            match self
                .transport
                .post(&s.endpoint, &authorization, topic, body)
                .await
            {
                Ok(200..=299) => out.sent += 1,
                Ok(404 | 410) => {
                    gone.push(s.endpoint);
                    out.dropped += 1;
                }
                Ok(_) | Err(_) => out.failed += 1,
            }
        }
        if !gone.is_empty() {
            let mut inner = self.lock();
            let subs = self.subs(&mut inner);
            subs.retain(|s| !gone.contains(&s.endpoint));
            let all = subs.clone();
            let _ = self.save_subs(&all);
        }
        out
    }

    fn subject(&self) -> String {
        std::fs::read_to_string(self.dir.join("subject"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| s.starts_with("mailto:") || s.starts_with("https://"))
            .unwrap_or_else(|| DEFAULT_SUBJECT.to_string())
    }
}

/// The Mac's half of "both hosts sign with one key": ask the away server
/// at `base` for its public key and, when it is not the Mac's, hand it the
/// Mac's key (`POST /api/push/key`, bearer `token`, over the same HTTPS the
/// sync uses). `Ok(true)` when the server took it, `Ok(false)` when it had
/// it already or has no push (an older build: 404 or 501).
pub async fn hand_key_to_away(push: &Push, base: &str, token: &str) -> Result<bool, String> {
    let base = base.trim().trim_end_matches('/');
    if !key_may_go_to(base) {
        return Err(KEY_NEEDS_A_SAFE_ROAD.into());
    }
    let mine = push.public_key()?;
    let http = client()?;
    let unreachable = |_| "the away server did not answer about push".to_string();
    let r = http
        .get(format!("{base}/api/push"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(unreachable)?;
    if matches!(r.status().as_u16(), 404 | 501) {
        return Ok(false);
    }
    if !r.status().is_success() {
        return Err(format!(
            "the away server answered {} about push",
            r.status().as_u16()
        ));
    }
    let theirs: Status = r.json().await.map_err(unreachable)?;
    if crypto::unb64(&theirs.key) == crypto::unb64(&mine) {
        return Ok(false);
    }
    let r = http
        .post(format!("{base}/api/push/key"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "pkcs8": crypto::b64(&push.export_key()?) }))
        .send()
        .await
        .map_err(unreachable)?;
    if !r.status().is_success() {
        return Err(format!(
            "the away server would not take the push key ({})",
            r.status().as_u16()
        ));
    }
    Ok(true)
}

/// The HTTP client both push requests use: ten seconds, and no redirect
/// followed (739 review L1). A push service's 3xx would otherwise carry
/// the send past the endpoint allow-list, and a 307 or 308 to the key
/// hand-off would re-post its body — the private key — to the `Location`.
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())
}

/// What [`hand_key_to_away`] answers for an address the key may not travel
/// to (739 review L2).
pub const KEY_NEEDS_A_SAFE_ROAD: &str =
    "the push key goes to the away server only over https or the tailnet";

/// Whether the private key may be sent to `base` (739 review L2): HTTPS;
/// or plain HTTP inside the tailnet — a `100.64.0.0/10` address or a
/// `*.ts.net` name, whose leg WireGuard encrypts — or to this machine
/// itself (loopback). Never plain HTTP across another network.
fn key_may_go_to(base: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(base) else {
        return false;
    };
    match url.scheme() {
        "https" => true,
        "http" => {
            let Some(host) = url.host_str() else {
                return false;
            };
            let host = host.trim_start_matches('[').trim_end_matches(']');
            match host.parse::<std::net::IpAddr>() {
                Ok(ip) => crate::remote::tailnet::is_tailnet(ip) || ip.is_loopback(),
                Err(_) => {
                    let host = host.to_ascii_lowercase();
                    host.ends_with(".ts.net") || host == "localhost"
                }
            }
        }
        _ => false,
    }
}

/// The push services a subscription may point at: Apple's (every iPhone),
/// and the three a desktop or Android browser would use.
const PUSH_HOSTS: [&str; 4] = [
    ".push.apple.com",
    "fcm.googleapis.com",
    ".push.services.mozilla.com",
    ".notify.windows.com",
];

/// The endpoint's origin (the VAPID audience), or why it is not an
/// endpoint this host will call: HTTPS, default port, a known push service.
fn push_origin(endpoint: &str) -> Result<String, String> {
    let bad = || "the subscription does not point at a push service".to_string();
    let url = reqwest::Url::parse(endpoint).map_err(|_| bad())?;
    let host = url.host_str().ok_or_else(bad)?.to_ascii_lowercase();
    let known = PUSH_HOSTS.iter().any(|h| match h.strip_prefix('.') {
        Some(rest) => host == rest || host.ends_with(h),
        None => host == *h,
    });
    if url.scheme() != "https" || url.port().is_some() || !url.username().is_empty() || !known {
        return Err(bad());
    }
    Ok(format!("https://{host}"))
}

/// The `Topic` header for a chat: a newer push about the same chat replaces
/// an undelivered older one. At most 32 characters of the URL-safe alphabet.
fn topic_for(chat: &str) -> String {
    chat.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(32)
        .collect()
}

/// Write `bytes` to `path` readable by him alone, in a folder made the same.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no folder for the push files")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not make {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let tmp = path.with_extension("tmp");
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        use std::io::Write;
        let mut f = opts
            .open(&tmp)
            .map_err(|e| format!("could not write the push files: {e}"))?;
        f.write_all(bytes)
            .map_err(|e| format!("could not write the push files: {e}"))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("could not write the push files: {e}"))
}

#[cfg(test)]
mod tests;
