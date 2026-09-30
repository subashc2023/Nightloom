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
    ApproveRequest, Asset, ChatRow, DEFAULT_PORT, Event, Handed, Host, ProjectRow, RemoteState,
    Server, api, tailnet, token,
};
use nightloom_service::store;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use tokio::sync::broadcast;

use crate::{AppState, power};

/// The relay's depth: a phone that falls this many events behind gets a
/// `lagged` event and re-reads rather than trusting what it missed.
const RELAY_CAPACITY: usize = 256;

/// The window events the phone's stream carries, unchanged. `aside-event`
/// (item 246, wave 2) is the window's word that an exchange the phone
/// asked has ended (`remoteHandlers.ts`); the backend's `aside-delta`s go
/// out under the same name, re-shaped by [`aside_delta_event`].
const RELAYED: [&str; 4] = ["turn-event", "tool-approval", "turn-notice", "aside-event"];

/// A backend `aside-delta` (`{seq, text}`) as the phone's `aside-event`
/// (`{kind: "delta", seq, text}`); `None` for a payload that is not one.
fn aside_delta_event(payload: &str) -> Option<String> {
    let mut v = serde_json::from_str::<serde_json::Value>(payload).ok()?;
    let o = v.as_object_mut()?;
    if !o.get("seq").is_some_and(|s| s.is_u64()) || !o.get("text").is_some_and(|t| t.is_string()) {
        return None;
    }
    o.insert("kind".into(), serde_json::json!("delta"));
    Some(v.to_string())
}

/// How long `Host::send` waits for the window's answer to a `remote-send`
/// before the phone is told the desktop did not take it. The window's
/// part is a chat open at most — an IPC and a file read.
const SEND_WAIT: Duration = Duration::from_secs(3);

/// A new chat from the phone may open another project first (item 246):
/// its lists are read before the chat starts, so the window gets longer.
const NEW_CHAT_WAIT: Duration = Duration::from_secs(10);

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
    /// The other window calls (item 246, wave 1: `remote-act`,
    /// `remote-rail`, …) awaiting `remote_done`, by id — the same ids as
    /// `replies`, from the one counter.
    calls: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>>>,
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
            calls: Mutex::new(HashMap::new()),
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
        // An aside's answer as it streams (item 246, wave 2): every one,
        // the Mac's own included — the phone keeps the `seq`s it asked.
        let host = self.clone();
        self.app.listen("aside-delta", move |ev| {
            if let Some(payload) = aside_delta_event(ev.payload()) {
                let _ = host.tx.send(Event {
                    name: "aside-event".to_string(),
                    payload,
                });
            }
        });
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

    /// The window's answer to any other call (from `remote_done`).
    fn finish(&self, id: u64, outcome: Result<serde_json::Value, String>) {
        let tx = self
            .calls
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

impl DesktopHost {
    /// Where a project's chats live: the one named by the phone's drawer
    /// (item 246), or the open project's when `None`.
    async fn dir_of(&self, project: Option<&str>) -> Result<std::path::PathBuf, String> {
        let state = self.state_of();
        let Some(id) = project else {
            return Ok(state.log_dir().await);
        };
        let found = state
            .workspaces
            .lock()
            .await
            .registry
            .projects()
            .into_iter()
            .find(|p| p.id == id);
        found
            .map(|p| p.session_dir())
            .ok_or_else(|| format!("no project {id}"))
    }

    /// Emit a `remote-send` carrying `payload` plus an id and wait up to
    /// `wait` for the window's answer (backlog 132).
    async fn hand(&self, mut payload: serde_json::Value, wait: Duration) -> Result<Handed, String> {
        let id = self.next_send.fetch_add(1, Ordering::Relaxed);
        payload["id"] = serde_json::json!(id);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.replies
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, tx);
        if let Err(e) = self.app.emit("remote-send", payload) {
            self.answer(id, Err(String::new()));
            return Err(format!(
                "the desktop window could not take the message: {e}"
            ));
        }
        match tokio::time::timeout(wait, rx).await {
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

    /// Emit `event` carrying `body` (an object) plus an id and wait up to
    /// `wait` for the window's `remote_done` (item 246, wave 1) — `hand`'s
    /// general form: the answer is any JSON, or the window's sentence.
    async fn call(
        &self,
        event: &str,
        mut body: serde_json::Value,
        wait: Duration,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_send.fetch_add(1, Ordering::Relaxed);
        body["id"] = serde_json::json!(id);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.calls
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, tx);
        if let Err(e) = self.app.emit(event, body) {
            self.finish(id, Err(String::new()));
            return Err(format!("the desktop window could not take it: {e}"));
        }
        match tokio::time::timeout(wait, rx).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err("the desktop window dropped it".into()),
            Err(_) => {
                self.calls
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .remove(&id);
                Err(
                    "the desktop window did not answer in time — is Nightloom's window open?"
                        .into(),
                )
            }
        }
    }

    /// The project `chat` lives in, when that is not the open one — so the
    /// window can switch to it before acting (blocker 665's default: the
    /// Mac's window follows the phone). `None` when the chat is in the
    /// open project, or found nowhere (the window's open then says so).
    async fn project_of(&self, chat: &str) -> Option<String> {
        let state = self.state_of();
        let (active, projects) = {
            let ws = state.workspaces.lock().await;
            (
                ws.active.as_ref().map(|p| p.id.clone()),
                ws.registry.projects(),
            )
        };
        let open_dir = state.log_dir().await;
        let chat = chat.to_string();
        crate::blocking(move || -> Result<Option<String>, String> {
            if store::find_by_prefix(&open_dir, &chat).is_ok() {
                return Ok(None);
            }
            Ok(projects
                .into_iter()
                .filter(|p| active.as_deref() != Some(p.id.as_str()))
                .find(|p| store::find_by_prefix(&p.session_dir(), &chat).is_ok())
                .map(|p| p.id))
        })
        .await
        .ok()
        .flatten()
    }

    /// A window call addressed to one chat: `chat` and its project (when
    /// not the open one) go with `body`.
    async fn call_chat(
        &self,
        event: &str,
        chat: &str,
        mut body: serde_json::Value,
        wait: Duration,
    ) -> Result<serde_json::Value, String> {
        body["chat"] = serde_json::json!(chat);
        body["project"] = serde_json::json!(self.project_of(chat).await);
        self.call(event, body, wait).await
    }
}

