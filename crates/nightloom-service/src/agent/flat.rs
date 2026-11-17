//! A new chat's reminders in its first user message, not in a system
//! message after it (nightshift item 758, 2026-11-16).
//!
//! Measured (nightshift `wave-k-cachemiss2-report-2026-11-16.md`): the CLI
//! (2.1.325–2.1.326) sends the environment, skills list, deferred tools,
//! hook context and date of each turn as a role `system` message *after*
//! the user's message, and puts the request's last cache breakpoint on it.
//! The next request then reads the cache only up to the turn before: on
//! turn 1 that turn is the whole CLAUDE.md + environment block, so a new
//! chat's second request read 23,165 of 32,533 (71%) and re-wrote ~9.4k —
//! on a turn and a keep-warm ping alike; every later turn re-wrote its own
//! ~100 tokens. The CLI's capability switch `-mid_conv_system` (in
//! `CLAUDE_CODE_MODEL_CAPABILITIES`) puts those reminders back inside the
//! user's message, and the second request reads everything (36,509 of
//! 36,509).
//!
//! The switch changes how the CLI renders the *whole* history, so a
//! session must keep the shape it started with: an old session resumed
//! with it re-rendered and re-wrote everything (27,012 read, 15,858
//! written of ~43k; on a 300k chat, 300k), and so did a switched session
//! resumed without it. So it is on only for a process that starts a new
//! session, and for one resuming a session this file marked as started
//! that way — a mark per session id in `<config>/flat-sessions/`, set when
//! such a process ends with its session on disk, and carried to a fork's
//! new id and to a rewind's copy. Every session that predates this keeps
//! the CLI's default, exactly as before.

use std::path::{Path, PathBuf};

/// The CLI's per-model capability overrides: `model=cap,-cap;…`, an entry
/// with no `model=` applying to every model.
pub const CAPS_ENV: &str = "CLAUDE_CODE_MODEL_CAPABILITIES";
/// Mid-conversation system messages off.
pub const MID_CONV_OFF: &str = "-mid_conv_system";
const DIR: &str = "flat-sessions";

/// A session id is a file name here: letters, digits and dashes only.
fn plain(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn dir() -> Option<PathBuf> {
    crate::project::config_dir().map(|d| d.join(DIR))
}

/// Whether session `id` started with the reminders in the user's message.
pub fn is_flat(id: &str) -> bool {
    dir().is_some_and(|d| is_flat_in(&d, id))
}

pub fn is_flat_in(dir: &Path, id: &str) -> bool {
    plain(id) && dir.join(id).is_file()
}

/// Mark `id` as started flat — only when the CLI saved it (a
/// `--no-session-persistence` process, or a test's made-up id, has no
/// transcript and is never resumed). Best-effort: an unwritable folder
/// leaves the session on the CLI's default next time, one re-write.
pub fn mark(id: &str) {
    let saved = crate::agent::cli_session::projects_dir()
        .and_then(|p| crate::session_figures::find_transcript(&p, id))
        .is_some();
    if saved && let Some(d) = dir() {
        let _ = mark_in(&d, id);
    }
}

pub fn mark_in(dir: &Path, id: &str) -> std::io::Result<()> {
    if !plain(id) {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(id), b"")
}

/// A copy Nightloom wrote of `from` under `to` (a rewind) keeps its shape.
pub fn inherit(from: &str, to: &str) {
    if let Some(d) = dir()
        && is_flat_in(&d, from)
    {
        let _ = mark_in(&d, to);
    }
}

/// The variable's value: the switch, after whatever he set himself.
pub fn caps_value(inherited: Option<&str>) -> String {
    match inherited.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) if v.split(';').any(|e| e.trim() == MID_CONV_OFF) => v.to_string(),
        Some(v) => format!("{v};{MID_CONV_OFF}"),
        None => MID_CONV_OFF.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_switch_follows_his_own_overrides() {
        assert_eq!(caps_value(None), "-mid_conv_system");
        assert_eq!(caps_value(Some("  ")), "-mid_conv_system");
        assert_eq!(
            caps_value(Some("claude-opus*=foo")),
            "claude-opus*=foo;-mid_conv_system"
        );
        assert_eq!(caps_value(Some("a;-mid_conv_system")), "a;-mid_conv_system");
    }

    #[test]
    fn a_mark_is_per_session_and_never_a_path() {
        let d = std::env::temp_dir().join(format!("nightloom-758-{}", uuid::Uuid::new_v4()));
        assert!(!is_flat_in(&d, "s-1"));
        mark_in(&d, "s-1").unwrap();
        assert!(is_flat_in(&d, "s-1"));
        assert!(!is_flat_in(&d, "s-2"));
        mark_in(&d, "../evil").unwrap();
        assert!(!is_flat_in(&d, "../evil"));
        assert!(!d.parent().unwrap().join("evil").exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}
