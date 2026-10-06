//! `GET /api/voice`: the phone's voice socket (nightshift backlog 246,
//! wave 3; design §2.3).
//!
//! Only the transport lives here: the WebSocket upgrade, and two pumps
//! between the socket and [`crate::voice::session::run`], which does the
//! work — the token gate included. The route sits *outside* the bearer
//! layer on purpose: a browser's `WebSocket` cannot send an
//! `Authorization` header and the token must never ride a URL, so the
//! session's first frame carries it and the socket is closed before any
//! audio is read when it does not match.

use std::sync::Arc;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use tokio::sync::{broadcast, mpsc};
use tokio_util::sync::CancellationToken;

use super::{Event, Handed, Host, RemoteState, Shared};
use crate::voice::session::{self, Deps, Inbound, Outbound, Turns};

/// The largest frame the phone may send: 20 ms of 16 kHz audio is 640
/// bytes, and a control frame is a line of JSON.
const MAX_FRAME: usize = 64 * 1024;

/// The listener's host, as a voice session sees it.
struct HostTurns(Arc<dyn Host>);

#[async_trait::async_trait]
impl Turns for HostTurns {
    async fn send_spoken(&self, chat: Option<&str>, text: &str) -> Result<Handed, String> {
        self.0.send_spoken(chat, text).await
    }
    async fn state(&self) -> RemoteState {
        self.0.state().await
    }
    fn events(&self) -> broadcast::Receiver<Event> {
        self.0.events()
    }
}

/// The upgrade. 404 with a sentence when this host has no voice (the page
/// reads `voice: null` from `/api/state` first and never asks then).
pub(super) async fn voice(State(shared): State<Arc<Shared>>, ws: WebSocketUpgrade) -> Response {
    let Some(engine) = shared.host.voice() else {
        return (
            StatusCode::NOT_FOUND,
            "voice is not set up on this host — run bin/voice-setup.sh",
        )
            .into_response();
    };
    let deps = Deps::with_engine(
        shared.token.clone(),
        engine,
        Arc::new(HostTurns(shared.host.clone())),
    );
    let closing = shared.closing.clone();
    ws.max_message_size(MAX_FRAME)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| serve(socket, deps, closing))
}