#[async_trait::async_trait]
impl Host for DesktopHost {
    async fn state(&self) -> RemoteState {
        let state = self.state_of();
        let project = state.active().await.map(|p| p.name);
        // A turn holds its chat's lock for its length (since backlog 159
        // A1, each chat has its own); `running` asks which without waiting.
        // ~~Busy meant the one open chat was locked, and the chat named was
        // the last one seen open~~ — now busy is any chat running, and the
        // chat named is the running one while a turn runs (he may have
        // opened another in the window meanwhile), else the open one.
        let running = state.chats.running();
        let (busy, active_chat) = match running.first() {
            None => {
                let id = state.chats.focus();
                *self.last_chat.lock().unwrap_or_else(|p| p.into_inner()) = id.clone();
                (false, id)
            }
            Some(id) => (true, Some(id.clone())),
        };
        // Held by a turn reads as connected: a turn cannot run without one.
        // ~~`state.agent.try_lock()`~~ — one agent per chat since backlog
        // 159 A2; the engine is live when a connection is, or a turn runs.
        let agent = state.agents.connected() || !state.agents.running().is_empty();
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
            voice: None,
        }
    }

    async fn chats(&self, project: Option<&str>) -> Result<Vec<ChatRow>, String> {
        let dir = self.dir_of(project).await?;
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

    async fn transcript(
        &self,
        project: Option<&str>,
        id: &str,
    ) -> Result<Vec<SessionEvent>, String> {
        let dir = self.dir_of(project).await?;
        let id = id.to_string();
        crate::blocking(move || -> Result<Vec<SessionEvent>, String> {
            let path = store::find_by_prefix(&dir, &id).map_err(|e| e.to_string())?;
            let session = nightloom_core::Session::load(path).map_err(|e| e.to_string())?;
            Ok(session.events().to_vec())
        })
        .await
    }

    async fn projects(&self) -> Result<Vec<ProjectRow>, String> {
        let state = self.state_of();
        let ws = state.workspaces.lock().await;
        let open = ws.active.as_ref().map(|p| p.id.clone());
        Ok(ws
            .registry
            .projects()
            .into_iter()
            .map(|p| ProjectRow {
                active: open.as_deref() == Some(p.id.as_str()),
                id: p.id,
                name: p.name,
            })
            .collect())
    }

    async fn send(&self, chat: Option<&str>, text: &str) -> Result<Handed, String> {
        self.hand(serde_json::json!({ "chat": chat, "text": text }), SEND_WAIT)
            .await
    }

    async fn new_chat(&self, project: Option<&str>, text: &str) -> Result<Handed, String> {
        self.hand(
            serde_json::json!({ "chat": null, "text": text, "new": true, "project": project }),
            NEW_CHAT_WAIT,
        )
        .await
    }

    async fn rename(&self, chat: &str, title: &str) -> Result<(), String> {
        // The desktop's own command (the id is the list's full one); a
        // chat whose turn is running is refused with its sentence.
        crate::rename_session(self.state_of(), chat.to_string(), title.to_string(), None).await?;
        // The window's list re-reads so the sidebar shows the new name.
        let _ = self.app.emit("remote-renamed", chat);
        Ok(())
    }

    async fn open(&self, chat: &str) -> Result<(), String> {
        self.app
            .emit("remote-open", serde_json::json!({ "chat": chat }))
            .map_err(|e| format!("the desktop window could not take it: {e}"))
    }

    async fn approve(&self, req: ApproveRequest) -> Result<(), String> {
        self.app
            .emit("remote-approve", req)
            .map_err(|e| format!("the desktop window could not take the answer: {e}"))
    }

    async fn cancel(&self, chat: Option<&str>) -> Result<(), String> {
        // The chat the phone shows (backlog 159, A3); `null` is the chat
        // on the Mac's screen, as before.
        self.app
            .emit("remote-cancel", serde_json::json!({ "chat": chat }))
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

    // ---- item 246 wave 1: 1A's trait methods, forwarded to 1B's
    // inherent ones below (`DesktopHost::x(self, …)` names the inherent
    // method; inherent wins over the trait's). JSON both ways: the window
    // speaks JSON, 1A's types are the wire's.

    fn features(&self) -> Vec<String> {
        DesktopHost::features(self)
    }

    async fn send_with(
        &self,
        chat: Option<&str>,
        req: nightloom_service::remote::SendRequest,
    ) -> Result<Handed, String> {
        if req.is_plain() && !req.spoken {
            return self.send(chat, &req.text).await;
        }
        DesktopHost::send_to(self, chat, to_json(&req)?).await
    }

    async fn act(&self, chat: &str, action: api::ChatAction) -> Result<api::ActReply, String> {
        from_json(DesktopHost::act(self, chat, to_json(&action)?).await?)
    }

    async fn context(&self, chat: &str) -> Result<api::ContextReply, String> {
        from_json(DesktopHost::context(self, chat).await?)
    }

    async fn edit_context(
        &self,
        chat: &str,
        targets: Vec<usize>,
        remove: bool,
    ) -> Result<nightloom_core::context::WireView, String> {
        from_json(DesktopHost::edit_context(self, chat, targets, remove).await?)
    }

    async fn layers(
        &self,
        chat: &str,
        change: api::LayerChange,
    ) -> Result<api::ContextReply, String> {
        from_json(DesktopHost::layers(self, chat, to_json(&change)?).await?)
    }

    async fn rail(&self) -> Result<api::Rail, String> {
        from_json(DesktopHost::rail(self).await?)
    }

    async fn set_rail(&self, patch: api::RailPatch) -> Result<api::Rail, String> {
        from_json(DesktopHost::set_rail(self, to_json(&patch)?).await?)
    }

    async fn running(&self) -> Result<api::Running, String> {
        from_json(DesktopHost::running(self).await?)
    }

    async fn usage(&self) -> Result<api::UsageReply, String> {
        from_json(DesktopHost::usage(self).await?)
    }

    async fn search(
        &self,
        q: &str,
        scope: api::SearchScope,
    ) -> Result<store::search::SearchResult, String> {
        let scope = match scope {
            api::SearchScope::This => crate::SearchScope::This,
            api::SearchScope::All => crate::SearchScope::All,
            api::SearchScope::Notes => crate::SearchScope::Notes,
        };
        crate::search_everywhere(self.state_of(), q.to_string(), scope).await
    }

    async fn project_new(&self, req: api::NewProjectRequest) -> Result<ProjectRow, String> {
        let made = DesktopHost::project_new(self, &req.name, req.instructions.as_deref()).await?;
        self.row_of(&made).await
    }

    async fn project_open(&self, id: &str) -> Result<ProjectRow, String> {
        let opened = DesktopHost::project_open(self, id).await?;
        self.row_of(&opened).await
    }

    async fn project_rename(&self, id: &str, name: &str) -> Result<ProjectRow, String> {
        let renamed = DesktopHost::project_rename(self, id, name).await?;
        self.row_of(&renamed).await
    }

    async fn project_forget(&self, id: &str) -> Result<(), String> {
        DesktopHost::project_forget(self, id).await.map(|_| ())
    }

    async fn notes_list(&self, scope: &str) -> Result<Vec<nightloom_service::Note>, String> {
        let scope = serde_json::from_value(serde_json::json!(scope))
            .map_err(|_| format!("no note scope {scope}"))?;
        crate::list_notes(self.state_of(), Some(scope)).await
    }

    async fn note_read(&self, scope: &str, name: &str) -> Result<String, String> {
        DesktopHost::note_read(self, scope, name).await
    }

    async fn note_write(&self, scope: &str, name: &str, text: &str) -> Result<(), String> {
        DesktopHost::note_write(self, scope, name, text)
            .await
            .map(|_| ())
    }

    async fn note_delete(&self, scope: &str, name: &str) -> Result<(), String> {
        DesktopHost::note_delete(self, scope, name).await
    }
}

/// How long a chat action may take in the window: the chat opened (in
/// another project, its lists read) and the command run — on Claude Code
/// a copy of the CLI's file.
const ACT_WAIT: Duration = Duration::from_secs(20);

/// A compaction is a model call; the phone waits for the summary.
const COMPACT_WAIT: Duration = Duration::from_secs(180);

/// A read the window answers from its own state.
const READ_WAIT: Duration = Duration::from_secs(5);

/// The rail's change reconnects the engine before it answers.
const RAIL_WAIT: Duration = Duration::from_secs(30);

/// What this host serves of §4 (item 246 design), for `/api/state`'s
/// `features`: the phone greys out what a host lacks.
pub const FEATURES: [&str; 15] = [
    "act",
    "context",
    "layers",
    "rail",
    "running",
    "usage",
    "search",
    "projects",
    "notes",
    "send_project",
    "images",
    "documents",
    "council",
    "spoken",
    // Wave 2 (2A): `POST /api/chats/{id}/aside`, `GET …/asides`.
    "aside",
];

/// The phone's note deletes go here, never gone (the never-lose-work
/// rule; blocker 685): `~/.nightloom/trash/notes/<when>/<scope>/<name>`.
fn note_trash(scope: &str, name: &str) -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty())?;
    let when = chrono::Local::now().format("%Y-%m-%d-%H%M%S").to_string();
    Some(
        std::path::PathBuf::from(home)
            .join(nightloom_service::project::DOT_DIR)
            .join("trash")
            .join("notes")
            .join(when)
            .join(scope)
            .join(name.trim().trim_start_matches('/')),
    )
}

