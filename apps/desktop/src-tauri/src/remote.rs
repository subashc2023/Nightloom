//! The phone page's desktop half (nightshift backlog 091, Shape B,
//! 2026-09-16): the [`Host`] the service crate's listener runs over, the
//! relay that copies the window's own events onto the phone's stream, and
//! the Settings → Remote card's commands.
//!
//! # How a phone message becomes a turn
//!
//! It does not call `send` in Rust. The host emits `remote-send` to the
//! desktop window, and the window's own `send` runs it — so the transcript,
//! the composer's queue, the hand-off, the banner and the sleep watch all
//! see a phone message exactly as a typed one, and the desktop's view is
//! never a turn behind. The same for `remote-approve` (→ `resolveApproval`)
//! and `remote-cancel` (→ `cancelTurn`). The turn runs on the Mac either
//! way; the phone reads its progress off the relayed `turn-event`s.
//!
//! The window answers (review 2026-09-17 FA2/FA3, backlog 132): each
//! `remote-send` carries an id, and the window's `remoteSend` reports back
//! through [`remote_sent`] — sent, queued behind the chat's running turn,
//! or refused with a sentence (no engine, busy in another chat, a chat
//! that would not open). `Host::send` waits for that answer (`SEND_WAIT`)
//! and the phone gets a 202 that says which, or a 409 and keeps the text;
//! a window that does not answer is a 409 too. Before this the 202 meant
//! only "emitted", and a message the window dropped was gone.
//!
//! # What the phone reads and from where
//!
//! The chat list and a transcript come from the store on disk, by id, with
//! no lock taken: the log is appended and flushed per event, so a transcript
//! read mid-turn is the honest partial, and any chat is readable while
//! another runs. `busy` is whether the session lock is held (a turn holds it
//! for its length), read with `try_lock` so the phone never waits on a turn.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nightloom_core::SessionEvent;
use nightloom_service::credentials;
use nightloom_service::remote::{
    ApproveRequest, Asset, ChatRow, DEFAULT_PORT, Event, Handed, Host, RemoteState, Server,
    tailnet, token,
};
use nightloom_service::store;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use tokio::sync::broadcast;

use crate::{AppState, power};

/// The relay's depth: a phone that falls this many events behind gets a
/// `lagged` event and re-reads rather than trusting what it missed.
const RELAY_CAPACITY: usize = 256;

/// The window events the phone's stream carries, unchanged.
const RELAYED: [&str; 3] = ["turn-event", "tool-approval", "turn-notice"];

/// How long `Host::send` waits for the window's answer to a `remote-send`
/// before the phone is told the desktop did not take it. The window's
/// part is a chat open at most — an IPC and a file read.
const SEND_WAIT: Duration = Duration::from_secs(3);

/// The desktop as the listener sees it.
pub struct DesktopHost {
    app: AppHandle,
    tx: broadcast::Sender<Event>,
    /// The open chat's id as last read while the session lock was free —
    /// what `state` answers while a turn holds it.
    last_chat: Mutex<Option<String>>,
    /// Every `tool-approval` the relay has seen, by id; `state` reports the
    /// ones the gates still hold and forgets the rest.
    seen: Mutex<HashMap<String, serde_json::Value>>,
    /// The `remote-send`s awaiting the window's answer, by id.
    replies: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<Handed, String>>>>,
    next_send: AtomicU64,
}

impl DesktopHost {
    fn new(app: AppHandle) -> Arc<Self> {
        let (tx, _) = broadcast::channel(RELAY_CAPACITY);
        Arc::new(Self {
            app,
            tx,
            last_chat: Mutex::new(None),
            seen: Mutex::new(HashMap::new()),
            replies: Mutex::new(HashMap::new()),
            next_send: AtomicU64::new(1),
        })
    }

