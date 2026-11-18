//! Home's routing (nightshift item 763, build item H5): he says a thing
//! once to Home and Home puts it in the project chat that owns it.
//!
//! - **Three tools, served to Home's chats only** ([`tools`], on Nightloom's
//!   own MCP server): [`START_TOOL`] `(project, prompt, may_write)`,
//!   [`SEND_TOOL`] `(chat, text)`, [`STATUS_TOOL`]. They are the three item
//!   767 names for outside callers; here they are the in-app half. A tool
//!   **never starts anything itself**: the server is a process of its own
//!   with no agent to run. It plans the route and appends it to the ledger;
//!   the app's clock ([`tick`], beside the jobs' clock) does the starting.
//! - **The ledger**, `<home>/routes.jsonl`: append-only, one whole
//!   [`Route`] per line, the newest line for an id being what it is now.
//!   Nothing is rewritten or erased.
//! - **Who may start what (blocker 2039's default, fork 5 option 2).** A
//!   read-only start is [`State::Queued`] and runs alone, in a chat held
//!   to the Chat policy as a job's is. Anything that may write — a new
//!   write-capable chat, or a message into a chat that may write — is
//!   [`State::Waiting`]: a Start card showing the prompt, editable, that
//!   begins only on his tap ([`confirm`]). Nothing in this module moves a
//!   `Waiting` route but [`confirm`] and [`dismiss`], and both are called
//!   only by his buttons.
//! - **Cold chats.** A message is never sent into a chat over
//!   [`COLD_TOKENS`] whose cache is cold (item 768's size; a cold 300k
//!   re-write is ≈ $2.40): the route waits as a card with the two costs,
//!   and he picks — a new chat in that project, or into it anyway.
//! - **Hand-off chains.** A chat that was handed off is not the place to
//!   write: the route follows the chain to its newest chat (items 702 and
//!   747) and says so.
//! - **Results.** The app records the start and the end as feed rows
//!   ([`super::FeedRow`], kinds `route_started`, `route_done`,
//!   `route_failed`) — in code, no model call. Home's turn ended long
//!   before; it reads the feed, or asks [`STATUS_TOOL`], next time.
//! - **The gate (the review, 2026-11-18).** The ledger is only a claim:
//!   his taps are kept apart ([`taps`]), as the exact thing he saw. At
//!   every start [`clear`] reads what the route is now — its project, its
//!   chat's kind and cache — and a route that may write, or goes into a
//!   cold big chat, runs only when his tap was for exactly that. A send
//!   is handed to the host at most once, a quit in the middle included.
//! - **Nights.** Nothing is routed into a project while a night run is
//!   going in it ([`night_now`]), read-only included: it waits, says so,
//!   and starts when the night ends.
//! - **"Started by Home".** [`started_by_home`] is every chat a route
//!   began; the lists mark those rows.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use nightloom_core::{ChatKind, ChatMode, Session, ToolDef};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::project::{PROJECTS_DIR, Project, Registry, SESSIONS_DIR};
use crate::remote::{Handed, Host};
use crate::store::{self, SessionSummary};

pub mod taps;

pub const START_TOOL: &str = "start_chat";
pub const SEND_TOOL: &str = "send_chat";
pub const STATUS_TOOL: &str = "chat_status";

/// The ledger's file, in Home's folder.
pub const FILE: &str = "routes.jsonl";
/// A chat at or over this context is "big" (item 768's default size).
pub const COLD_TOKENS: u64 = 150_000;
/// What a fresh chat's first request writes, for the card's second cost
/// (763's design §6: a fresh chat is ≈ 32k).
const FRESH_TOKENS: u64 = 32_000;
/// A started route is not looked for in the running list before this.
const RUN_GRACE_SECS: i64 = 20;
/// A route still running after this is recorded as not finished.
const RUN_MAX_SECS: i64 = 6 * 3600;
/// A queued route that cannot start is given up after this.
const QUEUE_MAX_SECS: i64 = 24 * 3600;
/// The most of a reply a row keeps.
const SUMMARY_MAX: usize = 240;
/// The longest prompt a route takes.
pub const PROMPT_MAX: usize = 20_000;
/// The Start card's push says only this (states, never Home's words).
pub const CARD_PUSH: &str = "Has a start waiting for your tap";
/// How a queued route that cannot start yet begins its note.
const WAITING: &str = "waiting — ";
/// A night log older than this is a night that ended without saying so.
const NIGHT_MAX_SECS: u64 = 12 * 3600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// A new chat in a project.
    Start,
    /// A message into a chat that exists.
    Send,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// A Start card: begins only on his tap.
    Waiting,
    /// Runs at the clock's next look (read-only, or he tapped).
    Queued,
    Started,
    Finished,
    Failed,
    /// He dismissed the card. Nothing was started.
    Dismissed,
}

/// Why a route waits for him.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Hold {
    /// The chat may edit files or run commands.
    Write,
    /// The target is a big chat whose cache is cold.
    Cold,
}

/// His pick on a cold card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Pick {
    /// A new chat in the target's project.
    New,
    /// Into the cold chat anyway.
    Into,
}

/// What a cold card shows (item 768's two costs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cold {
    /// The chat's context at its newest reply.
    pub tokens: u64,
    /// What sending into it re-writes, in API dollars; `None` without a
    /// rate for its model.
    #[serde(default)]
    pub into_usd: Option<f64>,
    /// What a new chat's first request writes instead.
    #[serde(default)]
    pub new_usd: Option<f64>,
}

