//! The phone page's listener (nightshift backlog 091, Shape B, 2026-09-16).
//!
//! A small HTTP server inside the desktop process, bound to the Mac's
//! tailnet address and nothing else, serving a phone-width page that shows
//! the open project's chats, streams a transcript, sends a message and
//! answers the Ask position's cards. Off by default; the Settings → Remote
//! card switches it on.
//!
//! # Why a trait and not the app's state
//!
//! Everything the page needs — the chat list, a transcript, "is a turn
//! running", send, approve — already exists as a Tauri command or a window
//! event in the desktop crate, which this crate cannot see. So the server
//! is written over a [`Host`] the desktop implements, and this module owns
//! only what is HTTP: the routes, the bearer check, the SSE relay, and the
//! one rule that matters — [`Server::start`] refuses to bind anywhere but a
//! tailnet address (nightshift blocker 105, its default taken). The
//! desktop's implementation hands sends and answers to its own window as
//! events, so a message from the phone runs through exactly the path a
//! typed one does; the turn runs on the Mac either way.
//!
//! # What is not here
//!
//! No LAN or public binding, no option for one. No TLS: the tailnet is
//! WireGuard end to end, and a certificate the phone would have to trust
//! is a setup step this page exists to not have. No Tailscale identity
//! headers yet (they need `tailscale serve` in front of the port; later).

pub mod tailnet;
pub mod token;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::Stream;
use nightloom_core::SessionEvent;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, oneshot};

/// The port the card proposes (nightshift blocker 172, its default taken).
/// Unassigned, above the well-known range, and easy to type on a phone.
pub const DEFAULT_PORT: u16 = 8642;

/// One row of the phone's chat list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatRow {
    pub id: String,
    /// The title, or the first message — `SessionSummary::label`.
    pub label: String,
    pub modified: chrono::DateTime<chrono::Utc>,
    pub user_turns: usize,
    /// `build` or `chat`, as the sidebar marks it.
    pub kind: String,
    /// `normal` or `incognito`; an ephemeral chat has no log to list.
    pub mode: String,
}

/// What the phone asks first and re-asks after every event: where the Mac
/// is, and whether it can take a message right now.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct RemoteState {
    /// The open project's name, or `None` for unfiled chats.
    pub project: Option<String>,
    /// The chat the desktop has open — the one a send with no chat goes to.
    pub active_chat: Option<String>,
    /// A turn (or a compaction, or an aside) holds the chat: a message sent
    /// now is queued on the phone and sent when this clears.
    pub busy: bool,
    /// Whether an engine is connected on the desktop at all; without one a
    /// send has nowhere to go.
    pub connected: bool,
    /// `claude-code` or the provider's kind, for the phone's header.
    pub engine: Option<String>,
    /// The approval prompts still waiting for an answer, each the desktop's
    /// own `tool-approval` payload (`id`, `name`, `input`, `effect`).
    pub pending: Vec<serde_json::Value>,
}

/// A message from the phone.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendRequest {
    pub text: String,
}

/// What became of a phone's message once the desktop took it (review
/// 2026-09-17 FA2/FA3, backlog 132): the 202 used to mean only "emitted
/// to the window", and a message the window then could not send — no
/// engine, the chat busy elsewhere, a chat that would not open — was
/// dropped with the phone told it was accepted. Now the window answers,
/// and the answer is the 202's body (`{"status": "sent" | "queued"}`) or
/// a 409 with the sentence.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Handed {
    /// The turn started (or is starting) in the chat named.
    Sent,
    /// The chat is running a turn; the message is in its queue on the Mac
    /// and goes when that turn ends.
    Queued,
}

/// The 202's body.
#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct SendReply {
    pub status: Handed,
}

/// An answer to one approval prompt: the desktop's `approve_call` arguments
/// by another road. `decision` is `allow`, `always` or `deny`; `answer` is
/// a question form's or a plan's updated input; `then` is the plan card's
/// `ask` or `auto`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApproveRequest {
    pub id: String,
    pub name: String,
    pub decision: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub answer: Option<serde_json::Value>,
    #[serde(default)]
    pub then: Option<String>,
}

