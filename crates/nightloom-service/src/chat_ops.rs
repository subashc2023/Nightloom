//! The chat's own edits — reword, remove, restore, rewind, fork, continue,
//! delete, kind — as functions of a log, shared by the desktop's commands
//! and the away server (nightshift item 246 wave 4, 4A; the pattern
//! [`crate::agent_turn`] set for the turn in item 268).
//!
//! Each function here is the body a desktop command ran, lifted as it was:
//! it takes the chat's [`Session`] (and the folder its logs live in, where
//! it makes a new chat), plus [`OnCli`] when the chat runs on the Claude
//! Code engine — the folder the CLI files its history under and, on the
//! desktop, the live agent to point at the copy an edit makes. What only
//! the window owns stays in the desktop's command: the chat and agent
//! locks, the held set, events to the window. `serve` calls the same
//! functions with no live agent: its next turn reads the CLI handle off the
//! log ([`crate::serve::ServeHost::spec_for`]), which is where
//! [`CliChange::adopt`] records it either way.
//!
//! The rule every edit keeps (from the desktop, unchanged): the CLI copy is
//! made *before* the log's marker, so a refusal leaves the log as it was.

use std::path::{Path, PathBuf};

use nightloom_core::{ChatKind, ChatMode, Session, SessionEvent};
use serde::{Deserialize, Serialize};

use crate::agent::ClaudeCodeAgent;
use crate::agent::cli_session::{self, Block, CliSession, Target};
use crate::agent_turn::AGENT;
use crate::store;

/// A chat on the Claude Code engine: the folder its CLI history is filed
/// under (the agent's working directory), and the live agent to point at
/// a copy, when there is one. The desktop passes its connected agent;
/// `serve` has none between turns and passes only the folder.
pub struct OnCli<'a> {
    pub workspace: PathBuf,
    pub agent: Option<&'a mut ClaudeCodeAgent>,
}

impl<'a> OnCli<'a> {
    /// The desktop's case: the connected agent and its own folder.
    pub fn of(agent: &'a mut ClaudeCodeAgent) -> Self {
        Self {
            workspace: agent.spec().workspace.clone(),
            agent: Some(agent),
        }
    }

    /// `serve`'s case: the folder alone; the next turn resumes what the
    /// log records.
    pub fn at(workspace: PathBuf) -> Self {
        Self {
            workspace,
            agent: None,
        }
    }
}

/// The folder and the agent apart, as the bodies below read them.
fn split(cli: Option<OnCli<'_>>) -> (Option<PathBuf>, Option<&mut ClaudeCodeAgent>) {
    match cli {
        Some(c) => (Some(c.workspace), c.agent),
        None => (None, None),
    }
}

/// "Edit and save" (nightshift backlog 062; `block` backlog 066): an `Edit`
/// marker on the log — on the turn, or on one text block of a reply — and,
/// on Claude Code, the CLI's history rewritten by copy first. The desktop's
/// `edit_message` with `mode: "save"`; `"send"` is a [`fork`].
pub fn edit_saved(
    session: &mut Session,
    cli: Option<OnCli<'_>>,
    index: usize,
    text: String,
    block: Option<usize>,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("an edit cannot be empty; remove the turn instead".into());
    }
    if !session.is_editable(index) {
        return Err(
            "only user messages and assistant replies with text can be edited; a tool result can be removed instead".into(),
        );
    }
    let (workspace, agent) = split(cli);
    let change = match &workspace {
        Some(cwd) => {
            let target = cli_target(session, index)?;
            let nth = match block {
                Some(b) => match cli_block(session, index, b)? {
                    Block::Text(nth) => Some(nth),
                    Block::ToolUse(_) => {
                        return Err(format!(
                            "block {b} of event {index} is a tool call, which cannot be reworded; it can be removed"
                        ));
                    }
                },
                None => None,
            };
            let new_text = text.clone();
            edit_on_cli(session, cwd, move |cli| match nth {
                Some(nth) => cli.rewrite_block(&target, nth, &new_text).map(Some),
                None => cli.rewrite(&target, &new_text).map(Some),
            })?
        }
        None => CliChange::Untouched,
    };
    match block {
        Some(b) => session.edit_block(index, b, text)?,
        None => session.edit(index, text)?,
    }
    change.adopt(session, agent);
    Ok(())
}