/// One route, as its newest ledger line says it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Route {
    pub id: String,
    /// When Home asked.
    pub at: DateTime<Utc>,
    pub kind: Kind,
    /// The target project's id; `None` is the unfiled chats.
    #[serde(default)]
    pub project: Option<String>,
    pub project_name: String,
    /// The chat written into: the target of a send; the new chat once a
    /// start has made it.
    #[serde(default)]
    pub chat: Option<String>,
    /// The chat's name as the card and the rows say it.
    #[serde(default)]
    pub label: Option<String>,
    /// What is sent — Home's words, or his edit of them on the card.
    pub prompt: String,
    /// The chat may write (edit files, run commands).
    pub write: bool,
    pub state: State,
    #[serde(default)]
    pub hold: Option<Hold>,
    #[serde(default)]
    pub cold: Option<Cold>,
    /// His pick on a cold card.
    #[serde(default)]
    pub pick: Option<Pick>,
    /// One line for him: why it waits, what was followed, what went wrong.
    #[serde(default)]
    pub note: Option<String>,
    /// The Home chat that asked, when the server knew it.
    #[serde(default)]
    pub from: Option<String>,
    /// He tapped Start (or picked): the only way a `Waiting` route moves.
    #[serde(default)]
    pub tapped_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub ended_at: Option<DateTime<Utc>>,
    /// The reply's first lines, once it ended.
    #[serde(default)]
    pub summary: Option<String>,
    /// The card's push went out (or was skipped because he is at the Mac).
    #[serde(default)]
    pub pushed: bool,
}

impl Route {
    /// "read-only" or "may write", as every surface says it.
    pub fn may(&self) -> &'static str {
        if self.write { "may write" } else { "read-only" }
    }

    /// Where it goes, in words: "a new chat in Nightloom" / "“778 fix” in
    /// Nightshift".
    pub fn place(&self) -> String {
        match (self.kind, &self.label) {
            (Kind::Send, Some(label)) => format!("“{label}” in {}", self.project_name),
            (Kind::Send, None) => format!("a chat in {}", self.project_name),
            (Kind::Start, _) => format!("a new chat in {}", self.project_name),
        }
    }
}

// ---- the ledger ----------------------------------------------------------

static WRITER: std::sync::Mutex<u64> = std::sync::Mutex::new(0);

pub fn path_in(config: &Path) -> PathBuf {
    super::dir_in(config).join(FILE)
}

fn new_id(now: DateTime<Utc>) -> String {
    let mut n = WRITER.lock().unwrap_or_else(|p| p.into_inner());
    *n += 1;
    format!(
        "r{}-{}-{}",
        now.timestamp_millis(),
        std::process::id() % 100_000,
        *n
    )
}

/// Append `route` as the newest line for its id.
pub fn record(config: &Path, route: &Route) -> Result<(), String> {
    use std::io::Write;
    let _held = WRITER.lock().unwrap_or_else(|p| p.into_inner());
    let dir = super::dir_in(config);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // One write per line: the MCP server's process appends here too.
    let mut line = serde_json::to_string(route).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(FILE))
        .map_err(|e| format!("Home's route ledger could not be written: {e}"))?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

/// Every route as it is now, oldest first; a damaged line is skipped.
pub fn read(config: &Path) -> Vec<Route> {
    let text = std::fs::read_to_string(path_in(config)).unwrap_or_default();
    let mut order: Vec<String> = Vec::new();
    let mut by_id: BTreeMap<String, Route> = BTreeMap::new();
    for route in text
        .lines()
        .filter_map(|l| serde_json::from_str::<Route>(l).ok())
    {
        if !by_id.contains_key(&route.id) {
            order.push(route.id.clone());
        }
        by_id.insert(route.id.clone(), route);
    }
    order
        .into_iter()
        .filter_map(|id| by_id.remove(&id))
        .collect()
}

pub fn find(config: &Path, id: &str) -> Option<Route> {
    read(config).into_iter().find(|r| r.id == id)
}

/// The Start cards: every route waiting for his tap, oldest first.
pub fn cards(config: &Path) -> Vec<Route> {
    let registry = Registry::load_in(config);
    read(config)
        .into_iter()
        .filter(|r| r.state == State::Waiting)
        .map(|mut r| {
            // Said as it is now, not as it was when Home asked.
            if night_in(&registry, &r) {
                let why = format!(
                    "a night run is going in {} — after your tap it starts when the night ends",
                    r.project_name
                );
                r.note = Some(match r.note.take() {
                    Some(n) => format!("{n}; {why}"),
                    None => why,
                });
            }
            r
        })
        .collect()
}

/// Routes he need not answer that cannot start yet — a project that is
/// not open, a night run going in it — each with why in its `note`.
pub fn held(config: &Path) -> Vec<Route> {
    read(config)
        .into_iter()
        .filter(|r| {
            r.state == State::Queued && r.note.as_deref().is_some_and(|n| n.starts_with(WAITING))
        })
        .collect()
}

/// The chats a route of Home's began (a new chat it started), for the
/// lists' "started by Home" mark.
pub fn started_by_home(config: &Path) -> Vec<String> {
    read(config)
        .into_iter()
        .filter(|r| {
            (r.kind == Kind::Start || r.pick == Some(Pick::New))
                && matches!(r.state, State::Started | State::Finished | State::Failed)
        })
        .filter_map(|r| r.chat)
        .collect()
}

// ---- planning (what a tool call becomes) ---------------------------------

fn sessions_of(config: &Path, project: Option<&Project>) -> PathBuf {
    match project {
        Some(p) => config.join(PROJECTS_DIR).join(&p.id).join(SESSIONS_DIR),
        None => config.join(crate::capture::UNFILED).join(SESSIONS_DIR),
    }
}

fn is_home(p: &Project) -> bool {
    p.source.as_deref() == Some(super::SOURCE)
}