    /// Copy the window's events onto the relay. Registered once at set-up;
    /// `AppHandle::listen` receives every event the app emits (tauri
    /// 2.11.5, `event/listener.rs`: `emit` runs with no filter).
    fn attach(self: &Arc<Self>) {
        for name in RELAYED {
            let host = self.clone();
            self.app.listen(name, move |ev| {
                if name == "tool-approval"
                    && let Ok(v) = serde_json::from_str::<serde_json::Value>(ev.payload())
                    && let Some(id) = v.get("id").and_then(|i| i.as_str())
                {
                    host.seen
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .insert(id.to_string(), v.clone());
                }
                // No subscriber is not an error: nothing is listening until
                // a phone opens the stream.
                let _ = host.tx.send(Event {
                    name: name.to_string(),
                    payload: ev.payload().to_string(),
                });
            });
        }
    }

    fn state_of(&self) -> State<'_, AppState> {
        self.app.state::<AppState>()
    }

    /// The window's answer to a `remote-send` (from `remote_sent`).
    fn answer(&self, id: u64, outcome: Result<Handed, String>) {
        let tx = self
            .replies
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
        if let Some(tx) = tx {
            let _ = tx.send(outcome);
        }
    }
}

fn lowercase<T: Serialize>(v: T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default()
}

#[async_trait::async_trait]
impl Host for DesktopHost {
    async fn state(&self) -> RemoteState {
        let state = self.state_of();
        let project = state.active().await.map(|p| p.name);
        // A turn holds the session for its length; `try_lock` is the
        // question "is one running" asked without waiting for the answer.
        let (busy, active_chat) = match state.session.try_lock() {
            Ok(guard) => {
                let id = guard.as_ref().map(|s| s.id.clone());
                *self.last_chat.lock().unwrap_or_else(|p| p.into_inner()) = id.clone();
                (false, id)
            }
            Err(_) => (
                true,
                self.last_chat
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .clone(),
            ),
        };
        // Held by a turn reads as connected: a turn cannot run without one.
        let agent = state.agent.try_lock().map(|g| g.is_some()).unwrap_or(true);
        let chat = state.chat.try_lock().map(|g| g.is_some()).unwrap_or(true);
        let engine = if agent {
            Some(crate::AGENT.to_string())
        } else if chat {
            Some("provider".to_string())
        } else {
            None
        };
        // The prompts still waiting: the Ask gate's (the Claude Code
        // engine) or the window approver's (the API engine). Anything
        // answered or abandoned is dropped here rather than kept forever.
        let pending = {
            let mut seen = self.seen.lock().unwrap_or_else(|p| p.into_inner());
            let gate = state.gate.pending.lock().unwrap_or_else(|p| p.into_inner());
            seen.retain(|id, _| state.ask.has(id) || gate.contains_key(id));
            seen.values().cloned().collect()
        };
        RemoteState {
            project,
            active_chat,
            busy,
            connected: agent || chat,
            engine,
            pending,
        }
    }

    async fn chats(&self) -> Result<Vec<ChatRow>, String> {
        let dir = self.state_of().log_dir().await;
        let rows = crate::blocking(move || store::list(&dir)).await?;
        Ok(rows
            .into_iter()
            .map(|s| ChatRow {
                label: s.label(80),
                id: s.id,
                modified: s.modified,
                user_turns: s.user_turns,
                kind: lowercase(s.kind),
                mode: lowercase(s.mode),
            })
            .collect())
    }

    async fn transcript(&self, id: &str) -> Result<Vec<SessionEvent>, String> {
        let dir = self.state_of().log_dir().await;
        let id = id.to_string();
        crate::blocking(move || -> Result<Vec<SessionEvent>, String> {
            let path = store::find_by_prefix(&dir, &id).map_err(|e| e.to_string())?;
            let session = nightloom_core::Session::load(path).map_err(|e| e.to_string())?;
            Ok(session.events().to_vec())
        })
        .await
    }

