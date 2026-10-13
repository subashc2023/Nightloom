//! Down: chats started on the away server come home (item 268 step 3,
//! §4.3).
//!
//! For each chat in the server's outbox the Mac copies the Nightloom log
//! into the chat's project (unfiled when the Mac has no such project) and
//! the CLI session file into the CLI's folder for the folder the chat will
//! run in on the Mac, its `cwd` fields rewritten for the Mac
//! ([`super::fork::rewrite_cli`]). Never over an existing file — the chat
//! id is the server's, so it is new here; a file already holding the same
//! bytes is a pass that was cut off before it acknowledged, and counts as
//! placed. Then it acknowledges what it placed, and the server's copy goes
//! read-only.

use std::path::{Path, PathBuf};

use nightloom_core::{ChatKind, Session};
use serde::Serialize;

use super::Client;
use super::fork::{Placement, place_new, rewrite_cli};
use super::manifest;
use super::mirror::{AckRequest, OutboxEntry};
use crate::agent::cli_session;
use crate::project::Project;

/// Where the Mac keeps things, for [`place`].
#[derive(Debug, Clone)]
pub struct MacSide {
    /// Every project on the Mac (marked or not: a chat started on the
    /// server in a project comes home to it).
    pub projects: Vec<Project>,
    /// `<config>/unfiled/sessions`.
    pub unfiled_sessions: PathBuf,
    /// The CLI's projects folder (`cli_session::projects_dir()`).
    pub claude_projects: PathBuf,
    /// The folder a Chat-kind chat runs in (`prompt::chat_dir()`).
    pub chat_dir: Option<PathBuf>,
    /// The folder an unfiled Build chat runs in on the Mac (the home
    /// folder: the desktop's fallback when no project is open).
    pub unfiled_cwd: PathBuf,
}

impl MacSide {
    /// The folder a chat of `kind` in `project` runs in on the Mac — where
    /// its CLI session file must sit for `--resume` to find it.
    pub fn cwd_for(&self, project: Option<&Project>, kind: ChatKind) -> PathBuf {
        match kind {
            ChatKind::Chat => self
                .chat_dir
                .clone()
                .unwrap_or_else(|| self.unfiled_cwd.clone()),
            _ => project
                .map(Project::workspace_dir)
                .unwrap_or_else(|| self.unfiled_cwd.clone()),
        }
    }
}

/// What became of one outbox chat on the Mac.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Placed {
    pub chat: String,
    pub log: PathBuf,
    pub cli: Option<PathBuf>,
    /// Filed under unfiled because the Mac has no project of that id.
    pub unfiled_instead: bool,
}