/// The project he named: its id, else its name whatever the case, else
/// the one project whose name starts with or holds the words. `Err` names
/// the projects there are, so Home's next call can be right.
pub fn find_project(registry: &Registry, said: &str) -> Result<Project, String> {
    let all: Vec<Project> = registry
        .projects()
        .into_iter()
        .filter(|p| !p.is_unfiled_holder())
        .collect();
    let want = said.trim().to_lowercase();
    let names = || {
        all.iter()
            .filter(|p| !is_home(p))
            .map(|p| p.name.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    };
    if want.is_empty() {
        return Err(format!("name the project — there are: {}", names()));
    }
    let exact: Vec<&Project> = all
        .iter()
        .filter(|p| p.id == said.trim() || p.name.to_lowercase() == want)
        .collect();
    let found: Vec<&Project> = if !exact.is_empty() {
        exact
    } else {
        let starts: Vec<&Project> = all
            .iter()
            .filter(|p| p.name.to_lowercase().starts_with(&want))
            .collect();
        if !starts.is_empty() {
            starts
        } else {
            all.iter()
                .filter(|p| p.name.to_lowercase().contains(&want))
                .collect()
        }
    };
    match found.as_slice() {
        [one] => Ok((*one).clone()),
        [] => Err(format!(
            "no project named {said:?} — there are: {}",
            names()
        )),
        many => Err(format!(
            "{said:?} could be {} — say which",
            many.iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>()
                .join(" or ")
        )),
    }
}

/// A night run is going in `workspace` (the contract's rule: its night
/// log's first line holds `NIGHT START` and no line holds `NIGHT DONE`),
/// read from the newest `notes/runner-design/night-log-*.md` written in
/// the last twelve hours.
pub fn night_running(workspace: &Path, now: std::time::SystemTime) -> bool {
    let dir = workspace.join("notes").join("runner-design");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return false;
    };
    let newest = entries
        .filter_map(Result::ok)
        .filter(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.starts_with("night-log-") && n.ends_with(".md")
        })
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .max_by_key(|(t, _)| *t);
    let Some((modified, path)) = newest else {
        return false;
    };
    if now
        .duration_since(modified)
        .is_ok_and(|d| d.as_secs() > NIGHT_MAX_SECS)
    {
        return false;
    }
    let text = std::fs::read_to_string(path).unwrap_or_default();
    text.lines()
        .next()
        .is_some_and(|l| l.contains("NIGHT START"))
        && !text.contains("NIGHT DONE")
}

/// A night is going in `workspace` now: its night log says so, or the
/// app's own marker does (a live shift's `state/run.lock`).
pub fn night_now(workspace: &Path) -> bool {
    night_running(workspace, std::time::SystemTime::now())
        || crate::nightshift::launch::is_live(workspace)
}

/// A night is going in `route`'s project.
fn night_in(registry: &Registry, route: &Route) -> bool {
    route
        .project
        .as_deref()
        .and_then(|id| registry.find(id))
        .and_then(|p| p.workspace.as_deref())
        .is_some_and(night_now)
}

fn title_of(s: &SessionSummary) -> String {
    s.label(48)
}

fn cut(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(SUMMARY_MAX).collect();
    if flat.chars().count() > SUMMARY_MAX {
        out.push('…');
    }
    out
}

fn tokens_short(n: u64) -> String {
    format!("{}k", (n + 500) / 1000)
}

fn check_prompt(prompt: &str) -> Result<String, String> {
    let p = prompt.trim();
    if p.is_empty() {
        return Err("the prompt is empty — say what the chat should do".into());
    }
    if p.chars().count() > PROMPT_MAX {
        return Err(format!(
            "the prompt is over {PROMPT_MAX} characters — shorten it, or point the chat at a file"
        ));
    }
    Ok(p.to_string())
}

/// `start_chat`: a new chat in `project`. Read-only is queued; one that
/// may write waits for his tap. Never Home itself.
pub fn plan_start(
    config: &Path,
    project: &str,
    prompt: &str,
    write: bool,
    from: Option<&str>,
    now: DateTime<Utc>,
) -> Result<Route, String> {
    let prompt = check_prompt(prompt)?;
    let registry = Registry::load_in(config);
    let project = find_project(&registry, project)?;
    if is_home(&project) {
        return Err(
            "Home does not start work in itself — name the project the work belongs to".into(),
        );
    }
    Ok(Route {
        id: new_id(now),
        at: now,
        kind: Kind::Start,
        project: Some(project.id.clone()),
        project_name: project.name.clone(),
        chat: None,
        label: None,
        prompt,
        write,
        state: if write { State::Waiting } else { State::Queued },
        hold: write.then_some(Hold::Write),
        cold: None,
        pick: None,
        note: None,
        from: from.map(str::to_string),
        tapped_at: None,
        started_at: None,
        ended_at: None,
        summary: None,
        pushed: false,
    })
}

/// A chat by id or short id, in any project or the unfiled chats.
fn find_chat(
    config: &Path,
    registry: &Registry,
    chat: &str,
) -> Result<(Option<Project>, PathBuf, PathBuf), String> {
    let chat = chat.trim();
    if chat.len() < 6 || !chat.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(format!(
            "{chat:?} is not a chat id — find the chat with search_chats, or {STATUS_TOOL} with a project, and pass its id"
        ));
    }
    let mut places: Vec<Option<Project>> = registry
        .projects()
        .into_iter()
        .filter(|p| !p.is_unfiled_holder())
        .map(Some)
        .collect();
    places.push(None);
    let mut found = Vec::new();
    for place in places {
        let dir = sessions_of(config, place.as_ref());
        if let Ok(path) = store::find_by_prefix(&dir, chat) {
            found.push((place, dir, path));
        }
    }
    match found.len() {
        1 => Ok(found.remove(0)),
        0 => Err(format!("no chat with id {chat:?} in any project")),
        _ => Err(format!(
            "{chat:?} matches chats in several projects — pass the whole id"
        )),
    }
}