    async fn send(&self, chat: Option<&str>, text: &str) -> Result<Handed, String> {
        let id = self.next_send.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.replies
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, tx);
        if let Err(e) = self.app.emit(
            "remote-send",
            serde_json::json!({ "id": id, "chat": chat, "text": text }),
        ) {
            self.answer(id, Err(String::new()));
            return Err(format!(
                "the desktop window could not take the message: {e}"
            ));
        }
        match tokio::time::timeout(SEND_WAIT, rx).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err("the desktop window dropped the message".into()),
            Err(_) => {
                self.replies
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                Err("the desktop window did not answer — is Nightloom's window open?".into())
            }
        }
    }

    async fn approve(&self, req: ApproveRequest) -> Result<(), String> {
        self.app
            .emit("remote-approve", req)
            .map_err(|e| format!("the desktop window could not take the answer: {e}"))
    }

    async fn cancel(&self) -> Result<(), String> {
        self.app
            .emit("remote-cancel", ())
            .map_err(|e| format!("the desktop window could not take the stop: {e}"))
    }

    fn events(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }

    /// A file of the page from the bundle (or, under `tauri dev`, from
    /// `dist/` on disk — the resolver does that itself). The bundle's
    /// resolver answers `index.html` for any path it does not have, so a
    /// path is checked against the bundle's own listing first: the
    /// listener's "nothing outside the page's roots" holds only if a miss
    /// is a miss.
    fn asset(&self, path: &str) -> Option<Asset> {
        let resolver = self.app.asset_resolver();
        let mut bundled = resolver.iter().peekable();
        if bundled.peek().is_some() && !bundled.any(|(k, _)| k.trim_start_matches('/') == path) {
            return None;
        }
        resolver.get(format!("/{path}")).map(|a| Asset {
            bytes: a.bytes,
            mime: a.mime_type,
        })
    }
}