fn to_json<T: Serialize>(t: &T) -> Result<serde_json::Value, String> {
    serde_json::to_value(t).map_err(|e| e.to_string())
}

fn from_json<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|e| format!("the window's answer did not read: {e}"))
}

impl DesktopHost {
    /// A project as the phone lists it, from the window's answer (the
    /// desktop's `ProjectInfo`: its `id`), with `active` read fresh.
    async fn row_of(&self, project: &serde_json::Value) -> Result<ProjectRow, String> {
        let id = project
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("the window did not say which project")?;
        self.projects()
            .await?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("project {id} is not on the list"))
    }
}

/// §4's new `Host` methods, the Mac's way (item 246, wave 1, agent 1B).
///
/// `impl Host for DesktopHost` forwards 1A's typed trait methods here
/// (JSON both ways, `to_json`/`from_json`); search and the notes list are
/// served there directly, since their replies are the service crate's own
/// types.
///
/// Every chat-addressed one runs in the window, like `send`: the window
/// opens the chat when it is not the open one (another project's first),
/// refused with a sentence while a turn runs in the chat on screen
/// (blocker 665's default), runs the same state function the Mac's button
/// runs, and answers through [`remote_done`]. Reads that need no window
/// (usage, search, notes) are served here.
impl DesktopHost {
    pub fn features(&self) -> Vec<String> {
        FEATURES.iter().map(|s| s.to_string()).collect()
    }

