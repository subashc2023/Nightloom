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
use nightloom_service::store;
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
    maybe_score(app);
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

/// What a restored chat's log gives keep-warm (item 972), owned so no lock
/// is held while the agent is looked for.
struct RestoredFacts {
    full: String,
    dir: std::path::PathBuf,
    reply: keep_warm::Reply,
    resume: String,
    model: Option<String>,
}

fn restored_facts(session: &Session) -> Option<RestoredFacts> {
    let full = session.id.clone();
    let dir = session
        .log_path()
        .and_then(|p| p.parent())
        .map(|d| d.join("ask").join(&full))?;
    Some(RestoredFacts {
        reply: keep_warm::reply_of(session)?,
        resume: crate::resume_of(session)?,
        model: keep_warm::reply_model(session),
        full,
        dir,
    })
}

/// Item 972: at launch the window offers every restored tab's chat to
/// keep-warm from its last reply, not only the shown one (which
/// `keep_warm_status` takes): a chat in a background tab had no run after a
/// restart and was never pinged. Each chat's log is read from the open
/// project's folder (nothing is held or locked); its agent is its own idle
/// one, else the rail's newest spec when that runs in the project's folder,
/// on the model the chat's last reply ran on; the same gates as a shown chat
/// decide (`Registry::offer`, then `step`). Returns how many chats are still
/// waiting for the rail to connect — the window asks again shortly.
#[tauri::command]
pub async fn keep_warm_offer_restored(
    app: AppHandle,
    state: State<'_, AppState>,
    holder: State<'_, Holder>,
    chats: Vec<String>,
) -> Result<usize, String> {
    let project = state.active().await;
    let workspace = project.as_ref().map(|p| p.workspace_dir());
    let log_dir = state.log_dir().await;
    let focus = state.chats.focus();
    let mut waiting = 0;
    let mut offers = Vec::new();
    for chat in chats.iter().filter(|c| chat_id_ok(c)) {
        let facts = match state.chats.find(chat) {
            // Held (shown, or running): read only if its log is free.
            Some((_, log)) => log.try_lock().ok().and_then(|s| restored_facts(&s)),
            None => {
                let (dir, id) = (log_dir.clone(), chat.clone());
                crate::blocking(move || {
                    let path = store::find_by_prefix(&dir, &id).map_err(|e| e.to_string())?;
                    Session::load(path).map_err(|e| e.to_string())
                })
                .await
                .ok()
                .and_then(|s| restored_facts(&s))
            }
        };
        let Some(f) = facts else { continue };
        if state.agents.busy(&f.full) || !holder.0.wants_facts(&f.full, &f.dir) {
            continue;
        }
        let own = state
            .agents
            .spec_of(&f.full, focus.as_deref() == Some(f.full.as_str()));
        let spec = own.or_else(|| {
            state
                .agents
                .rail_spec(workspace.as_deref())
                .map(|mut spec| {
                    // The ping runs on the model that wrote the reply's cache.
                    if f.model.is_some() {
                        spec.model = f.model.clone();
                    }
                    spec
                })
        });
        let Some(mut spec) = spec else {
            waiting += 1;
            continue;
        };
        spec.resume = Some(f.resume);
        offers.push((f.full, f.dir, spec, f.reply));
    }
    let took = holder.0.offer_restored(offers);
    let (policy, now) = (policy(), now_ms());
    for chat in &took {
        emit(&app, &holder.0.status(chat, None, &policy, now));
    }
    Ok(waiting)
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

/// Item 913 (blocker 2282): Stop from Settings' "Chats kept warm now" —
/// the run ends now and the chat stays stopped until its next send or
/// reply, even when he opens it ([`Registry::stop_until_next`]); the
/// switch stays as he set it. The window is told the new status.
#[tauri::command]
pub fn keep_warm_stop_until_next(app: AppHandle, holder: State<'_, Holder>, chat: String) -> bool {
    let was_on = holder.0.stop_until_next(&chat, now_ms());
    tell(&app, &holder, &chat);
    was_on
}

/// Item 913: every chat this run holds a keep-warm entry for, with its
/// status — the list Settings shows ("Chats kept warm now"), each row's
/// Extend and Stop going through `keep_warm_hold` and `keep_warm_stop`.
/// The window keeps only the rows that are keeping now.
#[tauri::command]
pub fn keep_warm_list(holder: State<'_, Holder>) -> Vec<Status> {
    let policy = policy();
    let now = now_ms();
    holder
        .0
        .known()
        .iter()
        .map(|chat| holder.0.status(chat, None, &policy, now))
        .collect()
}

// ---------- item 878: the hold rule's scoreboard ----------

use nightloom_service::hold_policy::{self, Sleep, sim};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

/// A scoreboard run is going (one at a time).
static SCORING: AtomicBool = AtomicBool::new(false);
/// When this run of the app first ticked, unix ms (the first score waits
/// [`SCORE_AFTER_START_MS`], so the start is never slowed by it).
static STARTED_MS: AtomicI64 = AtomicI64::new(0);
const SCORE_AFTER_START_MS: i64 = 2 * 60_000;
/// The scoreboard re-runs once its table is this old: daily.
const SCORE_EVERY_MS: i64 = 24 * 3_600_000;

/// Run the scoreboard when the last one is a day old (item 878's "no-model
/// background job, daily"), on a blocking thread.
fn maybe_score(app: &AppHandle) {
    let now = now_ms();
    let started = STARTED_MS.load(Ordering::Relaxed);
    if started == 0 {
        STARTED_MS.store(now, Ordering::Relaxed);
        return;
    }
    if now - started < SCORE_AFTER_START_MS || SCORING.load(Ordering::Relaxed) {
        return;
    }
    let config = nightloom_service::project::config_dir();
    let last = hold_policy::read_scoreboard(config.as_deref()).map(|b| b.computed_ms);
    if last.is_some_and(|t| now - t < SCORE_EVERY_MS && t <= now) {
        return;
    }
    rescore(app.clone());
}

/// Run the scoreboard now; tells the window when it is done, and of a new
/// overtake (the notice; never a switch — his "we can make that change tgt").
fn rescore(app: AppHandle) -> bool {
    if SCORING.swap(true, Ordering::SeqCst) {
        return false;
    }
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(|| {
            let config = nightloom_service::project::config_dir().ok_or("no config folder")?;
            let claude = nightloom_service::agent::cli_session::projects_dir()
                .ok_or("no Claude Code folder")?;
            hold_policy::score_now(&config, &claude, now_ms())
        })
        .await;
        SCORING.store(false, Ordering::SeqCst);
        match result {
            Ok(Ok(board)) => {
                crate::wake::log(
                    "keep-warm",
                    &format!(
                        "hold scoreboard: {} moments, {} weeks, leader {}, active {}",
                        board.moments,
                        board.weeks.len(),
                        board.leader,
                        board.active
                    ),
                );
                if board.overtake_new
                    && let Some(o) = &board.overtake
                {
                    let _ = app.emit("keep-warm-overtake", o);
                }
                let _ = app.emit("keep-warm-board", ());
                retell_all(&app);
            }
            Ok(Err(e)) => crate::wake::log("keep-warm", &format!("hold scoreboard failed: {e}")),
            Err(e) => crate::wake::log("keep-warm", &format!("hold scoreboard failed: {e}")),
        }
    });
    true
}