/// The newest chat of the hand-off chain through `id` among `all` (one
/// project's chats), and how many hand-offs on it is. A loop in damaged
/// logs ends the walk.
pub fn chain_newest<'a>(
    all: &'a [SessionSummary],
    id: &str,
) -> (Option<&'a SessionSummary>, usize) {
    let mut at = id.to_string();
    let mut seen: HashSet<String> = HashSet::from([at.clone()]);
    let mut steps = 0;
    loop {
        let next = all
            .iter()
            .filter(|s| {
                s.forked_from
                    .as_ref()
                    .is_some_and(|f| f.session == at && f.reason.as_deref() == Some("handoff"))
            })
            .max_by_key(|s| s.modified);
        match next {
            Some(n) if seen.insert(n.id.clone()) => {
                at = n.id.clone();
                steps += 1;
            }
            _ => break,
        }
    }
    (all.iter().find(|s| s.id == at), steps)
}

/// What the chat at `path` is **now**. The list's summary keeps only the
/// kind a chat was made with; a chat made read-only and later allowed to
/// write (or a job's chat, made and then held) reads wrong there, so the
/// log itself is asked. A log that cannot be read counts as one that may
/// write: it then needs his tap.
pub fn kind_now(path: &Path) -> ChatKind {
    Session::load(path).map_or(ChatKind::Build, |s| s.kind())
}

/// Whether the chat at `path` is big and cold now, and its two costs.
pub fn cold_of(path: &Path, logs: &Path, now: DateTime<Utc>) -> Option<Cold> {
    let session = Session::load(path).ok()?;
    let (tokens, _) = session.last_reply_context()?;
    if tokens < COLD_TOKENS {
        return None;
    }
    let pings = logs.join("ask").join(&session.id);
    let cold_at = crate::hand_off::cold_at(&session, Some(&pings))?;
    if cold_at > now {
        return None;
    }
    let model = session
        .live_events()
        .into_iter()
        .rev()
        .find_map(|(_, e)| match e {
            nightloom_core::SessionEvent::AssistantMessage { model, .. } => Some(model.clone()),
            _ => None,
        });
    let rate = model.and_then(|m| {
        let rates = crate::usage::load_rates_in(&crate::usage::claude_dir()?).ok()?;
        crate::usage::table_cache_rates(&rates, &m)
    });
    let usd = |n: u64| rate.as_ref().map(|r| n as f64 * r.write_1h / 1e6);
    Some(Cold {
        tokens,
        into_usd: usd(tokens),
        new_usd: usd(FRESH_TOKENS),
    })
}

/// `send_chat`: a message into a chat that exists — its chain's newest
/// chat. Waits for him when that chat may write, or is big and cold.
pub fn plan_send(
    config: &Path,
    chat: &str,
    text: &str,
    from: Option<&str>,
    now: DateTime<Utc>,
) -> Result<Route, String> {
    let prompt = check_prompt(text)?;
    let registry = Registry::load_in(config);
    let (project, dir, path) = find_chat(config, &registry, chat)?;
    if project.as_ref().is_some_and(is_home) {
        return Err("that is one of Home's own chats — Home does not route into itself".into());
    }
    let all = store::list(&dir).map_err(|e| e.to_string())?;
    let named = all
        .iter()
        .find(|s| s.path == path)
        .ok_or_else(|| "that chat's log could not be read".to_string())?;
    let (target, steps) = chain_newest(&all, &named.id);
    let target = target.unwrap_or(named);
    if target.mode != ChatMode::Normal {
        return Err("that chat is incognito — Home does not write into it".into());
    }
    let write = kind_now(&target.path) != ChatKind::Chat;
    let cold = cold_of(&target.path, dir.parent().unwrap_or(&dir), now);
    let followed = (steps > 0).then(|| {
        format!(
            "“{}” was handed off; this goes to the newest chat of its chain",
            title_of(named)
        )
    });
    let hold = if cold.is_some() {
        Some(Hold::Cold)
    } else if write {
        Some(Hold::Write)
    } else {
        None
    };
    Ok(Route {
        id: new_id(now),
        at: now,
        kind: Kind::Send,
        project: project.as_ref().map(|p| p.id.clone()),
        project_name: project
            .as_ref()
            .map_or_else(|| "the unfiled chats".to_string(), |p| p.name.clone()),
        chat: Some(target.id.clone()),
        label: Some(title_of(target)),
        prompt,
        write,
        state: if hold.is_some() {
            State::Waiting
        } else {
            State::Queued
        },
        hold,
        cold,
        pick: None,
        note: followed,
        from: from.map(str::to_string),
        tapped_at: None,
        started_at: None,
        ended_at: None,
        summary: None,
        pushed: false,
    })
}

/// What a planned route tells Home (the tool's reply): two lines at most.
pub fn planned_words(route: &Route) -> String {
    let id = &route.id;
    match (route.state, route.hold) {
        (State::Waiting, Some(Hold::Cold)) => {
            let c = route.cold.as_ref();
            format!(
                "Not sent. {} is {} with a cold cache, so a Start card (route {id}) asks him to pick: a new chat in {}, or into it anyway. Nothing goes until he picks. Tell him in one line; do not call again for this.",
                route.place(),
                c.map_or_else(|| "big".to_string(), |c| tokens_short(c.tokens)),
                route.project_name
            )
        }
        (State::Waiting, _) => format!(
            "Not started. {} may write, so a Start card (route {id}) shows him the prompt and waits for his tap. Tell him in one line that the card is waiting; do not call again for this.",
            route.place()
        ),
        _ => format!(
            "Queued (route {id}): {}, read-only. The app starts it within a minute{}. Its result lands in the feed; ask {STATUS_TOOL} with this route id later, not now.",
            route.place(),
            route
                .note
                .as_ref()
                .map(|n| format!(" ({n})"))
                .unwrap_or_default()
        ),
    }
}

// ---- his buttons ----------------------------------------------------------

