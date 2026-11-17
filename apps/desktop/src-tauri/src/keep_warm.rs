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
use nightloom_service::cache_miss;
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
    /// The registry with his Settings default read from the config
    /// directory (item 608: on with no file).
    pub fn load() -> Self {
        let h = Self::default();
        h.0.set_default(keep_warm::load_default(
            nightloom_service::project::config_dir().as_deref(),
        ));
        h
    }

    /// The chat was deleted or moved: its keep-warm run ends (the switch
    /// stays as he set it; item 608).
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

/// One ping's read and spend as the window hears it (item 699,
/// `keep-warm-ping`): the cache-miss toast's facts. `context` is what the
/// ping was meant to read (the reply's input plus output, as the ping's
/// line in `keep-warm.jsonl` records it).
#[derive(serde::Serialize, Clone)]
struct PingHeard {
    chat: String,
    sent_ms: i64,
    context: u64,
    cache_read: u64,
    cache_write: u64,
    cost_usd: Option<f64>,
    plan_est: Option<nightloom_service::turn_usage::Estimate>,
    model: Option<String>,
}

/// Tick for the life of the app.
/// Whether any chat has a keep-warm ping scheduled or running (blocker
/// 1799, his "yeah"): `wake::watch` keeps the Mac awake while it is, as it
/// does for a scheduled send, under the same Settings switch.
pub fn warming(app: &AppHandle) -> bool {
    let Some(holder) = app.try_state::<Holder>() else {
        return false;
    };
    let p = policy();
    let now = now_ms();
    holder
        .0
        .on()
        .iter()
        .any(|chat| holder.0.status(chat, None, &p, now).scheduled)
}

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
            // Item 727: the ping's prefix print, for the cache-miss check.
            if let Some(fork) = job.spec.keep_warm_ping() {
                cache_miss::record_print_quiet(&job.dir, cache_miss::Kind::Ping, sent, &fork);
            }
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
            // Item 699: what the ping read and spent, for the window's
            // cache-miss toast — not for a ping his send cancelled, which
            // leaves no trace, nor one that failed.
            if !job.cancel.is_cancelled()
                && let Ok(r) = &result
                && r.error.is_none()
            {
                let _ = app.emit(
                    "keep-warm-ping",
                    PingHeard {
                        chat: job.chat.clone(),
                        sent_ms: sent,
                        context: job.context,
                        cache_read: r.cache_read,
                        cache_write: r.cache_write,
                        cost_usd: r.cost_usd,
                        plan_est: nightloom_service::turn_usage::estimate_cost(r.cost_usd),
                        model: r.model.clone(),
                    },
                );
                // Item 727: an unexplained miss goes to cache-miss.jsonl,
                // off this task (it reads the parent's session file).
                let req = cache_miss::Request {
                    kind: cache_miss::Kind::Ping,
                    chat: job.chat.clone(),
                    project: cache_miss::project_of(&job.dir),
                    at_ms: sent,
                    read: r.cache_read,
                    context: job.context,
                    last_ms: Some(job.last_ms),
                    one_hour: job.one_hour,
                    cost_usd: r.cost_usd,
                    chosen: None,
                    cli_file: cache_miss::cli_file(&job.spec.workspace, job.spec.resume.as_deref()),
                    ask_dir: Some(job.dir.clone()),
                };
                crate::commands::cli::check_request(&app, req);
            }
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

/// An aside in `chat` read the cache (item 677): sent at `sent_ms`, its
/// newest round read `cache_read` tokens. When that refreshed the held
/// reply's cache the schedule counts from it, and the window is told.
pub fn aside_read(app: &AppHandle, chat: &str, sent_ms: i64, cache_read: u64) {
    let Some(holder) = app.try_state::<Holder>() else {
        return;
    };
    if holder.0.aside_read(chat, sent_ms, cache_read) {
        emit(app, &holder.0.status(chat, None, &policy(), now_ms()));
    }
}

/// Item 728: chat `chat` was handed off — a next chat now continues it.
/// The first time only, its keep-warm switches off (a scheduled ping is
/// cancelled) and the chip says why; a later hand-off of the same chat,
/// after he switched it back on, does nothing. `dir` is [`ask_dir`]'s.
pub fn handed_off(app: &AppHandle, chat: &str, dir: &Path) {
    let Some(holder) = app.try_state::<Holder>() else {
        return;
    };
    let now = now_ms();
    if holder.0.handed_off(chat, dir, now) {
        emit(app, &holder.0.status(chat, Some(dir), &policy(), now));
    }
}

/// A chat's keep-warm folder, as [`held_chat`] finds it: `ask/<id>`
/// beside the chat's log, else under `log_dir`.
pub fn ask_dir(session: &Session, log_dir: &Path) -> std::path::PathBuf {
    session
        .log_path()
        .and_then(|p| p.parent())
        .unwrap_or(log_dir)
        .join("ask")
        .join(&session.id)
}