/// One event for the phone's stream: the desktop's window event by name,
/// with its payload as the JSON it was emitted with.
#[derive(Debug, Clone)]
pub struct Event {
    pub name: String,
    pub payload: String,
}

/// One file of the phone page, as the desktop's asset resolver hands it.
#[derive(Debug, Clone)]
pub struct Asset {
    pub bytes: Vec<u8>,
    pub mime: String,
}

/// What the server needs from the app around it.
#[async_trait::async_trait]
pub trait Host: Send + Sync + 'static {
    async fn state(&self) -> RemoteState;
    async fn chats(&self) -> Result<Vec<ChatRow>, String>;
    async fn transcript(&self, id: &str) -> Result<Vec<SessionEvent>, String>;
    /// Send `text` to `chat`, or to the open chat when `None`. Returns once
    /// the message is handed on — sent, or queued behind a running turn
    /// in that chat — not when the turn ends; `Err` when it was not (the
    /// sentence goes to the phone as a 409, and the phone keeps the text).
    async fn send(&self, chat: Option<&str>, text: &str) -> Result<Handed, String>;
    async fn approve(&self, req: ApproveRequest) -> Result<(), String>;
    /// Stop `chat`'s turn, or the open chat's when `None` (nightshift
    /// backlog 159, A3: two chats may run at once, and the phone's Stop
    /// is for the chat the phone is showing).
    async fn cancel(&self, chat: Option<&str>) -> Result<(), String>;
    /// A fresh subscriber to the event relay.
    fn events(&self) -> broadcast::Receiver<Event>;
    /// The page's files by path (`remote.html`, `assets/remote-….js`, …).
    fn asset(&self, path: &str) -> Option<Asset>;
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(
        "{0} is not a tailnet address; the phone page binds only to the Mac's Tailscale address"
    )]
    NotTailnet(IpAddr),
    #[error("could not listen on {addr}: {source}")]
    Bind {
        addr: SocketAddr,
        #[source]
        source: std::io::Error,
    },
}

struct Shared {
    host: Arc<dyn Host>,
    token: String,
    /// Cancelled by [`Server::stop`] and on drop: every open event stream
    /// ends on it. Axum runs each connection as its own task and its
    /// shutdown only asks hyper to finish the in-flight response, which an
    /// SSE stream never does — so without this, "off" (and a regenerated
    /// token, which restarts the listener) left every phone that held a
    /// stream still receiving the desktop's events (review 2026-09-17).
    closing: tokio_util::sync::CancellationToken,
}

/// A running listener. Dropping it, or [`Server::stop`], closes the port;
/// open SSE streams end with it and the phone reconnects when the listener
/// is next up.
pub struct Server {
    addr: SocketAddr,
    /// The bearer this listener runs with, for a rebind that must fall
    /// back to it (the desktop's `rebind`, review 2026-09-17 FA9).
    token: String,
    shutdown: Option<oneshot::Sender<()>>,
    closing: tokio_util::sync::CancellationToken,
    task: tokio::task::JoinHandle<()>,
}

impl Server {
    /// Bind `ip:port` and serve. `ip` must be a tailnet address
    /// (`100.64.0.0/10`); anything else is refused before a socket exists.
    pub async fn start(
        ip: IpAddr,
        port: u16,
        token: String,
        host: Arc<dyn Host>,
    ) -> Result<Self, Error> {
        if !tailnet::is_tailnet(ip) {
            return Err(Error::NotTailnet(ip));
        }
        Self::start_at(SocketAddr::new(ip, port), token, host).await
    }

    /// The crate's own tests bind loopback; nothing else may. The check
    /// lives in [`Server::start`] and this stays `cfg(test)` so no caller
    /// can reach a binding the rule refuses.
    #[cfg(test)]
    pub(crate) async fn start_for_test(
        addr: SocketAddr,
        token: String,
        host: Arc<dyn Host>,
    ) -> Result<Self, Error> {
        Self::start_at(addr, token, host).await
    }

