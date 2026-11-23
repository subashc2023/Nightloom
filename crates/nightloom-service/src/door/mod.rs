//! The door (nightshift item 767): start, message and wait on a Nightloom
//! chat from outside the app — a terminal, a script, another agent's MCP
//! client — read-only until he says otherwise.
//!
//! # The shape
//!
//! Whoever holds the Nightloom home (the desktop app, or `nightloom
//! serve`) listens on a Unix socket in it, [`SOCKET`], mode 0600: one JSON
//! [`Request`] per line in, one reply per line out ([`server`]). The two
//! callers are thin: `nightloom chat …` ([`cli`]; the desktop binary
//! carries it as `--chat …`) and four MCP tools on `mcp-serve --outside`
//! ([`tools`]). Both go through [`client::ask`].
//!
//! # What a call may do
//!
//! - **Reads** — `list`, `show`, `status` — always. They read the logs on
//!   disk, so they also work with nothing holding the home (the client
//!   then reads the disk itself; every chat is idle by definition).
//! - **Writes** — `start`, `send` — only while [`Access::writes`] is on
//!   (Settings → Outside control; off by default), and only through a
//!   holder: the holder is the one writer of a chat's log and the only
//!   thing that can run a turn without breaking the one-holder rule
//!   ([`crate::serve`]). With no holder a write is refused with
//!   [`NO_HOLDER`] (blocker 2250).
//!
//! A write runs as a recurring job's run does ([`Host::job_prepare`],
//! [`Host::job_send`]): off screen, in its own chat, so the chat on his
//! screen and his half-typed draft do not move.
//!
//! # What is never served
//!
//! An incognito chat: not listed, not shown, not sent to — the rule
//! `search_chats` keeps.
//!
//! # Who started it
//!
//! A chat started through the door is recorded in `door/started.json`
//! (chat id → who, when); the sidebars and the phone's list mark it. A
//! side file rather than a log event: the mark is about how the chat came
//! to be, the holder is its one writer, and no reader of a log changes.

pub mod cli;
pub mod client;
pub mod server;
pub mod tools;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use nightloom_core::{ChatKind, ChatMode, Session, SessionEvent};
use serde::{Deserialize, Serialize};

use crate::project::{PROJECTS_DIR, Registry, SESSIONS_DIR};
use crate::store;

/// The socket's name under the Nightloom home.
pub const SOCKET: &str = "door.sock";
/// The door's own folder under the home: the switch and the started list.
pub const DIR: &str = "door";
const ACCESS_FILE: &str = "access.json";
const STARTED_FILE: &str = "started.json";

/// Why a write is refused while the switch is off.
pub const WRITES_OFF: &str = "starting and messaging chats from outside is off — switch it on in Nightloom's Settings → Outside control";
/// Why a write is refused with nothing holding the home.
pub const NO_HOLDER: &str = "Nightloom is not running, so nothing can run the chat — open Nightloom (or run `nightloom serve`) and try again; list and show work without it";
/// Why a send is refused while the chat runs: a send never interrupts.
pub const RUNNING: &str =
    "that chat is running a turn — wait for it (chat show <id> --wait), then send";
const INCOGNITO: &str = "that chat is incognito: it is not read or messaged from outside";

/// How many messages `show` sends when the caller names no number.
pub const DEFAULT_LAST: usize = 6;
/// How many chats `list` sends when the caller names no number.
pub const DEFAULT_LIMIT: usize = 30;
/// The longest a "who" is kept.
const BY_MAX: usize = 40;

pub fn socket_path(config: &Path) -> PathBuf {
    config.join(SOCKET)
}

/// What outside callers may do. Absent file, unreadable file: read-only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Access {
    /// `start` and `send` are allowed.
    #[serde(default)]
    pub writes: bool,
}