    /// One message action (`ChatAction`, tagged by `op`) → `ActReply`
    /// (`{chat, events}`: the chat now showing — a fork's new id — and its
    /// log). `Err` is the window's sentence (the 409).
    pub async fn act(
        &self,
        chat: &str,
        action: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let wait = match action.get("op").and_then(|o| o.as_str()) {
            Some("compact") => COMPACT_WAIT,
            _ => ACT_WAIT,
        };
        self.call_chat(
            "remote-act",
            chat,
            serde_json::json!({ "action": action }),
            wait,
        )
        .await
    }

    /// `{ view, layers, pending }` of `chat` — the Context page's reads.
    pub async fn context(&self, chat: &str) -> Result<serde_json::Value, String> {
        self.call_chat("remote-context", chat, serde_json::json!({}), ACT_WAIT)
            .await
    }

    /// Remove or restore the content of log events → the new view.
    pub async fn edit_context(
        &self,
        chat: &str,
        targets: Vec<usize>,
        remove: bool,
    ) -> Result<serde_json::Value, String> {
        self.call_chat(
            "remote-edit-context",
            chat,
            serde_json::json!({ "targets": targets, "remove": remove }),
            ACT_WAIT,
        )
        .await
    }

    /// `{off:[kind]}`, `{kind, text|null}` or `{kind, choice}` → the
    /// context as `context` reads it.
    pub async fn layers(
        &self,
        chat: &str,
        change: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.call_chat(
            "remote-layers",
            chat,
            serde_json::json!({ "change": change }),
            RAIL_WAIT,
        )
        .await
    }

