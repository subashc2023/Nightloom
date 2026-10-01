//! Continuing a Mac chat from the phone = a fork (blocker 652), and the
//! one rewrite both directions need: a Claude Code session file moved to a
//! machine whose folders differ.
//!
//! The CLI keys a conversation by the folder it ran in:
//! `<claude>/projects/<slug of cwd>/<session id>.jsonl`, and each node in
//! the file records that `cwd`. `--resume <id>` looks under the slug of the
//! folder it is run in. So a session file that moves to another machine is
//! copied (never moved, never edited in place — the rule
//! `agent/cli_session.rs` follows for rewinds) with its `cwd` fields
//! rewritten to the new folder, and placed under the new folder's slug.
//!
//! `not measured`: whether the CLI resumes such a copy and keeps the whole
//! conversation. The research note's §4.4 makes that step 2's check on the
//! Fly box; `notes/runner-design/268-step2-report-2026-09-30.md` did not
//! exist when this was built. The rewrite is tested on a fixture of the
//! measured 2.1.263 shape only.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use nightloom_core::Session;
use serde_json::Value;

use crate::agent::cli_session::{self, CliSession, CliSessionError};
use crate::agent_turn::AGENT;

/// A Claude Code session file's text with every `cwd` that is `from` (or
/// under it) moved to `to`, and every `sessionId` set to `id` when one is
/// given. `from` is the file's own: the `cwd` of its first node.
///
/// Refuses (as `cli_session` does) a file whose shape or major version is
/// not the measured one, rather than writing a copy that reads back as
/// something else. Lines with nothing to change go out byte for byte; a
/// changed line is re-serialized, which the CLI reads the same
/// (`cli_session::CliSession::render_as`'s note).
pub fn rewrite_cli(text: &str, to: &Path, id: Option<&str>) -> Result<String, CliSessionError> {
    CliSession::parse(text)?;
    let to = to.to_string_lossy().into_owned();
    let mut from: Option<String> = None;
    let mut out = String::with_capacity(text.len());
    for raw in text.lines() {
        let raw = raw.trim_end_matches('\r');
        if raw.trim().is_empty() {
            continue;
        }
        let mut json: Value = serde_json::from_str(raw)
            .map_err(|e| CliSessionError::Shape(format!("a line is not JSON: {e}")))?;
        let mut dirty = false;
        if let Some(obj) = json.as_object_mut() {
            if let Some(Value::String(cwd)) = obj.get("cwd") {
                if from.is_none() && obj.get("uuid").is_some() {
                    from = Some(cwd.clone());
                }
                if let Some(f) = &from {
                    let moved = if cwd == f {
                        Some(to.clone())
                    } else {
                        cwd.strip_prefix(&format!("{f}/"))
                            .map(|rest| format!("{to}/{rest}"))
                    };
                    if let Some(m) = moved
                        && m != *cwd
                    {
                        obj.insert("cwd".into(), Value::String(m));
                        dirty = true;
                    }
                }
            }
            if let Some(id) = id
                && let Some(Value::String(old)) = obj.get("sessionId")
                && old != id
            {
                obj.insert("sessionId".into(), Value::String(id.to_string()));
                dirty = true;
            }
        }
        if dirty {
            out.push_str(&serde_json::to_string(&json).expect("a Value serializes"));
        } else {
            out.push_str(raw);
        }
        out.push('\n');
    }
    Ok(out)
}

/// Write `bytes` at `dest` only if nothing is there: through a temp file
/// beside it and a hard link, which fails rather than replaces. An
/// existing file with the same bytes is not an error (a pass that placed it
/// and was cut off before saying so); a different one is.
pub fn place_new(dest: &Path, bytes: &[u8]) -> io::Result<Placement> {
    if let Ok(existing) = fs::read(dest) {
        return if existing == bytes {
            Ok(Placement::AlreadyThere)
        } else {
            Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!(
                    "{} already exists with other contents; it was left as it is",
                    dest.display()
                ),
            ))
        };
    }
    let dir = dest
        .parent()
        .ok_or_else(|| io::Error::other("a destination with no folder"))?;
    fs::create_dir_all(dir)?;
    let name = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.{}.part", uuid::Uuid::new_v4()));
    {
        let mut f = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    let linked = fs::hard_link(&tmp, dest);
    let _ = fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(Placement::Written),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => place_new(dest, bytes),
        Err(e) => Err(e),
    }
}

/// What [`place_new`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    Written,
    AlreadyThere,
}

/// What a fork is made from and where it goes.
#[derive(Debug, Clone)]
pub struct ForkPlan {
    /// The log being continued (a mirrored chat, or a server chat the Mac
    /// has taken down). Read, never written.
    pub source_log: PathBuf,
    /// Where the CLI session file the log names is looked for (the
    /// mirror's `claude/` for a mirrored chat; the server's own CLI
    /// projects folder for a server chat).
    pub source_claude: PathBuf,
    /// The server-owned sessions folder the fork's log goes in:
    /// `<home>/projects/<project id>/sessions` (or `unfiled/sessions`), so
    /// it comes down to the same project on the Mac.
    pub dest_sessions: PathBuf,
    /// The server's CLI projects folder (`~/.claude/projects` of the user
    /// `serve` runs as).
    pub dest_claude: PathBuf,
    /// The folder the fork's turns run in on the server.
    pub cwd: PathBuf,
}

