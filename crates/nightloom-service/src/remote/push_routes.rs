//! `/api/push…` (nightshift item 739): the phone page's Subscribe button
//! and off switch, over the host's [`crate::push::Push`].
//!
//! - `GET /push` — this host's public key (the page subscribes with it),
//!   how many phones are subscribed, how many chats wait (the badge).
//! - `POST /push/subscribe` — the page's `PushSubscription` and the key it
//!   was made with; 409 with [`crate::push::KEY_DIFFERS`] when that is not
//!   this host's key.
//! - `POST /push/unsubscribe` — `{endpoint}`: the off switch.
//! - `POST /push/seen` — `{chat}`: he opened it; it stops counting.
//! - `GET /push/feed` — item 741: the last thing that happened in each
//!   chat he has not opened since (the phone's home screen), newest first;
//!   kept with or without a subscribed phone.
//! - `POST /push/test` — one push that says push works.
//! - `POST /push/key` — the away server only: the Mac hands over its key so
//!   both hosts sign with one (a phone holds one subscription, tied to one
//!   key). The Mac's own listener refuses it.
//!
//! All behind the bearer check like every `/api` route; a host with no
//! push answers 501 and `/api/state` does not list the `push` feature.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use super::api::NOT_AVAILABLE;
use super::{Shared, answer, bad, refused};
use crate::push::{Push, SubscribeRequest};

pub(super) fn router() -> Router<Arc<Shared>> {
    Router::new()
        .route("/push", get(status))
        .route("/push/subscribe", post(subscribe))
        .route("/push/unsubscribe", post(unsubscribe))
        .route("/push/seen", post(seen))
        .route("/push/feed", get(feed))
        .route("/push/test", post(test))
        .route("/push/key", post(key))
}

/// The host's push, or `None` — every route then answers [`no_push`].
fn push(shared: &Shared) -> Option<Arc<Push>> {
    shared.host.push()
}

fn no_push() -> Response {
    refused(NOT_AVAILABLE.into())
}

async fn status(State(shared): State<Arc<Shared>>) -> Response {
    match push(&shared) {
        Some(p) => answer(p.status()),
        None => no_push(),
    }
}

async fn subscribe(
    State(shared): State<Arc<Shared>>,
    Json(req): Json<SubscribeRequest>,
) -> Response {
    let Some(p) = push(&shared) else {
        return no_push();
    };
    match p.subscribe(req) {
        Ok(()) => answer(p.status()),
        Err(e) if e == crate::push::KEY_DIFFERS => refused(e),
        Err(e) => bad(e),
    }
}

#[derive(Deserialize)]
struct Endpoint {
    endpoint: String,
}

async fn unsubscribe(State(shared): State<Arc<Shared>>, Json(req): Json<Endpoint>) -> Response {
    let Some(p) = push(&shared) else {
        return no_push();
    };
    match p.unsubscribe(&req.endpoint) {
        Ok(_) => answer(p.status()),
        Err(e) => refused(e),
    }
}

#[derive(Deserialize)]
struct Seen {
    chat: String,
}

async fn seen(State(shared): State<Arc<Shared>>, Json(req): Json<Seen>) -> Response {
    let Some(p) = push(&shared) else {
        return no_push();
    };
    p.seen(&req.chat);
    answer(p.status())
}

/// `GET /push/feed`'s body.
#[derive(serde::Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct Feed {
    pub rows: Vec<crate::push::FeedRow>,
}

async fn feed(State(shared): State<Arc<Shared>>) -> Response {
    match push(&shared) {
        Some(p) => answer(Ok::<_, String>(Feed { rows: p.feed() })),
        None => no_push(),
    }
}

async fn test(State(shared): State<Arc<Shared>>) -> Response {
    match push(&shared) {
        Some(p) => Json(p.test().await).into_response(),
        None => no_push(),
    }
}

#[derive(Deserialize)]
struct Key {
    /// The Mac's key, PKCS#8, base64url.
    pkcs8: String,
}