/// One answer per card: his Start, his Dismiss and the clock's own
/// writes to a waiting card each read the card and write it under this,
/// so two of them never both see it waiting.
static DECIDING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// His tap on a Start card: the route is queued with the prompt as he
/// left it, and with his pick when the card was a cold one. The only way
/// a waiting route starts. `Err` leaves the card as it was.
pub fn confirm(
    config: &Path,
    id: &str,
    prompt: Option<&str>,
    pick: Option<Pick>,
    now: DateTime<Utc>,
) -> Result<Route, String> {
    let _one = DECIDING.lock().unwrap_or_else(|p| p.into_inner());
    let mut route = find(config, id).ok_or_else(|| "that Start card is gone".to_string())?;
    if route.state != State::Waiting {
        return Err("that Start card was already answered".into());
    }
    if let Some(p) = prompt {
        route.prompt = check_prompt(p)?;
    }
    if route.hold == Some(Hold::Cold) {
        match pick {
            Some(Pick::New) => {
                // A new chat in the same project: read-only, as every
                // start he did not ask to write. The cold chat is left.
                route.pick = Some(Pick::New);
                route.note = Some(format!(
                    "his pick: a new chat instead of {}",
                    route.label.as_deref().map_or_else(
                        || "the cold chat".to_string(),
                        |l| format!("the cold “{l}”")
                    )
                ));
                route.chat = None;
                route.label = None;
                route.write = false;
            }
            Some(Pick::Into) => route.pick = Some(Pick::Into),
            None => {
                return Err(
                    "pick one: a new chat in that project, or into the cold chat anyway".into(),
                );
            }
        }
    }
    route.state = State::Queued;
    route.tapped_at = Some(now);
    // His tap, kept apart from the ledger, as what he saw — first, so a
    // line with no tap behind it never reads as tapped.
    taps::append(
        config,
        &taps::Line::Tap {
            id: route.id.clone(),
            at: now,
            approved: taps::Approved::of(&route),
        },
    )?;
    record(config, &route)?;
    Ok(route)
}

/// His Dismiss: the card goes, nothing starts, the ledger keeps the line.
pub fn dismiss(config: &Path, id: &str, now: DateTime<Utc>) -> Result<Route, String> {
    let _one = DECIDING.lock().unwrap_or_else(|p| p.into_inner());
    let mut route = find(config, id).ok_or_else(|| "that Start card is gone".to_string())?;
    if route.state != State::Waiting {
        return Err("that Start card was already answered".into());
    }
    route.state = State::Dismissed;
    route.ended_at = Some(now);
    record(config, &route)?;
    Ok(route)
}

// ---- the clock -----------------------------------------------------------

fn feed(config: &Path, route: &Route, kind: &str, line: String, at: DateTime<Utc>) {
    super::append(
        config,
        &super::FeedRow {
            at,
            kind: kind.into(),
            label: route
                .label
                .clone()
                .or_else(|| Some(route.project_name.clone())),
            chat: route.chat.clone(),
            project: route.project.clone(),
            line,
        },
    );
}

/// Whether a route may be handed to the host at all: never while it
/// waits for him. The one gate every start passes.
pub fn may_run(route: &Route) -> bool {
    route.state == State::Queued
        && (route.hold.is_none() || route.tapped_at.is_some())
        && (route.hold != Some(Hold::Cold) || route.pick.is_some())
}

/// What the gate says of a queued route.
#[derive(Debug, Clone, PartialEq)]
pub enum Clear {
    /// It may be handed to the host; `write` is what its chat is.
    Go { write: bool },
    /// It needs his tap on what it is now: back to a card.
    Ask {
        hold: Hold,
        cold: Option<Cold>,
        write: bool,
    },
    /// Its line asks for something no route may do.
    Refuse(String),
}

/// The gate every start passes, read from what the route **is** now, not
/// from what its ledger line says of itself: the project (never Home),
/// the chat (there, not incognito; a start's chat only the one it made),
/// whether that chat may write, whether it is big and cold. A route that
/// may write, or goes into a cold big chat, is cleared only by a tap of
/// his ([`taps`]) on exactly this — same place, same kind, same pick,
/// same prompt.
pub fn clear(config: &Path, route: &Route, book: &taps::Book, now: DateTime<Utc>) -> Clear {
    let registry = Registry::load_in(config);
    let project = match route.project.as_deref() {
        Some(id) => match registry.find(id) {
            Some(p) => Some(p.clone()),
            None => return Clear::Refuse("its project is gone from the Mac".into()),
        },
        None => None,
    };
    if project.as_ref().is_some_and(is_home) {
        return Clear::Refuse("Home does not route work into itself".into());
    }
    let new_chat = route.kind == Kind::Start || route.pick == Some(Pick::New);
    let (write, hold, cold) = if new_chat {
        if project.is_none() {
            return Clear::Refuse("a new chat needs a project".into());
        }
        if route.chat.is_some() && route.chat != book.made {
            return Clear::Refuse("its line names a chat this route did not make".into());
        }
        (route.write, route.write.then_some(Hold::Write), None)
    } else {
        let Some(chat) = route.chat.as_deref() else {
            return Clear::Refuse("its line names no chat".into());
        };
        let dir = sessions_of(config, project.as_ref());
        let all = store::list(&dir).unwrap_or_default();
        let Some(target) = all.iter().find(|s| s.id == chat) else {
            return Clear::Refuse("its chat is gone".into());
        };
        if target.mode != ChatMode::Normal {
            return Clear::Refuse("its chat is incognito — Home does not write into it".into());
        }
        let write = kind_now(&target.path) != ChatKind::Chat;
        let cold = cold_of(&target.path, dir.parent().unwrap_or(&dir), now);
        let hold = if cold.is_some() {
            Some(Hold::Cold)
        } else if write {
            Some(Hold::Write)
        } else {
            None
        };
        (write, hold, cold)
    };
    let Some(hold) = hold else {
        return Clear::Go { write };
    };
    let mut asked = taps::Approved::of(route);
    asked.write = write;
    let tapped =
        book.tap.as_ref() == Some(&asked) && (hold != Hold::Cold || route.pick == Some(Pick::Into));
    if tapped {
        Clear::Go { write }
    } else {
        Clear::Ask { hold, cold, write }
    }
}