    /// The rail as the Mac shows it: engine, model, effort, fallback,
    /// limits, ask, plan, fork mode, council seats (blocker 666: no keys,
    /// no folders).
    pub async fn rail(&self) -> Result<serde_json::Value, String> {
        self.call(
            "remote-rail",
            serde_json::json!({ "patch": null }),
            READ_WAIT,
        )
        .await
    }

    /// Merge `patch` into the rail and reconnect, as a click on the Mac's
    /// rail does → the rail after.
    pub async fn set_rail(&self, patch: serde_json::Value) -> Result<serde_json::Value, String> {
        self.call(
            "remote-rail",
            serde_json::json!({ "patch": patch }),
            RAIL_WAIT,
        )
        .await
    }

    /// An aside on `chat` (item 246, wave 2): `{op: "ask", text, thread?}`
    /// or `{op: "stop", thread}` → `{chat, thread, seq}` once the exchange
    /// exists. The answer streams on the relay as `aside-event`s. The
    /// window opens the chat first (an aside forks the open chat).
    ///
    /// Not reached by a route yet: the service crate's `aside`/`asides`
    /// Host methods and routes are in `246w2-patch-p2a-to-orchestrator`,
    /// whose diff adds the trait forwards and drops these `allow`s.
    #[allow(dead_code)]
    pub async fn aside(
        &self,
        chat: &str,
        req: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.call_chat(
            "remote-aside",
            chat,
            serde_json::json!({ "aside": req }),
            ACT_WAIT,
        )
        .await
    }

    /// `chat`'s aside threads: the open ones, then the closed ones under
    /// Past — read from the window without opening the chat.
    #[allow(dead_code)]
    pub async fn asides(&self, chat: &str) -> Result<serde_json::Value, String> {
        self.call(
            "remote-asides",
            serde_json::json!({ "chat": chat }),
            READ_WAIT,
        )
        .await
    }

    /// The chats running now and the open chat's subagents, from the
    /// window's Running tasks.
    pub async fn running(&self) -> Result<serde_json::Value, String> {
        self.call("remote-running", serde_json::json!({}), READ_WAIT)
            .await
    }

    /// `{ plan, ledger }`: the plan window (5 h, week, resets) and the
    /// ledger's summary, read off disk.
    pub async fn usage(&self) -> Result<serde_json::Value, String> {
        let plan =
            crate::blocking(|| Ok::<_, String>(nightloom_service::plan_usage::read())).await?;
        let ledger =
            crate::blocking(|| Ok::<_, String>(nightloom_service::usage::summary())).await?;
        Ok(serde_json::json!({ "plan": plan, "ledger": ledger }))
    }

    /// A new project by name (its folder under the projects folder, as
    /// the Mac's form without a picked folder) → its row.
    pub async fn project_new(
        &self,
        name: &str,
        instructions: Option<&str>,
    ) -> Result<serde_json::Value, String> {
        self.call(
            "remote-project",
            serde_json::json!({ "op": "new", "name": name, "instructions": instructions }),
            ACT_WAIT,
        )
        .await
    }