/// Remove the turn at `index` from the context (backlog 062): the `Elide`
/// marker; on Claude Code the CLI's copy drops a text turn outright and
/// marks a turn with tool calls ([`CliSession::remove`]).
pub fn remove_message(
    session: &mut Session,
    cli: Option<OnCli<'_>>,
    index: usize,
) -> Result<(), String> {
    if !matches!(
        session.events().get(index),
        Some(SessionEvent::UserMessage { .. } | SessionEvent::AssistantMessage { .. })
    ) {
        return Err(format!(
            "event {index} is not a turn; the context panel removes tool results"
        ));
    }
    let (workspace, agent) = split(cli);
    let change = match &workspace {
        Some(cwd) => {
            let target = cli_target(session, index)?;
            edit_on_cli(session, cwd, move |cli| cli.remove(&target).map(Some))?
        }
        None => CliChange::Untouched,
    };
    session.elide([index])?;
    change.adopt(session, agent);
    Ok(())
}

/// Put back the turn [`remove_message`] took out (backlog 064): the
/// `Unelide` marker; on Claude Code a third copy with the turn's nodes back
/// from the file it was removed from ([`restore_on_cli`]).
pub fn restore_message(
    session: &mut Session,
    cli: Option<OnCli<'_>>,
    index: usize,
) -> Result<(), String> {
    if !session.elide_flags().get(index).copied().unwrap_or(false) {
        return Err(format!("event {index} is not removed from the context"));
    }
    let (workspace, agent) = split(cli);
    let change = match &workspace {
        Some(cwd) => restore_on_cli(session, cwd, index, None)?,
        None => CliChange::Untouched,
    };
    session.unelide([index])?;
    change.adopt(session, agent);
    Ok(())
}

/// Remove one block of the reply at `index` (backlog 066): a text block, or
/// a call with its result. A subagent's steps are the window's; the CLI
/// never had them, so its history is left alone for those.
pub fn remove_block(
    session: &mut Session,
    cli: Option<OnCli<'_>>,
    index: usize,
    block: usize,
) -> Result<(), String> {
    let (workspace, agent) = split(cli);
    let change = match &workspace {
        Some(_) if is_narrative_block(session, index, block) => CliChange::Untouched,
        Some(cwd) => {
            let target = cli_target(session, index)?;
            let which = cli_block(session, index, block)?;
            edit_on_cli(session, cwd, move |cli| {
                cli.remove_block(&target, &which).map(Some)
            })?
        }
        None => CliChange::Untouched,
    };
    session.elide_block(index, block)?;
    change.adopt(session, agent);
    Ok(())
}

/// Put back a block [`remove_block`] took out, on [`restore_message`]'s
/// terms.
pub fn restore_block(
    session: &mut Session,
    cli: Option<OnCli<'_>>,
    index: usize,
    block: usize,
) -> Result<(), String> {
    if !session
        .block_elisions()
        .get(index)
        .is_some_and(|gone| gone.contains(&block))
    {
        return Err(format!(
            "block {block} of event {index} is not removed from the context"
        ));
    }
    let (workspace, agent) = split(cli);
    let change = match &workspace {
        Some(cwd) => restore_on_cli(session, cwd, index, Some(block))?,
        None => CliChange::Untouched,
    };
    session.unelide_block(index, block)?;
    change.adopt(session, agent);
    Ok(())
}

/// Rewind to the turn at log index `to`: on Claude Code the CLI's file is
/// copied cut before that turn (found by its text, backlog 255) and the
/// copy resumed; the log gets its `Rewind` marker either way.
pub fn rewind(session: &mut Session, cli: Option<OnCli<'_>>, to: usize) -> Result<(), String> {
    let (workspace, agent) = split(cli);
    let (turns, before) = turn_texts(session, to)?;
    let change = match &workspace {
        Some(cwd) => edit_on_cli(session, cwd, |cli| {
            cli.truncate_by_text(&turns, before.as_deref())
        })?,
        None => CliChange::Untouched,
    };
    session.rewind(to)?;
    change.adopt(session, agent);
    Ok(())
}