/// The fork that was made.
#[derive(Debug, Clone)]
pub struct Forked {
    /// The new chat's id (its log's file stem).
    pub chat: String,
    pub log: PathBuf,
    /// The CLI session the fork resumes, when the original had one and its
    /// file was found.
    pub cli_session: Option<String>,
    pub cli_file: Option<PathBuf>,
    /// Said to the phone when the fork could not carry the CLI's history
    /// (the file was not sent, or is a shape this build refuses): the reply
    /// then starts from the log alone.
    pub warning: Option<String>,
}

/// Fork the chat at `plan.source_log` into a new server-owned chat.
///
/// The log is copied whole under a fresh id, its creation line naming the
/// original and the cut at its whole length with `reason: "away"`; the
/// CLI session file it names is copied under a fresh session id with its
/// folder rewritten to `plan.cwd` ([`rewrite_cli`]), and the copy's handle
/// recorded on the new log, so the fork's first turn resumes the copy.
/// The original log and session file are opened for reading only.
pub fn fork(plan: &ForkPlan) -> Result<Forked, String> {
    let raw = fs::read_to_string(&plan.source_log)
        .map_err(|e| format!("{}: {e}", plan.source_log.display()))?;
    let parent = Session::load(&plan.source_log)
        .map_err(|e| format!("{}: {e}", plan.source_log.display()))?;
    let id = uuid::Uuid::new_v4().to_string();
    let text = refork_log(&raw, &parent.id, &id, parent.events().len())?;
    let log = plan.dest_sessions.join(format!("{id}.jsonl"));
    place_new(&log, text.as_bytes()).map_err(|e| e.to_string())?;

    let mut forked = Forked {
        chat: id,
        log: log.clone(),
        cli_session: None,
        cli_file: None,
        warning: None,
    };
    let Some((agent, sid)) = parent.agent_session() else {
        return Ok(forked);
    };
    if agent != AGENT {
        return Ok(forked);
    }
    let copied = (|| -> Result<(String, PathBuf), String> {
        let found =
            cli_session::find(&plan.source_claude, &plan.cwd, sid).map_err(|e| e.to_string())?;
        let text = fs::read_to_string(&found).map_err(|e| format!("{}: {e}", found.display()))?;
        let new_sid = uuid::Uuid::new_v4().to_string();
        let moved = rewrite_cli(&text, &plan.cwd, Some(&new_sid)).map_err(|e| e.to_string())?;
        let dest = plan
            .dest_claude
            .join(cli_session::project_folder(&plan.cwd))
            .join(format!("{new_sid}.jsonl"));
        place_new(&dest, moved.as_bytes()).map_err(|e| e.to_string())?;
        Ok((new_sid, dest))
    })();
    match copied {
        Ok((new_sid, dest)) => {
            let mut session = Session::load(&log).map_err(|e| format!("{}: {e}", log.display()))?;
            session.record_agent_session(AGENT, new_sid.clone());
            if let Some(f) = session.write_failure() {
                return Err(format!("the fork's log could not be written: {f:?}"));
            }
            forked.cli_session = Some(new_sid);
            forked.cli_file = Some(dest);
        }
        Err(e) => {
            forked.warning = Some(format!(
                "this chat continues as a copy, but Claude Code's own history of it did not \
                 come with it ({e}); the reply starts from the transcript alone"
            ));
        }
    }
    Ok(forked)
}

/// The log's text under the new id: the creation line's `id` replaced and
/// `forked_from` set to the parent at `cut` with reason `away`; every
/// other line byte for byte.
fn refork_log(raw: &str, parent: &str, id: &str, cut: usize) -> Result<String, String> {
    // A torn last record (the Mac sent the file mid-append) is left out: it
    // is what `Session::load` would cut on the first append anyway.
    let raw = match raw.rfind('\n') {
        Some(end) if end + 1 < raw.len() => &raw[..=end],
        _ => raw,
    };
    let mut out = String::with_capacity(raw.len() + 128);
    let mut done = false;
    for line in raw.split_inclusive('\n') {
        if !done && !line.trim().is_empty() {
            let mut json: Value = serde_json::from_str(line.trim_end())
                .map_err(|e| format!("the chat's first line is not JSON: {e}"))?;
            let obj = json
                .as_object_mut()
                .filter(|o| o.get("event").and_then(Value::as_str) == Some("session_created"))
                .ok_or("the chat's log does not begin with its creation line")?;
            obj.insert("id".into(), Value::String(id.into()));
            obj.insert(
                "forked_from".into(),
                serde_json::json!({ "session": parent, "index": cut, "reason": crate::sync::FORK_REASON }),
            );
            out.push_str(&serde_json::to_string(&json).expect("a Value serializes"));
            out.push('\n');
            done = true;
            continue;
        }
        out.push_str(line);
    }
    if !done {
        return Err("the chat's log is empty".into());
    }
    if !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}