/// A route that cannot ever start: recorded as failed, with why.
fn fail(config: &Path, mut route: Route, why: String, now: DateTime<Utc>) {
    route.state = State::Failed;
    route.ended_at = Some(now);
    route.summary = Some(why.clone());
    let _ = record(config, &route);
    feed(config, &route, "route_failed", why, now);
}

/// Start one queued route through the host's own job path: the chat is
/// made (or held as it is) and the prompt goes into it off screen.
async fn start(host: &dyn Host, config: &Path, mut route: Route, now: DateTime<Utc>) {
    if !may_run(&route) {
        return;
    }
    let book = taps::Book::of(config, &route.id);
    match book.handed {
        taps::Handed::No => {}
        // Its line says "queued" again though the host already took it
        // (an old line written again, or a quit between the send and the
        // line): it is running, not to be sent a second time.
        taps::Handed::Sent => {
            route.state = State::Started;
            route.started_at = route.started_at.or(Some(now));
            let _ = record(config, &route);
            return;
        }
        taps::Handed::CutOff => {
            let why = "the app quit while this was being handed over — open its chat to see whether it went; it is not sent twice".to_string();
            return fail(config, route, why, now);
        }
    }
    match clear(config, &route, &book, now) {
        Clear::Go { write } => route.write = write,
        Clear::Refuse(why) => return fail(config, route, format!("not started — {why}"), now),
        Clear::Ask { hold, cold, write } => {
            let _one = DECIDING.lock().unwrap_or_else(|p| p.into_inner());
            route.state = State::Waiting;
            route.hold = Some(hold);
            route.cold = cold;
            route.write = write;
            route.pick = None;
            route.tapped_at = None;
            route.pushed = false;
            route.note = Some(
                match hold {
                    Hold::Cold => "its cache went cold before this could start",
                    Hold::Write => "this is not what was tapped — it needs your tap as it is now",
                }
                .to_string(),
            );
            let _ = record(config, &route);
            return;
        }
    }
    // The design's rule: never route work into a repo during a night.
    if night_in(&Registry::load_in(config), &route) {
        let why = format!(
            "a night run is going in {} — it starts when the night ends",
            route.project_name
        );
        return wait(config, route, why, now);
    }
    let new_chat = route.kind == Kind::Start || route.pick == Some(Pick::New);
    let title = crate::jobs::title_from(&route.prompt);
    let prepared = host
        .job_prepare(crate::jobs::Prep {
            project: route.project.clone(),
            chat: route.chat.clone(),
            title: title.clone(),
            read_only: !route.write,
            auto_hand_off: None,
            model: None,
            connectors: false,
        })
        .await;
    let chat = match prepared {
        Ok(chat) => chat,
        Err(why) => return wait(config, route, why, now),
    };
    // Kept before the send: a send that fails must not make a second chat.
    if route.chat.as_deref() != Some(chat.as_str()) {
        route.chat = Some(chat.clone());
        if new_chat {
            route.label = Some(title);
        }
        let made = taps::Line::Made {
            id: route.id.clone(),
            chat: chat.clone(),
        };
        if taps::append(config, &made).is_err() || record(config, &route).is_err() {
            return;
        }
    }
    // At most once: said before the host is asked, so a quit in the
    // middle is seen as one, never as "not sent yet".
    let sending = taps::Line::Sending {
        id: route.id.clone(),
        at: now,
    };
    if taps::append(config, &sending).is_err() {
        return;
    }
    // One row per routed turn: the route's own, not also the push's.
    super::job_run_started(&chat);
    match host
        .job_send(route.project.as_deref(), &chat, &route.prompt)
        .await
    {
        Ok(Handed::Sent | Handed::Queued) => {
            let _ = taps::append(
                config,
                &taps::Line::Sent {
                    id: route.id.clone(),
                },
            );
            route.state = State::Started;
            route.started_at = Some(now);
            route.note = None;
            let _ = record(config, &route);
            let line = format!("Home started this — {}", route.may());
            feed(config, &route, "route_started", line, now);
        }
        Err(why) => {
            super::job_run_ended(&chat);
            let _ = taps::append(
                config,
                &taps::Line::Unsent {
                    id: route.id.clone(),
                },
            );
            wait(config, route, why, now);
        }
    }
}

/// A route that could not start yet says why and is tried again at the
/// next look; after a day it fails, and says so.
fn wait(config: &Path, mut route: Route, why: String, now: DateTime<Utc>) {
    // The host's reasons are worded for jobs; this is not one.
    let why = why
        .replace("the job runs when", "it starts when")
        .replace("the job's project", "its project");
    let since = route.tapped_at.unwrap_or(route.at);
    if (now - since).num_seconds() > QUEUE_MAX_SECS {
        route.state = State::Failed;
        route.ended_at = Some(now);
        route.summary = Some(format!("never started — {why}"));
        let _ = record(config, &route);
        let line = format!("Home could not start this in a day — {why}");
        return feed(config, &route, "route_failed", line, now);
    }
    let note = format!("{WAITING}{why}");
    if route.note.as_deref() != Some(note.as_str()) {
        route.note = Some(note);
        let _ = record(config, &route);
    }
}