/// Item 787: `chat`'s cache has gone cold — the hour its newest reply (or
/// a ping, or an aside's read since) bought is over, or nothing is known
/// of it. The registry's reading first; for a chat it holds nothing of,
/// the open log's newest reply.
pub fn cold(app: &AppHandle, chat: &str, session: Option<&Session>) -> bool {
    let now = now_ms();
    let policy = policy();
    let held = app
        .try_state::<Holder>()
        .and_then(|h| h.0.status(chat, None, &policy, now).warm_until_ms);
    let until = held.or_else(|| {
        session
            .and_then(keep_warm::reply_of)
            .map(|r| keep_warm::warm_until(&r, None, false, &policy))
    });
    until.is_none_or(|t| t <= now)
}

/// Now, unix ms — for a caller outside this file (an aside's send).
pub fn now() -> i64 {
    now_ms()
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
    let (full, dir, facts) = held_chat(&state, &chat).await?;
    let now = now_ms();
    holder.0.set_mode(&full, &dir, mode, facts, now);
    let status = holder.0.status(&full, Some(&dir), &policy(), now);
    emit(&app, &status);
    Ok(status)
}

/// Hold a chat warm longer (item 643): `hours` 12 or 24 caps its
/// keep-warm at that many hours after each reply until a whole hold
/// passes without one; 6 (or anything else) puts it back on the default
/// cap. A chat whose switch reads off is switched on.
#[tauri::command]
pub async fn keep_warm_hold(
    app: AppHandle,
    state: State<'_, AppState>,
    holder: State<'_, Holder>,
    chat: String,
    hours: u32,
) -> Result<Status, String> {
    let (full, dir, facts) = held_chat(&state, &chat).await?;
    let now = now_ms();
    holder.0.set_hold(&full, &dir, hours, facts, now);
    let status = holder.0.status(&full, Some(&dir), &policy(), now);
    emit(&app, &status);
    Ok(status)
}

/// [`held_chat`]'s answer: the full id, the folder, the facts.
type HeldChat = (
    String,
    std::path::PathBuf,
    Option<(AgentSpec, keep_warm::Reply)>,
);

/// A held chat's full id, its keep-warm folder, and — when its log is
/// free and its agent known — the facts that start a schedule now.
async fn held_chat(state: &AppState, chat: &str) -> Result<HeldChat, String> {
    let (full, log) = state
        .chats
        .find(chat)
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
    Ok((full, dir, facts))
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
            let dir = s
                .log_path()
                .and_then(|p| p.parent())
                .map(|d| d.join("ask").join(&full))?;
            // Item 608: a chat on by default (or by him) that this run
            // holds no reply for — shown after a restart, or its tab
            // reopened — starts from its last reply now, as a switch-on
            // would; `step`'s guards (1-hour, 50k, cap, cold) still decide.
            if !state.agents.busy(&full) && holder.0.wants_facts(&full, &dir) {
                let focused = state.chats.focus().as_deref() == Some(full.as_str());
                if let (Some(mut spec), Some(reply), Some(resume)) = (
                    state.agents.spec_of(&full, focused),
                    keep_warm::reply_of(&s),
                    crate::resume_of(&s),
                ) {
                    spec.resume = Some(resume);
                    holder.0.offer(&full, &dir, &spec, reply);
                }
            }
            Some(dir)
        }),
        None => None,
    };
    let dir = match dir {
        Some(d) => d,
        None => state.log_dir().await.join("ask").join(&chat),
    };
    Ok(holder.0.status(&chat, Some(&dir), &policy(), now_ms()))
}

/// His Settings default, "Keep chats' caches warm automatically" (item
/// 608): on with no file.
#[tauri::command]
pub fn keep_warm_default(holder: State<'_, Holder>) -> bool {
    holder.0.default_on()
}

/// Set his Settings default; every held chat's status is sent again, so
/// a switch that follows the default reads right at once.
#[tauri::command]
pub fn keep_warm_set_default(
    app: AppHandle,
    holder: State<'_, Holder>,
    on: bool,
) -> Result<bool, String> {
    let dir = nightloom_service::project::config_dir()
        .ok_or_else(|| "no config directory to keep the setting in".to_string())?;
    keep_warm::save_default(&dir, on)?;
    holder.0.set_default(on);
    for chat in holder.0.known() {
        tell(&app, &holder, &chat);
    }
    Ok(on)
}

/// The chat's tab was closed: its keep-warm run ends; the switch stays as
/// he set it (item 608), "until I'm back" excepted.
#[tauri::command]
pub fn keep_warm_stop(app: AppHandle, holder: State<'_, Holder>, chat: String) -> bool {
    let was_on = holder.stop(&chat);
    if was_on {
        tell(&app, &holder, &chat);
    }
    was_on
}
