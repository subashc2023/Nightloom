//! The subscription store and the sender (item 739). No test sends
//! anywhere: the transport is a recorder.

use super::*;
use ring::agreement;
use ring::rand::SystemRandom;

#[derive(Default)]
struct Recorder {
    /// (endpoint, authorization, topic, body length)
    posts: Mutex<Vec<(String, String, String, usize)>>,
    /// The status to answer per endpoint; 201 otherwise.
    answers: Mutex<HashMap<String, Result<u16, String>>>,
}

impl Recorder {
    fn posts(&self) -> Vec<(String, String, String, usize)> {
        self.posts.lock().unwrap().clone()
    }
    fn answer(&self, endpoint: &str, a: Result<u16, String>) {
        self.answers.lock().unwrap().insert(endpoint.into(), a);
    }
}

#[async_trait::async_trait]
impl Transport for Recorder {
    async fn post(
        &self,
        endpoint: &str,
        authorization: &str,
        topic: &str,
        body: Vec<u8>,
    ) -> Result<u16, String> {
        self.posts.lock().unwrap().push((
            endpoint.into(),
            authorization.into(),
            topic.into(),
            body.len(),
        ));
        self.answers
            .lock()
            .unwrap()
            .get(endpoint)
            .cloned()
            .unwrap_or(Ok(201))
    }
}

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("nightloom-push-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn push(tag: &str) -> (Arc<Push>, Arc<Recorder>, PathBuf) {
    let dir = scratch(tag);
    let rec = Arc::new(Recorder::default());
    (
        Push::with_transport(dir.clone(), "mac", rec.clone()),
        rec,
        dir,
    )
}

/// A phone's subscription at `endpoint`, made with `key`.
fn phone(endpoint: &str, key: &str) -> SubscribeRequest {
    let rng = SystemRandom::new();
    let k = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
    SubscribeRequest {
        endpoint: endpoint.into(),
        keys: SubscriptionKeys {
            p256dh: crypto::b64(k.compute_public_key().unwrap().as_ref()),
            auth: crypto::b64(&[9u8; 16]),
        },
        key: key.into(),
    }
}

const APPLE: &str = "https://web.push.apple.com/QGq7abc";
const APPLE2: &str = "https://web.push.apple.com/Zother";

fn note(what: What, chat: &str) -> Note {
    Note {
        what,
        chat: Some(chat.into()),
        label: Some("Fix the tab drag".into()),
        project: Some("p1".into()),
        at_the_mac: false,
        detail: None,
    }
}

#[test]
fn the_key_is_made_once_kept_private_and_read_back() {
    let (p, _, dir) = push("key");
    let key = p.public_key().unwrap();
    assert_eq!(crypto::unb64(&key).unwrap().len(), crypto::POINT_LEN);
    assert_eq!(p.public_key().unwrap(), key);
    // A second process over the same folder reads the same key.
    let again = Push::with_transport(dir.clone(), "mac", Arc::new(Recorder::default()));
    assert_eq!(again.public_key().unwrap(), key);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.join("vapid.pk8"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        let dmode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(dmode & 0o777, 0o700);
    }
    // A key file that does not read as a key is an error, never a new key.
    std::fs::write(dir.join("vapid.pk8"), b"garbage").unwrap();
    let broken = Push::with_transport(dir.clone(), "mac", Arc::new(Recorder::default()));
    assert!(broken.public_key().is_err());
    assert_eq!(std::fs::read(dir.join("vapid.pk8")).unwrap(), b"garbage");
}