/// Lift the rewind recorded at `of` (backlog 064): the `Unrewind` marker;
/// on Claude Code the chat goes back to resuming the id in force before the
/// rewind, recorded afresh (the desktop's `unrewind` has the reasoning).
pub fn unrewind(session: &mut Session, cli: Option<OnCli<'_>>, of: usize) -> Result<(), String> {
    session.unrewind(of)?;
    if let Some(cli) = cli {
        let before = agent_session_before(session, of);
        let current = session
            .agent_session()
            .filter(|(agent, _)| *agent == AGENT)
            .map(|(_, id)| id.to_string());
        let change = match (before, current) {
            (Some(b), Some(c)) if b == c => CliChange::Untouched,
            (Some(b), _) => CliChange::Resume(b),
            (None, Some(_)) => CliChange::Fresh,
            (None, None) => CliChange::Untouched,
        };
        change.adopt(session, cli.agent);
    }
    Ok(())
}

/// Fork `parent` before the user turn at `upto` (backlog 062) into a new
/// log in `log_dir`; the parent is untouched. On Claude Code the CLI's file
/// is copied cut before that turn and the copy's id recorded on the fork;
/// otherwise the fork's first turn opens a CLI conversation of its own.
/// The CLI copy comes first, so a refusal makes no fork.
pub fn fork(
    parent: &Session,
    log_dir: &Path,
    cli: Option<OnCli<'_>>,
    upto: usize,
) -> Result<Session, String> {
    let (workspace, mut agent) = split(cli);
    let (turns, before) = turn_texts(parent, upto)?;
    let change = match &workspace {
        Some(cwd) => edit_on_cli(parent, cwd, |cli| {
            cli.truncate_by_text(&turns, before.as_deref())
        })?,
        None => CliChange::Untouched,
    };
    let mut fork = parent.fork_from(log_dir, upto).map_err(|e| e.to_string())?;
    match change {
        // The fork carries no handle of the parent's, so anything but a
        // copy to resume means the fork's first turn opens a CLI
        // conversation of its own.
        CliChange::Untouched | CliChange::Fresh => {
            if let Some(agent) = agent.as_mut() {
                agent.set_resume(None);
            }
        }
        resume => resume.adopt(&mut fork, agent),
    }
    Ok(fork)
}

/// Continue `parent` in a fresh chat after a hand-off (backlog 086): empty,
/// in the same folder, linked by `forked_from` with `reason: "handoff"`,
/// with no CLI conversation to resume.
pub fn continue_from(
    parent: &Session,
    log_dir: &Path,
    agent: Option<&mut ClaudeCodeAgent>,
) -> Result<Session, String> {
    let next = parent.continued_from(log_dir).map_err(|e| e.to_string())?;
    if let Some(agent) = agent {
        agent.set_resume(None);
    }
    Ok(next)
}

/// Move the log at `path` (chat `full_id`) to `<log_dir>/trash/` — the
/// reversible delete (review round 1, 2026-09-13: no click may lose work
/// for good). The listing never descends into subdirectories, so the chat
/// leaves the list at once and stays on disk. A second deletion under one
/// id (a re-import) keeps both, the later stamped.
pub fn move_to_trash(log_dir: &Path, path: &Path, full_id: &str) -> Result<(), String> {
    let trash = log_dir.join("trash");
    std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .ok_or_else(|| "session log has no file name".to_string())?;
    let mut dest = trash.join(name);
    if dest.exists() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        dest = trash.join(format!("{full_id}.{stamp}.jsonl"));
    }
    std::fs::rename(path, &dest).map_err(|e| e.to_string())
}