    async fn start_at(addr: SocketAddr, token: String, host: Arc<dyn Host>) -> Result<Self, Error> {
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .map_err(|source| Error::Bind { addr, source })?;
        let bound = listener
            .local_addr()
            .map_err(|source| Error::Bind { addr, source })?;
        let (tx, rx) = oneshot::channel();
        let closing = tokio_util::sync::CancellationToken::new();
        let app = router(Arc::new(Shared {
            host,
            token: token.clone(),
            closing: closing.clone(),
        }));
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = rx.await;
                })
                .await;
        });
        Ok(Self {
            addr: bound,
            token,
            shutdown: Some(tx),
            closing,
            task,
        })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// The bearer this listener checks.
    pub fn token(&self) -> &str {
        &self.token
    }

    /// Close the port and end the serve task. The graceful signal lets an
    /// in-flight request finish; the abort is what closes the port, because
    /// axum's graceful shutdown otherwise waits for every keep-alive
    /// connection the phone holds open — the SSE stream never ends on its
    /// own, so without the abort "off" would never come.
    pub async fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        self.closing.cancel();
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        self.closing.cancel();
        self.task.abort();
    }
}

fn router(shared: Arc<Shared>) -> Router {
    let api = Router::new()
        .route("/state", get(state))
        .route("/chats", get(chats))
        .route("/chats/{id}/transcript", get(transcript))
        .route("/chats/{id}/send", post(send_to))
        .route("/send", post(send_active))
        .route("/approve", post(approve))
        .route("/cancel", post(cancel))
        .route("/chats/{id}/cancel", post(cancel_chat))
        .route("/events", get(events))
        // An explicit fallback so the bearer layer below covers a miss
        // too: without one an unknown `/api` path fell through to the
        // outer router's 404 *before* the token check, which let a caller
        // with no token tell a real route (401) from a missing one (404)
        // — a map of the API for free (review 2026-09-17, reviewer A).
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(middleware::from_fn_with_state(
            shared.clone(),
            require_token,
        ));
    Router::new()
        .route("/", get(page))
        .route("/remote.html", get(page))
        .route("/assets/{*path}", get(asset_under_assets))
        .route("/remote/{*path}", get(asset_under_remote))
        .nest("/api", api)
        .with_state(shared)
}

/// `Authorization: Bearer <token>` on every `/api` route, or 401. The page
/// and its files are served without it: the page is not secret and the
/// token reaches the phone through the page's own URL fragment.
async fn require_token(State(shared): State<Arc<Shared>>, req: Request, next: Next) -> Response {
    let presented = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .unwrap_or("");
    if !token::matches(&shared.token, presented) {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
            "the token is missing or wrong — open the link from Settings → Remote again",
        )
            .into_response();
    }
    next.run(req).await
}

fn bad(e: String) -> Response {
    (StatusCode::BAD_REQUEST, e).into_response()
}

async fn state(State(shared): State<Arc<Shared>>) -> Json<RemoteState> {
    Json(shared.host.state().await)
}

async fn chats(State(shared): State<Arc<Shared>>) -> Response {
    match shared.host.chats().await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => bad(e),
    }
}

async fn transcript(State(shared): State<Arc<Shared>>, Path(id): Path<String>) -> Response {
    match shared.host.transcript(&id).await {
        Ok(events) => Json(events).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, e).into_response(),
    }
}

async fn send_to(
    State(shared): State<Arc<Shared>>,
    Path(id): Path<String>,
    Json(req): Json<SendRequest>,
) -> Response {
    send_impl(&shared, Some(&id), req).await
}

async fn send_active(State(shared): State<Arc<Shared>>, Json(req): Json<SendRequest>) -> Response {
    send_impl(&shared, None, req).await
}

async fn send_impl(shared: &Shared, chat: Option<&str>, req: SendRequest) -> Response {
    if req.text.trim().is_empty() {
        return bad("nothing to send".into());
    }
    match shared.host.send(chat, &req.text).await {
        // Accepted, not done: the turn runs on the Mac and its progress
        // comes down the event stream; the body says whether it started
        // or waits behind the running turn.
        Ok(status) => (StatusCode::ACCEPTED, Json(SendReply { status })).into_response(),
        Err(e) => (StatusCode::CONFLICT, e).into_response(),
    }
}

async fn approve(State(shared): State<Arc<Shared>>, Json(req): Json<ApproveRequest>) -> Response {
    match shared.host.approve(req).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => bad(e),
    }
}