pub fn access(config: &Path) -> Access {
    std::fs::read_to_string(config.join(DIR).join(ACCESS_FILE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn set_access(config: &Path, access: Access) -> Result<(), String> {
    write_json(&config.join(DIR).join(ACCESS_FILE), &access)
}

/// Written whole to a neighbour and renamed over: a reader never sees half.
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let dir = path.parent().ok_or("no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Who started a chat through the door, and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Started {
    pub by: String,
    pub at: DateTime<Utc>,
}

/// Every chat started through the door, by id.
pub fn started(config: &Path) -> BTreeMap<String, Started> {
    std::fs::read_to_string(config.join(DIR).join(STARTED_FILE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Record that `by` started `chat`. The holder's write, one at a time
/// under the server's lock.
pub fn note_started(config: &Path, chat: &str, by: &str) -> Result<(), String> {
    let mut all = started(config);
    all.insert(
        chat.to_string(),
        Started {
            by: clean_by(by),
            at: Utc::now(),
        },
    );
    write_json(&config.join(DIR).join(STARTED_FILE), &all)
}

/// A "who" as it is kept and shown: one line, no control characters, at
/// most [`BY_MAX`] characters; "outside" when nothing is left.
pub fn clean_by(by: &str) -> String {
    let one: String = by
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let one = one.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = one.chars().take(BY_MAX).collect();
    if cut.is_empty() {
        "outside".into()
    } else {
        cut
    }
}

/// The sidebar's sentence for a chat started through the door.
pub fn started_tip(by: &str) -> String {
    format!("Started from outside Nightloom by {by}")
}

/// One call. `op` names it on the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    /// The chats, newest first: of `project` (an id or a name), or of
    /// every project and the unfiled ones.
    List {
        #[serde(default)]
        project: Option<String>,
        #[serde(default)]
        limit: Option<usize>,
    },
    /// One chat: where it stands and its last `last` messages.
    Show {
        chat: String,
        #[serde(default)]
        last: Option<usize>,
    },
    /// Where a chat stands, from the holder alone (no log is read): what
    /// a wait polls. `chat` is a whole id.
    Status { chat: String },
    /// A new chat in `project` with `text` as its first message.
    Start {
        project: String,
        text: String,
        #[serde(default)]
        title: Option<String>,
        /// Held to the Chat policy: it may read, not change files.
        #[serde(default)]
        read_only: bool,
        #[serde(default)]
        by: String,
    },
    /// `text` into an existing chat.
    Send {
        chat: String,
        text: String,
        #[serde(default)]
        by: String,
    },
}

/// Where a chat stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// No turn runs.
    #[default]
    Idle,
    Running,
    /// A turn runs and waits on him: a permission, a question, a plan.
    Waiting,
    /// Stopped at the plan's usage limit until the window opens.
    Paused,
}

impl State {
    pub fn word(self) -> &'static str {
        match self {
            State::Idle => "idle",
            State::Running => "running",
            State::Waiting => "waiting on you",
            State::Paused => "paused at the usage limit",
        }
    }

    /// The chat cannot go on until he does something.
    pub fn needs_him(self) -> bool {
        matches!(self, State::Waiting | State::Paused)
    }
}

/// `status`'s answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct Status {
    pub state: State,
    /// What he has to do, when the state needs him.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs: Option<String>,
}

/// One chat in a listing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatLine {
    pub id: String,
    /// Its project's name; `None` for an unfiled chat.
    #[serde(default)]
    pub project: Option<String>,
    pub title: String,
    pub modified: DateTime<Utc>,
    pub user_turns: usize,
    /// `build` (Claude Code) or `chat` (reads, changes nothing).
    pub kind: String,
    #[serde(default)]
    pub state: State,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs: Option<String>,
    /// Who started it through the door, when someone did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_by: Option<String>,
}

/// `list`'s answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Listing {
    pub chats: Vec<ChatLine>,
    /// How many there were before the limit.
    pub total: usize,
    /// What answered: `mac`, `serve`, or `None` when the caller read the
    /// disk itself.
    #[serde(default)]
    pub holder: Option<String>,
    /// Whether `start` and `send` are allowed now.
    pub writes: bool,
}

/// One conversational message: his or the model's text, never a tool's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    /// `user` or `assistant`.
    pub who: String,
    pub at: DateTime<Utc>,
    pub text: String,
}

/// `show`'s answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatView {
    #[serde(flatten)]
    pub line: ChatLine,
    /// How many replies with text the log holds — rewound ones counted, so
    /// the number only grows. A wait compares it with [`Sent::replies`].
    pub replies: usize,
    /// How many conversational messages there are in all.
    pub messages_total: usize,
    /// The last ones asked for, oldest first.
    pub messages: Vec<Message>,
    #[serde(default)]
    pub holder: Option<String>,
}

impl ChatView {
    /// The newest reply's text.
    pub fn last_reply(&self) -> Option<&Message> {
        self.messages.iter().rev().find(|m| m.who == "assistant")
    }
}

/// `start`'s and `send`'s answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sent {
    pub chat: String,
    #[serde(default)]
    pub project: Option<String>,
    /// [`ChatView::replies`] before the message went.
    pub replies: usize,
}

/// What the holder knows that the disk does not.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Live {
    /// Each running chat and its unanswered prompts.
    pub running: Vec<(String, usize)>,
    /// The chat paused at the usage limit, and the sentence about it.
    pub paused: Option<(String, String)>,
    pub holder: Option<String>,
}