#[test]
fn a_subscription_is_kept_replaced_by_endpoint_and_forgotten() {
    let (p, _, dir) = push("store");
    let key = p.public_key().unwrap();
    p.subscribe(phone(APPLE, &key)).unwrap();
    p.subscribe(phone(APPLE, &key)).unwrap();
    p.subscribe(phone(APPLE2, &key)).unwrap();
    assert_eq!(p.status().unwrap().subscriptions, 2);
    // On disk, private, and read by a second instance.
    let again = Push::with_transport(dir.clone(), "mac", Arc::new(Recorder::default()));
    assert_eq!(again.status().unwrap().subscriptions, 2);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.join("subscriptions.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    assert!(p.unsubscribe(APPLE).unwrap());
    assert!(!p.unsubscribe(APPLE).unwrap());
    assert_eq!(p.status().unwrap().subscriptions, 1);
    assert!(p.any());
    assert!(p.unsubscribe(APPLE2).unwrap());
    assert!(!p.any());
}

#[test]
fn only_a_push_service_endpoint_made_with_this_key_is_taken() {
    let (p, _, _) = push("refuse");
    let key = p.public_key().unwrap();
    for bad in [
        "http://web.push.apple.com/x",
        "https://example.com/x",
        "https://web.push.apple.com.evil.example/x",
        "https://evilpush.apple.com.example/x",
        "https://127.0.0.1/x",
        "https://web.push.apple.com:8443/x",
        "https://user@web.push.apple.com/x",
        "not a url",
    ] {
        assert!(p.subscribe(phone(bad, &key)).is_err(), "{bad}");
    }
    for good in [
        APPLE,
        "https://fcm.googleapis.com/fcm/send/abc",
        "https://updates.push.services.mozilla.com/wpush/v2/abc",
    ] {
        p.subscribe(phone(good, &key)).unwrap();
    }
    // Another host's key: refused with the sentence the page shows.
    let (other, _, _) = push("refuse-other");
    let e = p
        .subscribe(phone(APPLE2, &other.public_key().unwrap()))
        .unwrap_err();
    assert_eq!(e, KEY_DIFFERS);
    // Keys that are not a subscription's.
    let mut short = phone(APPLE2, &key);
    short.keys.auth = crypto::b64(&[1u8; 4]);
    assert!(p.subscribe(short).is_err());
    assert_eq!(p.status().unwrap().subscriptions, 3);
}

#[test]
fn the_oldest_subscription_goes_past_the_cap() {
    let (p, _, _) = push("cap");
    let key = p.public_key().unwrap();
    for i in 0..(MAX_SUBSCRIPTIONS + 2) {
        p.subscribe(phone(&format!("https://web.push.apple.com/{i}"), &key))
            .unwrap();
    }
    assert_eq!(p.status().unwrap().subscriptions, MAX_SUBSCRIPTIONS);
    assert!(!p.unsubscribe("https://web.push.apple.com/0").unwrap());
    assert!(p.unsubscribe("https://web.push.apple.com/2").unwrap());
}

#[tokio::test]
async fn a_note_goes_to_every_phone_signed_and_sealed() {
    let (p, rec, _) = push("send");
    let key = p.public_key().unwrap();
    p.subscribe(phone(APPLE, &key)).unwrap();
    p.subscribe(phone("https://fcm.googleapis.com/fcm/send/abc", &key))
        .unwrap();
    let chat = "0b0e6a52-1111-4222-8333-444455556666";
    let sent = p.notify(note(What::Done, chat)).await;
    assert_eq!(
        sent,
        Sent {
            sent: 2,
            ..Sent::default()
        }
    );
    let posts = rec.posts();
    assert_eq!(posts.len(), 2);
    for (endpoint, authorization, topic, len) in &posts {
        // Signed for that service's origin, with this host's key.
        let jwt = authorization
            .strip_prefix("vapid t=")
            .and_then(|r| r.split_once(", k="))
            .unwrap();
        assert_eq!(jwt.1, key);
        let claims: serde_json::Value =
            serde_json::from_slice(&crypto::unb64(jwt.0.split('.').nth(1).unwrap()).unwrap())
                .unwrap();
        let origin = if endpoint.contains("apple") {
            "https://web.push.apple.com"
        } else {
            "https://fcm.googleapis.com"
        };
        assert_eq!(claims["aud"], origin);
        assert_eq!(claims["sub"], DEFAULT_SUBJECT);
        let exp = claims["exp"].as_i64().unwrap() - Utc::now().timestamp();
        assert!(exp > 0 && exp <= 24 * 3600, "{exp}");
        // One chat, one topic: 32 URL-safe characters.
        assert_eq!(topic, "0b0e6a52111142228333444455556666");
        // Sealed: the header, the payload, the delimiter, the tag.
        assert!(*len > 86 + 17 && *len <= 4096);
    }
}

#[test]
fn a_push_says_the_chat_and_its_state_and_nothing_else() {
    let (p, _, _) = push("payload");
    let mut n = note(What::Approval, "c1");
    let v: serde_json::Value = serde_json::from_str(&p.payload(&n, 3)).unwrap();
    assert_eq!(
        v,
        serde_json::json!({
            "title": "Fix the tab drag",
            "body": "Waiting for your approval",
            "tag": "c1",
            "chat": "c1",
            "project": "p1",
            "host": "mac",
            "badge": 3,
            "kind": "approval",
        })
    );
    for (w, words) in [
        (What::Done, "Finished"),
        (What::Failed, "Failed"),
        (What::Limit, "Paused by the usage limit"),
        (What::Question, "Has a question for you"),
        (What::Changes, "Wants to make changes — approve it?"),
    ] {
        n.what = w;
        let v: serde_json::Value = serde_json::from_str(&p.payload(&n, 0)).unwrap();
        assert_eq!(v["body"], words);
    }
    // No name: a plain one. A long name: cut, never the whole first message.
    n.label = Some("  ".into());
    let v: serde_json::Value = serde_json::from_str(&p.payload(&n, 0)).unwrap();
    assert_eq!(v["title"], "A chat");
    n.label = Some("é".repeat(300));
    let v: serde_json::Value = serde_json::from_str(&p.payload(&n, 0)).unwrap();
    assert_eq!(v["title"].as_str().unwrap().chars().count(), NAME_MAX);
    assert!(p.payload(&n, 0).len() <= crypto::MAX_PLAINTEXT);

    assert_eq!(What::for_prompt("AskUserQuestion"), What::Question);
    assert_eq!(What::for_prompt("ExitPlanMode"), What::Question);
    assert_eq!(What::for_prompt("Bash"), What::Approval);
}

#[tokio::test]
async fn nothing_is_sent_while_he_is_at_the_mac_or_with_no_phone() {
    let (p, rec, _) = push("quiet");
    let sent = p.notify(note(What::Done, "c1")).await;
    assert_eq!(sent.skipped, Some("no phone is subscribed"));
    let key = p.public_key().unwrap();
    p.subscribe(phone(APPLE, &key)).unwrap();

    p.notify(note(What::Approval, "c1")).await;
    assert_eq!(p.status().unwrap().waiting, 1);
    let mut n = note(What::Done, "c1");
    n.at_the_mac = true;
    let sent = p.notify(n).await;
    assert_eq!(sent.skipped, Some("he is at the Mac"));
    assert_eq!(sent.sent, 0);
    // One post (the approval), and the chat he is looking at stops waiting.
    assert_eq!(rec.posts().len(), 1);
    assert_eq!(p.status().unwrap().waiting, 0);
}

#[tokio::test]
async fn the_badge_counts_chats_waiting_and_falls_when_one_is_seen() {
    let (p, _, _) = push("badge");
    let key = p.public_key().unwrap();
    p.subscribe(phone(APPLE, &key)).unwrap();
    p.notify(note(What::Done, "c1")).await;
    p.notify(note(What::Approval, "c2")).await;
    p.notify(note(What::Question, "c2")).await;
    assert_eq!(p.status().unwrap().waiting, 2);
    p.seen("c2");
    assert_eq!(p.status().unwrap().waiting, 1);
    p.seen("nope");
    p.seen("c1");
    assert_eq!(p.status().unwrap().waiting, 0);
}

#[tokio::test]
async fn a_failed_or_paused_turn_is_not_also_called_finished() {
    let (p, rec, _) = push("same-end");
    let key = p.public_key().unwrap();
    p.subscribe(phone(APPLE, &key)).unwrap();
    assert_eq!(p.notify(note(What::Limit, "c1")).await.sent, 1);
    let again = p.notify(note(What::Done, "c1")).await;
    assert_eq!(again.skipped, Some("the same turn's end, already said"));
    // Another chat's end is its own; so is a later approval in the same one.
    assert_eq!(p.notify(note(What::Done, "c2")).await.sent, 1);
    assert_eq!(p.notify(note(What::Approval, "c1")).await.sent, 1);
    assert_eq!(p.notify(note(What::Done, "c1")).await.sent, 1);
    assert_eq!(rec.posts().len(), 4);
}

#[tokio::test]
async fn a_subscription_the_service_says_is_gone_is_forgotten_others_kept() {
    let (p, rec, dir) = push("gone");
    let key = p.public_key().unwrap();
    p.subscribe(phone(APPLE, &key)).unwrap();
    p.subscribe(phone(APPLE2, &key)).unwrap();
    p.subscribe(phone("https://fcm.googleapis.com/fcm/send/abc", &key))
        .unwrap();
    rec.answer(APPLE, Ok(410));
    rec.answer(APPLE2, Ok(500));
    let sent = p.notify(note(What::Done, "c1")).await;
    assert_eq!(
        sent,
        Sent {
            sent: 1,
            dropped: 1,
            failed: 1,
            skipped: None
        }
    );
    assert_eq!(p.status().unwrap().subscriptions, 2);
    // A request that never completed keeps its subscription too.
    rec.answer(APPLE2, Err("down".into()));
    let sent = p.notify(note(What::Done, "c2")).await;
    assert_eq!((sent.sent, sent.dropped, sent.failed), (1, 0, 1));
    let again = Push::with_transport(dir, "mac", Arc::new(Recorder::default()));
    assert_eq!(again.status().unwrap().subscriptions, 2);
}

#[tokio::test]
async fn the_away_server_adopts_the_mac_s_key_and_asks_phones_to_subscribe_again() {
    let (mac, _, _) = push("adopt-mac");
    let (away, rec, _) = push("adopt-away");
    let old = away.public_key().unwrap();
    away.subscribe(phone(APPLE, &old)).unwrap();
    assert_ne!(old, mac.public_key().unwrap());

    assert!(away.adopt(&mac.export_key().unwrap()).unwrap());
    assert_eq!(away.public_key().unwrap(), mac.public_key().unwrap());
    // The old subscription cannot be sent to with the new key: forgotten.
    assert_eq!(away.status().unwrap().subscriptions, 0);
    // Again: nothing changes, and a phone subscribed since is kept.
    away.subscribe(phone(APPLE, &mac.public_key().unwrap()))
        .unwrap();
    assert!(!away.adopt(&mac.export_key().unwrap()).unwrap());
    assert_eq!(away.status().unwrap().subscriptions, 1);
    assert_eq!(away.notify(note(What::Done, "c1")).await.sent, 1);
    assert!(rec.posts()[0].1.ends_with(&mac.public_key().unwrap()));
    assert!(away.adopt(b"not a key").is_err());
}

#[tokio::test]
async fn the_test_push_names_no_chat() {
    let (p, rec, _) = push("test");
    assert_eq!(p.test().await.skipped, Some("no phone is subscribed"));
    let key = p.public_key().unwrap();
    p.subscribe(phone(APPLE, &key)).unwrap();
    assert_eq!(p.test().await.sent, 1);
    assert_eq!(rec.posts()[0].2, "nightloomtest");
    assert_eq!(p.status().unwrap().waiting, 0);
}

#[test]
fn the_contact_claim_is_generic_unless_a_file_names_one() {
    let (p, _, dir) = push("subject");
    assert_eq!(p.subject(), DEFAULT_SUBJECT);
    std::fs::write(dir.join("subject"), "  https://example.org/contact \n").unwrap();
    assert_eq!(p.subject(), "https://example.org/contact");
    std::fs::write(dir.join("subject"), "someone").unwrap();
    assert_eq!(p.subject(), DEFAULT_SUBJECT);
}

/// A local listener for the two review tests below: `GET /api/push` names a
/// key that is not the Mac's, `POST /api/push/key` and `POST /send` answer
/// with a redirect to `/hit`, and `/hit` counts who followed one.
async fn redirector() -> (String, Arc<std::sync::atomic::AtomicUsize>) {
    use axum::http::{StatusCode, header};
    use axum::routing::{any, get, post};
    use std::sync::atomic::{AtomicUsize, Ordering};
    let hits = Arc::new(AtomicUsize::new(0));
    let counted = hits.clone();
    let other = Vapid::from_pkcs8(&Vapid::generate().unwrap())
        .unwrap()
        .public_key();
    let to_hit = || async { (StatusCode::TEMPORARY_REDIRECT, [(header::LOCATION, "/hit")]) };
    let app = axum::Router::new()
        .route(
            "/api/push",
            get(move || {
                let key = other.clone();
                async move {
                    axum::Json(Status {
                        key,
                        subscriptions: 0,
                        waiting: 0,
                    })
                }
            }),
        )
        .route("/api/push/key", post(to_hit))
        .route("/send", post(to_hit))
        .route(
            "/hit",
            any(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                async { "followed" }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (base, hits)
}

/// 739 review L1: a push service's redirect is not followed — the send
/// reports the 307 and nothing reaches its `Location`.
#[tokio::test]
async fn the_sender_follows_no_redirect() {
    let (base, hits) = redirector().await;
    let https = Https(client().unwrap());
    let status = https
        .post(&format!("{base}/send"), "vapid t=x, k=y", "", vec![1, 2, 3])
        .await
        .unwrap();
    assert_eq!(status, 307);
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);
}

/// 739 review L1: the key hand-off follows no redirect either — a 307 to
/// the key's POST is refused, and its body (the private key) reaches no
/// `Location`.
#[tokio::test]
async fn the_key_hand_off_follows_no_redirect() {
    let (base, hits) = redirector().await;
    let (mac, _, _) = push("hand-redirect");
    let e = hand_key_to_away(&mac, &base, "token").await.unwrap_err();
    assert!(e.contains("307"), "{e}");
    assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0);
}

/// 739 review L2: the key travels over HTTPS, the tailnet or loopback only.
#[tokio::test]
async fn the_key_goes_only_over_https_or_the_tailnet() {
    for ok in [
        "https://away.example.com",
        "https://203.0.113.9:8443",
        "http://100.64.0.1:8642",
        "http://100.101.102.103",
        "http://100.127.255.254",
        "http://away.tail1234.ts.net:8642",
        "http://AWAY.TAIL1234.TS.NET",
        "http://127.0.0.1:8642",
        "http://localhost:8642",
        "http://[::1]:8642",
    ] {
        assert!(key_may_go_to(ok), "{ok}");
    }
    for no in [
        "http://away.example.com",
        "http://203.0.113.9:8642",
        "http://100.63.255.255",
        "http://100.128.0.1",
        "http://192.168.1.20:8642",
        "http://ts.net.example.com",
        "http://[fd7a:115c:a1e0::1]",
        "ftp://100.64.0.1",
        "not a url",
        "",
    ] {
        assert!(!key_may_go_to(no), "{no}");
    }
    // Refused before any request: a TEST-NET address would only time out.
    let (mac, _, _) = push("hand-plain-http");
    assert_eq!(
        hand_key_to_away(&mac, "http://192.0.2.1:8642", "token")
            .await
            .unwrap_err(),
        KEY_NEEDS_A_SAFE_ROAD
    );
}

/// Item 784: a stuck run's push names the job and says what it ran, with
/// Continue / Stop waiting in the chat; any other kind ignores a detail.
#[test]
fn a_stuck_runs_push_says_what_it_ran() {
    let (p, _, _) = push("stuck");
    let mut n = note(What::Stuck, "c1");
    n.label = Some("Check CI".into());
    n.detail = Some("Looks stuck: ran `cargo test` 3 times, same result".into());
    let v: serde_json::Value = serde_json::from_str(&p.payload(&n, 1)).unwrap();
    assert_eq!(v["title"], "Check CI");
    assert_eq!(
        v["body"],
        "Looks stuck: ran `cargo test` 3 times, same result"
    );
    assert_eq!(v["kind"], "stuck");
    assert_eq!(What::for_prompt(crate::runaway::STUCK_TOOL), What::Stuck);
    n.detail = None;
    let v: serde_json::Value = serde_json::from_str(&p.payload(&n, 1)).unwrap();
    assert_eq!(v["body"], "Looks stuck — Continue or Stop?");
    let mut done = note(What::Done, "c1");
    done.detail = Some("the reply".into());
    let v: serde_json::Value = serde_json::from_str(&p.payload(&done, 1)).unwrap();
    assert_eq!(v["body"], "Finished", "never the reply");
}
