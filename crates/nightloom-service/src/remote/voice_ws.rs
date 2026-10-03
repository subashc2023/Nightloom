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

    /// The whole road with the real programs: hello, the fixture's audio,
    /// the end frame, the words sent spoken to the host. Run by hand like
    /// `voice::real` (NIGHTLOOM_VOICE_TEST=1, --ignored).
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
}