async fn cancel(State(shared): State<Arc<Shared>>) -> Response {
    match shared.host.cancel(None).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => bad(e),
    }
}

/// Stop one chat's turn (backlog 159, A3): the chat the phone shows, which
/// need not be the one on the Mac's screen.
async fn cancel_chat(State(shared): State<Arc<Shared>>, Path(id): Path<String>) -> Response {
    match shared.host.cancel(Some(&id)).await {
        Ok(()) => StatusCode::OK.into_response(),
        Err(e) => bad(e),
    }
}

/// The relay as SSE: `event: <name>` / `data: <payload>` per window event,
/// a `hello` first so the phone knows the stream is live, a comment every
/// 15 s so an idle connection is not cut by the phone. A subscriber that
/// falls behind the channel gets a `lagged` event and carries on — the
/// phone re-reads the state and the transcript on it rather than trusting
/// what it missed.
async fn events(
    State(shared): State<Arc<Shared>>,
) -> Sse<impl Stream<Item = Result<SseEvent, std::convert::Infallible>>> {
    let mut rx = shared.host.events();
    let closing = shared.closing.clone();
    let stream = async_stream::stream! {
        yield Ok(SseEvent::default().event("hello").data("{}"));
        loop {
            let next = tokio::select! {
                _ = closing.cancelled() => break,
                next = rx.recv() => next,
            };
            match next {
                Ok(ev) => yield Ok(SseEvent::default().event(ev.name).data(ev.payload)),
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    yield Ok(SseEvent::default().event("lagged").data(n.to_string()));
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15)))
}

async fn page(State(shared): State<Arc<Shared>>) -> Response {
    serve_asset(&shared, "remote.html", true)
}

async fn asset_under_assets(
    State(shared): State<Arc<Shared>>,
    Path(path): Path<String>,
) -> Response {
    serve_asset(&shared, &format!("assets/{path}"), false)
}

async fn asset_under_remote(
    State(shared): State<Arc<Shared>>,
    Path(path): Path<String>,
) -> Response {
    serve_asset(&shared, &format!("remote/{path}"), false)
}

