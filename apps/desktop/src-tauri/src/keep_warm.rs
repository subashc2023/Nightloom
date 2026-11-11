//! The keep-warm clock (nightshift backlog 582): the shell's half of
//! `nightloom_service::keep_warm`, which has the policy and the why.
//!
//! The service holds each chat's switch and schedule; this module ticks
//! it ([`watch`], every [`TICK`]), says which chats are busy (their own
//! agent is locked — a turn or an aside runs), runs the pings that are
//! due, and tells the window (`keep-warm`, a [`Status`]) whenever a
//! chat's keep-warm changed. `send_agent` calls [`sent`] as his message
//! goes out and [`replied`] when its reply has landed; `delete_session`
//! and a move to another project call [`Holder::stop`].
//!
//! A ping takes no lock of the chat's: it is a second CLI process on the
//! chat's session, as an aside or a council seat is, and his send cancels
//! it rather than wait behind it.

use crate::AppState;
use nightloom_core::Session;
use nightloom_service::agent::AgentSpec;
use nightloom_service::keep_warm::{self, Mode, Policy, Registry, Status};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// How often the schedule is looked at.
const TICK: Duration = Duration::from_secs(10);

/// The process's keep-warm registry, managed by the app.
#[derive(Default, Clone)]
pub struct Holder(pub Arc<Registry>);

impl Holder {
    /// The chat was deleted or moved: its keep-warm ends, switch off.
    pub fn stop(&self, chat: &str) -> bool {
        self.0.stop(chat, now_ms())
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn policy() -> Policy {
    Policy::load(nightloom_service::project::config_dir().as_deref())
}

fn emit(app: &AppHandle, status: &Status) {
    let _ = app.emit("keep-warm", status);
}

fn tell(app: &AppHandle, holder: &Holder, chat: &str) {
    emit(app, &holder.0.status(chat, None, &policy(), now_ms()));
}

/// Tick for the life of the app.
pub fn watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(TICK).await;
            tick(&app);
        }
    });
}

fn tick(app: &AppHandle) {
    let (Some(holder), Some(state)) = (app.try_state::<Holder>(), app.try_state::<AppState>())
    else {
        return;
    };
    if holder.0.on().is_empty() {
        return;
    }
    let p = policy();
    let jobs = holder.0.due(&p, now_ms(), |chat| state.agents.busy(chat));
    for job in jobs {
        let app = app.clone();
        let holder = holder.inner().clone();
        tauri::async_runtime::spawn(async move {
            let sent = now_ms();
            emit(&app, &holder.0.status(&job.chat, None, &policy(), sent));
            let result = keep_warm::ping(&job.spec, &job.cancel).await;
            crate::wake::log(
                "keep-warm",
                &match &result {
                    Ok(r) => format!(
                        "chat {} ping: context {} read {} wrote {} out {}{}",
                        job.chat,
                        job.context,
                        r.cache_read,
                        r.cache_write,
                        r.output,
                        r.error
                            .as_ref()
                            .map(|e| format!(" error: {e}"))
                            .unwrap_or_default()
                    ),
                    Err(e) => format!("chat {} ping failed: {e}", job.chat),
                },
            );
            holder.0.done(&job, sent, result);
            tell(&app, &holder, &job.chat);
        });
    }
}

/// His message is going out in `chat`: a ping in flight stops, and "until
/// I'm back" has been answered.
pub fn sent(app: &AppHandle, chat: &str, dir: Option<&Path>) {
    let Some(holder) = app.try_state::<Holder>() else {
        return;
    };
    holder.0.sent(chat, dir, now_ms());
    if dir.is_some() {
        emit(app, &holder.0.status(chat, dir, &policy(), now_ms()));
    }
}

/// The chat's turn ended: the schedule starts from its newest reply, when
/// the chat's switch is on.
pub fn replied(app: &AppHandle, session: &Session, spec: &AgentSpec, dir: Option<&Path>) {
    let (Some(holder), Some(dir)) = (app.try_state::<Holder>(), dir) else {
        return;
    };
    let mut spec = spec.clone();
    if let Some(resume) = crate::resume_of(session) {
        spec.resume = Some(resume);
    }
    holder
        .0
        .replied(&session.id, dir, &spec, keep_warm::reply_of(session));
    emit(
        app,
        &holder.0.status(&session.id, Some(dir), &policy(), now_ms()),
    );
}

fn chat_id_ok(chat: &str) -> bool {
    !chat.is_empty() && chat.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Set a held chat's switch: `off`, `on` (after every reply), or `once`
/// ("until I'm back": on until his next message). With the chat's last
/// reply and agent on hand the schedule starts now; while its turn runs
/// it starts when the reply lands.
#[tauri::command]
pub async fn keep_warm_set(
    app: AppHandle,
    state: State<'_, AppState>,
    holder: State<'_, Holder>,
    chat: String,
    mode: Mode,
) -> Result<Status, String> {
    let (full, log) = state
        .chats
        .find(&chat)
        .ok_or_else(|| "open the chat to switch its keep-warm".to_string())?;
    let focused = state.chats.focus().as_deref() == Some(full.as_str());
    let fallback = state.log_dir().await.join("ask").join(&full);
    let (dir, facts) = match log.try_lock() {
        Ok(session) => {
            let dir = session
                .log_path()
                .and_then(|p| p.parent())
                .map(|d| d.join("ask").join(&full))
                .unwrap_or(fallback);
            let facts = match (
                state.agents.spec_of(&full, focused),
                keep_warm::reply_of(&session),
                crate::resume_of(&session),
            ) {
                (Some(mut spec), Some(reply), Some(resume)) => {
                    spec.resume = Some(resume);
                    Some((spec, reply))
                }
                _ => None,
            };
            (dir, facts)
        }
        // Its turn is running: `replied` brings the facts.
        Err(_) => (fallback, None),
    };
    let now = now_ms();
    holder.0.set_mode(&full, &dir, mode, facts, now);
    let status = holder.0.status(&full, Some(&dir), &policy(), now);
    emit(&app, &status);
    Ok(status)
}

/// A chat's keep-warm, for the window: the switch, when the cache goes
/// cold if the schedule runs, and what its pings have spent.
#[tauri::command]
pub async fn keep_warm_status(
    state: State<'_, AppState>,
    holder: State<'_, Holder>,
    chat: String,
) -> Result<Status, String> {
    if !chat_id_ok(&chat) {
        return Err("not a chat id".into());
    }
    let dir = match state.chats.find(&chat) {
        Some((full, log)) => log.try_lock().ok().and_then(|s| {
            s.log_path()
                .and_then(|p| p.parent())
                .map(|d| d.join("ask").join(&full))
        }),
        None => None,
    };
    let dir = match dir {
        Some(d) => d,
        None => state.log_dir().await.join("ask").join(&chat),
    };
    Ok(holder.0.status(&chat, Some(&dir), &policy(), now_ms()))
}

/// The chat's tab was closed: its keep-warm ends and the switch goes off.
#[tauri::command]
pub fn keep_warm_stop(app: AppHandle, holder: State<'_, Holder>, chat: String) -> bool {
    let was_on = holder.stop(&chat);
    if was_on {
        tell(&app, &holder, &chat);
    }
    was_on
}