async fn key(State(shared): State<Arc<Shared>>, Json(req): Json<Key>) -> Response {
    let Some(p) = push(&shared) else {
        return no_push();
    };
    // Only the away server takes a key; the Mac's is the one that is made.
    if shared.host.kind() != "serve" {
        return (StatusCode::CONFLICT, "this host keeps its own push key").into_response();
    }
    let Some(bytes) = crate::push::crypto::unb64(&req.pkcs8) else {
        return bad("not a key".into());
    };
    match p.adopt(&bytes) {
        Ok(changed) => Json(serde_json::json!({ "changed": changed })).into_response(),
        Err(e) => bad(e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        ApproveRequest, Asset, ChatRow, Event, Handed, Host, ProjectRow, RemoteState, Server,
    };
    use crate::push::{Push, Status, Transport};
    use nightloom_core::SessionEvent;
    use std::sync::{Arc, Mutex};
    use tokio::sync::broadcast;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<String>>);

    #[async_trait::async_trait]
    impl Transport for Recorder {
        async fn post(&self, endpoint: &str, _: &str, _: &str, _: Vec<u8>) -> Result<u16, String> {
            self.0.lock().unwrap().push(endpoint.into());
            Ok(201)
        }
    }

    /// A host with push (or none) and one chat; everything else refuses.
    struct PushHost {
        push: Option<Arc<Push>>,
        kind: &'static str,
        tx: broadcast::Sender<Event>,
    }

    #[async_trait::async_trait]
    impl Host for PushHost {
        async fn state(&self) -> RemoteState {
            RemoteState::default()
        }
        async fn chats(&self, _: Option<&str>) -> Result<Vec<ChatRow>, String> {
            Ok(Vec::new())
        }
        async fn projects(&self) -> Result<Vec<ProjectRow>, String> {
            Ok(Vec::new())
        }
        async fn transcript(&self, _: Option<&str>, id: &str) -> Result<Vec<SessionEvent>, String> {
            if id == "c1" {
                Ok(Vec::new())
            } else {
                Err("no such chat".into())
            }
        }
        async fn send(&self, _: Option<&str>, _: &str) -> Result<Handed, String> {
            Ok(Handed::Sent)
        }
        async fn new_chat(&self, _: Option<&str>, _: &str) -> Result<Handed, String> {
            Err("no".into())
        }
        async fn rename(&self, _: &str, _: &str) -> Result<(), String> {
            Err("no".into())
        }
        async fn open(&self, _: &str) -> Result<(), String> {
            Err("no".into())
        }
        async fn approve(&self, _: ApproveRequest) -> Result<(), String> {
            Err("no".into())
        }
        async fn cancel(&self, _: Option<&str>) -> Result<(), String> {
            Err("no".into())
        }
        fn events(&self) -> broadcast::Receiver<Event> {
            self.tx.subscribe()
        }
        fn asset(&self, path: &str) -> Option<Asset> {
            (path == "remote/push-sw.js").then(|| Asset {
                bytes: b"// worker".to_vec(),
                mime: "application/octet-stream".into(),
            })
        }
        fn kind(&self) -> &'static str {
            self.kind
        }
        fn push(&self) -> Option<Arc<Push>> {
            self.push.clone()
        }
    }

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    async fn up(kind: &'static str, with_push: bool) -> (Server, Option<Arc<Push>>, Arc<Recorder>) {
        let rec = Arc::new(Recorder::default());
        let dir =
            std::env::temp_dir().join(format!("nightloom-push-routes-{}", uuid::Uuid::new_v4()));
        let push = with_push.then(|| Push::with_transport(dir, "mac", rec.clone()));
        let (tx, _) = broadcast::channel(8);
        let host = Arc::new(PushHost {
            push: push.clone(),
            kind,
            tx,
        });
        let server = Server::start_for_test("127.0.0.1:0".parse().unwrap(), TOKEN.into(), host)
            .await
            .unwrap();
        (server, push, rec)
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    /// A subscription body a phone would send, made with `key`.
    fn phone(endpoint: &str, key: &str) -> serde_json::Value {
        use ring::agreement;
        let rng = ring::rand::SystemRandom::new();
        let k = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
        serde_json::json!({
            "endpoint": endpoint,
            "expirationTime": null,
            "keys": {
                "p256dh": crate::push::crypto::b64(k.compute_public_key().unwrap().as_ref()),
                "auth": crate::push::crypto::b64(&[3u8; 16]),
            },
            "key": key,
        })
    }

    #[tokio::test]
    async fn the_phone_subscribes_is_counted_tests_and_switches_off() {
        let (server, push, rec) = up("mac", true).await;
        let base = format!("http://{}/api", server.addr());
        let c = client();
        // The bearer guards it like every route.
        let r = c.get(format!("{base}/push")).send().await.unwrap();
        assert_eq!(r.status(), 401);
        let s: Status = c
            .get(format!("{base}/push"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!((s.subscriptions, s.waiting), (0, 0));
        assert_eq!(s.key, push.as_ref().unwrap().public_key().unwrap());
        // `/api/state` names the feature.
        let state: serde_json::Value = c
            .get(format!("{base}/state"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(
            state["features"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f == "push")
        );

        let endpoint = "https://web.push.apple.com/abc";
        let r = c
            .post(format!("{base}/push/subscribe"))
            .bearer_auth(TOKEN)
            .json(&phone(endpoint, &s.key))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.json::<Status>().await.unwrap().subscriptions, 1);
        // Another key: 409 with the sentence. A bad endpoint: 400.
        let other = crate::push::crypto::Vapid::from_pkcs8(
            &crate::push::crypto::Vapid::generate().unwrap(),
        )
        .unwrap()
        .public_key();
        let r = c
            .post(format!("{base}/push/subscribe"))
            .bearer_auth(TOKEN)
            .json(&phone(endpoint, &other))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 409);
        assert_eq!(r.text().await.unwrap(), crate::push::KEY_DIFFERS);
        let r = c
            .post(format!("{base}/push/subscribe"))
            .bearer_auth(TOKEN)
            .json(&phone("https://example.com/x", &s.key))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 400);

        let sent: serde_json::Value = c
            .post(format!("{base}/push/test"))
            .bearer_auth(TOKEN)
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(sent["sent"], 1);
        assert_eq!(*rec.0.lock().unwrap(), vec![endpoint.to_string()]);

        let r = c
            .post(format!("{base}/push/unsubscribe"))
            .bearer_auth(TOKEN)
            .json(&serde_json::json!({ "endpoint": endpoint }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.json::<Status>().await.unwrap().subscriptions, 0);
        server.stop().await;
    }

    /// Item 741: the feed holds the last note per chat with no phone
    /// subscribed, newest first; opening the chat (or a note sent while he
    /// is at the Mac) drops its row.
    /// Item 947: over real HTTP, `/shortcut/needs` (Siri) says as many things as the phone page counts from
    /// `/push/feed` (the page's `PUSH_NEED` kinds: approval, reminder, set_aside, unattended, question, stuck).
    #[tokio::test]
    async fn siri_sentence_counts_what_the_phone_pages_feed_counts_947() {
        let (server, push, _) = up("mac", true).await;
        let push = push.unwrap();
        let base = format!("http://{}/api", server.addr());
        let c = client();
        use crate::push::What;
        for (chat, what) in [
            ("c1", What::Question),
            ("c2", What::Done),
            ("c3", What::Approval),
            ("c4", What::Stuck),
            ("c5", What::SetAside),
            ("c6", What::Failed),
        ] {
            push.notify(crate::push::Note {
                what,
                chat: Some(chat.into()),
                label: Some(format!("Chat {chat}")),
                project: Some("p1".into()),
                at_the_mac: false,
                detail: None,
            })
            .await;
        }
        let feed: serde_json::Value = c
            .get(format!("{base}/push/feed"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let page_count = feed["rows"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| {
                [
                    "approval",
                    "reminder",
                    "set_aside",
                    "unattended",
                    "question",
                    "stuck",
                ]
                .contains(&r["what"].as_str().unwrap())
            })
            .count();
        assert_eq!(page_count, 4, "{feed}");
        let said = c
            .get(format!("{base}/shortcut/needs"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert!(said.starts_with("Four things need you: "), "{said}");
        assert!(
            !said.contains("Chat c2") && !said.contains("Chat c6"),
            "done and failed are Handled, not needs: {said}"
        );
        server.stop().await;
    }

    #[tokio::test]
    async fn the_feed_lists_each_chats_last_note_until_he_opens_it() {
        let (server, push, _) = up("mac", true).await;
        let push = push.unwrap();
        let base = format!("http://{}/api", server.addr());
        let c = client();
        let note = |chat: &str, what, at_the_mac| crate::push::Note {
            what,
            chat: Some(chat.into()),
            label: Some(format!("Chat {chat}")),
            project: Some("p1".into()),
            at_the_mac,
            detail: None,
        };
        use crate::push::What;
        push.notify(note("c1", What::Question, false)).await;
        push.notify(note("c2", What::Done, false)).await;
        push.notify(note("c1", What::Done, false)).await;
        push.notify(note("c3", What::Approval, false)).await;
        let get_feed = || async {
            c.get(format!("{base}/push/feed"))
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap()
                .json::<super::Feed>()
                .await
                .unwrap()
        };
        let f = get_feed().await;
        assert_eq!(f.rows.len(), 3);
        let c1 = f.rows.iter().find(|r| r.chat == "c1").unwrap();
        assert_eq!(c1.what, What::Done);
        assert_eq!(c1.label.as_deref(), Some("Chat c1"));
        assert_eq!(c1.project.as_deref(), Some("p1"));
        assert!(f.rows.windows(2).all(|w| w[0].at >= w[1].at));
        push.seen("c2");
        push.notify(note("c3", What::Done, true)).await;
        let f = get_feed().await;
        assert_eq!(
            f.rows.iter().map(|r| r.chat.as_str()).collect::<Vec<_>>(),
            vec!["c1"]
        );
        server.stop().await;
    }

    #[tokio::test]
    async fn a_chat_read_or_written_from_the_phone_stops_waiting() {
        let (server, push, _) = up("mac", true).await;
        let push = push.unwrap();
        let base = format!("http://{}/api", server.addr());
        let c = client();
        let key = push.public_key().unwrap();
        push.subscribe(
            serde_json::from_value(phone("https://web.push.apple.com/abc", &key)).unwrap(),
        )
        .unwrap();
        let note = |chat: &str| crate::push::Note {
            what: crate::push::What::Done,
            chat: Some(chat.into()),
            label: None,
            project: None,
            at_the_mac: false,
            detail: None,
        };
        push.notify(note("c1")).await;
        push.notify(note("c2")).await;
        push.notify(note("c3")).await;
        assert_eq!(push.status().unwrap().waiting, 3);
        // Reading its transcript, sending to it, or the page's own word.
        let r = c
            .get(format!("{base}/chats/c1/transcript"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(push.status().unwrap().waiting, 2);
        let r = c
            .post(format!("{base}/chats/c2/send"))
            .bearer_auth(TOKEN)
            .json(&serde_json::json!({ "text": "go on" }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 202);
        assert_eq!(push.status().unwrap().waiting, 1);
        let s: Status = c
            .post(format!("{base}/push/seen"))
            .bearer_auth(TOKEN)
            .json(&serde_json::json!({ "chat": "c3" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(s.waiting, 0);
        server.stop().await;
    }

    #[tokio::test]
    async fn only_the_away_server_takes_a_key_and_a_host_without_push_says_so() {
        let pkcs8 = crate::push::crypto::Vapid::generate().unwrap();
        let body = serde_json::json!({ "pkcs8": crate::push::crypto::b64(&pkcs8) });
        let theirs = crate::push::crypto::Vapid::from_pkcs8(&pkcs8)
            .unwrap()
            .public_key();
        let c = client();

        let (mac, push, _) = up("mac", true).await;
        let r = c
            .post(format!("http://{}/api/push/key", mac.addr()))
            .bearer_auth(TOKEN)
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 409);
        assert_ne!(push.unwrap().public_key().unwrap(), theirs);
        mac.stop().await;

        let (away, push, _) = up("serve", true).await;
        let url = format!("http://{}/api/push/key", away.addr());
        let r = c.post(&url).json(&body).send().await.unwrap();
        assert_eq!(r.status(), 401, "no token, no key");
        let r = c
            .post(&url)
            .bearer_auth(TOKEN)
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(
            r.json::<serde_json::Value>().await.unwrap()["changed"],
            true
        );
        assert_eq!(push.as_ref().unwrap().public_key().unwrap(), theirs);
        let r = c
            .post(&url)
            .bearer_auth(TOKEN)
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(
            r.json::<serde_json::Value>().await.unwrap()["changed"],
            false
        );
        let r = c
            .post(&url)
            .bearer_auth(TOKEN)
            .json(&serde_json::json!({ "pkcs8": "AAAA" }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 400);
        // The Mac's own hand-off finds the key already there.
        let mac_push = Push::with_transport(
            std::env::temp_dir().join(format!("nightloom-push-hand-{}", uuid::Uuid::new_v4())),
            "mac",
            Arc::new(Recorder::default()),
        );
        let base = format!("http://{}", away.addr());
        assert!(
            crate::push::hand_key_to_away(&mac_push, &base, TOKEN)
                .await
                .unwrap()
        );
        assert_eq!(
            push.unwrap().public_key().unwrap(),
            mac_push.public_key().unwrap()
        );
        assert!(
            !crate::push::hand_key_to_away(&mac_push, &base, TOKEN)
                .await
                .unwrap()
        );
        away.stop().await;

        let (bare, _, _) = up("mac", false).await;
        let base = format!("http://{}", bare.addr());
        let r = c
            .get(format!("{base}/api/push"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 501);
        let state: serde_json::Value = c
            .get(format!("{base}/api/state"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(
            !state["features"]
                .as_array()
                .unwrap()
                .iter()
                .any(|f| f == "push")
        );
        // An older away server (no push): the hand-off is a quiet no.
        assert!(
            !crate::push::hand_key_to_away(&mac_push, &base, TOKEN)
                .await
                .unwrap()
        );
        bare.stop().await;
    }

    #[tokio::test]
    async fn the_worker_is_served_at_the_root_as_a_script_with_no_token() {
        let (server, _, _) = up("mac", true).await;
        let r = client()
            .get(format!("http://{}/push-sw.js", server.addr()))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["content-type"], "text/javascript");
        assert_eq!(r.headers()["cache-control"], "no-cache");
        assert_eq!(r.text().await.unwrap(), "// worker");
        server.stop().await;
    }
}