/// Whether `<log_dir>/trash/` holds chat `id` (plain or stamped).
pub fn in_trash(log_dir: &Path, id: &str) -> bool {
    let trash = log_dir.join("trash");
    trash.join(format!("{id}.jsonl")).exists()
        || std::fs::read_dir(&trash).is_ok_and(|rd| {
            rd.filter_map(|e| e.ok()).any(|e| {
                e.file_name()
                    .to_str()
                    .is_some_and(|n| n.starts_with(&format!("{id}.")) && n.ends_with(".jsonl"))
            })
        })
}

/// Put a deleted chat back from `<log_dir>/trash/` (backlog 064, the undo
/// of a delete). `id` is the full id the delete returned; a chat deleted
/// twice under one id comes back newest first. Refused, with nothing
/// moved, when a live log already has the name.
pub fn restore_from_trash(log_dir: &Path, id: &str) -> Result<String, String> {
    // The id becomes two file names below; a `../name` would move a live
    // log out of the store (review 2026-09-17 FC-e, backlog 134).
    if !store::is_log_id(id) {
        return Err(format!("not a chat id: {id:?}"));
    }
    let trash = log_dir.join("trash");
    let plain = trash.join(format!("{id}.jsonl"));
    let stamped = std::fs::read_dir(&trash)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(&format!("{id}.")) && n.ends_with(".jsonl"))
                && *p != plain
        })
        .max();
    let source = match (plain.exists(), stamped) {
        (_, Some(newest)) => newest,
        (true, None) => plain,
        (false, None) => return Err(format!("no deleted chat {id} in the trash")),
    };
    let dest = log_dir.join(format!("{id}.jsonl"));
    if dest.exists() {
        return Err(format!(
            "a chat {id} already exists; the deleted one stays in the trash"
        ));
    }
    std::fs::rename(&source, &dest).map_err(|e| e.to_string())?;
    Ok(id.to_string())
}

/// The folder a switch to Claude Code names, checked (backlog 144): blank
/// is none, and one that is not a directory is refused.
pub fn kind_folder(workspace: Option<String>) -> Result<Option<PathBuf>, String> {
    let workspace = workspace
        .map(|w| w.trim().to_string())
        .filter(|w| !w.is_empty())
        .map(PathBuf::from);
    if let Some(dir) = &workspace
        && !dir.is_dir()
    {
        return Err(format!("{} is not a folder", dir.display()));
    }
    Ok(workspace)
}

/// Make the chat the other kind from the next turn on (backlog 144): a
/// `kind` event on the log, the latest live one winning.
pub fn set_kind(session: &mut Session, kind: ChatKind, workspace: Option<PathBuf>) {
    session.record_kind(kind, workspace);
}

// ---- the CLI's history, by copy (moved from the desktop's main.rs) ----

/// The Claude Code session id in force just before the marker at `at`:
/// the latest live `AgentSession` line recorded before it. `None` when
/// the chat had no CLI session then.
pub fn agent_session_before(session: &Session, at: usize) -> Option<String> {
    session
        .live_events()
        .into_iter()
        .rev()
        .filter(|(i, _)| *i < at)
        .find_map(|(_, e)| match e {
            SessionEvent::AgentSession { agent, id, .. } if agent == AGENT => Some(id.clone()),
            _ => None,
        })
}

/// What an edit did to Claude Code's history, for the log and the agent
/// to follow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliChange {
    /// No CLI session behind this chat; the marker is the whole edit.
    Untouched,
    /// A copy under this id; the next turn resumes it.
    Resume(String),
    /// The cut left the CLI no turn to resume; the next turn starts a
    /// conversation of its own, and the chat records it when it lands.
    Fresh,
}

impl CliChange {
    /// Record the new handle on `session` and point the agent at it.
    /// `Fresh` records nothing — an id is written after the turn that
    /// opened it, as `send_agent` does — and lets the agent go of the old.
    pub fn adopt(self, session: &mut Session, agent: Option<&mut ClaudeCodeAgent>) {
        match self {
            CliChange::Untouched => {}
            CliChange::Resume(id) => {
                session.record_agent_session(AGENT, &id);
                if let Some(agent) = agent {
                    agent.set_resume(Some(id));
                }
            }
            CliChange::Fresh => {
                if let Some(agent) = agent {
                    agent.set_resume(None);
                }
            }
        }
    }
}

