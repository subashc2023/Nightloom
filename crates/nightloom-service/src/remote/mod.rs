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
//! No LAN or public binding, no option for one. No TLS by default: the
//! tailnet is WireGuard end to end, and a certificate the phone would have
//! to trust is a setup step this page exists to not have. HTTPS is served
//! only when `tailscale cert`'s `cert.pem` + `key.pem` are in
//! `<config>/remote/` (item 246 wave 3, [`crate::tls`]; the phone's
//! microphone needs a secure page). No Tailscale identity
//! headers yet (they need `tailscale serve` in front of the port; later).

pub mod api;
pub mod tailnet;
pub mod token;
mod voice_ws;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::Stream;
use nightloom_core::SessionEvent;
use nightloom_core::message::{DocumentInput, ImageInput};
use serde::{Deserialize, Serialize};

use crate::council::CouncilRequest;
use api::{
    ActReply, AsideCancel, AsideRequest, AsideStarted, ChatAction, ContextEditRequest,
    ContextReply, LayerChange, NOT_AVAILABLE, NewProjectRequest, NoteText, ProjectRenameRequest,
    Rail, RailPatch, Running, SearchScope, StateReply, UsageReply,
};
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

/// One row of the phone's project list (item 246): the drawer groups the
/// chats under these, and a new chat can start in any of them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    /// The project open on the Mac.
    pub active: bool,
}

/// A new chat from the phone (item 246): the first message, and the
/// project to start it in (`None`: the one open on the Mac).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewChatRequest {
    pub text: String,
    #[serde(default)]
    pub project: Option<String>,
}

/// A chat's new name, from the phone's chat-actions sheet (item 246).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameRequest {
    pub title: String,
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
    /// This host's voice (item 246, wave 3), or `None` when
    /// `bin/voice-setup.sh`'s programs are not there: the page then offers
    /// keyboard dictation instead of the orb. Filled by the listener from
    /// [`Host::voice`], not by the host's `state`.
    #[serde(default)]
    pub voice: Option<crate::voice::VoiceInfo>,
}

/// A message from the phone. Only `text` was there before item 246's
/// wave 1; every other field defaults, so an older page still sends.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SendRequest {
    pub text: String,
    /// Said aloud in voice mode (wave 3): the reply is written for the ear.
    /// Accepted and passed to the host; nothing acts on it before wave 3.
    #[serde(default)]
    pub spoken: bool,
    /// The project the chat is in, when it is not the one open on the Mac:
    /// the host opens it first, as a new chat in another project does.
    #[serde(default)]
    pub project: Option<String>,
    /// Photos, base64 with no `data:` prefix, as the Mac's composer
    /// attaches them.
    #[serde(default)]
    pub images: Vec<ImageInput>,
    #[serde(default)]
    pub documents: Vec<DocumentInput>,
    /// Send as a council turn, with these seats.
    #[serde(default)]
    pub council: Option<CouncilRequest>,
}

impl SendRequest {
    /// Only text (and perhaps `spoken`): what a host from before wave 1
    /// can take through [`Host::send`].
    pub fn is_plain(&self) -> bool {
        self.project.is_none()
            && self.images.is_empty()
            && self.documents.is_empty()
            && self.council.is_none()
    }
}

/// The largest body a send takes: photos and documents ride in it as
/// base64, which the extractor's 2 MB default would refuse for a single
/// phone photo. Every other route keeps the default.
pub const SEND_BODY_LIMIT: usize = 32 * 1024 * 1024;

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
    /// The chats of `project`, or of the project open on the Mac when `None`.
    async fn chats(&self, project: Option<&str>) -> Result<Vec<ChatRow>, String>;
    /// Every project, the open one marked (item 246).
    async fn projects(&self) -> Result<Vec<ProjectRow>, String>;
    /// A chat's log, in `project` or the open project when `None`.
    async fn transcript(
        &self,
        project: Option<&str>,
        id: &str,
    ) -> Result<Vec<SessionEvent>, String>;
    /// Send `text` to `chat`, or to the open chat when `None`. Returns once
    /// the message is handed on — sent, or queued behind a running turn
    /// in that chat — not when the turn ends; `Err` when it was not (the
    /// sentence goes to the phone as a 409, and the phone keeps the text).
    async fn send(&self, chat: Option<&str>, text: &str) -> Result<Handed, String>;
    /// Start a new chat in `project` (or the open project) with `text` as
    /// its first message — answered as `send` is (item 246).
    async fn new_chat(&self, project: Option<&str>, text: &str) -> Result<Handed, String>;
    /// Name a chat (item 246); `Err` is the desktop's sentence.
    async fn rename(&self, chat: &str, title: &str) -> Result<(), String>;
    /// Open a chat in the Mac's window (item 246), so he finds it there.
    async fn open(&self, chat: &str) -> Result<(), String>;
    async fn approve(&self, req: ApproveRequest) -> Result<(), String>;
    /// Stop `chat`'s turn, or the open chat's when `None` (nightshift
    /// backlog 159, A3: two chats may run at once, and the phone's Stop
    /// is for the chat the phone is showing).
    async fn cancel(&self, chat: Option<&str>) -> Result<(), String>;
    /// Send `text` as a spoken message (the phone's voice mode, item 246
    /// wave 3): answered as `send` is, recorded `spoken`, and run with the
    /// "answer for the ear" note. A host that cannot says so.
    async fn send_spoken(&self, chat: Option<&str>, text: &str) -> Result<Handed, String> {
        let _ = (chat, text);
        Err("spoken messages are not available on this host".into())
    }
    /// The voice engine, when this host has one (`crate::voice::Engine::find`).
    fn voice(&self) -> Option<Arc<crate::voice::Engine>> {
        None
    }
    /// A fresh subscriber to the event relay.
    fn events(&self) -> broadcast::Receiver<Event>;
    /// The page's files by path (`remote.html`, `assets/remote-….js`, …).
    fn asset(&self, path: &str) -> Option<Asset>;

    // ---- item 246, wave 1: the ONE API (design §4) ----
    //
    // Every method below has a default body answering [`NOT_AVAILABLE`]
    // (a 501 to the phone), so a host adopts them one at a time; it names
    // what it serves in `features` (the names in [`api::feature`]).

    /// The route groups this host serves, from [`api::feature`]. Carried on
    /// `/api/state` so the phone greys out the rest.
    fn features(&self) -> Vec<String> {
        Vec::new()
    }
    /// A send with everything the phone can attach. The default takes a
    /// plain text send through [`Host::send`] (`spoken` is ignored before
    /// wave 3) and answers [`NOT_AVAILABLE`] for the rest.
    async fn send_with(&self, chat: Option<&str>, req: SendRequest) -> Result<Handed, String> {
        if req.is_plain() {
            self.send(chat, &req.text).await
        } else {
            Err(NOT_AVAILABLE.into())
        }
    }
    /// One action on `chat`'s log, as the Mac's menus offer it. `Err` is
    /// the sentence the phone shows (409), and the chat is as it was.
    async fn act(&self, _chat: &str, _action: ChatAction) -> Result<ActReply, String> {
        Err(NOT_AVAILABLE.into())
    }
    /// `chat`'s Context page.
    async fn context(&self, _chat: &str) -> Result<ContextReply, String> {
        Err(NOT_AVAILABLE.into())
    }
    /// Hide or show items of `chat`'s context; the answer is the new view.
    async fn edit_context(
        &self,
        _chat: &str,
        _targets: Vec<usize>,
        _remove: bool,
    ) -> Result<nightloom_core::context::WireView, String> {
        Err(NOT_AVAILABLE.into())
    }
    /// Change `chat`'s prompt layers; the answer is its Context page after.
    async fn layers(&self, _chat: &str, _change: LayerChange) -> Result<ContextReply, String> {
        Err(NOT_AVAILABLE.into())
    }
    /// The engine and turn settings.
    async fn rail(&self) -> Result<Rail, String> {
        Err(NOT_AVAILABLE.into())
    }
    /// Merge `patch` into the settings and reconnect; the whole rail after.
    async fn set_rail(&self, _patch: RailPatch) -> Result<Rail, String> {
        Err(NOT_AVAILABLE.into())
    }
    /// What is running now: turns, asides, a dream, a capture.
    async fn running(&self) -> Result<Running, String> {
        Err(NOT_AVAILABLE.into())
    }
    /// The plan's usage windows and the ledger's summary.
    async fn usage(&self) -> Result<UsageReply, String> {
        Err(NOT_AVAILABLE.into())
    }
    /// Search everywhere, as the Mac's panel does.
    async fn search(
        &self,
        _q: &str,
        _scope: SearchScope,
    ) -> Result<crate::store::search::SearchResult, String> {
        Err(NOT_AVAILABLE.into())
    }
    /// A new project in the host's projects folder.
    async fn project_new(&self, _req: NewProjectRequest) -> Result<ProjectRow, String> {
        Err(NOT_AVAILABLE.into())
    }
    /// Make `id` the open project.
    async fn project_open(&self, _id: &str) -> Result<ProjectRow, String> {
        Err(NOT_AVAILABLE.into())
    }
    async fn project_rename(&self, _id: &str, _name: &str) -> Result<ProjectRow, String> {
        Err(NOT_AVAILABLE.into())
    }
    /// Drop `id` from the list; its folder and chats stay on disk.
    async fn project_forget(&self, _id: &str) -> Result<(), String> {
        Err(NOT_AVAILABLE.into())
    }
    /// The notes of `scope` (one of [`api::NOTE_SCOPES`]).
    async fn notes_list(&self, _scope: &str) -> Result<Vec<crate::project::Note>, String> {
        Err(NOT_AVAILABLE.into())
    }
    async fn note_read(&self, _scope: &str, _name: &str) -> Result<String, String> {
        Err(NOT_AVAILABLE.into())
    }
    async fn note_write(&self, _scope: &str, _name: &str, _text: &str) -> Result<(), String> {
        Err(NOT_AVAILABLE.into())
    }
    /// Delete a note — to the trash, never gone (the never-lose-work rule).
    async fn note_delete(&self, _scope: &str, _name: &str) -> Result<(), String> {
        Err(NOT_AVAILABLE.into())
    }
    /// An aside on `chat` (item 246, wave 2). Answers once the exchange
    /// exists; its text streams as `aside-event`s.
    async fn aside(&self, _chat: &str, _req: AsideRequest) -> Result<AsideStarted, String> {
        Err(NOT_AVAILABLE.into())
    }
    /// Stop exchange `seq` of an aside on `chat` while it answers.
    async fn aside_cancel(&self, _chat: &str, _seq: u64) -> Result<(), String> {
        Err(NOT_AVAILABLE.into())
    }
    /// `chat`'s aside threads (the host's own shape, passed through).
    async fn asides(&self, _chat: &str) -> Result<Vec<serde_json::Value>, String> {
        Err(NOT_AVAILABLE.into())
    }
}