impl Live {
    pub fn status(&self, chat: &str) -> Status {
        if let Some((_, waiting)) = self.running.iter().find(|(c, _)| c == chat) {
            return if *waiting > 0 {
                Status {
                    state: State::Waiting,
                    needs: Some(format!(
                        "{} waiting for an answer in Nightloom (a permission, a question or a plan)",
                        if *waiting == 1 {
                            "1 prompt is".to_string()
                        } else {
                            format!("{waiting} prompts are")
                        }
                    )),
                }
            } else {
                Status {
                    state: State::Running,
                    needs: None,
                }
            };
        }
        match &self.paused {
            Some((c, why)) if c == chat => Status {
                state: State::Paused,
                needs: Some(why.clone()),
            },
            _ => Status::default(),
        }
    }
}

/// A local time as he reads it: `2026-11-23 3:05 AM`.
pub fn stamp12(at: &DateTime<Utc>) -> String {
    at.with_timezone(&chrono::Local)
        .format("%Y-%m-%d %-I:%M %p")
        .to_string()
}

/// One place chats live: a project's sessions, or the unfiled ones.
#[derive(Debug, Clone)]
struct Place {
    /// `(id, name)`; `None` for the unfiled chats.
    project: Option<(String, String)>,
    dir: PathBuf,
}

/// Every place under `config`, the registry's order, the unfiled last.
/// Built from `config` (not `Project::session_dir`, which reads the
/// process-wide home), as `capture::session_dirs` is.
fn places(config: &Path) -> Vec<Place> {
    let mut out: Vec<Place> = Registry::load_in(config)
        .projects()
        .into_iter()
        .map(|p| Place {
            dir: config.join(PROJECTS_DIR).join(&p.id).join(SESSIONS_DIR),
            project: Some((p.id, p.name)),
        })
        .collect();
    out.push(Place {
        project: None,
        dir: config.join(crate::capture::UNFILED).join(SESSIONS_DIR),
    });
    out
}