/// How many live user turns follow event `index` — the "from the newest"
/// count [`Target`] addresses a CLI node by. For an assistant reply it is
/// counted from the user turn that produced it.
pub fn turns_after(session: &Session, index: usize) -> Result<usize, String> {
    let live = session.live_events();
    let turn = live
        .iter()
        .rposition(|(i, e)| *i <= index && matches!(e, SessionEvent::UserMessage { .. }))
        .ok_or_else(|| format!("event {index} is not part of a turn"))?;
    Ok(live[turn + 1..]
        .iter()
        .filter(|(_, e)| matches!(e, SessionEvent::UserMessage { .. }))
        .count())
}

/// What the log's live user turns read now (edits applied), from the turn
/// event `index` belongs to through the newest, and the turn just before
/// it — what [`CliSession::truncate_by_text`] finds the cut by (nightshift
/// backlog 255), in place of the count [`turns_after`] gives, which a turn
/// the CLI never recorded throws off by one.
pub fn turn_texts(
    session: &Session,
    index: usize,
) -> Result<(Vec<String>, Option<String>), String> {
    let edited = session.edit_texts();
    let users: Vec<(usize, String)> = session
        .live_events()
        .into_iter()
        .filter_map(|(i, e)| match e {
            SessionEvent::UserMessage { text, .. } => {
                Some((i, edited[i].unwrap_or(text).to_string()))
            }
            _ => None,
        })
        .collect();
    let turn = users
        .iter()
        .rposition(|(i, _)| *i <= index)
        .ok_or_else(|| format!("event {index} is not part of a turn"))?;
    Ok((
        users[turn..].iter().map(|(_, t)| t.clone()).collect(),
        turn.checked_sub(1).map(|b| users[b].1.clone()),
    ))
}

/// The CLI node that stands for event `index`, addressed from the newest
/// turn and by the text the log projects for it now — the check that
/// keeps an edit from landing on the wrong node when the two histories
/// have drifted (a chat that ran on the other engine first, a turn the
/// CLI never saw).
pub fn cli_target(session: &Session, index: usize) -> Result<Target, String> {
    let from_last = turns_after(session, index)?;
    let edited = session.edit_texts();
    match session.events().get(index) {
        Some(SessionEvent::UserMessage { text, .. }) => Ok(Target::User {
            from_last,
            text: edited[index].unwrap_or(text).to_string(),
        }),
        // The reply's text as its per-block markers leave it (backlog
        // 066): edits applied, removed blocks out, removed calls leaving
        // no mark — which is what the CLI's copy reads after the same
        // edits, so the two histories still agree on the reply.
        //
        // Without the subagents' narratives (nightshift item 252): the
        // recorder writes one `<subagent …>` text block per running child
        // into each round of the parent's reply, for the window; the CLI's
        // file never has them, so a reply with any never matched and every
        // edit of it refused.
        Some(SessionEvent::AssistantMessage { .. }) => Ok(Target::Assistant {
            from_last,
            text: cli_reply_text(session, index),
        }),
        Some(_) => Err(format!(
            "event {index} is not a user message or an assistant reply"
        )),
        None => Err(format!("no event at {index}")),
    }
}

/// What the CLI's copy of the reply at `index` reads: `Session::reply_text`
/// (edits applied, removed blocks out) less the subagents' narratives,
/// which are the window's and never the model's (item 252).
pub fn cli_reply_text(session: &Session, index: usize) -> String {
    let Some(SessionEvent::AssistantMessage { blocks, .. }) = session.events().get(index) else {
        return String::new();
    };
    let edits = session.block_edits();
    let gone = session.block_elisions();
    let mut out = String::new();
    for (n, b) in blocks.iter().enumerate() {
        if gone[index].contains(&n) || b.is_subagent_narrative() {
            continue;
        }
        if let nightloom_core::ContentBlock::Text { text } = b {
            out.push_str(edits[index].get(&n).copied().unwrap_or(text.as_str()));
        }
    }
    if let Some(text) = edits[index].get(&blocks.len()) {
        out.push_str(text);
    }
    out
}