/// The shortest bearer [`Server::start_public`] accepts (a 32-byte random
/// token is 64 hex characters; this refuses a typo'd or test value).
pub const PUBLIC_TOKEN_MIN: usize = 32;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(
        "{0} is not a tailnet address; the phone page binds only to the Mac's Tailscale address"
    )]
    NotTailnet(IpAddr),
    #[error(
        "a public listener needs a token of at least {PUBLIC_TOKEN_MIN} characters; this one has {0}"
    )]
    WeakToken(usize),
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
    /// Serving HTTPS with Tailscale's certificate (the page's link is then
    /// `https://<machine>.<tailnet>.ts.net:<port>/`, not the bare address).
    https: bool,
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
        let addr = SocketAddr::new(ip, port);
        // HTTPS when `tailscale cert`'s files are in `<config>/remote/`
        // (item 246 wave 3, blocker 660); plain HTTP otherwise, as before.
        // Unreadable files are an error, not a silent fall back to HTTP.
        let tls = crate::tls::dir()
            .and_then(|d| crate::tls::load(&d))
            .transpose()
            .map_err(|e| Error::Bind {
                addr,
                source: std::io::Error::other(e),
            })?;
        Self::start_at(addr, token, host, tls).await
    }

    /// Bind `ip:port` on any address, plain HTTP: the away server on Fly
    /// (item 268 step 2, blocker 673), where Fly's proxy terminates TLS and
    /// the internet reaches the port. The bearer layer is unchanged — every
    /// `/api` route and the voice socket need the token; the page and its
    /// files do not, as on the tailnet — and the token must be long enough
    /// to face the internet ([`PUBLIC_TOKEN_MIN`]). Only `nightloom serve`
    /// with `NIGHTLOOM_SERVE_PUBLIC=1` calls this.
    pub async fn start_public(
        ip: IpAddr,
        port: u16,
        token: String,
        host: Arc<dyn Host>,
    ) -> Result<Self, Error> {
        if token.len() < PUBLIC_TOKEN_MIN {
            return Err(Error::WeakToken(token.len()));
        }
        Self::start_at(SocketAddr::new(ip, port), token, host, None).await
    }

    /// The crate's own tests bind loopback without a long token. The checks
    /// live in [`Server::start`] and [`Server::start_public`], and this
    /// stays `cfg(test)` so no caller can reach a binding they refuse.
    #[cfg(test)]
    pub(crate) async fn start_for_test(
        addr: SocketAddr,
        token: String,
        host: Arc<dyn Host>,
    ) -> Result<Self, Error> {
        // Plain HTTP always: the tests must not turn to TLS on a machine
        // whose real `<config>/remote/cert.pem` exists (3A's patch note).
        Self::start_at(addr, token, host, None).await
    }

    async fn start_at(
        addr: SocketAddr,
        token: String,
        host: Arc<dyn Host>,
        tls: Option<Arc<rustls::ServerConfig>>,
    ) -> Result<Self, Error> {
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
        let https = tls.is_some();
        let task = match tls {
            Some(config) => tokio::spawn(async move {
                let _ = axum::serve(crate::tls::TlsListener::new(listener, config), app)
                    .with_graceful_shutdown(async {
                        let _ = rx.await;
                    })
                    .await;
            }),
            None => tokio::spawn(async move {
                let _ = axum::serve(listener, app)
                    .with_graceful_shutdown(async {
                        let _ = rx.await;
                    })
                    .await;
            }),
        };
        Ok(Self {
            addr: bound,
            https,
            token,
            shutdown: Some(tx),
            closing,
            task,
        })
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// Whether this listener serves HTTPS (see [`crate::tls`]).
    pub fn https(&self) -> bool {
        self.https
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
        .route("/projects", get(projects).post(project_new))
        .route("/projects/{id}/open", post(project_open))
        .route("/projects/{id}/rename", post(project_rename))
        .route("/projects/{id}/forget", post(project_forget))
        .route("/projects/{id}/chats", get(project_chats))
        .route(
            "/projects/{pid}/chats/{id}/transcript",
            get(project_transcript),
        )
        .route("/new", post(new_chat))
        .route("/chats/{id}/rename", post(rename))
        .route("/chats/{id}/open", post(open))
        .route("/chats/{id}/transcript", get(transcript))
        .route(
            "/chats/{id}/send",
            post(send_to).layer(DefaultBodyLimit::max(SEND_BODY_LIMIT)),
        )
        .route(
            "/send",
            post(send_active).layer(DefaultBodyLimit::max(SEND_BODY_LIMIT)),
        )
        .route("/approve", post(approve))
        .route("/cancel", post(cancel))
        .route("/chats/{id}/cancel", post(cancel_chat))
        .route("/events", get(events))
        // Item 246, wave 1: the ONE API (design §4; types in `api`).
        .route("/chats/{id}/act", post(act))
        .route("/chats/{id}/context", get(context).post(edit_context))
        .route("/chats/{id}/layers", post(layers))
        .route("/chats/{id}/aside", post(aside))
        .route("/chats/{id}/aside/cancel", post(aside_cancel))
        .route("/chats/{id}/asides", get(asides))
        .route("/rail", get(rail).post(set_rail))
        .route("/running", get(running))
        .route("/usage", get(usage))
        .route("/search", get(search))
        .route("/notes", get(notes_list))
        .route(
            "/notes/{scope}/{*name}",
            get(note_read).put(note_write).delete(note_delete),
        )
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
        // Outside the bearer layer: the socket's first frame carries the
        // token (a browser WebSocket cannot send the header), checked
        // before any audio is read (voice_ws.rs).
        .route("/api/voice", get(voice_ws::voice))
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

/// A host's refusal: 501 when it has no such thing ([`NOT_AVAILABLE`]),
/// 409 with its sentence when it refused this time.
fn refused(e: String) -> Response {
    if e == NOT_AVAILABLE {
        (StatusCode::NOT_IMPLEMENTED, e).into_response()
    } else {
        (StatusCode::CONFLICT, e).into_response()
    }
}

/// `Ok` as 200 with the JSON body, `Err` as [`refused`].
fn answer<T: Serialize>(r: Result<T, String>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => refused(e),
    }
}

/// `Ok(())` as 204, `Err` as [`refused`].
fn done(r: Result<(), String>) -> Response {
    match r {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => refused(e),
    }
}

/// The state, and what this host serves (item 246: `features`).
async fn state(State(shared): State<Arc<Shared>>) -> Json<StateReply> {
    let mut state = shared.host.state().await;
    state.voice = shared.host.voice().map(|v| v.info());
    Json(StateReply {
        state,
        features: shared.host.features(),
    })
}

async fn chats(State(shared): State<Arc<Shared>>) -> Response {
    match shared.host.chats(None).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => bad(e),
    }
}