/// A file of the page. Only the three roots above are reachable, so the
/// desktop's own `index.html` and anything else in the bundle stay
/// unserved; a path with `..` in it is refused before the resolver sees it.
fn serve_asset(shared: &Shared, path: &str, is_page: bool) -> Response {
    if path.split('/').any(|seg| seg == "..") {
        return StatusCode::NOT_FOUND.into_response();
    }
    match shared.host.asset(path) {
        Some(asset) => {
            let mut resp = Response::new(Body::from(asset.bytes));
            let headers = resp.headers_mut();
            if let Ok(v) = HeaderValue::from_str(&asset.mime) {
                headers.insert(header::CONTENT_TYPE, v);
            }
            // The page is re-fetched each open so a new build lands; its
            // hashed files can be kept.
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static(if is_page {
                    "no-cache"
                } else {
                    "public, max-age=31536000, immutable"
                }),
            );
            resp
        }
        None => (StatusCode::NOT_FOUND, "not part of the phone page").into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A host that records what it was asked and answers from fixtures.
    struct FakeHost {
        sent: Mutex<Vec<(Option<String>, String)>>,
        approved: Mutex<Vec<ApproveRequest>>,
        cancelled: Mutex<usize>,
        cancelled_chats: Mutex<Vec<Option<String>>>,
        tx: broadcast::Sender<Event>,
    }

    impl FakeHost {
        fn new() -> (Arc<Self>, broadcast::Sender<Event>) {
            let (tx, _) = broadcast::channel(16);
            let host = Arc::new(Self {
                sent: Mutex::new(Vec::new()),
                approved: Mutex::new(Vec::new()),
                cancelled: Mutex::new(0),
                cancelled_chats: Mutex::new(Vec::new()),
                tx: tx.clone(),
            });
            (host, tx)
        }
    }

    #[async_trait::async_trait]
    impl Host for FakeHost {
        async fn state(&self) -> RemoteState {
            RemoteState {
                project: Some("nightloom".into()),
                active_chat: Some("abc".into()),
                busy: false,
                connected: true,
                engine: Some("claude-code".into()),
                pending: vec![serde_json::json!({"id": "t1", "name": "Bash"})],
            }
        }
        async fn chats(&self) -> Result<Vec<ChatRow>, String> {
            Ok(vec![ChatRow {
                id: "abc".into(),
                label: "first".into(),
                modified: chrono::Utc::now(),
                user_turns: 2,
                kind: "build".into(),
                mode: "normal".into(),
            }])
        }
        async fn transcript(&self, id: &str) -> Result<Vec<SessionEvent>, String> {
            if id == "abc" {
                Ok(vec![SessionEvent::UserMessage {
                    text: "hello".into(),
                    images: vec![],
                    documents: vec![],
                    at: chrono::Utc::now(),
                }])
            } else {
                Err(format!("no chat {id}"))
            }
        }
        async fn send(&self, chat: Option<&str>, text: &str) -> Result<Handed, String> {
            // The window's three answers, by the text (review 2026-09-17
            // FA2/FA3): refused, queued, or sent.
            if text.contains("refuse me") {
                return Err("the desktop is busy in another chat".into());
            }
            self.sent
                .lock()
                .unwrap()
                .push((chat.map(String::from), text.to_string()));
            Ok(if text.contains("queue me") {
                Handed::Queued
            } else {
                Handed::Sent
            })
        }
        async fn approve(&self, req: ApproveRequest) -> Result<(), String> {
            self.approved.lock().unwrap().push(req);
            Ok(())
        }
        async fn cancel(&self, chat: Option<&str>) -> Result<(), String> {
            *self.cancelled.lock().unwrap() += 1;
            self.cancelled_chats
                .lock()
                .unwrap()
                .push(chat.map(String::from));
            Ok(())
        }
        fn events(&self) -> broadcast::Receiver<Event> {
            self.tx.subscribe()
        }
        fn asset(&self, path: &str) -> Option<Asset> {
            match path {
                "remote.html" => Some(Asset {
                    bytes: b"<!doctype html><title>phone</title>".to_vec(),
                    mime: "text/html".into(),
                }),
                "assets/remote-1.js" => Some(Asset {
                    bytes: b"console.log(1)".to_vec(),
                    mime: "text/javascript".into(),
                }),
                _ => None,
            }
        }
    }

    async fn up() -> (Server, Arc<FakeHost>, broadcast::Sender<Event>, String) {
        let (host, tx) = FakeHost::new();
        let token = token::generate();
        let server =
            Server::start_for_test("127.0.0.1:0".parse().unwrap(), token.clone(), host.clone())
                .await
                .unwrap();
        (server, host, tx, token)
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    #[tokio::test]
    async fn a_non_tailnet_address_is_refused_before_any_socket_exists() {
        let (host, _) = FakeHost::new();
        for ip in ["127.0.0.1", "0.0.0.0", "192.168.1.20", "::"] {
            let err = Server::start(ip.parse().unwrap(), 0, "t".into(), host.clone())
                .await
                .err()
                .expect(ip);
            assert!(matches!(err, Error::NotTailnet(_)), "{ip}: {err}");
        }
    }

    #[tokio::test]
    async fn the_api_needs_the_bearer_and_the_page_does_not() {
        let (server, _host, _tx, token) = up().await;
        let base = format!("http://{}", server.addr());
        let c = client();
        // No token: 401 on the API.
        let r = c.get(format!("{base}/api/state")).send().await.unwrap();
        assert_eq!(r.status(), 401);
        // A wrong token: 401.
        let r = c
            .get(format!("{base}/api/state"))
            .bearer_auth("nope")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 401);
        // The right one: the state.
        let r = c
            .get(format!("{base}/api/state"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        let st: RemoteState = r.json().await.unwrap();
        assert_eq!(st.active_chat.as_deref(), Some("abc"));
        assert_eq!(st.pending.len(), 1);
        // The page and its files need nothing.
        let r = c.get(format!("{base}/")).send().await.unwrap();
        assert_eq!(r.status(), 200);
        assert!(
            r.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with("text/html")
        );
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-cache");
        let r = c
            .get(format!("{base}/assets/remote-1.js"))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        // Nothing outside the page's roots, and no walking up.
        let r = c.get(format!("{base}/index.html")).send().await.unwrap();
        assert_eq!(r.status(), 404);
        let r = c
            .get(format!("{base}/assets/../index.html"))
            .send()
            .await
            .unwrap();
        assert_ne!(r.status(), 200);
        server.stop().await;
    }

    /// Review 2026-09-17 (reviewer A): the bearer check is a layer over the
    /// whole `/api` router, so it runs before the route table answers — an
    /// unknown path, a wrong method, `OPTIONS` and `HEAD` all say 401 with
    /// no token rather than 404 or 405, and an oversized body is refused
    /// by the extractor's default limit once the token is right.
    #[tokio::test]
    async fn every_api_road_needs_the_bearer_before_anything_else() {
        let (server, host, _tx, token) = up().await;
        let base = format!("http://{}", server.addr());
        let c = client();
        let reqs = [
            c.request(reqwest::Method::OPTIONS, format!("{base}/api/send")),
            c.head(format!("{base}/api/state")),
            c.get(format!("{base}/api/not-a-route")),
            c.get(format!("{base}/api/send")),
            c.post(format!("{base}/api/state")),
        ];
        for r in reqs {
            let r = r.build().unwrap();
            let what = format!("{} {}", r.method(), r.url().path());
            let resp = c.execute(r).await.unwrap();
            assert_eq!(resp.status(), 401, "{what}");
        }
        // A 3 MB message with the right token: the extractor's default
        // limit (2 MB) refuses it. The server answers before the body is
        // all read and hyper then closes the connection, so the client
        // sees either the 413 or a reset while still writing — which of
        // the two is a race on loopback. The property is that the host
        // never sees the message.
        let big = SendRequest {
            text: "x".repeat(3 * 1024 * 1024),
        };
        match c
            .post(format!("{base}/api/send"))
            .bearer_auth(&token)
            .json(&big)
            .send()
            .await
        {
            Ok(r) => assert_eq!(r.status(), 413),
            Err(e) => assert!(e.is_request(), "{e}"),
        }
        assert!(host.sent.lock().unwrap().is_empty());
        // An asset path that starts with `/` after the root is still a
        // relative lookup, not an absolute one.
        let r = c
            .get(format!("{base}/assets//etc/passwd"))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 404);
        server.stop().await;
    }

    #[tokio::test]
    async fn chats_transcript_send_approve_and_cancel_reach_the_host() {
        let (server, host, _tx, token) = up().await;
        let base = format!("http://{}", server.addr());
        let c = client();
        let rows: Vec<ChatRow> = c
            .get(format!("{base}/api/chats"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(rows[0].label, "first");
        let events: Vec<serde_json::Value> = c
            .get(format!("{base}/api/chats/abc/transcript"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(events[0]["event"], "user_message");
        let r = c
            .get(format!("{base}/api/chats/zzz/transcript"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 404);

        let r = c
            .post(format!("{base}/api/chats/abc/send"))
            .bearer_auth(&token)
            .json(&SendRequest {
                text: "from the phone".into(),
            })
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 202);
        assert_eq!(r.json::<SendReply>().await.unwrap().status, Handed::Sent);
        // The window's answer travels: queued behind a turn is a 202 that
        // says so; a refusal is a 409 with the sentence, and the message
        // is not recorded as sent (review 2026-09-17 FA2/FA3).
        let r = c
            .post(format!("{base}/api/chats/abc/send"))
            .bearer_auth(&token)
            .json(&SendRequest {
                text: "queue me please".into(),
            })
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 202);
        assert_eq!(r.json::<SendReply>().await.unwrap().status, Handed::Queued);
        let r = c
            .post(format!("{base}/api/chats/abc/send"))
            .bearer_auth(&token)
            .json(&SendRequest {
                text: "refuse me".into(),
            })
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 409);
        assert_eq!(
            r.text().await.unwrap(),
            "the desktop is busy in another chat"
        );
        let r = c
            .post(format!("{base}/api/send"))
            .bearer_auth(&token)
            .json(&SendRequest {
                text: "to the open chat".into(),
            })
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 202);
        let r = c
            .post(format!("{base}/api/send"))
            .bearer_auth(&token)
            .json(&SendRequest { text: "   ".into() })
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 400, "a blank message is refused, not queued");
        assert_eq!(
            *host.sent.lock().unwrap(),
            vec![
                (Some("abc".to_string()), "from the phone".to_string()),
                (Some("abc".to_string()), "queue me please".to_string()),
                (None, "to the open chat".to_string()),
            ]
        );

        let r = c
            .post(format!("{base}/api/approve"))
            .bearer_auth(&token)
            .json(&serde_json::json!({"id": "t1", "name": "Bash", "decision": "deny", "reason": "not now"}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        // Scoped so the guard is gone before the next await (clippy's
        // `await_holding_lock`; an explicit `drop` does not satisfy it).
        {
            let approved = host.approved.lock().unwrap();
            assert_eq!(approved[0].decision, "deny");
            assert_eq!(approved[0].reason.as_deref(), Some("not now"));
            assert!(approved[0].answer.is_none());
        }

        let r = c
            .post(format!("{base}/api/cancel"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(*host.cancelled.lock().unwrap(), 1);

        // The phone's Stop for the chat it shows (backlog 159, A3).
        let r = c
            .post(format!("{base}/api/chats/abc/cancel"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(
            *host.cancelled_chats.lock().unwrap(),
            vec![None, Some("abc".to_string())]
        );
        server.stop().await;
    }

    #[tokio::test]
    async fn the_event_stream_relays_window_events_by_name() {
        let (server, _host, tx, token) = up().await;
        let base = format!("http://{}", server.addr());
        let c = client();
        let mut r = c
            .get(format!("{base}/api/events"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        assert!(
            r.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap()
                .starts_with("text/event-stream")
        );
        // The hello first, then a relayed turn-event.
        let mut got = String::new();
        while !got.contains("event: hello") {
            let chunk = r.chunk().await.unwrap().expect("stream open");
            got.push_str(&String::from_utf8_lossy(&chunk));
        }
        tx.send(Event {
            name: "turn-event".into(),
            payload: r#"{"type":"text_delta","text":"hi"}"#.into(),
        })
        .unwrap();
        while !got.contains("event: turn-event") {
            let chunk = r.chunk().await.unwrap().expect("stream open");
            got.push_str(&String::from_utf8_lossy(&chunk));
        }
        assert!(
            got.contains(r#"data: {"type":"text_delta","text":"hi"}"#),
            "{got}"
        );
        server.stop().await;
    }

    /// Review 2026-09-17 (reviewer A): `stop` closed the port but not the
    /// streams already open on it — axum spawns each connection as its own
    /// task and shutdown only asks hyper to finish the in-flight response,
    /// which an SSE stream never does. So "off", and a regenerated token
    /// (which is a restart), left every phone that held a stream still
    /// receiving the desktop's events. The stream must end with the
    /// listener.
    #[tokio::test]
    async fn stopping_ends_an_open_event_stream() {
        let (server, _host, tx, token) = up().await;
        let base = format!("http://{}", server.addr());
        let c = client();
        let mut r = c
            .get(format!("{base}/api/events"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        let mut got = String::new();
        while !got.contains("event: hello") {
            let chunk = r.chunk().await.unwrap().expect("stream open");
            got.push_str(&String::from_utf8_lossy(&chunk));
        }
        server.stop().await;
        // The relay is still alive (the desktop is), so an event sent now
        // must not reach a stream the listener no longer owns.
        let _ = tx.send(Event {
            name: "turn-event".into(),
            payload: "{}".into(),
        });
        // Read to the end: the stream must close, not deliver the event.
        // Bounded so a stream that never closes fails the test rather than
        // hanging it — the bound is generous, not a timing assumption.
        let rest = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut rest = String::new();
            while let Ok(Some(chunk)) = r.chunk().await {
                rest.push_str(&String::from_utf8_lossy(&chunk));
            }
            rest
        })
        .await
        .expect("the stream ends with the listener");
        assert!(!rest.contains("event: turn-event"), "{rest}");
    }

    #[tokio::test]
    async fn stopping_closes_the_port() {
        let (server, _host, _tx, token) = up().await;
        let base = format!("http://{}", server.addr());
        let c = client();
        assert_eq!(
            c.get(format!("{base}/api/state"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        server.stop().await;
        assert!(c.get(format!("{base}/api/state")).send().await.is_err());
    }
}