/// Whether block `block` of the reply at `index` is a subagent's narrative
/// (item 252): the window's alone, so removing or restoring it changes
/// nothing in the CLI's file.
pub fn is_narrative_block(session: &Session, index: usize, block: usize) -> bool {
    matches!(
        session.events().get(index),
        Some(SessionEvent::AssistantMessage { blocks, .. })
            if blocks.get(block).is_some_and(|b| b.is_subagent_narrative())
    )
}

/// The CLI's address for block `block` of the reply at `index`
/// (nightshift backlog 066): a text block by its count among the reply's
/// text blocks, a call by its id — the two things both histories agree
/// on. Refuses anything else, as the core's `edit_block` / `elide_block`
/// would.
pub fn cli_block(session: &Session, index: usize, block: usize) -> Result<Block, String> {
    let Some(SessionEvent::AssistantMessage { blocks, .. }) = session.events().get(index) else {
        return Err(format!("event {index} is not a reply"));
    };
    match blocks.get(block) {
        // Counted among the text blocks the CLI's copy has (item 252): not
        // the subagents' narratives, which it never had, and not a text
        // block already removed, which its copy dropped when it was.
        Some(b) if b.is_subagent_narrative() => Err(format!(
            "block {block} of event {index} is a subagent's steps, which Claude Code's history does not hold"
        )),
        Some(nightloom_core::ContentBlock::Text { .. }) => {
            let gone = session.block_elisions();
            Ok(Block::Text(
                blocks[..block]
                    .iter()
                    .enumerate()
                    .filter(|(n, b)| {
                        matches!(b, nightloom_core::ContentBlock::Text { .. })
                            && !b.is_subagent_narrative()
                            && !gone[index].contains(n)
                    })
                    .count(),
            ))
        }
        Some(nightloom_core::ContentBlock::ToolUse { id, .. }) => Ok(Block::ToolUse(id.clone())),
        Some(_) => Err(format!(
            "block {block} of event {index} is not text or a tool call"
        )),
        None => Err(format!("event {index} has no block {block}")),
    }
}

/// Change Claude Code's history to match an edit to the log, by copy.
///
/// The log this session is a record of has a CLI session behind it
/// (`SessionEvent::AgentSession`); `change` is applied to a parse of that
/// file and the result written beside it under a fresh id, which comes
/// back as [`CliChange::Resume`] for the caller to record and resume. The
/// original file is never opened for writing. `Untouched` when there is
/// no CLI session to change — an ephemeral chat, whose turns the shell
/// replays itself, or a chat that has not yet run a turn on this engine
/// — so the marker alone is the edit, as on the other engine; `Fresh`
/// when `change` cut every turn the CLI had.
///
/// Refusals are the module's own sentences, shown as notices: a file
/// written by a CLI whose shape this build was not measured against, a
/// turn the CLI's history does not have, a file that is not where it
/// should be.
pub fn edit_on_cli(
    session: &Session,
    workspace: &Path,
    change: impl FnOnce(&CliSession) -> Result<Option<CliSession>, cli_session::CliSessionError>,
) -> Result<CliChange, String> {
    // An ephemeral chat has a CLI session id — the CLI reports one even
    // under `--no-session-persistence` — but no file behind it, and the
    // next turn replays the log anyway; the id alone was read as "a file
    // to edit" and rewind on one refused (his report, 2026-09-17).
    if session.mode() == ChatMode::Ephemeral {
        return Ok(CliChange::Untouched);
    }
    let Some(id) = session
        .agent_session()
        .filter(|(agent, _)| *agent == AGENT)
        .map(|(_, id)| id.to_string())
    else {
        return Ok(CliChange::Untouched);
    };
    let projects = cli_session::projects_dir()
        .ok_or_else(|| "no home directory, so no ~/.claude/projects to look in".to_string())?;
    edit_cli_file(&projects, workspace, &id, change)
}