/// Another project's chats (item 246), for the phone's drawer.
async fn project_chats(State(shared): State<Arc<Shared>>, Path(id): Path<String>) -> Response {
    match shared.host.chats(Some(&id)).await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => bad(e),
    }
}

async fn projects(State(shared): State<Arc<Shared>>) -> Response {
    match shared.host.projects().await {
        Ok(rows) => Json(rows).into_response(),
        Err(e) => bad(e),
    }
}

/// A new chat (item 246): 202 with `sent`/`queued` as a send, 409 with
/// the desktop's sentence when it could not start one.
async fn new_chat(State(shared): State<Arc<Shared>>, Json(req): Json<NewChatRequest>) -> Response {
    if req.text.trim().is_empty() {
        return bad("nothing to send".into());
    }
    match shared
        .host
        .new_chat(req.project.as_deref(), &req.text)
        .await
    {
        Ok(status) => (StatusCode::ACCEPTED, Json(SendReply { status })).into_response(),
        Err(e) => (StatusCode::CONFLICT, e).into_response(),
    }
}

async fn rename(
    State(shared): State<Arc<Shared>>,
    Path(id): Path<String>,
    Json(req): Json<RenameRequest>,
) -> Response {
    if req.title.trim().is_empty() {
        return bad("a name cannot be empty".into());
    }
    match shared.host.rename(&id, req.title.trim()).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::CONFLICT, e).into_response(),
    }
}

async fn open(State(shared): State<Arc<Shared>>, Path(id): Path<String>) -> Response {
    match shared.host.open(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::CONFLICT, e).into_response(),
    }
}

async fn transcript(State(shared): State<Arc<Shared>>, Path(id): Path<String>) -> Response {
    match shared.host.transcript(None, &id).await {
        Ok(events) => Json(events).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, e).into_response(),
    }
}