/// A project by what the caller typed: its id, else its name whatever the
/// case, else the one name that starts with it. `(id, name)`.
pub fn pick_project(
    projects: &[(String, String)],
    typed: &str,
) -> Result<(String, String), String> {
    let typed = typed.trim();
    if typed.is_empty() {
        return Err("name a project (its name or its id)".into());
    }
    if let Some(p) = projects.iter().find(|(id, _)| id == typed) {
        return Ok(p.clone());
    }
    let low = typed.to_lowercase();
    let exact: Vec<_> = projects
        .iter()
        .filter(|(_, n)| n.to_lowercase() == low)
        .collect();
    let found = if exact.is_empty() {
        projects
            .iter()
            .filter(|(_, n)| n.to_lowercase().starts_with(&low))
            .collect()
    } else {
        exact
    };
    match found.len() {
        1 => Ok(found[0].clone()),
        0 => Err(format!(
            "no project called {typed:?}; the projects are: {}",
            names(projects.iter())
        )),
        _ => Err(format!(
            "{typed:?} names more than one project — use the id: {}",
            found
                .iter()
                .map(|(id, n)| format!("{n} ({id})"))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

fn names<'a>(projects: impl Iterator<Item = &'a (String, String)>) -> String {
    let all: Vec<&str> = projects.map(|(_, n)| n.as_str()).collect();
    if all.is_empty() {
        "none yet".into()
    } else {
        all.join(", ")
    }
}

/// A chat found on disk.
#[derive(Debug, Clone)]
pub struct Found {
    pub id: String,
    pub path: PathBuf,
    /// `(id, name)` of its project; `None` for an unfiled chat.
    pub project: Option<(String, String)>,
}

/// The chat whose id is, or starts with, `typed` — across every project
/// and the unfiled chats. Two matches are refused with both ids.
pub fn find(config: &Path, typed: &str) -> Result<Found, String> {
    let typed = typed.trim();
    if !store::is_log_id(typed) {
        return Err(format!("{typed:?} is not a chat id"));
    }
    let mut found: Vec<Found> = Vec::new();
    for place in places(config) {
        if !place.dir.is_dir() {
            continue;
        }
        let whole = place.dir.join(format!("{typed}.jsonl"));
        let path = if whole.is_file() {
            whole
        } else {
            match store::find_by_prefix(&place.dir, typed) {
                Ok(path) => path,
                Err(store::StoreError::NotFound { .. }) => continue,
                Err(e) => return Err(e.to_string()),
            }
        };
        let Some(id) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
            continue;
        };
        found.push(Found {
            id,
            path,
            project: place.project,
        });
    }
    match found.len() {
        0 => Err(format!(
            "no chat whose id starts with {typed:?} — `chat list` shows the ids"
        )),
        1 => Ok(found.remove(0)),
        _ => Err(format!(
            "{typed:?} matches more than one chat; give more of the id: {}",
            found
                .iter()
                .map(|f| f.id.clone())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

fn kind_word(kind: ChatKind) -> &'static str {
    match kind {
        ChatKind::Chat => "chat",
        _ => "build",
    }
}

/// The chats on disk, newest first, with what `live` knows of each.
pub fn list(
    config: &Path,
    project: Option<&str>,
    limit: Option<usize>,
    live: &Live,
) -> Result<Listing, String> {
    let all = places(config);
    let only = match project {
        Some(typed) => {
            let known: Vec<(String, String)> =
                all.iter().filter_map(|p| p.project.clone()).collect();
            Some(pick_project(&known, typed)?.0)
        }
        None => None,
    };
    let by = started(config);
    let mut chats = Vec::new();
    for place in all {
        if let Some(only) = &only
            && place.project.as_ref().map(|(id, _)| id) != Some(only)
        {
            continue;
        }
        for s in store::list(&place.dir).map_err(|e| e.to_string())? {
            if s.mode != ChatMode::Normal {
                continue;
            }
            let status = live.status(&s.id);
            chats.push(ChatLine {
                title: s.label(80),
                project: place.project.as_ref().map(|(_, n)| n.clone()),
                modified: s.modified,
                user_turns: s.user_turns,
                kind: kind_word(s.kind).into(),
                state: status.state,
                needs: status.needs,
                started_by: by.get(&s.id).map(|b| b.by.clone()),
                id: s.id,
            });
        }
    }
    chats.sort_by_key(|a| std::cmp::Reverse(a.modified));
    let total = chats.len();
    chats.truncate(limit.unwrap_or(DEFAULT_LIMIT).max(1));
    Ok(Listing {
        chats,
        total,
        holder: live.holder.clone(),
        writes: access(config).writes,
    })
}

/// A chat's log, read: what `show` and `send` both need of it.
pub struct Read {
    pub found: Found,
    pub kind: ChatKind,
    pub title: String,
    pub replies: usize,
    pub user_turns: usize,
    pub modified: DateTime<Utc>,
    /// Every conversational message with text, after rewinds, oldest first.
    pub messages: Vec<Message>,
}

/// Read the chat `typed` names. An incognito chat is refused.
pub fn read(config: &Path, typed: &str) -> Result<Read, String> {
    let found = find(config, typed)?;
    let session = Session::load(&found.path).map_err(|e| e.to_string())?;
    if session.mode() != ChatMode::Normal {
        return Err(INCOGNITO.into());
    }
    let replies = session
        .events()
        .iter()
        .filter(|e| matches!(e, SessionEvent::AssistantMessage { .. }))
        .filter_map(store::said)
        .filter(|s| !s.text.trim().is_empty())
        .count();
    let messages: Vec<Message> = session
        .live_events()
        .into_iter()
        .filter_map(|(_, e)| store::said(e))
        .filter(|s| s.conversation && !s.text.trim().is_empty())
        .map(|s| Message {
            who: if s.who == "you" { "user" } else { "assistant" }.into(),
            at: s.at,
            text: s.text.into_owned(),
        })
        .collect();
    let user_turns = messages.iter().filter(|m| m.who == "user").count();
    let title = session
        .title()
        .map(str::to_string)
        .or_else(|| {
            messages
                .iter()
                .find(|m| m.who == "user")
                .map(|m| crate::jobs::title_from(&m.text))
        })
        .unwrap_or_default();
    let modified = std::fs::metadata(&found.path)
        .and_then(|m| m.modified())
        .map(DateTime::<Utc>::from)
        .unwrap_or_else(|_| Utc::now());
    Ok(Read {
        kind: session.kind(),
        title,
        replies,
        user_turns,
        modified,
        messages,
        found,
    })
}

/// One chat with its last `last` messages and what `live` knows of it.
pub fn show(
    config: &Path,
    typed: &str,
    last: Option<usize>,
    live: &Live,
) -> Result<ChatView, String> {
    let r = read(config, typed)?;
    let status = live.status(&r.found.id);
    let total = r.messages.len();
    let keep = last.unwrap_or(DEFAULT_LAST);
    let messages = r.messages[total.saturating_sub(keep)..].to_vec();
    Ok(ChatView {
        line: ChatLine {
            started_by: started(config).get(&r.found.id).map(|b| b.by.clone()),
            id: r.found.id,
            project: r.found.project.map(|(_, n)| n),
            title: r.title,
            modified: r.modified,
            user_turns: r.user_turns,
            kind: kind_word(r.kind).into(),
            state: status.state,
            needs: status.needs,
        },
        replies: r.replies,
        messages_total: total,
        messages,
        holder: live.holder.clone(),
    })
}