/// Place one chat: the CLI file first (an orphan session file is harmless;
/// a log whose session is missing is not), then the log.
pub fn place(
    mac: &MacSide,
    entry: &OutboxEntry,
    log: &[u8],
    cli: Option<&[u8]>,
) -> Result<Placed, String> {
    if !crate::store::is_log_id(&entry.chat) {
        return Err(format!("{:?} is not a chat id", entry.chat));
    }
    if manifest::sha256_hex(log) != entry.log_sha256 {
        return Err(format!(
            "chat {} changed on the server while it was copied; it comes next time",
            entry.chat
        ));
    }
    let project = entry
        .project
        .as_deref()
        .and_then(|id| mac.projects.iter().find(|p| p.id == id));
    let unfiled_instead = entry.project.is_some() && project.is_none();
    let dir = project
        .map(Project::session_dir)
        .unwrap_or_else(|| mac.unfiled_sessions.clone());
    let dest_log = dir.join(format!("{}.jsonl", entry.chat));

    // The kind decides the folder the CLI file belongs under; read off the
    // bytes in hand, through a scratch copy (`Session::load` reads a path).
    let kind = {
        let scratch = std::env::temp_dir().join(format!(
            "nightloom-pull-{}-{}.jsonl",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&scratch, log).map_err(|e| e.to_string())?;
        let kind = Session::load(&scratch).map(|s| s.declared_kind());
        let _ = std::fs::remove_file(&scratch);
        kind.map_err(|e| format!("chat {}'s log could not be read: {e}", entry.chat))?
    };

    let mut cli_dest = None;
    if let (Some(meta), Some(bytes)) = (&entry.cli, cli) {
        if manifest::sha256_hex(bytes) != meta.sha256 {
            return Err(format!(
                "chat {}'s Claude Code file changed on the server while it was copied; it comes \
                 next time",
                entry.chat
            ));
        }
        if !meta
            .session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
            || meta.session_id.is_empty()
        {
            return Err(format!("{:?} is not a session id", meta.session_id));
        }
        let text = String::from_utf8(bytes.to_vec())
            .map_err(|_| format!("chat {}'s Claude Code file is not text", entry.chat))?;
        let cwd = mac.cwd_for(project, kind);
        let moved = rewrite_cli(&text, &cwd, None).map_err(|e| e.to_string())?;
        let dest = mac
            .claude_projects
            .join(cli_session::project_folder(&cwd))
            .join(format!("{}.jsonl", meta.session_id));
        place_new(&dest, moved.as_bytes()).map_err(|e| e.to_string())?;
        cli_dest = Some(dest);
    }
    match place_new(&dest_log, log).map_err(|e| e.to_string())? {
        Placement::Written | Placement::AlreadyThere => {}
    }
    Ok(Placed {
        chat: entry.chat.clone(),
        log: dest_log,
        cli: cli_dest,
        unfiled_instead,
    })
}

/// What a pull did.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct PullReport {
    pub placed: Vec<Placed>,
    /// Chats left on the server this time, in words.
    pub skipped: Vec<String>,
}

/// Read the outbox, place each chat, acknowledge what was placed.
pub async fn run(client: &Client, mac: &MacSide) -> Result<PullReport, String> {
    let outbox: Vec<OutboxEntry> = client.get_json("outbox").await?;
    let mut report = PullReport::default();
    for entry in outbox {
        if !crate::store::is_log_id(&entry.chat) {
            report
                .skipped
                .push(format!("{:?} is not a chat id", entry.chat));
            continue;
        }
        let log = match client
            .get_bytes(&format!("outbox/{}/log", entry.chat))
            .await
        {
            Ok(b) => b,
            Err(e) => {
                report.skipped.push(format!("chat {}: {e}", entry.chat));
                continue;
            }
        };
        let cli = match &entry.cli {
            None => None,
            Some(_) => match client
                .get_bytes(&format!("outbox/{}/cli", entry.chat))
                .await
            {
                Ok(b) => Some(b),
                Err(e) => {
                    report.skipped.push(format!("chat {}: {e}", entry.chat));
                    continue;
                }
            },
        };
        let mac = mac.clone();
        let placed = tokio::task::spawn_blocking(move || {
            place(&mac, &entry, &log, cli.as_deref()).map_err(|e| (entry.chat.clone(), e))
        })
        .await
        .map_err(|e| e.to_string())?;
        match placed {
            Ok(p) => report.placed.push(p),
            Err((chat, e)) => report.skipped.push(format!("chat {chat}: {e}")),
        }
    }
    if !report.placed.is_empty() {
        client
            .post_empty(
                "ack",
                &AckRequest {
                    chats: report.placed.iter().map(|p| p.chat.clone()).collect(),
                },
            )
            .await?;
    }
    Ok(report)
}

/// The Mac's [`MacSide`] for a config dir and its projects.
pub fn mac_side(config: &Path, projects: Vec<Project>) -> MacSide {
    MacSide {
        projects,
        unfiled_sessions: config.join("unfiled").join(crate::project::SESSIONS_DIR),
        claude_projects: cli_session::projects_dir().unwrap_or_else(|| config.join("claude")),
        chat_dir: crate::prompt::chat_dir(),
        unfiled_cwd: std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| config.to_path_buf()),
    }
}