/// The pure half of [`edit_on_cli`]: the projects root is a parameter so a
/// test can point it at a directory of its own.
pub fn edit_cli_file(
    projects: &Path,
    workspace: &Path,
    id: &str,
    change: impl FnOnce(&CliSession) -> Result<Option<CliSession>, cli_session::CliSessionError>,
) -> Result<CliChange, String> {
    let path = cli_session::find(projects, workspace, id).map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed = CliSession::parse(&text).map_err(|e| e.to_string())?;
    match change(&parsed).map_err(|e| e.to_string())? {
        Some(edited) => cli_session::write_copy(&path, &edited)
            .map(CliChange::Resume)
            .map_err(|e| e.to_string()),
        None => Ok(CliChange::Fresh),
    }
}

/// What an edit to a turn changed: the transcript, and the id of the chat
/// now open — the same one, or the fork.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEdit {
    pub events: Vec<SessionEvent>,
    /// The open chat's id after the edit. Differs from the one before
    /// exactly when a fork was made (`mode: "send"`, `fork_session`), and
    /// the UI then sends the edited text as that chat's next turn.
    pub session: String,
    /// Whether a fork was made.
    pub forked: bool,
}

/// [`edit_on_cli`]'s counterpart for a restore: the current file and the
/// one the turn was removed from, the turn's nodes put back, a copy
/// written. `Untouched` when the chat has no CLI session now, or had none
/// when the turn was removed (no `AgentSession` before the marker, or the
/// same one as now — the removal then made no copy). With `block`, the
/// marker looked for is the one that named that block of the reply, and
/// only that block's nodes come back.
pub fn restore_on_cli(
    session: &Session,
    workspace: &Path,
    index: usize,
    block: Option<usize>,
) -> Result<CliChange, String> {
    // As in `edit_on_cli`: an ephemeral chat has an id but no file.
    if session.mode() == ChatMode::Ephemeral {
        return Ok(CliChange::Untouched);
    }
    let Some(current) = session
        .agent_session()
        .filter(|(agent, _)| *agent == AGENT)
        .map(|(_, id)| id.to_string())
    else {
        return Ok(CliChange::Untouched);
    };
    let marker = session
        .live_events()
        .into_iter()
        .rev()
        .find(|(_, e)| {
            matches!(e, SessionEvent::Elide { targets, block: b, .. } if targets.contains(&index) && *b == block)
        })
        .map(|(i, _)| i)
        .ok_or_else(|| format!("event {index} is not removed from the context"))?;
    let Some(original) = agent_session_before(session, marker).filter(|id| *id != current) else {
        return Ok(CliChange::Untouched);
    };
    if block.is_some_and(|b| is_narrative_block(session, index, b)) {
        return Ok(CliChange::Untouched);
    }
    let target = cli_target(session, index)?;
    let which = block.map(|b| cli_block(session, index, b)).transpose()?;
    let projects = cli_session::projects_dir()
        .ok_or_else(|| "no home directory, so no ~/.claude/projects to look in".to_string())?;
    restore_cli_file(
        &projects,
        workspace,
        &current,
        &original,
        &target,
        which.as_ref(),
    )
}

/// The pure half of [`restore_on_cli`], with the projects root as a
/// parameter for the test's sake, like [`edit_cli_file`].
pub fn restore_cli_file(
    projects: &Path,
    workspace: &Path,
    current: &str,
    original: &str,
    target: &Target,
    block: Option<&Block>,
) -> Result<CliChange, String> {
    let read = |id: &str| -> Result<(PathBuf, CliSession), String> {
        let path = cli_session::find(projects, workspace, id).map_err(|e| e.to_string())?;
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let parsed = CliSession::parse(&text).map_err(|e| e.to_string())?;
        Ok((path, parsed))
    };
    let (path, current) = read(current)?;
    let (_, original) = read(original)?;
    let restored = match block {
        Some(block) => current.restore_block(&original, target, block),
        None => current.restore(&original, target),
    }
    .map_err(|e| e.to_string())?;
    cli_session::write_copy(&path, &restored)
        .map(CliChange::Resume)
        .map_err(|e| e.to_string())
}