/// Pump frames both ways until either side ends or the listener stops.
async fn serve(socket: WebSocket, deps: Deps, closing: CancellationToken) {
    let (mut sink, mut stream) = socket.split();
    let (in_tx, in_rx) = mpsc::channel(512);
    let (out_tx, mut out_rx) = mpsc::channel(512);
    let session = tokio::spawn(session::run(deps, in_rx, out_tx));
    let reader = async move {
        while let Some(Ok(msg)) = stream.next().await {
            let frame = match msg {
                Message::Text(t) => Inbound::Text(t.to_string()),
                Message::Binary(b) => Inbound::Binary(b.to_vec()),
                Message::Close(_) => break,
                _ => continue,
            };
            if in_tx.send(frame).await.is_err() {
                break;
            }
        }
    };
    let writer = async move {
        while let Some(f) = out_rx.recv().await {
            let sent = match f {
                Outbound::Text(t) => sink.send(Message::Text(t.into())).await,
                Outbound::Binary(b) => sink.send(Message::Binary(b.into())).await,
                Outbound::Close => {
                    let _ = sink.send(Message::Close(None)).await;
                    break;
                }
            };
            if sent.is_err() {
                break;
            }
        }
    };
    tokio::select! {
        _ = reader => {}
        _ = writer => {}
        _ = closing.cancelled() => {}
    }
    session.abort();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::{ApproveRequest, Asset, ChatRow, ProjectRow, Server};
    use nightloom_core::SessionEvent;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio_tungstenite::tungstenite;

    /// A host with a voice or without one; everything else refuses.
    struct VoiceHost {
        engine: Option<Arc<crate::voice::Engine>>,
        tx: broadcast::Sender<Event>,
        sent: std::sync::Mutex<Vec<String>>,
        busy: AtomicBool,
    }

    #[async_trait::async_trait]
    impl Host for VoiceHost {
        async fn state(&self) -> RemoteState {
            RemoteState {
                active_chat: Some("c1".into()),
                busy: self.busy.load(Ordering::SeqCst),
                ..RemoteState::default()
            }
        }
        async fn chats(&self, _: Option<&str>) -> Result<Vec<ChatRow>, String> {
            Ok(vec![])
        }
        async fn projects(&self) -> Result<Vec<ProjectRow>, String> {
            Ok(vec![])
        }
        async fn transcript(&self, _: Option<&str>, _: &str) -> Result<Vec<SessionEvent>, String> {
            Err("none".into())
        }
        async fn send(&self, _: Option<&str>, _: &str) -> Result<Handed, String> {
            Err("typed sends are not this test's".into())
        }
        async fn send_spoken(&self, _: Option<&str>, text: &str) -> Result<Handed, String> {
            self.sent.lock().unwrap().push(text.to_string());
            Ok(Handed::Sent)
        }
        async fn new_chat(&self, _: Option<&str>, _: &str) -> Result<Handed, String> {
            Err("no".into())
        }
        async fn rename(&self, _: &str, _: &str) -> Result<(), String> {
            Ok(())
        }
        async fn open(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        async fn approve(&self, _: ApproveRequest) -> Result<(), String> {
            Ok(())
        }
        async fn cancel(&self, _: Option<&str>) -> Result<(), String> {
            Ok(())
        }
        fn voice(&self) -> Option<Arc<crate::voice::Engine>> {
            self.engine.clone()
        }
        fn events(&self) -> broadcast::Receiver<Event> {
            self.tx.subscribe()
        }
        fn asset(&self, _: &str) -> Option<Asset> {
            None
        }
    }

    async fn up(engine: Option<Arc<crate::voice::Engine>>) -> (Server, Arc<VoiceHost>) {
        let (tx, _) = broadcast::channel(64);
        let host = Arc::new(VoiceHost {
            engine,
            tx,
            sent: std::sync::Mutex::new(vec![]),
            busy: AtomicBool::new(false),
        });
        let server =
            Server::start_for_test("127.0.0.1:0".parse().unwrap(), "tok".into(), host.clone())
                .await
                .unwrap();
        (server, host)
    }

    /// The route is outside the bearer layer (a browser socket cannot send
    /// the header), and a host with no voice says so with a sentence
    /// rather than a 401 — the gate for a host *with* voice is the hello,
    /// tested in `voice::session`. And `/api/state` says `voice: null`.
    #[tokio::test]
    async fn the_voice_route_needs_no_bearer_and_a_host_without_voice_says_so() {
        let (server, _) = up(None).await;
        let url = format!("ws://{}/api/voice", server.addr());
        match tokio_tungstenite::connect_async(url.as_str()).await {
            Err(tungstenite::Error::Http(r)) => {
                assert_eq!(r.status(), 404);
                let body = String::from_utf8_lossy(r.body().as_deref().unwrap_or(&[])).into_owned();
                assert!(body.contains("voice-setup"), "{body}");
            }
            other => panic!("expected a 404, got {other:?}"),
        }
        let state: serde_json::Value = reqwest::Client::new()
            .get(format!("http://{}/api/state", server.addr()))
            .bearer_auth("tok")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert!(state["voice"].is_null(), "{state}");
        // The rest of /api still needs the bearer.
        let r = reqwest::get(format!("http://{}/api/state", server.addr()))
            .await
            .unwrap();
        assert_eq!(r.status(), 401);
        server.stop().await;
    }

    /// Backlog 317 over a real WebSocket (this module's pumps, loopback
    /// `ws://` — `wss://` adds only TLS, which the live test below covers):
    /// a spoken turn whose model calls a tool that waits for approval says
    /// so — an `approval` frame, then the sentence as reply audio — where
    /// before the socket said nothing for minutes. Stand-ins hear the
    /// fixture's words and speak text as its bytes.
    #[tokio::test]
    async fn a_turn_that_calls_a_tool_says_so_over_the_socket() {
        use crate::voice::{Hear, Pass, Speak};
        struct Ear;
        #[async_trait::async_trait]
        impl Hear for Ear {
            async fn transcribe(&self, _: &[i16], _: Pass) -> Result<String, String> {
                Ok("What's the weather like on the away server?".into())
            }
        }
        struct Mouth;
        #[async_trait::async_trait]
        impl Speak for Mouth {
            async fn speak(&self, text: &str) -> Result<Vec<u8>, String> {
                Ok(text.as_bytes().to_vec())
            }
        }
        struct Chat {
            tx: broadcast::Sender<Event>,
            busy: AtomicBool,
        }
        #[async_trait::async_trait]
        impl Turns for Chat {
            async fn send_spoken(&self, _: Option<&str>, _: &str) -> Result<Handed, String> {
                self.busy.store(true, Ordering::SeqCst);
                // The fixture's turn: the model reaches for a tool, and the
                // engine parks the call at the approval gate.
                let tx = self.tx.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    let _ = tx.send(Event {
                        name: "turn-event".into(),
                        payload: serde_json::json!({"chat": "c1", "type": "tool_call",
                            "id": "t1", "name": "mcp__nightloom__search_chats"})
                        .to_string(),
                    });
                    let _ = tx.send(Event {
                        name: "tool-approval".into(),
                        payload: serde_json::json!({"id": "t1",
                            "name": "mcp__nightloom__search_chats",
                            "input": {"query": "away server weather"},
                            "effect": "read_only", "chat": "c1"})
                        .to_string(),
                    });
                });
                Ok(Handed::Sent)
            }
            async fn state(&self) -> RemoteState {
                RemoteState {
                    active_chat: Some("c1".into()),
                    busy: self.busy.load(Ordering::SeqCst),
                    ..RemoteState::default()
                }
            }
            fn events(&self) -> broadcast::Receiver<Event> {
                self.tx.subscribe()
            }
        }
        let (tx, _) = broadcast::channel(64);
        let chat = Arc::new(Chat {
            tx,
            busy: AtomicBool::new(false),
        });
        let closing = CancellationToken::new();
        let app = axum::Router::new().route(
            "/api/voice",
            axum::routing::get({
                let chat = chat.clone();
                let closing = closing.clone();
                move |ws: WebSocketUpgrade| async move {
                    let deps = Deps {
                        token: "tok".into(),
                        hear: Arc::new(Ear),
                        speak: Arc::new(Mouth),
                        turns: chat,
                        warm: None,
                        timing: session::Timing::default(),
                    };
                    ws.on_upgrade(move |socket| serve(socket, deps, closing))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });

        use tungstenite::Message as M;
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/api/voice"))
            .await
            .unwrap();
        ws.send(M::Text(r#"{"t":"hello","token":"tok"}"#.into()))
            .await
            .unwrap();
        // A second of speech, in the phone's 20 ms frames.
        let pcm = vec![500i16; 16_000];
        let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
        for frame in bytes.chunks(640) {
            ws.send(M::Binary(frame.to_vec().into())).await.unwrap();
        }
        ws.send(M::Text(r#"{"t":"end"}"#.into())).await.unwrap();
        let said = "I need your OK to use search chats — it's on your screen.";
        let (mut shown, mut spoken) = (false, false);
        while !(shown && spoken) {
            let m = tokio::time::timeout(std::time::Duration::from_secs(5), ws.next())
                .await
                .expect("the socket is not silent")
                .expect("open")
                .unwrap();
            match m {
                M::Text(t) => {
                    let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                    assert_ne!(v["t"], "error", "{v}");
                    if v["t"] == "approval" {
                        assert_eq!(v["id"], "t1");
                        assert_eq!(v["text"], said);
                        shown = true;
                    }
                    if v["t"] == "audio" {
                        assert_eq!(v["sentence"], said);
                    }
                }
                M::Binary(b) => {
                    assert_eq!(b.as_ref(), said.as_bytes());
                    spoken = true;
                }
                _ => {}
            }
        }
        closing.cancel();
    }

    /// The whole road with the real programs: hello, the fixture's audio,
    /// the end frame, the words sent spoken to the host. Run by hand like
    /// `voice::real` (NIGHTLOOM_VOICE_TEST=1, --ignored).
    ///
    /// (Backlog 317's socket test is [`a_turn_that_calls_a_tool_says_so_over_the_socket`].)
    #[tokio::test]
    #[ignore = "needs bin/voice-setup.sh and NIGHTLOOM_VOICE_TEST=1"]
    async fn a_real_socket_hears_the_fixture_and_sends_it_spoken() {
        if std::env::var("NIGHTLOOM_VOICE_TEST").ok().as_deref() != Some("1") {
            return;
        }
        let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join(".nightloom/voice");
        let engine = crate::voice::Engine::new(crate::voice::Setup::find_in(&dir).expect("setup"));
        let (server, host) = up(Some(engine)).await;
        let state: serde_json::Value = reqwest::Client::new()
            .get(format!("http://{}/api/state", server.addr()))
            .bearer_auth("tok")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(state["voice"]["mic_rate"], 16_000, "{state}");
        let (mut ws, _) =
            tokio_tungstenite::connect_async(format!("ws://{}/api/voice", server.addr()))
                .await
                .unwrap();
        use tungstenite::Message as M;
        ws.send(M::Text(r#"{"t":"hello","token":"tok"}"#.into()))
            .await
            .unwrap();
        let (_, pcm) =
            crate::voice::wav::decode(&std::fs::read(dir.join("fixtures/weather.wav")).unwrap())
                .unwrap();
        let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
        for frame in bytes.chunks(640) {
            ws.send(M::Binary(frame.to_vec().into())).await.unwrap();
        }
        ws.send(M::Text(r#"{"t":"end"}"#.into())).await.unwrap();
        loop {
            let m = tokio::time::timeout(std::time::Duration::from_secs(30), ws.next())
                .await
                .expect("a frame")
                .expect("open")
                .unwrap();
            if let M::Text(t) = m {
                println!("{t}");
                if t.contains("\"sent\"") {
                    break;
                }
                assert!(!t.contains("\"error\""), "{t}");
            }
        }
        assert_eq!(
            *host.sent.lock().unwrap(),
            vec!["What's the weather like on the away server?".to_string()]
        );
        server.stop().await;
    }

    /// A live listener over `wss://`, as his phone reaches it (246, the
    /// Mac's HTTPS): the fixture paced as the phone sends it (20 ms
    /// frames), the end frame, then the real turn's reply until its first
    /// audio. Run by hand against a running `nightloom serve` or desktop:
    ///
    /// ```text
    /// NIGHTLOOM_VOICE_TEST=1 NIGHTLOOM_VOICE_URL=wss://<machine>.<tailnet>.ts.net:<port>/api/voice \
    /// NIGHTLOOM_VOICE_TOKEN_FILE=<file holding the token> \
    /// cargo test -p nightloom-service live_wss -- --ignored --nocapture
    /// ```
    ///
    /// The certificate is checked against the public roots, as Safari does.
    /// `NIGHTLOOM_VOICE_FIXTURE` picks the fixture (default `weather`),
    /// `NIGHTLOOM_VOICE_FIXTURE_DIR` where it is (default the setup's).
    /// The chat the host has open hears it. ~~A reply that asks to use a
    /// tool waits for an approval no one gives here, so pick a question
    /// that needs none.~~ (2026-10-06, backlog 317: such a reply now sends
    /// an `approval` frame and speaks that it waits, so the first audio
    /// still comes — the weather fixture, which calls `search_chats`, ends
    /// here on that sentence. The approval itself is left unanswered.)
    #[tokio::test]
    #[ignore = "needs a live HTTPS listener and NIGHTLOOM_VOICE_TEST=1"]
    async fn live_wss_hears_the_fixture_and_speaks_the_reply() {
        if std::env::var("NIGHTLOOM_VOICE_TEST").ok().as_deref() != Some("1") {
            return;
        }
        use tungstenite::Message as M;
        let url = std::env::var("NIGHTLOOM_VOICE_URL").expect("NIGHTLOOM_VOICE_URL");
        let token = std::fs::read_to_string(
            std::env::var("NIGHTLOOM_VOICE_TOKEN_FILE").expect("NIGHTLOOM_VOICE_TOKEN_FILE"),
        )
        .unwrap()
        .trim()
        .to_string();
        let name = std::env::var("NIGHTLOOM_VOICE_FIXTURE").unwrap_or_else(|_| "weather".into());
        let dir = std::env::var_os("NIGHTLOOM_VOICE_FIXTURE_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::PathBuf::from(std::env::var("HOME").unwrap())
                    .join(".nightloom/voice/fixtures")
            });
        let said = std::fs::read_to_string(dir.join(format!("{name}.txt"))).unwrap();
        let (_, pcm) =
            crate::voice::wav::decode(&std::fs::read(dir.join(format!("{name}.wav"))).unwrap())
                .unwrap();

        // TLS by hand: tokio-tungstenite is built without a TLS feature.
        let uri: tungstenite::http::Uri = url.parse().unwrap();
        let host = uri.host().unwrap().to_string();
        let port = uri.port_u16().unwrap_or(443);
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
        let started = std::time::Instant::now();
        let tcp = tokio::net::TcpStream::connect((host.as_str(), port))
            .await
            .unwrap();
        let tls = tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(
                rustls::pki_types::ServerName::try_from(host.clone()).unwrap(),
                tcp,
            )
            .await
            .expect("the certificate verifies against the public roots");
        let (mut ws, _) = tokio_tungstenite::client_async(url.as_str(), tls)
            .await
            .unwrap();
        println!(
            "connected (TCP + TLS + upgrade): {} ms",
            started.elapsed().as_millis()
        );
        ws.send(M::Text(
            serde_json::json!({"t": "hello", "token": token})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
        let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
        let (mut tx, mut rx) = ws.split();
        let ended: Arc<std::sync::OnceLock<std::time::Instant>> = Arc::default();
        let reader = tokio::spawn({
            let ended = ended.clone();
            async move {
                let mut heard = String::new();
                loop {
                    let m = tokio::time::timeout(std::time::Duration::from_secs(120), rx.next())
                        .await
                        .expect("a frame within two minutes")
                        .expect("open")
                        .unwrap();
                    let M::Text(t) = m else { continue };
                    let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                    let at = ended.get().map(|e| e.elapsed().as_millis());
                    println!("{t}  [after the end frame: {at:?} ms]");
                    match v["t"].as_str().unwrap_or("") {
                        "final" => heard = v["text"].as_str().unwrap_or("").to_string(),
                        "audio" => return heard,
                        "error" | "dropped" => panic!("{t}"),
                        _ => {}
                    }
                }
            }
        });
        for frame in bytes.chunks(640) {
            tx.send(M::Binary(frame.to_vec().into())).await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let _ = ended.set(std::time::Instant::now());
        tx.send(M::Text(r#"{"t":"end"}"#.into())).await.unwrap();
        let heard = reader.await.unwrap();
        println!(
            "end frame to first audio (wall clock here): {} ms",
            ended.get().unwrap().elapsed().as_millis()
        );
        let words = |s: &str| -> Vec<String> {
            s.split_whitespace()
                .map(|w| {
                    w.trim_matches(|c: char| !c.is_alphanumeric() && c != '\'')
                        .to_lowercase()
                })
                .filter(|w| !w.is_empty())
                .collect()
        };
        let got = words(&heard);
        let want = words(&said);
        let hit = want.iter().filter(|w| got.contains(w)).count();
        println!(
            "recall {}/{} = {:.0}%: said {:?}, heard {:?}",
            hit,
            want.len(),
            100.0 * hit as f64 / want.len() as f64,
            said.trim(),
            heard
        );
        assert!(hit * 10 >= want.len() * 9, "under 90% of the words");
    }
}