    /// Open a project in the Mac's window.
    pub async fn project_open(&self, id: &str) -> Result<serde_json::Value, String> {
        self.call(
            "remote-project",
            serde_json::json!({ "op": "open", "pid": id }),
            ACT_WAIT,
        )
        .await
    }

    pub async fn project_rename(&self, id: &str, name: &str) -> Result<serde_json::Value, String> {
        self.call(
            "remote-project",
            serde_json::json!({ "op": "rename", "pid": id, "name": name }),
            ACT_WAIT,
        )
        .await
    }

    /// Forget, never delete: the folder, notes and chats stay on disk.
    pub async fn project_forget(&self, id: &str) -> Result<serde_json::Value, String> {
        self.call(
            "remote-project",
            serde_json::json!({ "op": "forget", "pid": id }),
            ACT_WAIT,
        )
        .await
    }

    pub async fn note_read(&self, scope: &str, name: &str) -> Result<String, String> {
        let scope = serde_json::from_value(serde_json::json!(scope))
            .map_err(|_| format!("no note scope {scope}"))?;
        crate::read_note(self.state_of(), Some(scope), name.to_string()).await
    }

    /// Write a note (a new one too); the window's lists re-read.
    pub async fn note_write(
        &self,
        scope: &str,
        name: &str,
        text: &str,
    ) -> Result<serde_json::Value, String> {
        let parsed = serde_json::from_value(serde_json::json!(scope))
            .map_err(|_| format!("no note scope {scope}"))?;
        let note = crate::save_note(
            self.state_of(),
            Some(parsed),
            name.to_string(),
            text.to_string(),
        )
        .await?;
        let _ = self.app.emit(
            "remote-notes-changed",
            serde_json::json!({ "scope": scope, "name": name }),
        );
        serde_json::to_value(note).map_err(|e| e.to_string())
    }

    /// Delete a note: its text is copied to the trash folder first
    /// (`note_trash`), and only then is the file removed.
    pub async fn note_delete(&self, scope: &str, name: &str) -> Result<(), String> {
        let text = self.note_read(scope, name).await?;
        let trash = note_trash(scope, name)
            .ok_or_else(|| "no home folder to keep the deleted note in".to_string())?;
        crate::blocking(move || -> Result<(), String> {
            if let Some(dir) = trash.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            std::fs::write(&trash, text).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| {
            format!("could not keep a copy of the note in the trash, so it was not deleted: {e}")
        })?;
        let parsed = serde_json::from_value(serde_json::json!(scope))
            .map_err(|_| format!("no note scope {scope}"))?;
        crate::delete_note(self.state_of(), Some(parsed), name.to_string()).await?;
        let _ = self.app.emit(
            "remote-notes-changed",
            serde_json::json!({ "scope": scope, "name": name, "deleted": true }),
        );
        Ok(())
    }

    /// `send` with §4's `SendRequest`: `project` opens that project first,
    /// `images`/`documents`/`council` go with the message as the Mac's
    /// composer sends them; `spoken` is accepted and ignored until wave 3.
    pub async fn send_to(
        &self,
        chat: Option<&str>,
        req: serde_json::Value,
    ) -> Result<Handed, String> {
        let mut payload = req;
        payload["chat"] = serde_json::json!(chat);
        let wait = if payload.get("project").is_some_and(|p| !p.is_null()) {
            NEW_CHAT_WAIT
        } else {
            SEND_WAIT
        };
        self.hand(payload, wait).await
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

/// The switch as last set, on disk, so a relaunch brings the listener back
/// (his ask, 2026-09-18: "make sure the phone section is still on" after
/// the update installs — until now the listener lived only in memory and
/// every relaunch left the phone unable to connect, backlog 154's likely
/// cause). `~/.nightloom/remote.json`.
#[derive(Debug, Clone, Default, Serialize, serde::Deserialize)]
struct Persisted {
    on: bool,
    port: u16,
    keep_awake: bool,
}

fn persisted_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty())?;
    Some(
        std::path::PathBuf::from(home)
            .join(nightloom_service::project::DOT_DIR)
            .join("remote.json"),
    )
}

fn read_persisted() -> Persisted {
    persisted_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_persisted(p: &Persisted) {
    let Some(path) = persisted_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(t) = serde_json::to_string_pretty(p) {
        let _ = std::fs::write(path, t);
    }
}

impl Remote {
    /// Build the host, attach the relay, and manage the state. Called once
    /// from `setup`, after `AppState` is managed. Then, off the setup
    /// thread, the listener comes back up if the switch was on when the
    /// app last ran; a failure (no Tailscale yet, the port taken) is
    /// logged and the card shows the listener off, as before.
    pub fn install(app: &AppHandle) {
        let host = DesktopHost::new(app.clone());
        host.attach();
        let saved = read_persisted();
        app.manage(Remote {
            host,
            server: tokio::sync::Mutex::new(None),
            port: Mutex::new(if saved.port > 0 {
                saved.port
            } else {
                DEFAULT_PORT
            }),
            keep_awake: Mutex::new(saved.keep_awake),
            awake: Mutex::new(None),
        });
        if saved.on {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let remote = app.state::<Remote>();
                match start_listener(&app, &remote, None).await {
                    Ok(st) => eprintln!("remote: listener back up at {:?}", st.address),
                    Err(e) => eprintln!("remote: could not bring the listener back: {e}"),
                }
            });
        }
    }