async fn project_transcript(
    State(shared): State<Arc<Shared>>,
    Path((pid, id)): Path<(String, String)>,
) -> Response {
    match shared.host.transcript(Some(&pid), &id).await {
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
    // A photo or a document with no caption is a message (item 246); an
    // empty text alone is not.
    if req.text.trim().is_empty() && req.images.is_empty() && req.documents.is_empty() {
        return bad("nothing to send".into());
    }
    if let Some(council) = &req.council
        && let Err(e) = council.validate()
    {
        return bad(e.to_string());
    }
    match shared.host.send_with(chat, req).await {
        // Accepted, not done: the turn runs on the Mac and its progress
        // comes down the event stream; the body says whether it started
        // or waits behind the running turn.
        Ok(status) => (StatusCode::ACCEPTED, Json(SendReply { status })).into_response(),
        Err(e) => refused(e),
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

// ---- item 246, wave 1: the ONE API ----

/// One action on a chat's log (edit, remove, rewind, fork, delete, …):
/// 200 with the chat now showing and its log, 409 with the sentence, 400
/// for an action no host could take.
async fn act(
    State(shared): State<Arc<Shared>>,
    Path(id): Path<String>,
    Json(action): Json<ChatAction>,
) -> Response {
    if let Err(e) = action.check() {
        return bad(e);
    }
    answer::<ActReply>(shared.host.act(&id, action).await)
}

async fn context(State(shared): State<Arc<Shared>>, Path(id): Path<String>) -> Response {
    answer(shared.host.context(&id).await)
}

async fn edit_context(
    State(shared): State<Arc<Shared>>,
    Path(id): Path<String>,
    Json(req): Json<ContextEditRequest>,
) -> Response {
    if req.targets.is_empty() {
        return bad("no items named".into());
    }
    answer(shared.host.edit_context(&id, req.targets, req.remove).await)
}

async fn layers(
    State(shared): State<Arc<Shared>>,
    Path(id): Path<String>,
    Json(change): Json<LayerChange>,
) -> Response {
    answer(shared.host.layers(&id, change).await)
}

/// An aside asked (item 246, wave 2): 202 with the thread and
/// the exchange's number once it exists, 409 with the sentence, 400 for a
/// question with no words.
async fn aside(
    State(shared): State<Arc<Shared>>,
    Path(id): Path<String>,
    Json(req): Json<AsideRequest>,
) -> Response {
    if let Err(e) = req.check() {
        return bad(e);
    }
    match shared.host.aside(&id, req).await {
        Ok(started) => (StatusCode::ACCEPTED, Json(started)).into_response(),
        Err(e) => refused(e),
    }
}

/// An aside's running exchange stopped: 204, or 409 with the sentence.
async fn aside_cancel(
    State(shared): State<Arc<Shared>>,
    Path(id): Path<String>,
    Json(req): Json<AsideCancel>,
) -> Response {
    done(shared.host.aside_cancel(&id, req.seq).await)
}

async fn asides(State(shared): State<Arc<Shared>>, Path(id): Path<String>) -> Response {
    answer(shared.host.asides(&id).await)
}

async fn rail(State(shared): State<Arc<Shared>>) -> Response {
    answer(shared.host.rail().await)
}

async fn set_rail(State(shared): State<Arc<Shared>>, Json(patch): Json<RailPatch>) -> Response {
    if patch.is_empty() {
        return bad("nothing to change".into());
    }
    answer(shared.host.set_rail(patch).await)
}

async fn running(State(shared): State<Arc<Shared>>) -> Response {
    answer::<Running>(shared.host.running().await)
}

async fn usage(State(shared): State<Arc<Shared>>) -> Response {
    answer::<UsageReply>(shared.host.usage().await)
}

/// `?q=` (required) and `?scope=this|all|notes` (default `all`).
async fn search(State(shared): State<Arc<Shared>>, uri: Uri) -> Response {
    let q = api::query_param(uri.query(), "q").unwrap_or_default();
    if q.trim().is_empty() {
        return bad("nothing to search for".into());
    }
    let scope = api::query_param(uri.query(), "scope").unwrap_or_default();
    let Some(scope) = SearchScope::parse(&scope) else {
        return bad(format!(
            "a search is `this`, `all` or `notes`, not `{scope}`"
        ));
    };
    answer(shared.host.search(q.trim(), scope).await)
}

async fn project_new(
    State(shared): State<Arc<Shared>>,
    Json(req): Json<NewProjectRequest>,
) -> Response {
    if req.name.trim().is_empty() {
        return bad("a project needs a name".into());
    }
    answer(shared.host.project_new(req).await)
}

async fn project_open(State(shared): State<Arc<Shared>>, Path(id): Path<String>) -> Response {
    answer(shared.host.project_open(&id).await)
}

async fn project_rename(
    State(shared): State<Arc<Shared>>,
    Path(id): Path<String>,
    Json(req): Json<ProjectRenameRequest>,
) -> Response {
    if req.name.trim().is_empty() {
        return bad("a name cannot be empty".into());
    }
    answer(shared.host.project_rename(&id, req.name.trim()).await)
}

async fn project_forget(State(shared): State<Arc<Shared>>, Path(id): Path<String>) -> Response {
    done(shared.host.project_forget(&id).await)
}

/// A scope the Mac's editor knows, or the 400's sentence.
fn note_scope(scope: &str) -> Result<(), String> {
    if api::NOTE_SCOPES.contains(&scope) {
        Ok(())
    } else {
        Err(format!(
            "`{scope}` is not a notes scope ({})",
            api::NOTE_SCOPES.join(", ")
        ))
    }
}

/// A note's name: a path under its scope, never out of it.
fn note_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.split('/').any(|seg| seg.is_empty() || seg == "..") {
        Err(format!("`{name}` is not a note's name"))
    } else {
        Ok(())
    }
}

/// `?scope=` (default `project`, as the Mac's).
async fn notes_list(State(shared): State<Arc<Shared>>, uri: Uri) -> Response {
    let scope = api::query_param(uri.query(), "scope")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "project".into());
    if let Err(e) = note_scope(&scope) {
        return bad(e);
    }
    answer(shared.host.notes_list(&scope).await)
}

async fn note_read(
    State(shared): State<Arc<Shared>>,
    Path((scope, name)): Path<(String, String)>,
) -> Response {
    if let Err(e) = note_scope(&scope).and_then(|()| note_name(&name)) {
        return bad(e);
    }
    answer(
        shared
            .host
            .note_read(&scope, &name)
            .await
            .map(|text| NoteText { text }),
    )
}

async fn note_write(
    State(shared): State<Arc<Shared>>,
    Path((scope, name)): Path<(String, String)>,
    Json(body): Json<NoteText>,
) -> Response {
    if let Err(e) = note_scope(&scope).and_then(|()| note_name(&name)) {
        return bad(e);
    }
    done(shared.host.note_write(&scope, &name, &body.text).await)
}

async fn note_delete(
    State(shared): State<Arc<Shared>>,
    Path((scope, name)): Path<(String, String)>,
) -> Response {
    if let Err(e) = note_scope(&scope).and_then(|()| note_name(&name)) {
        return bad(e);
    }
    done(shared.host.note_delete(&scope, &name).await)
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
        /// `(project, text)` of each new chat; `(chat, title)` of each
        /// rename; each chat opened; each project whose chats were listed.
        started: Mutex<Vec<(Option<String>, String)>>,
        renamed: Mutex<Vec<(String, String)>>,
        opened: Mutex<Vec<String>>,
        listed: Mutex<Vec<Option<String>>>,
        /// Item 246, wave 1: sends with attachments or a project; each
        /// action by chat; each layer change; the rail; notes by
        /// `(scope, name)`; projects forgotten.
        extras: Mutex<Vec<(Option<String>, SendRequest)>>,
        acted: Mutex<Vec<(String, ChatAction)>>,
        layered: Mutex<Vec<(String, LayerChange)>>,
        rail: Mutex<Rail>,
        notes: Mutex<std::collections::BTreeMap<(String, String), String>>,
        forgotten: Mutex<Vec<String>>,
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
                started: Mutex::new(Vec::new()),
                renamed: Mutex::new(Vec::new()),
                opened: Mutex::new(Vec::new()),
                listed: Mutex::new(Vec::new()),
                extras: Mutex::new(Vec::new()),
                acted: Mutex::new(Vec::new()),
                layered: Mutex::new(Vec::new()),
                rail: Mutex::new(Rail {
                    engine: "claude-code".into(),
                    model: "opus".into(),
                    ..Default::default()
                }),
                notes: Mutex::new(
                    [(
                        ("project".to_string(), "plans/today.md".to_string()),
                        "# Today".to_string(),
                    )]
                    .into_iter()
                    .collect(),
                ),
                forgotten: Mutex::new(Vec::new()),
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
                voice: None,
            }
        }
        async fn chats(&self, project: Option<&str>) -> Result<Vec<ChatRow>, String> {
            self.listed.lock().unwrap().push(project.map(String::from));
            Ok(vec![ChatRow {
                id: "abc".into(),
                label: "first".into(),
                modified: chrono::Utc::now(),
                user_turns: 2,
                kind: "build".into(),
                mode: "normal".into(),
            }])
        }
        async fn transcript(
            &self,
            project: Option<&str>,
            id: &str,
        ) -> Result<Vec<SessionEvent>, String> {
            if id == "abc" && matches!(project, None | Some("p2")) {
                Ok(vec![SessionEvent::UserMessage {
                    text: "hello".into(),
                    images: vec![],
                    documents: vec![],
                    spoken: false,
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
        async fn projects(&self) -> Result<Vec<ProjectRow>, String> {
            Ok(vec![
                ProjectRow {
                    id: "p1".into(),
                    name: "nightloom".into(),
                    active: true,
                },
                ProjectRow {
                    id: "p2".into(),
                    name: "keepsake".into(),
                    active: false,
                },
            ])
        }
        async fn new_chat(&self, project: Option<&str>, text: &str) -> Result<Handed, String> {
            if text.contains("refuse me") {
                return Err("the desktop is busy in another chat".into());
            }
            self.started
                .lock()
                .unwrap()
                .push((project.map(String::from), text.to_string()));
            Ok(Handed::Sent)
        }
        async fn rename(&self, chat: &str, title: &str) -> Result<(), String> {
            if chat == "running" {
                return Err("that chat is running a turn".into());
            }
            self.renamed
                .lock()
                .unwrap()
                .push((chat.to_string(), title.to_string()));
            Ok(())
        }
        async fn open(&self, chat: &str) -> Result<(), String> {
            self.opened.lock().unwrap().push(chat.to_string());
            Ok(())
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

        // ---- item 246, wave 1 ----
        //
        // Each refuses with a sentence on a chat named `running` (or an
        // input the Mac would refuse), as the window would.

        fn features(&self) -> Vec<String> {
            api::feature::ALL.iter().map(|s| s.to_string()).collect()
        }
        async fn send_with(&self, chat: Option<&str>, req: SendRequest) -> Result<Handed, String> {
            if req.is_plain() {
                return self.send(chat, &req.text).await;
            }
            if chat == Some("running") {
                return Err("a turn is running in the chat the Mac has open".into());
            }
            self.extras
                .lock()
                .unwrap()
                .push((chat.map(String::from), req));
            Ok(Handed::Sent)
        }
        async fn act(&self, chat: &str, action: ChatAction) -> Result<ActReply, String> {
            if chat == "running" {
                return Err("a turn is running in that chat — stop it first".into());
            }
            self.acted
                .lock()
                .unwrap()
                .push((chat.to_string(), action.clone()));
            Ok(ActReply {
                chat: match action {
                    ChatAction::Fork { .. } => "forked".into(),
                    _ => chat.to_string(),
                },
                events: self.transcript(None, "abc").await?,
            })
        }
        async fn context(&self, chat: &str) -> Result<ContextReply, String> {
            if chat == "running" {
                return Err("a turn is running in that chat".into());
            }
            Ok(ContextReply {
                view: empty_view(),
                layers: serde_json::json!({"off": []}),
                pending: serde_json::Value::Null,
            })
        }
        async fn edit_context(
            &self,
            chat: &str,
            targets: Vec<usize>,
            remove: bool,
        ) -> Result<nightloom_core::context::WireView, String> {
            if chat == "running" {
                return Err("a turn is running in that chat".into());
            }
            // The fake's tell: the view counts the items it hid.
            let mut view = empty_view();
            view.totals.unestimated = if remove { targets.len() } else { 0 };
            Ok(view)
        }
        async fn layers(&self, chat: &str, change: LayerChange) -> Result<ContextReply, String> {
            if chat == "running" {
                return Err("a turn is running in that chat".into());
            }
            self.layered
                .lock()
                .unwrap()
                .push((chat.to_string(), change));
            self.context(chat).await
        }
        async fn rail(&self) -> Result<Rail, String> {
            Ok(self.rail.lock().unwrap().clone())
        }
        async fn set_rail(&self, patch: RailPatch) -> Result<Rail, String> {
            if patch.engine.as_deref().is_some_and(|e| e == "bogus") {
                return Err("there is no engine called bogus".into());
            }
            let mut rail = self.rail.lock().unwrap();
            if let Some(m) = patch.model {
                rail.model = m;
            }
            if let Some(e) = patch.effort {
                rail.effort = e;
            }
            Ok(rail.clone())
        }
        async fn aside(&self, chat: &str, req: AsideRequest) -> Result<AsideStarted, String> {
            if chat == "running" {
                return Err("an aside runs on the Claude Code engine".into());
            }
            Ok(AsideStarted {
                chat: chat.into(),
                thread: req.thread.unwrap_or(1),
                seq: Some(7),
            })
        }
        async fn aside_cancel(&self, _chat: &str, seq: u64) -> Result<(), String> {
            if seq == 7 {
                Ok(())
            } else {
                Err("that aside is not answering".into())
            }
        }
        async fn asides(&self, chat: &str) -> Result<Vec<serde_json::Value>, String> {
            Ok(vec![
                serde_json::json!({ "id": 1, "open": true, "chat": chat }),
            ])
        }
        async fn running(&self) -> Result<Running, String> {
            Ok(Running {
                chats: vec![api::RunningChat {
                    chat: Some("abc".into()),
                    project: Some("p1".into()),
                    title: "first".into(),
                    since: Some(1_790_000_000_000),
                    on_screen: true,
                    waiting: 0,
                }],
                ..Default::default()
            })
        }
        async fn usage(&self) -> Result<UsageReply, String> {
            Ok(UsageReply {
                plan: crate::plan_usage::PlanUsage {
                    five_hour: Some(12),
                    source: "cli-cache".into(),
                    ..Default::default()
                },
                ledger: serde_json::Value::Null,
            })
        }
        async fn search(
            &self,
            q: &str,
            scope: SearchScope,
        ) -> Result<crate::store::search::SearchResult, String> {
            if scope == SearchScope::This && q == "nothing open" {
                return Err("no project is open".into());
            }
            Ok(crate::store::search::SearchResult {
                matches: q.len(),
                ..Default::default()
            })
        }
        async fn project_new(&self, req: NewProjectRequest) -> Result<ProjectRow, String> {
            if req.name == "nightloom" {
                return Err("a project called nightloom exists".into());
            }
            Ok(ProjectRow {
                id: "p3".into(),
                name: req.name,
                active: false,
            })
        }
        async fn project_open(&self, id: &str) -> Result<ProjectRow, String> {
            if id != "p2" {
                return Err(format!("no project {id}"));
            }
            Ok(ProjectRow {
                id: id.into(),
                name: "keepsake".into(),
                active: true,
            })
        }
        async fn project_rename(&self, id: &str, name: &str) -> Result<ProjectRow, String> {
            if id != "p2" {
                return Err(format!("no project {id}"));
            }
            Ok(ProjectRow {
                id: id.into(),
                name: name.into(),
                active: false,
            })
        }
        async fn project_forget(&self, id: &str) -> Result<(), String> {
            if id == "p1" {
                return Err("close the project before forgetting it".into());
            }
            self.forgotten.lock().unwrap().push(id.to_string());
            Ok(())
        }
        async fn notes_list(&self, scope: &str) -> Result<Vec<crate::project::Note>, String> {
            Ok(self
                .notes
                .lock()
                .unwrap()
                .iter()
                .filter(|((s, _), _)| s == scope)
                .map(|((_, name), text)| crate::project::Note {
                    name: name.clone(),
                    bytes: text.len() as u64,
                    modified: chrono::Utc::now(),
                    summary: text.lines().next().map(String::from),
                })
                .collect())
        }
        async fn note_read(&self, scope: &str, name: &str) -> Result<String, String> {
            self.notes
                .lock()
                .unwrap()
                .get(&(scope.to_string(), name.to_string()))
                .cloned()
                .ok_or_else(|| format!("no note {name}"))
        }
        async fn note_write(&self, scope: &str, name: &str, text: &str) -> Result<(), String> {
            self.notes
                .lock()
                .unwrap()
                .insert((scope.to_string(), name.to_string()), text.to_string());
            Ok(())
        }
        async fn note_delete(&self, scope: &str, name: &str) -> Result<(), String> {
            self.notes
                .lock()
                .unwrap()
                .remove(&(scope.to_string(), name.to_string()))
                .map(|_| ())
                .ok_or_else(|| format!("no note {name}"))
        }
    }

    fn empty_view() -> nightloom_core::context::WireView {
        serde_json::from_value(serde_json::json!({
            "system": [], "system_text": null, "messages": [],
            "totals": {"tokens": 0, "bytes": 0, "unestimated": 0},
            "context_limit": null
        }))
        .unwrap()
    }

    /// A host from before wave 1: only the required methods, every new
    /// one left to its default — what the away server's headless host is
    /// until it adopts them.
    struct BareHost(Arc<FakeHost>);

    #[async_trait::async_trait]
    impl Host for BareHost {
        async fn state(&self) -> RemoteState {
            self.0.state().await
        }
        async fn chats(&self, project: Option<&str>) -> Result<Vec<ChatRow>, String> {
            self.0.chats(project).await
        }
        async fn projects(&self) -> Result<Vec<ProjectRow>, String> {
            self.0.projects().await
        }
        async fn transcript(
            &self,
            project: Option<&str>,
            id: &str,
        ) -> Result<Vec<SessionEvent>, String> {
            self.0.transcript(project, id).await
        }
        async fn send(&self, chat: Option<&str>, text: &str) -> Result<Handed, String> {
            self.0.send(chat, text).await
        }
        async fn new_chat(&self, project: Option<&str>, text: &str) -> Result<Handed, String> {
            self.0.new_chat(project, text).await
        }
        async fn rename(&self, chat: &str, title: &str) -> Result<(), String> {
            self.0.rename(chat, title).await
        }
        async fn open(&self, chat: &str) -> Result<(), String> {
            self.0.open(chat).await
        }
        async fn approve(&self, req: ApproveRequest) -> Result<(), String> {
            self.0.approve(req).await
        }
        async fn cancel(&self, chat: Option<&str>) -> Result<(), String> {
            self.0.cancel(chat).await
        }
        fn events(&self) -> broadcast::Receiver<Event> {
            self.0.events()
        }
        fn asset(&self, path: &str) -> Option<Asset> {
            self.0.asset(path)
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
    async fn a_public_listener_needs_a_long_token_and_still_guards_the_api() {
        let (host, _) = FakeHost::new();
        let lo: IpAddr = "127.0.0.1".parse().unwrap();
        let err = Server::start_public(lo, 0, "short".into(), host.clone())
            .await
            .err()
            .expect("a short token is refused");
        assert!(matches!(err, Error::WeakToken(5)), "{err}");
        let token = "a".repeat(PUBLIC_TOKEN_MIN);
        let server = Server::start_public(lo, 0, token.clone(), host)
            .await
            .unwrap();
        assert!(!server.https());
        let base = format!("http://{}", server.addr());
        let c = client();
        let r = c.get(format!("{base}/api/state")).send().await.unwrap();
        assert_eq!(r.status(), 401);
        let r = c
            .get(format!("{base}/api/state"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        server.stop().await;
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
            // The phone's per-chat Stop (backlog 159, A3; review 2026-09-25).
            c.post(format!("{base}/api/chats/abc/cancel")),
        ];
        for r in reqs {
            let r = r.build().unwrap();
            let what = format!("{} {}", r.method(), r.url().path());
            let resp = c.execute(r).await.unwrap();
            assert_eq!(resp.status(), 401, "{what}");
        }
        // A message past the send limit with the right token is refused
        // (item 246 raised a send's limit to `SEND_BODY_LIMIT` for photos;
        // it was the extractor's 2 MB default). The server answers before
        // the body is all read and hyper then closes the connection, so
        // the client sees either the 413 or a reset while still writing —
        // which of the two is a race on loopback. The property is that the
        // host never sees the message.
        let big = SendRequest {
            text: "x".repeat(SEND_BODY_LIMIT + 1024 * 1024),
            ..Default::default()
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
        // Every other route keeps the 2 MB default: a 3 MB edit is refused.
        let edit = serde_json::json!({
            "op": "edit", "index": 0, "mode": "save", "text": "x".repeat(3 * 1024 * 1024)
        });
        match c
            .post(format!("{base}/api/chats/abc/act"))
            .bearer_auth(&token)
            .json(&edit)
            .send()
            .await
        {
            Ok(r) => assert_eq!(r.status(), 413),
            Err(e) => assert!(e.is_request(), "{e}"),
        }
        assert!(host.acted.lock().unwrap().is_empty());
        assert!(host.sent.lock().unwrap().is_empty());
        // A fresh client: the server closes a connection it refused a body
        // on, and a pooled one may be that connection.
        let c = client();
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
    async fn projects_new_chat_rename_and_open_reach_the_host() {
        let (server, host, _tx, token) = up().await;
        let base = format!("http://{}", server.addr());
        let c = client();
        let rows: Vec<ProjectRow> = c
            .get(format!("{base}/api/projects"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows[0].active && !rows[1].active);
        // A project named on the list is passed through; none is the open one.
        let r = c
            .get(format!("{base}/api/projects/p2/chats"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        let r = c
            .get(format!("{base}/api/chats"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(
            *host.listed.lock().unwrap(),
            vec![Some("p2".to_string()), None]
        );
        let r = c
            .get(format!("{base}/api/projects/p2/chats/abc/transcript"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        let r = c
            .get(format!("{base}/api/projects/p9/chats/abc/transcript"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 404);

        let r = c
            .post(format!("{base}/api/new"))
            .bearer_auth(&token)
            .json(&NewChatRequest {
                text: "a fresh start".into(),
                project: Some("p2".into()),
            })
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 202);
        assert_eq!(r.json::<SendReply>().await.unwrap().status, Handed::Sent);
        let r = c
            .post(format!("{base}/api/new"))
            .bearer_auth(&token)
            .json(&serde_json::json!({ "text": "refuse me" }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 409);
        let r = c
            .post(format!("{base}/api/new"))
            .bearer_auth(&token)
            .json(&serde_json::json!({ "text": "  " }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 400);
        assert_eq!(
            *host.started.lock().unwrap(),
            vec![(Some("p2".to_string()), "a fresh start".to_string())]
        );

        let r = c
            .post(format!("{base}/api/chats/abc/rename"))
            .bearer_auth(&token)
            .json(&RenameRequest {
                title: "  a new name ".into(),
            })
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 204);
        let r = c
            .post(format!("{base}/api/chats/running/rename"))
            .bearer_auth(&token)
            .json(&RenameRequest { title: "x".into() })
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 409);
        let r = c
            .post(format!("{base}/api/chats/abc/rename"))
            .bearer_auth(&token)
            .json(&RenameRequest { title: " ".into() })
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 400);
        assert_eq!(
            *host.renamed.lock().unwrap(),
            vec![("abc".to_string(), "a new name".to_string())]
        );

        let r = c
            .post(format!("{base}/api/chats/abc/open"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 204);
        assert_eq!(*host.opened.lock().unwrap(), vec!["abc".to_string()]);
        // And none of them without the bearer.
        let r = c.get(format!("{base}/api/projects")).send().await.unwrap();
        assert_eq!(r.status(), 401);
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
                ..Default::default()
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
                ..Default::default()
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
                ..Default::default()
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
                ..Default::default()
            })
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 202);
        let r = c
            .post(format!("{base}/api/send"))
            .bearer_auth(&token)
            .json(&SendRequest {
                text: "   ".into(),
                ..Default::default()
            })
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

    // ---- item 246, wave 1: the ONE API ----

    /// Every new route says 401 with no token, before the route table or
    /// the body is looked at.
    #[tokio::test]
    async fn every_wave_1_route_needs_the_bearer() {
        let (server, host, _tx, _token) = up().await;
        let base = format!("http://{}", server.addr());
        let c = client();
        let reqs = [
            c.post(format!("{base}/api/chats/abc/act"))
                .json(&serde_json::json!({"op": "delete"})),
            c.get(format!("{base}/api/chats/abc/context")),
            c.post(format!("{base}/api/chats/abc/context")),
            c.post(format!("{base}/api/chats/abc/layers")),
            c.get(format!("{base}/api/rail")),
            c.post(format!("{base}/api/rail")),
            c.get(format!("{base}/api/running")),
            c.get(format!("{base}/api/usage")),
            c.get(format!("{base}/api/search?q=x")),
            c.post(format!("{base}/api/projects")),
            c.post(format!("{base}/api/projects/p2/open")),
            c.post(format!("{base}/api/projects/p2/rename")),
            c.post(format!("{base}/api/projects/p2/forget")),
            c.get(format!("{base}/api/notes")),
            c.get(format!("{base}/api/notes/project/plans/today.md")),
            c.put(format!("{base}/api/notes/project/plans/today.md")),
            c.delete(format!("{base}/api/notes/project/plans/today.md")),
        ];
        for r in reqs {
            let r = r.build().unwrap();
            let what = format!("{} {}", r.method(), r.url().path());
            let resp = c.execute(r).await.unwrap();
            assert_eq!(resp.status(), 401, "{what}");
        }
        assert!(host.acted.lock().unwrap().is_empty());
        assert!(host.forgotten.lock().unwrap().is_empty());
        server.stop().await;
    }

    /// Tiny helpers for the tests below: a request with the bearer.
    async fn get_json(c: &reqwest::Client, url: String, token: &str) -> (u16, serde_json::Value) {
        let r = c.get(url).bearer_auth(token).send().await.unwrap();
        let status = r.status().as_u16();
        let text = r.text().await.unwrap();
        (
            status,
            serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text)),
        )
    }

    async fn post_json(
        c: &reqwest::Client,
        url: String,
        token: &str,
        body: serde_json::Value,
    ) -> (u16, serde_json::Value) {
        let r = c
            .post(url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        let status = r.status().as_u16();
        let text = r.text().await.unwrap();
        (
            status,
            serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text)),
        )
    }

    #[tokio::test]
    async fn state_lists_what_the_host_serves() {
        let (server, _host, _tx, token) = up().await;
        let base = format!("http://{}", server.addr());
        let (status, v) = get_json(&client(), format!("{base}/api/state"), &token).await;
        assert_eq!(status, 200);
        assert_eq!(v["active_chat"], "abc", "the state is still flat");
        let features: Vec<String> = serde_json::from_value(v["features"].clone()).unwrap();
        assert_eq!(features.len(), api::feature::ALL.len());
        assert!(features.iter().any(|f| f == "act"));
        server.stop().await;
    }

    #[tokio::test]
    async fn an_action_answers_the_log_or_the_sentence() {
        let (server, host, _tx, token) = up().await;
        let base = format!("http://{}", server.addr());
        let c = client();
        let url = |chat: &str| format!("{base}/api/chats/{chat}/act");
        let (status, v) = post_json(
            &c,
            url("abc"),
            &token,
            serde_json::json!({"op": "edit", "index": 0, "text": "better", "mode": "save"}),
        )
        .await;
        assert_eq!(status, 200, "{v}");
        let reply: ActReply = serde_json::from_value(v).unwrap();
        assert_eq!(reply.chat, "abc");
        assert_eq!(reply.events.len(), 1);
        // A fork answers with the new chat, so the phone follows it.
        let (status, v) = post_json(
            &c,
            url("abc"),
            &token,
            serde_json::json!({"op": "fork", "upto": 0}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(v["chat"], "forked");
        // The host's refusal is a 409 with its sentence.
        let (status, v) = post_json(
            &c,
            url("running"),
            &token,
            serde_json::json!({"op": "rewind", "to": 0}),
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(v, "a turn is running in that chat — stop it first");
        // What no host could take is a 400 and never reaches the host.
        let (status, _) = post_json(
            &c,
            url("abc"),
            &token,
            serde_json::json!({"op": "kind", "kind": "novel"}),
        )
        .await;
        assert_eq!(status, 400);
        let (status, _) = post_json(
            &c,
            url("abc"),
            &token,
            serde_json::json!({"op": "edit", "index": 0, "text": " ", "mode": "send"}),
        )
        .await;
        assert_eq!(status, 400);
        // An op the API does not have is the extractor's 422.
        let (status, _) =
            post_json(&c, url("abc"), &token, serde_json::json!({"op": "explode"})).await;
        assert_eq!(status, 422);
        let acted = host.acted.lock().unwrap().clone();
        assert_eq!(
            acted,
            vec![
                (
                    "abc".to_string(),
                    ChatAction::Edit {
                        index: 0,
                        text: "better".into(),
                        mode: api::EditMode::Save,
                        block: None
                    }
                ),
                ("abc".to_string(), ChatAction::Fork { upto: 0 }),
            ]
        );
        server.stop().await;
    }

    #[tokio::test]
    async fn context_layers_and_rail_reach_the_host() {
        let (server, host, _tx, token) = up().await;
        let base = format!("http://{}", server.addr());
        let c = client();
        let (status, v) = get_json(&c, format!("{base}/api/chats/abc/context"), &token).await;
        assert_eq!(status, 200);
        let reply: ContextReply = serde_json::from_value(v).unwrap();
        assert!(reply.view.messages.is_empty());
        assert_eq!(reply.layers["off"], serde_json::json!([]));
        let (status, v) = get_json(&c, format!("{base}/api/chats/running/context"), &token).await;
        assert_eq!(
            (status, v.as_str()),
            (409, Some("a turn is running in that chat"))
        );

        let (status, v) = post_json(
            &c,
            format!("{base}/api/chats/abc/context"),
            &token,
            serde_json::json!({"targets": [1, 2], "remove": true}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(v["totals"]["unestimated"], 2, "the new view");
        let (status, _) = post_json(
            &c,
            format!("{base}/api/chats/abc/context"),
            &token,
            serde_json::json!({"targets": [], "remove": true}),
        )
        .await;
        assert_eq!(status, 400);

        let (status, _) = post_json(
            &c,
            format!("{base}/api/chats/abc/layers"),
            &token,
            serde_json::json!({"off": ["identity"]}),
        )
        .await;
        assert_eq!(status, 200);
        let (status, _) = post_json(
            &c,
            format!("{base}/api/chats/running/layers"),
            &token,
            serde_json::json!({"kind": "identity", "text": "be brief"}),
        )
        .await;
        assert_eq!(status, 409);
        assert_eq!(host.layered.lock().unwrap().len(), 1);

        let (status, v) = get_json(&c, format!("{base}/api/rail"), &token).await;
        assert_eq!(status, 200);
        assert_eq!(v["model"], "opus");
        let (status, v) = post_json(
            &c,
            format!("{base}/api/rail"),
            &token,
            serde_json::json!({"model": "sonnet", "effort": "high"}),
        )
        .await;
        assert_eq!(status, 200);
        let rail: Rail = serde_json::from_value(v).unwrap();
        assert_eq!(
            (rail.model.as_str(), rail.effort.as_str()),
            ("sonnet", "high")
        );
        assert_eq!(
            rail.engine, "claude-code",
            "a patch changes only what it names"
        );
        let (status, _) = post_json(
            &c,
            format!("{base}/api/rail"),
            &token,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 400);
        let (status, v) = post_json(
            &c,
            format!("{base}/api/rail"),
            &token,
            serde_json::json!({"engine": "bogus"}),
        )
        .await;
        assert_eq!(
            (status, v.as_str()),
            (409, Some("there is no engine called bogus"))
        );
        server.stop().await;
    }

    #[tokio::test]
    async fn an_aside_is_accepted_refused_or_listed() {
        let (server, _host, _tx, token) = up().await;
        let base = format!("http://{}", server.addr());
        let c = client();
        let (status, v) = post_json(
            &c,
            format!("{base}/api/chats/abc/aside"),
            &token,
            serde_json::json!({"text": "why?"}),
        )
        .await;
        assert_eq!(status, 202, "{v}");
        assert_eq!(
            serde_json::from_value::<AsideStarted>(v).unwrap(),
            AsideStarted {
                chat: "abc".into(),
                thread: 1,
                seq: Some(7)
            }
        );
        let r = c
            .post(format!("{base}/api/chats/abc/aside/cancel"))
            .bearer_auth(&token)
            .json(&serde_json::json!({"seq": 7}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 204);
        let (status, v) = post_json(
            &c,
            format!("{base}/api/chats/abc/aside/cancel"),
            &token,
            serde_json::json!({"seq": 8}),
        )
        .await;
        assert_eq!(
            (status, v.as_str()),
            (409, Some("that aside is not answering"))
        );
        let (status, _) = post_json(
            &c,
            format!("{base}/api/chats/abc/aside"),
            &token,
            serde_json::json!({"text": "  "}),
        )
        .await;
        assert_eq!(status, 400);
        let (status, v) = post_json(
            &c,
            format!("{base}/api/chats/running/aside"),
            &token,
            serde_json::json!({"text": "q"}),
        )
        .await;
        assert_eq!(
            (status, v.as_str()),
            (409, Some("an aside runs on the Claude Code engine"))
        );
        let (status, v) = get_json(&c, format!("{base}/api/chats/abc/asides"), &token).await;
        assert_eq!((status, v[0]["chat"].as_str()), (200, Some("abc")));
        // Without the token, nothing.
        let r = c
            .get(format!("{base}/api/chats/abc/asides"))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 401);
        server.stop().await;
    }

    #[tokio::test]
    async fn running_usage_and_search_answer() {
        let (server, _host, _tx, token) = up().await;
        let base = format!("http://{}", server.addr());
        let c = client();
        let (status, v) = get_json(&c, format!("{base}/api/running"), &token).await;
        assert_eq!(status, 200);
        assert_eq!(v["chats"][0]["chat"], "abc");
        assert_eq!(v["asides"], serde_json::json!([]));
        let (status, v) = get_json(&c, format!("{base}/api/usage"), &token).await;
        assert_eq!(status, 200);
        assert_eq!(v["plan"]["five_hour"], 12);
        // `q` decoded (`hello there`, 11 characters: the fake's count).
        let (status, v) = get_json(
            &c,
            format!("{base}/api/search?q=hello%20there&scope=notes"),
            &token,
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(v["matches"], 11);
        let (status, _) = get_json(&c, format!("{base}/api/search"), &token).await;
        assert_eq!(status, 400, "no query");
        let (status, _) = get_json(&c, format!("{base}/api/search?q=a&scope=moon"), &token).await;
        assert_eq!(status, 400, "no such scope");
        let (status, v) = get_json(
            &c,
            format!("{base}/api/search?q=nothing+open&scope=this"),
            &token,
        )
        .await;
        assert_eq!((status, v.as_str()), (409, Some("no project is open")));
        server.stop().await;
    }

    #[tokio::test]
    async fn projects_can_be_made_opened_renamed_and_forgotten() {
        let (server, host, _tx, token) = up().await;
        let base = format!("http://{}", server.addr());
        let c = client();
        let (status, v) = post_json(
            &c,
            format!("{base}/api/projects"),
            &token,
            serde_json::json!({"name": "garden"}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(v["id"], "p3");
        let (status, v) = post_json(
            &c,
            format!("{base}/api/projects"),
            &token,
            serde_json::json!({"name": "nightloom"}),
        )
        .await;
        assert_eq!(
            (status, v.as_str()),
            (409, Some("a project called nightloom exists"))
        );
        let (status, _) = post_json(
            &c,
            format!("{base}/api/projects"),
            &token,
            serde_json::json!({"name": " "}),
        )
        .await;
        assert_eq!(status, 400);
        let (status, v) = post_json(
            &c,
            format!("{base}/api/projects/p2/open"),
            &token,
            serde_json::json!(null),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(v["active"], true);
        let (status, _) = post_json(
            &c,
            format!("{base}/api/projects/p9/open"),
            &token,
            serde_json::json!(null),
        )
        .await;
        assert_eq!(status, 409);
        let (status, v) = post_json(
            &c,
            format!("{base}/api/projects/p2/rename"),
            &token,
            serde_json::json!({"name": "  keepsake two "}),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(v["name"], "keepsake two");
        let r = c
            .post(format!("{base}/api/projects/p2/forget"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 204);
        let r = c
            .post(format!("{base}/api/projects/p1/forget"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 409);
        assert_eq!(*host.forgotten.lock().unwrap(), vec!["p2".to_string()]);
        server.stop().await;
    }

    #[tokio::test]
    async fn notes_are_listed_read_written_and_deleted() {
        let (server, _host, _tx, token) = up().await;
        let base = format!("http://{}", server.addr());
        let c = client();
        let (status, v) = get_json(&c, format!("{base}/api/notes"), &token).await;
        assert_eq!(status, 200, "the scope defaults to project");
        assert_eq!(v[0]["name"], "plans/today.md");
        let (status, v) = get_json(&c, format!("{base}/api/notes?scope=knowledge"), &token).await;
        assert_eq!((status, v), (200, serde_json::json!([])));
        let (status, _) = get_json(&c, format!("{base}/api/notes?scope=attic"), &token).await;
        assert_eq!(status, 400);

        let note = format!("{base}/api/notes/project/plans/today.md");
        let (status, v) = get_json(&c, note.clone(), &token).await;
        assert_eq!(status, 200);
        assert_eq!(v["text"], "# Today");
        let r = c
            .put(&note)
            .bearer_auth(&token)
            .json(&NoteText {
                text: "# Today\n\nwalk".into(),
            })
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 204);
        let (_, v) = get_json(&c, note.clone(), &token).await;
        assert_eq!(v["text"], "# Today\n\nwalk");
        let r = c.delete(&note).bearer_auth(&token).send().await.unwrap();
        assert_eq!(r.status(), 204);
        let (status, v) = get_json(&c, note.clone(), &token).await;
        assert_eq!((status, v.as_str()), (409, Some("no note plans/today.md")));
        // A bad scope or an empty segment never reaches the host. (A `..`
        // segment is folded away by the URL before it is sent; `note_name`
        // refuses it too, checked below.)
        let (status, _) = get_json(&c, format!("{base}/api/notes/attic/x.md"), &token).await;
        assert_eq!(status, 400);
        let (status, _) =
            get_json(&c, format!("{base}/api/notes/project/plans//x.md"), &token).await;
        assert_eq!(status, 400);
        assert!(note_name("a/../b").is_err());
        assert!(note_name("..").is_err());
        assert!(note_name("a/b.md").is_ok());
        server.stop().await;
    }

    #[tokio::test]
    async fn a_send_carries_photos_a_project_and_a_council() {
        let (server, host, _tx, token) = up().await;
        let base = format!("http://{}", server.addr());
        let c = client();
        // A 4 MB photo with no caption: past the old 2 MB limit, and a
        // message without text.
        let photo = "A".repeat(4 * 1024 * 1024);
        let r = c
            .post(format!("{base}/api/chats/abc/send"))
            .bearer_auth(&token)
            .json(&serde_json::json!({
                "text": "",
                "images": [{"media_type": "image/jpeg", "data": photo}],
                "project": "p2",
                "spoken": true
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 202);
        {
            let extras = host.extras.lock().unwrap();
            assert_eq!(extras.len(), 1);
            let (chat, req) = &extras[0];
            assert_eq!(chat.as_deref(), Some("abc"));
            assert_eq!(req.project.as_deref(), Some("p2"));
            assert_eq!(req.images[0].data.len(), 4 * 1024 * 1024);
            assert!(req.spoken);
        }
        // A plain send still goes through `send`, `spoken` or not.
        let (status, _) = post_json(
            &c,
            format!("{base}/api/send"),
            &token,
            serde_json::json!({"text": "hi", "spoken": true}),
        )
        .await;
        assert_eq!(status, 202);
        assert_eq!(host.sent.lock().unwrap().len(), 1);
        // The host's refusal: 409 with the sentence.
        let (status, v) = post_json(
            &c,
            format!("{base}/api/chats/running/send"),
            &token,
            serde_json::json!({"text": "x", "project": "p2"}),
        )
        .await;
        assert_eq!(
            (status, v.as_str()),
            (409, Some("a turn is running in the chat the Mac has open"))
        );
        // A council of one is refused before the host sees it.
        let (status, v) = post_json(
            &c,
            format!("{base}/api/send"),
            &token,
            serde_json::json!({"text": "x", "council": {"seats": [{"model": "opus"}]}}),
        )
        .await;
        assert_eq!(status, 400, "{v}");
        let (status, _) = post_json(
            &c,
            format!("{base}/api/send"),
            &token,
            serde_json::json!({"text": "x", "council": {"seats": [{"model": "opus"}, {"model": "sonnet"}]}}),
        )
        .await;
        assert_eq!(status, 202);
        assert_eq!(host.extras.lock().unwrap().len(), 2);
        server.stop().await;
    }

    /// A host that has not adopted wave 1 (the away server's today): every
    /// new route is a 501 with the sentence, a plain send still works, and
    /// `/api/state` lists no features.
    #[tokio::test]
    async fn a_host_from_before_wave_1_says_not_available() {
        let (fake, _tx) = FakeHost::new();
        let token = token::generate();
        let server = Server::start_for_test(
            "127.0.0.1:0".parse().unwrap(),
            token.clone(),
            Arc::new(BareHost(fake.clone())),
        )
        .await
        .unwrap();
        let base = format!("http://{}", server.addr());
        let c = client();
        let (status, v) = get_json(&c, format!("{base}/api/state"), &token).await;
        assert_eq!(status, 200);
        assert_eq!(v["features"], serde_json::json!([]));
        for (status, v) in [
            post_json(
                &c,
                format!("{base}/api/chats/abc/act"),
                &token,
                serde_json::json!({"op": "delete"}),
            )
            .await,
            get_json(&c, format!("{base}/api/chats/abc/context"), &token).await,
            get_json(&c, format!("{base}/api/rail"), &token).await,
            get_json(&c, format!("{base}/api/running"), &token).await,
            get_json(&c, format!("{base}/api/usage"), &token).await,
            get_json(&c, format!("{base}/api/search?q=x"), &token).await,
            get_json(&c, format!("{base}/api/notes"), &token).await,
            post_json(
                &c,
                format!("{base}/api/projects"),
                &token,
                serde_json::json!({"name": "garden"}),
            )
            .await,
            post_json(
                &c,
                format!("{base}/api/send"),
                &token,
                serde_json::json!({"text": "x", "images": [{"media_type": "image/png", "data": "AA=="}]}),
            )
            .await,
        ] {
            assert_eq!((status, v.as_str()), (501, Some(NOT_AVAILABLE)));
        }
        let (status, _) = post_json(
            &c,
            format!("{base}/api/send"),
            &token,
            serde_json::json!({"text": "plain", "spoken": true}),
        )
        .await;
        assert_eq!(status, 202);
        assert_eq!(fake.sent.lock().unwrap().len(), 1);
        server.stop().await;
    }

    /// The API check script (`scripts/remote-api-check.sh`, which later
    /// waves run against the Mac, `nightloom-cli serve` and the Fly
    /// machine) passes against both fakes: everything on the full host,
    /// and on the bare one the new routes reported as lacking, not failed.
    /// Skipped where bash, curl or jq is missing.
    #[tokio::test]
    async fn the_api_check_script_passes_against_both_hosts() {
        let have = |tool: &str| {
            std::process::Command::new("sh")
                .args(["-c", &format!("command -v {tool}")])
                .output()
                .is_ok_and(|o| o.status.success())
        };
        if !["bash", "curl", "jq"].into_iter().all(have) {
            eprintln!("skipped: needs bash, curl and jq");
            return;
        }
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../scripts/remote-api-check.sh");
        let run = |base: String, token: String| {
            let script = script.clone();
            async move {
                tokio::process::Command::new("bash")
                    .arg(script)
                    .args([base, token, "--write".into()])
                    .env("NO_PROXY", "*")
                    .output()
                    .await
                    .unwrap()
            }
        };
        let (server, _host, _tx, token) = up().await;
        let out = run(format!("http://{}", server.addr()), token).await;
        let text = String::from_utf8_lossy(&out.stdout);
        eprintln!("{text}");
        assert!(
            out.status.success(),
            "{text}{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(!text.contains("LACKS"), "{text}");
        assert!(text.contains("PASS  DELETE the scratch note"), "{text}");
        server.stop().await;

        let (fake, _tx) = FakeHost::new();
        let token = token::generate();
        let server = Server::start_for_test(
            "127.0.0.1:0".parse().unwrap(),
            token.clone(),
            Arc::new(BareHost(fake)),
        )
        .await
        .unwrap();
        let out = run(format!("http://{}", server.addr()), token).await;
        let text = String::from_utf8_lossy(&out.stdout);
        eprintln!("{text}");
        assert!(out.status.success(), "{text}");
        assert!(
            text.contains("LACKS GET /api/rail (feature rail)"),
            "{text}"
        );
        server.stop().await;
    }
}