/// The listener's switch and its settings, managed beside `AppState`.
pub struct Remote {
    host: Arc<DesktopHost>,
    server: tokio::sync::Mutex<Option<Server>>,
    port: Mutex<u16>,
    keep_awake: Mutex<bool>,
    /// The keep-awake task's stop. The task holds a `power::Holder` guard
    /// across its wait; a guard borrows the holder, so it lives in a task
    /// rather than in this struct.
    awake: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl Remote {
    /// Build the host, attach the relay, and manage the state. Called once
    /// from `setup`, after `AppState` is managed.
    pub fn install(app: &AppHandle) {
        let host = DesktopHost::new(app.clone());
        host.attach();
        app.manage(Remote {
            host,
            server: tokio::sync::Mutex::new(None),
            port: Mutex::new(DEFAULT_PORT),
            keep_awake: Mutex::new(false),
            awake: Mutex::new(None),
        });
    }

    fn port(&self) -> u16 {
        *self.port.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn keep_awake(&self) -> bool {
        *self.keep_awake.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Hold the 101 guard while the listener is on and the switch is set;
    /// release it otherwise. The guard spawns `caffeinate` only when the
    /// Sleep card's own switch is on — the holder's rule, not changed here.
    fn apply_awake(&self, app: &AppHandle, on: bool) {
        let mut slot = self.awake.lock().unwrap_or_else(|p| p.into_inner());
        if on && slot.is_none() {
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let holder = app.state::<power::Holder>();
                let _guard = holder.acquire();
                let _ = rx.await;
            });
            *slot = Some(tx);
        } else if !on {
            // Dropping the sender ends the task's wait and its guard.
            slot.take();
        }
    }
}

/// What the card shows.
#[derive(Serialize, Clone, Debug, Default)]
pub struct RemoteStatus {
    pub on: bool,
    /// The tailnet address the listener is (or would be) bound to; `None`
    /// when Tailscale is not up.
    pub address: Option<String>,
    pub port: u16,
    pub keep_awake: bool,
    pub has_token: bool,
    /// The token as text, for the card and for a paste on the phone.
    pub token: Option<String>,
    /// `http://<address>:<port>/#token=<token>` — the QR's contents.
    pub setup_url: Option<String>,
    /// The QR as an SVG string.
    pub qr_svg: Option<String>,
}

const NO_TAILSCALE: &str =
    "Tailscale is not up on this Mac — open the Tailscale app and sign in, then try again";

/// `bound` is the running listener's address, or `None` when it is off.
/// While it is on the card shows *that* address, not whatever Tailscale
/// answers now: the two differ after a re-login or a reset changes the
/// node's address, and a QR built from the new one would point the phone
/// at a port nothing listens on (review 2026-09-17, reviewer A).
///
/// Plain values in, so it can run off the runtime: the Tailscale CLI (two
/// processes, each waited for at most `tailnet::CLI_TIMEOUT`), the keychain
/// and the QR render all block, and on a runtime worker they held a
/// streaming turn with them (review 2026-09-17 FA7). `status` is the
/// `spawn_blocking` wrapper every command uses.
fn status_of(port: u16, keep_awake: bool, bound: Option<std::net::SocketAddr>) -> RemoteStatus {
    let on = bound.is_some();
    let address = match bound {
        Some(addr) => Some(addr.ip()),
        None => tailnet::address().map(IpAddr::V4),
    };
    let port = bound.map(|a| a.port()).unwrap_or(port);
    let token = credentials::remote_token();
    let setup_url = match (&address, &token) {
        (Some(ip), Some(t)) => Some(token::setup_url(&ip.to_string(), port, t)),
        _ => None,
    };
    let qr_svg = setup_url.as_deref().and_then(|u| token::qr_svg(u).ok());
    RemoteStatus {
        on,
        address: address.map(|a| a.to_string()),
        port,
        keep_awake,
        has_token: token.is_some(),
        token,
        setup_url,
        qr_svg,
    }
}

/// `status_of` off the runtime, with the card's settings read first.
async fn status(
    remote: &Remote,
    bound: Option<std::net::SocketAddr>,
) -> Result<RemoteStatus, String> {
    let port = remote.port();
    let keep_awake = remote.keep_awake();
    crate::blocking(move || Ok::<_, String>(status_of(port, keep_awake, bound))).await
}

/// The card's read: is the listener up, where, and the token.
#[tauri::command]
pub async fn remote_status(remote: State<'_, Remote>) -> Result<RemoteStatus, String> {
    let bound = remote.server.lock().await.as_ref().map(Server::addr);
    status(&remote, bound).await
}

/// The window's answer to a `remote-send` (backlog 132): `queued` when the
/// message waits behind the chat's running turn, `error` when it was not
/// taken, else sent.
#[tauri::command]
pub fn remote_sent(remote: State<'_, Remote>, id: u64, queued: bool, error: Option<String>) {
    let outcome = match error {
        Some(e) => Err(e),
        None if queued => Ok(Handed::Queued),
        None => Ok(Handed::Sent),
    };
    remote.host.answer(id, outcome);
}

/// The token the keychain holds, or a sentence when it could not say
/// (review 2026-09-17 FA4): a locked or refusing keychain must not read
/// as "no token" — that minted a new one and un-paired every phone.
fn stored_token() -> Result<Option<String>, String> {
    credentials::try_remote_token()
        .map_err(|e| format!("could not read the phone token from the keychain ({e}); the one you have is kept — try again"))
}

/// Switch the listener on at `port` on the Mac's tailnet address. Refused
/// with a sentence naming Tailscale when there is none; a token is made
/// and stored on the first start.
#[tauri::command]
pub async fn remote_start(
    app: AppHandle,
    remote: State<'_, Remote>,
    port: Option<u16>,
) -> Result<RemoteStatus, String> {
    let port = port.unwrap_or_else(|| remote.port());
    if port == 0 {
        return Err("the port must be between 1 and 65535".into());
    }
    // The CLI and the keychain off the runtime (FA7); a keychain that
    // could not be read keeps the token (FA4).
    let (ip, stored) = crate::blocking(move || -> Result<_, String> {
        let ip: Ipv4Addr = tailnet::address().ok_or_else(|| NO_TAILSCALE.to_string())?;
        Ok((ip, stored_token()?))
    })
    .await?;
    let token = match stored {
        Some(t) => t,
        None => {
            let t = token::generate();
            credentials::set_remote_token(&t).map_err(|e| e.to_string())?;
            t
        }
    };
    let bound = rebind(&remote, IpAddr::V4(ip), port, token).await?;
    remote.apply_awake(&app, remote.keep_awake());
    status(&remote, Some(bound)).await
}

/// Start the listener at `ip:port` with `token`, in place of the one
/// running. Bind first and stop second when the port differs, so a bind
/// that fails leaves the old listener up; on the same port the old one
/// must go first, and if the new bind then fails the old address and
/// token are tried again so the switch is not left off with nothing
/// listening (review 2026-09-17 FA9). Either way an error names what
/// failed, and the card shows the listener as it is.
async fn rebind(
    remote: &Remote,
    ip: IpAddr,
    port: u16,
    token: String,
) -> Result<std::net::SocketAddr, String> {
    let host: Arc<dyn Host> = remote.host.clone();
    let mut slot = remote.server.lock().await;
    let old = slot.as_ref().map(|s| (s.addr(), s.token().to_string()));
    let same_port = old.as_ref().is_some_and(|(a, _)| a.port() == port);
    if !same_port {
        let server = Server::start(ip, port, token, host)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(previous) = slot.replace(server) {
            previous.stop().await;
        }
    } else {
        if let Some(previous) = slot.take() {
            previous.stop().await;
        }
        match Server::start(ip, port, token, host.clone()).await {
            Ok(server) => {
                *slot = Some(server);
            }
            Err(e) => {
                // Best effort: the listener as it was, so a mistyped
                // setting does not switch remote off.
                if let Some((addr, old_token)) = old
                    && let Ok(server) = Server::start(addr.ip(), addr.port(), old_token, host).await
                {
                    *slot = Some(server);
                }
                return Err(e.to_string());
            }
        }
    }
    *remote.port.lock().unwrap_or_else(|p| p.into_inner()) = port;
    Ok(slot.as_ref().map(Server::addr).expect("just bound"))
}

/// Switch the listener off: the port closes, open phone streams end, the
/// keep-awake guard (if held) goes.
#[tauri::command]
pub async fn remote_stop(
    app: AppHandle,
    remote: State<'_, Remote>,
) -> Result<RemoteStatus, String> {
    if let Some(server) = remote.server.lock().await.take() {
        server.stop().await;
    }
    remote.apply_awake(&app, false);
    status(&remote, None).await
}

/// The "keep the Mac awake while remote is on" switch: the guard is held
/// only while the listener is up.
#[tauri::command]
pub async fn remote_set_keep_awake(
    app: AppHandle,
    remote: State<'_, Remote>,
    on: bool,
) -> Result<RemoteStatus, String> {
    *remote.keep_awake.lock().unwrap_or_else(|p| p.into_inner()) = on;
    let bound = remote.server.lock().await.as_ref().map(Server::addr);
    remote.apply_awake(&app, on && bound.is_some());
    status(&remote, bound).await
}

/// The token, made and stored if there is none; `regenerate` replaces it
/// (every phone must be set up again) and restarts a running listener with
/// the new one. A keychain that could not be read keeps the token (FA4);
/// with the listener up, the new token is stored only once the listener
/// runs with it, so a restart that fails leaves the phones paired (FA9).
#[tauri::command]
pub async fn remote_token(
    app: AppHandle,
    remote: State<'_, Remote>,
    regenerate: bool,
) -> Result<RemoteStatus, String> {
    let stored = crate::blocking(stored_token).await?;
    let fresh = regenerate || stored.is_none();
    let bound = remote.server.lock().await.as_ref().map(Server::addr);
    if !fresh {
        return status(&remote, bound).await;
    }
    let new = token::generate();
    if let Some(addr) = bound {
        let bound = rebind(&remote, addr.ip(), addr.port(), new.clone()).await?;
        credentials::set_remote_token(&new).map_err(|e| e.to_string())?;
        remote.apply_awake(&app, remote.keep_awake());
        return status(&remote, Some(bound)).await;
    }
    credentials::set_remote_token(&new).map_err(|e| e.to_string())?;
    status(&remote, None).await
}