    fn persist(&self, on: bool) {
        write_persisted(&Persisted {
            on,
            port: self.port(),
            keep_awake: self.keep_awake(),
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

/// The window's answer to any other call (item 246, wave 1: `remote-act`,
/// `remote-rail`, `remote-context`, …) — `remote_sent`'s general form.
/// `ok` with `json` the reply (absent is `null`); not `ok` with `json`
/// the sentence the phone is shown.
#[tauri::command]
pub fn remote_done(remote: State<'_, Remote>, id: u64, ok: bool, json: Option<serde_json::Value>) {
    remote.host.finish(id, done_outcome(ok, json));
}

fn done_outcome(ok: bool, json: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
    if ok {
        return Ok(json.unwrap_or(serde_json::Value::Null));
    }
    Err(match json {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => s,
        _ => "the desktop did not do it".to_string(),
    })
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
    let st = start_listener(&app, &remote, port).await?;
    remote.persist(true);
    Ok(st)
}

/// The start itself, shared by the command and the relaunch.
async fn start_listener(
    app: &AppHandle,
    remote: &Remote,
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
    let bound = rebind(remote, IpAddr::V4(ip), port, token).await?;
    remote.apply_awake(app, remote.keep_awake());
    status(remote, Some(bound)).await
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
    remote.persist(false);
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
    remote.persist(bound.is_some());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_done_answer_is_the_reply_or_the_windows_sentence() {
        let reply = serde_json::json!({ "chat": "c2", "events": [] });
        assert_eq!(done_outcome(true, Some(reply.clone())), Ok(reply));
        assert_eq!(done_outcome(true, None), Ok(serde_json::Value::Null));
        assert_eq!(
            done_outcome(
                false,
                Some(serde_json::json!("that chat is running a turn"))
            ),
            Err("that chat is running a turn".to_string())
        );
        // A refusal with no words still reads as one, never as success.
        assert_eq!(
            done_outcome(false, None),
            Err("the desktop did not do it".to_string())
        );
        assert_eq!(
            done_outcome(false, Some(serde_json::json!(""))),
            Err("the desktop did not do it".to_string())
        );
    }

    #[test]
    fn a_deleted_note_is_kept_under_the_trash_by_scope_and_name() {
        let Some(path) = note_trash("project", "/plans/today.md") else {
            return; // no HOME in this environment
        };
        let s = path.to_string_lossy();
        assert!(s.contains("/.nightloom/trash/notes/"), "{s}");
        assert!(s.ends_with("/project/plans/today.md"), "{s}");
    }

    #[test]
    fn an_aside_delta_goes_to_the_phone_as_an_aside_event() {
        let out = aside_delta_event(r#"{"seq":4,"text":"hel"}"#).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "kind": "delta", "seq": 4, "text": "hel" })
        );
        assert!(aside_delta_event("[1]").is_none());
        assert!(aside_delta_event(r#"{"text":"x"}"#).is_none());
        assert!(RELAYED.contains(&"aside-event"));
    }

    #[test]
    fn features_name_every_route_this_host_serves() {
        for f in [
            "act", "rail", "running", "usage", "notes", "images", "aside",
        ] {
            assert!(FEATURES.contains(&f), "{f}");
        }
    }
}