/// Record the end of a started route once its chat stops running.
async fn finish(host: &dyn Host, config: &Path, mut route: Route, now: DateTime<Utc>) {
    let (Some(chat), Some(started)) = (route.chat.clone(), route.started_at) else {
        return;
    };
    // A relaunch forgets the process's runs; every look says it again.
    super::job_run_started(&chat);
    let age = (now - started).num_seconds();
    if age < RUN_GRACE_SECS {
        return;
    }
    let listed = match host.running().await {
        Ok(r) => r
            .chats
            .iter()
            .any(|c| c.chat.as_deref() == Some(chat.as_str())),
        Err(e) if e == crate::remote::api::NOT_AVAILABLE => host.state().await.busy,
        Err(_) => true,
    };
    if listed && age < RUN_MAX_SECS {
        return;
    }
    let (ok, summary) = if listed {
        (
            false,
            "still running after six hours — open its chat".to_string(),
        )
    } else {
        match host.transcript(route.project.as_deref(), &chat).await {
            Ok(events) => {
                let events: Vec<Value> = events
                    .iter()
                    .filter_map(|e| serde_json::to_value(e).ok())
                    .collect();
                match crate::jobs::reply_in(&events, &route.prompt) {
                    Some(reply) => (true, cut(&reply)),
                    None => (false, "it ended with no reply — open its chat".to_string()),
                }
            }
            Err(e) => (false, format!("its chat could not be read: {e}")),
        }
    };
    route.state = if ok { State::Finished } else { State::Failed };
    route.ended_at = Some(now);
    route.summary = Some(summary.clone());
    let _ = record(config, &route);
    let kind = if ok { "route_done" } else { "route_failed" };
    feed(config, &route, kind, summary, now);
    super::job_run_ended(&chat);
}

/// A new Start card's push, once: "Home — Has a start waiting for your
/// tap". States only; the prompt never leaves the Mac in a push.
async fn push_card(host: &dyn Host, config: &Path, route: Route, now: DateTime<Utc>) {
    // Read again under his buttons' lock: the look's copy may be older
    // than a Dismiss or a tap, and must not write the card back.
    let route = {
        let _one = DECIDING.lock().unwrap_or_else(|p| p.into_inner());
        let Some(mut route) =
            find(config, &route.id).filter(|r| r.state == State::Waiting && !r.pushed)
        else {
            return;
        };
        route.pushed = true;
        if record(config, &route).is_err() {
            return;
        }
        route
    };
    let line = format!(
        "Start card waiting — {} ({})",
        route.place(),
        match route.hold {
            Some(Hold::Cold) => "cold chat, your pick",
            _ => "may write, your tap",
        }
    );
    feed(config, &route, "route_waiting", line, now);
    let Some(push) = host.push() else {
        return;
    };
    let home = Registry::load_in(config)
        .find_by_source(super::SOURCE)
        .map(|p| p.id.clone());
    push.notify(crate::push::Note {
        what: crate::push::What::Approval,
        chat: route.from.clone(),
        label: Some(super::NAME.to_string()),
        project: home,
        at_the_mac: host.at_the_mac(),
        detail: Some(CARD_PUSH.to_string()),
    })
    .await;
}

/// One starter at a time in this process: the clock's look, the window's
/// look and his tap all read the ledger and then ask the host, and two
/// of them reading the same queued line would make two chats.
static LOOKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// One look of the clock: finish what ended, start what is queued, push
/// each new card once. A waiting route is never started here.
pub async fn tick(host: &dyn Host, now: DateTime<Utc>) {
    let Some(config) = host.home_config() else {
        return;
    };
    let _one = LOOKING.lock().await;
    if !path_in(&config).is_file() {
        return;
    }
    for route in read(&config) {
        match route.state {
            State::Started => finish(host, &config, route, now).await,
            State::Queued => start(host, &config, route, now).await,
            State::Waiting if !route.pushed => push_card(host, &config, route, now).await,
            _ => {}
        }
    }
}

/// His tap, then a look at once, so the chat starts under his finger
/// and not at the next half minute.
pub async fn confirm_and_run(
    host: &dyn Host,
    id: &str,
    prompt: Option<&str>,
    pick: Option<Pick>,
    now: DateTime<Utc>,
) -> Result<Route, String> {
    let config = host
        .home_config()
        .ok_or_else(|| crate::remote::api::NOT_AVAILABLE.to_string())?;
    let _one = LOOKING.lock().await;
    let route = confirm(&config, id, prompt, pick, now)?;
    start(host, &config, route, now).await;
    find(&config, id).ok_or_else(|| "that Start card is gone".to_string())
}

// ---- the tools -----------------------------------------------------------

const START_DESC: &str = "Start a new chat in one of his projects with a prompt you write, when he asks for work that belongs to a project (\"start the 778 fix in Nightshift\"). You do not do the work in Home. project: the project's name. prompt: everything the new chat needs — it has none of this conversation; say the goal, what he said in his words, and the files to read. may_write false (the default): the chat is held read-only (reads, search, the web) and starts by itself — use it for an investigation. may_write true: the chat may edit files and run commands, so nothing starts; a Start card shows him your prompt, he can edit it, and it begins when he taps. You never wait for the chat: reply in two lines — where it went and that it is queued or waiting for his tap.";

const SEND_DESC: &str = "Send a message into a chat that already exists in one of his projects (its id from search_chats or chat_status). If that chat was handed off, the message goes to the newest chat of its chain. A chat that may write, or a big chat whose cache is cold, is never written into by you: a Start card asks him. Prefer start_chat unless the work clearly continues that chat.";

const STATUS_DESC: &str = "What became of something you routed, or what chats a project has. route: a route id from start_chat or send_chat — its state (waiting for his tap, queued, started, finished, failed) and the reply's first lines once it ended. project: a project's name — its newest chats with ids, sizes and whether each may write. With neither: the routes of the last day.";

/// `start_chat`.
pub struct StartChat {
    config: PathBuf,
    from: Option<String>,
}

/// `send_chat`.
pub struct SendChat {
    config: PathBuf,
    from: Option<String>,
}

/// `chat_status`.
pub struct ChatStatus {
    config: PathBuf,
}