/// Every chat's status again: the rule (or his sleep) changed.
fn retell_all(app: &AppHandle) {
    let Some(holder) = app.try_state::<Holder>() else {
        return;
    };
    let p = policy();
    let now = now_ms();
    for chat in holder.0.known() {
        emit(app, &holder.0.status(&chat, None, &p, now));
    }
}

/// What Settings → keep warm shows of the hold rule.
#[derive(serde::Serialize)]
pub struct BoardView {
    /// The rule in force and its words.
    pub active: String,
    pub active_name: String,
    /// His sleep in force, and whether he set it himself.
    pub sleep: Sleep,
    pub sleep_manual: bool,
    /// The learned one (shown beside his own when he set one).
    pub learned_sleep: Option<Sleep>,
    /// The cap the rule runs under, ms.
    pub cap_ms: i64,
    /// The last scoreboard, if one ran.
    pub board: Option<sim::Scoreboard>,
    pub scoring: bool,
}

fn board_view() -> BoardView {
    let config = nightloom_service::project::config_dir();
    let board = hold_policy::read_scoreboard(config.as_deref());
    let (sleep, manual) = hold_policy::sleep_in_force(config.as_deref(), board.as_ref());
    let p = policy();
    BoardView {
        active: p.rule_id.to_string(),
        active_name: sim::name_of(p.rule_id),
        sleep,
        sleep_manual: manual,
        learned_sleep: board.as_ref().map(|b| b.learned_sleep),
        cap_ms: p.cap_ms,
        board,
        scoring: SCORING.load(Ordering::Relaxed),
    }
}

#[tauri::command]
pub fn keep_warm_board() -> BoardView {
    board_view()
}

/// His click: switch the hold rule (never done for him).
#[tauri::command]
pub fn keep_warm_set_rule(app: AppHandle, id: String) -> Result<BoardView, String> {
    let config = nightloom_service::project::config_dir().ok_or("no config folder")?;
    hold_policy::set_active(&config, &id, now_ms())?;
    retell_all(&app);
    Ok(board_view())
}

/// His sleep by hand (`start`/`end` local hours), or back to the learned
/// one with neither.
#[tauri::command]
pub fn keep_warm_set_sleep(
    app: AppHandle,
    start: Option<u8>,
    end: Option<u8>,
) -> Result<BoardView, String> {
    let config = nightloom_service::project::config_dir().ok_or("no config folder")?;
    let sleep = match (start, end) {
        (Some(start), Some(end)) => Some(Sleep { start, end }),
        _ => None,
    };
    hold_policy::set_manual_sleep(&config, sleep)?;
    retell_all(&app);
    Ok(board_view())
}

/// Re-run the scoreboard now (Settings' "Re-score now"); false while one runs.
#[tauri::command]
pub fn keep_warm_rescore(app: AppHandle) -> bool {
    rescore(app)
}
