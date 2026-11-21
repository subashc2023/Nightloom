//! His taps, kept apart from the ledger (item 763 H5's review, 2026-11-18).
//!
//! The ledger (`home/routes.jsonl`) is written by the MCP server on a
//! model's call and sits in Home's folder, which is read by scans and is
//! the part of Nightloom's home meant to sync. A line there that says
//! "he tapped" is therefore only a claim. What he actually approved is
//! written here, `<nightloom home>/remote/home-route-taps.jsonl`, by his
//! buttons alone ([`super::confirm`]), as the exact thing he saw: where,
//! whether it may write, his pick, and the prompt. The gate
//! ([`super::clear`]) starts a write-capable or cold route only when the
//! ledger line still says exactly that.
//!
//! The same file is the at-most-once record of what was handed to the
//! host: `sending` before the send, then `sent` or `unsent`. A route
//! with a `sending` and no outcome was cut off mid-send (the app quit);
//! it is never sent a second time by the clock.
//!
//! What this does not stop: a process that can write any file under
//! Nightloom's home can write this one too. It is the same trust as the
//! chat logs themselves.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{Kind, Pick, Route};

const DIR: &str = "remote";
const FILE: &str = "home-route-taps.jsonl";

/// What he saw on the card when he tapped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Approved {
    pub kind: Kind,
    #[serde(default)]
    pub project: Option<String>,
    /// The chat written into; `None` for a new chat.
    #[serde(default)]
    pub chat: Option<String>,
    pub write: bool,
    #[serde(default)]
    pub pick: Option<Pick>,
    pub prompt: String,
}

impl Approved {
    /// What `route`'s line asks for now, in the same terms.
    pub fn of(route: &Route) -> Self {
        let new_chat = route.kind == Kind::Start || route.pick == Some(Pick::New);
        Approved {
            kind: route.kind,
            project: route.project.clone(),
            chat: if new_chat { None } else { route.chat.clone() },
            write: route.write,
            pick: route.pick,
            prompt: route.prompt.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "what", rename_all = "snake_case")]
pub enum Line {
    /// His tap on a card.
    Tap {
        id: String,
        at: DateTime<Utc>,
        approved: Approved,
    },
    /// The new chat a start made (so a retry reuses it, and no line can
    /// point a start at a chat of its own choosing).
    Made { id: String, chat: String },
    /// About to hand the prompt to the host.
    Sending { id: String, at: DateTime<Utc> },
    /// The host refused it; nothing went.
    Unsent { id: String },
    /// The host took it.
    Sent { id: String },
}

impl Line {
    fn id(&self) -> &str {
        match self {
            Line::Tap { id, .. }
            | Line::Made { id, .. }
            | Line::Sending { id, .. }
            | Line::Unsent { id }
            | Line::Sent { id } => id,
        }
    }
}

pub fn path_in(config: &Path) -> PathBuf {
    config.join(DIR).join(FILE)
}

static WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn append(config: &Path, line: &Line) -> Result<(), String> {
    use std::io::Write;
    let _held = WRITER.lock().unwrap_or_else(|p| p.into_inner());
    let path = path_in(config);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut text = serde_json::to_string(line).map_err(|e| e.to_string())?;
    text.push('\n');
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("his tap could not be recorded: {e}"))?;
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())
}

/// Where a send stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handed {
    /// Never handed to the host (or every try was refused).
    No,
    /// A `sending` with no outcome: cut off mid-send.
    CutOff,
    /// The host took it.
    Sent,
}

/// What this file says of one route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Book {
    /// His newest tap.
    pub tap: Option<Approved>,
    /// The chat its start made.
    pub made: Option<String>,
    pub handed: Handed,
}

impl Book {
    pub fn of(config: &Path, id: &str) -> Self {
        let text = std::fs::read_to_string(path_in(config)).unwrap_or_default();
        let mut book = Book {
            tap: None,
            made: None,
            handed: Handed::No,
        };
        for line in text
            .lines()
            .filter_map(|l| serde_json::from_str::<Line>(l).ok())
            .filter(|l| l.id() == id)
        {
            match line {
                Line::Tap { approved, .. } => book.tap = Some(approved),
                Line::Made { chat, .. } => book.made = Some(chat),
                Line::Sending { .. } if book.handed != Handed::Sent => {
                    book.handed = Handed::CutOff;
                }
                Line::Unsent { .. } if book.handed != Handed::Sent => book.handed = Handed::No,
                Line::Sent { .. } => book.handed = Handed::Sent,
                _ => {}
            }
        }
        book
    }
}