#[async_trait::async_trait]
impl Tool for StartChat {
    /// `Session`: it appends one line to Home's own ledger. What the line
    /// may start without him is this module's rule, not the caller's.
    fn effect(&self) -> Effect {
        Effect::Session
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: START_TOOL.into(),
            description: START_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string", "description": "The project's name, as he says it." },
                    "prompt": { "type": "string", "description": "The new chat's first message, complete in itself." },
                    "may_write": { "type": "boolean", "description": "true only when the work must edit files or run commands; it then waits for his tap." }
                },
                "required": ["project", "prompt"]
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let route = plan_start(
            &self.config,
            input["project"].as_str().unwrap_or(""),
            input["prompt"].as_str().unwrap_or(""),
            input["may_write"].as_bool().unwrap_or(false),
            self.from.as_deref(),
            Utc::now(),
        )?;
        record(&self.config, &route)?;
        Ok(planned_words(&route))
    }
}

#[async_trait::async_trait]
impl Tool for SendChat {
    fn effect(&self) -> Effect {
        Effect::Session
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: SEND_TOOL.into(),
            description: SEND_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "chat": { "type": "string", "description": "The chat's id, or its short id from a search_chats line." },
                    "text": { "type": "string", "description": "The message, complete in itself." }
                },
                "required": ["chat", "text"]
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let route = plan_send(
            &self.config,
            input["chat"].as_str().unwrap_or(""),
            input["text"].as_str().unwrap_or(""),
            self.from.as_deref(),
            Utc::now(),
        )?;
        record(&self.config, &route)?;
        Ok(planned_words(&route))
    }
}

/// One route as `chat_status` says it.
pub fn status_line(r: &Route) -> String {
    let state = match r.state {
        State::Waiting => match r.hold {
            Some(Hold::Cold) => "waiting for his pick (cold chat)".to_string(),
            _ => "waiting for his tap".to_string(),
        },
        State::Queued => r.note.clone().unwrap_or_else(|| "queued".to_string()),
        State::Started => "running".to_string(),
        State::Finished => "finished".to_string(),
        State::Failed => "failed".to_string(),
        State::Dismissed => "dismissed by him — do not start it again unasked".to_string(),
    };
    let mut line = format!("route {} — {} ({}): {state}", r.id, r.place(), r.may());
    if let Some(chat) = &r.chat {
        line.push_str(&format!(" · chat {chat}"));
    }
    if let Some(s) = &r.summary {
        line.push_str(&format!("\n  reply: {s}"));
    }
    line
}

fn project_chats(config: &Path, said: &str, now: DateTime<Utc>) -> Result<String, String> {
    let registry = Registry::load_in(config);
    let project = find_project(&registry, said)?;
    let dir = sessions_of(config, Some(&project));
    let mut all = store::list(&dir).map_err(|e| e.to_string())?;
    all.sort_by_key(|s| std::cmp::Reverse(s.modified));
    let continued: HashSet<&str> = all
        .iter()
        .filter_map(|s| s.forked_from.as_ref())
        .filter(|f| f.reason.as_deref() == Some("handoff"))
        .map(|f| f.session.as_str())
        .collect();
    let mut out = format!("{} — newest chats:", project.name);
    for s in all
        .iter()
        .filter(|s| s.mode == ChatMode::Normal && !continued.contains(s.id.as_str()))
        .take(8)
    {
        let size = s
            .context_used
            .map_or_else(|| "no reply yet".to_string(), tokens_short);
        let cold = cold_of(&s.path, dir.parent().unwrap_or(&dir), now).is_some();
        out.push_str(&format!(
            "\n- {} · “{}” · {size}{} · {} · last written {}",
            s.id,
            title_of(s),
            if cold {
                ", cold — a send asks him first"
            } else {
                ""
            },
            if kind_now(&s.path) == ChatKind::Chat {
                "read-only"
            } else {
                "may write — a send waits for his tap"
            },
            s.modified.format("%Y-%m-%d %H:%M UTC"),
        ));
    }
    if all.is_empty() {
        out.push_str("\n(no chats yet)");
    }
    Ok(out)
}

#[async_trait::async_trait]
impl Tool for ChatStatus {
    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: STATUS_TOOL.into(),
            description: STATUS_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "route": { "type": "string", "description": "A route id." },
                    "project": { "type": "string", "description": "A project's name, to list its chats." }
                }
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let now = Utc::now();
        if let Some(id) = input["route"].as_str().filter(|s| !s.trim().is_empty()) {
            return find(&self.config, id.trim())
                .map(|r| status_line(&r))
                .ok_or_else(|| format!("no route {id:?}"));
        }
        if let Some(p) = input["project"].as_str().filter(|s| !s.trim().is_empty()) {
            return project_chats(&self.config, p, now);
        }
        let recent: Vec<String> = read(&self.config)
            .iter()
            .filter(|r| (now - r.at).num_hours() < 24)
            .map(status_line)
            .collect();
        Ok(if recent.is_empty() {
            "Nothing routed in the last day.".to_string()
        } else {
            recent.join("\n")
        })
    }
}

/// The three tools, for a chat of Home's (`from`: the chat asking).
pub fn tools(config: &Path, from: Option<&str>) -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(StartChat {
            config: config.to_path_buf(),
            from: from.map(str::to_string),
        }),
        Box::new(SendChat {
            config: config.to_path_buf(),
            from: from.map(str::to_string),
        }),
        Box::new(ChatStatus {
            config: config.to_path_buf(),
        }),
    ]
}

/// What the server's `initialize` adds when the tools are served.
pub const INSTRUCTION: &str = " You are Home: when he asks for work that belongs to a project, route it with start_chat (or send_chat for a chat that exists) instead of doing it here, then answer in two lines — where it went, and whether it is queued or waiting for his tap. A chat that may write never starts without his tap; never say it has started when the tool said it waits.";

#[cfg(test)]
mod tests;
