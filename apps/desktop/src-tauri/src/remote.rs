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
//! # What the phone reads and from where
//!
//! The chat list and a transcript come from the store on disk, by id, with
//! no lock taken: the log is appended and flushed per event, so a transcript
//! read mid-turn is the honest partial, and any chat is readable while
//! another runs. `busy` is whether the session lock is held (a turn holds it
//! for its length), read with `try_lock` so the phone never waits on a turn.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex};

use nightloom_core::SessionEvent;
use nightloom_service::credentials;
use nightloom_service::remote::{
    ApproveRequest, Asset, ChatRow, DEFAULT_PORT, Event, Host, RemoteState, Server, tailnet, token,
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
}

impl DesktopHost {
    fn new(app: AppHandle) -> Arc<Self> {
        let (tx, _) = broadcast::channel(RELAY_CAPACITY);
        Arc::new(Self {
            app,
            tx,
            last_chat: Mutex::new(None),
            seen: Mutex::new(HashMap::new()),
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

    async fn send(&self, chat: Option<&str>, text: &str) -> Result<(), String> {
        self.app
            .emit(
                "remote-send",
                serde_json::json!({ "chat": chat, "text": text }),
            )
            .map_err(|e| format!("the desktop window could not take the message: {e}"))
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

fn status_of(remote: &Remote, on: bool) -> RemoteStatus {
    let address = tailnet::address();
    let port = remote.port();
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
        keep_awake: remote.keep_awake(),
        has_token: token.is_some(),
        token,
        setup_url,
        qr_svg,
    }
}

/// The card's read: is the listener up, where, and the token.
#[tauri::command]
pub async fn remote_status(remote: State<'_, Remote>) -> Result<RemoteStatus, String> {
    let on = remote.server.lock().await.is_some();
    Ok(status_of(&remote, on))
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
    let ip: Ipv4Addr = tailnet::address().ok_or_else(|| NO_TAILSCALE.to_string())?;
    let port = port.unwrap_or_else(|| remote.port());
    if port == 0 {
        return Err("the port must be between 1 and 65535".into());
    }
    let token = match credentials::remote_token() {
        Some(t) => t,
        None => {
            let t = token::generate();
            credentials::set_remote_token(&t).map_err(|e| e.to_string())?;
            t
        }
    };
    let mut slot = remote.server.lock().await;
    if let Some(server) = slot.take() {
        server.stop().await;
    }
    let host: Arc<dyn Host> = remote.host.clone();
    let server = Server::start(IpAddr::V4(ip), port, token, host)
        .await
        .map_err(|e| e.to_string())?;
    *remote.port.lock().unwrap_or_else(|p| p.into_inner()) = port;
    *slot = Some(server);
    drop(slot);
    remote.apply_awake(&app, remote.keep_awake());
    Ok(status_of(&remote, true))
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
    Ok(status_of(&remote, false))
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
    let up = remote.server.lock().await.is_some();
    remote.apply_awake(&app, on && up);
    Ok(status_of(&remote, up))
}

/// The token, made and stored if there is none; `regenerate` replaces it
/// (every phone must be set up again) and restarts a running listener with
/// the new one.
#[tauri::command]
pub async fn remote_token(
    app: AppHandle,
    remote: State<'_, Remote>,
    regenerate: bool,
) -> Result<RemoteStatus, String> {
    let fresh = regenerate || credentials::remote_token().is_none();
    if fresh {
        credentials::set_remote_token(&token::generate()).map_err(|e| e.to_string())?;
    }
    let up = remote.server.lock().await.is_some();
    if fresh && up {
        return remote_start(app, remote, None).await;
    }
    Ok(status_of(&remote, up))
}
