//! Steering a running subagent (2026-10-04, nightshift backlog 295).
//!
//! A note he types under a live agent's transcript is queued here, in the
//! chat's directory ([`STEER_FILE`] beside the brief), keyed by the
//! subagent's `agent_id` — which is the stream's `task_id` for that agent
//! (measured 2026-10-04, nightshift `notes/runner-design/295-measurements-
//! 2026-10-04.md`, run A). The brief hook ([`super::brief::decide`]), which
//! sees every call of every subagent, takes the agent's queued notes on its
//! next call and hands them to the model as `additionalContext` — once —
//! recording when and with which call. Measured on CLI 2.1.289: a
//! `PreToolUse` `additionalContext` on a child's call reaches that child,
//! which acted on it in its next step; the text is not in the stream-json
//! output, so the record here is the only way the window learns of the
//! delivery.
//!
//! A note can also be queued for the **main thread** ([`MAIN`]): the chat's
//! own next call then carries "he sent this to your subagent …", so the
//! parent is not surprised by what the child does next.
//!
//! A note still queued when the agent finishes (an agent with no further
//! calls) is taken back by the window ([`unqueue`]) and goes the
//! held-until-finished way (backlog 157). The file is read and written
//! under an advisory lock, since the turn's hooks run at once.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// The queue and the delivered record, in the chat's directory.
pub const STEER_FILE: &str = "subagent-steer.json";

/// The key for a note to the main thread (a hook call with no `agent_id`).
pub const MAIN: &str = "main";

/// How many delivered records are kept (the oldest dropped first) — the
/// window reads them while the agent runs, and his notes stay in the
/// window's own store and the child's transcript either way.
pub const DELIVERED_CAP: usize = 200;

/// A note waiting for its agent's next call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Queued {
    /// The window's id for the note (it asks after it by this).
    pub id: String,
    pub text: String,
    /// When he sent it, ms since the epoch.
    pub at_ms: i64,
    /// For a main-thread copy: what the subagent is called, for the words.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub about: Option<String>,
    /// Nightloom's own words rather than his (backlog 329's nested-spawn
    /// report to the main thread): delivered as they are, unwrapped.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub raw: bool,
}

/// A note that went.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Delivered {
    pub id: String,
    /// The `agent_id` it went to, or [`MAIN`].
    pub agent_id: String,
    pub text: String,
    pub at_ms: i64,
    pub delivered_at_ms: i64,
    /// The call it rode on: its name and id.
    pub tool: String,
    #[serde(default)]
    pub tool_use_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SteerState {
    #[serde(default)]
    pub queued: std::collections::BTreeMap<String, Vec<Queued>>,
    #[serde(default)]
    pub delivered: Vec<Delivered>,
}

/// Open the file locked, change the state, write it back. A file that
/// cannot be opened or locked is `None` — the caller treats it as nothing
/// queued (a hook) or as a failed send (the window, which then holds the
/// note the old way).
fn with_state<T>(dir: &Path, f: impl FnOnce(&mut SteerState) -> T) -> Option<T> {
    use std::io::{Read as _, Seek as _, Write as _};
    std::fs::create_dir_all(dir).ok()?;
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join(STEER_FILE))
        .ok()?;
    file.lock().ok()?;
    let mut have = String::new();
    let _ = file.read_to_string(&mut have);
    let mut s: SteerState = serde_json::from_str(&have).unwrap_or_default();
    let before = s.clone();
    let out = f(&mut s);
    if s != before {
        let _ = file.set_len(0);
        let _ = file.seek(std::io::SeekFrom::Start(0));
        let _ = file.write_all(serde_json::to_string(&s).unwrap_or_default().as_bytes());
    }
    Some(out)
}

/// Queue `note` for `agent_id` (or [`MAIN`]). An id already queued or
/// delivered is not queued twice (a retried send).
pub fn queue(dir: &Path, agent_id: &str, note: Queued) -> std::io::Result<()> {
    if agent_id.trim().is_empty() || note.text.trim().is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "a note needs an agent and words",
        ));
    }
    with_state(dir, |s| {
        let seen = s
            .delivered
            .iter()
            .any(|d| d.id == note.id && d.agent_id == agent_id)
            || s.queued
                .get(agent_id)
                .is_some_and(|q| q.iter().any(|n| n.id == note.id));
        if !seen {
            s.queued.entry(agent_id.to_string()).or_default().push(note);
        }
    })
    .ok_or_else(|| std::io::Error::other("the chat's steer file could not be opened"))
}

/// Take back a note not yet delivered: `true` when it was still queued
/// (and is now gone), `false` when it had already gone or never was.
pub fn unqueue(dir: &Path, agent_id: &str, id: &str) -> bool {
    with_state(dir, |s| {
        let Some(q) = s.queued.get_mut(agent_id) else {
            return false;
        };
        let before = q.len();
        q.retain(|n| n.id != id);
        let took = q.len() != before;
        if q.is_empty() {
            s.queued.remove(agent_id);
        }
        took
    })
    .unwrap_or(false)
}

/// The state as it stands, for the window.
pub fn read(dir: &Path) -> SteerState {
    std::fs::read(dir.join(STEER_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// The hook's half: take every note queued for `who` (an `agent_id`, or
/// [`MAIN`]), record each delivered on this call, and return the words
/// the model reads. `None` when nothing waits — the common case, read
/// without writing.
pub fn take(dir: &Path, who: &str, tool: &str, tool_use_id: &str, now_ms: i64) -> Option<String> {
    if who.is_empty() {
        return None;
    }
    // Cheap first look, unlocked: almost every call has nothing waiting.
    if !read(dir).queued.get(who).is_some_and(|q| !q.is_empty()) {
        return None;
    }
    let notes = with_state(dir, |s| {
        let notes = s.queued.remove(who).unwrap_or_default();
        for n in &notes {
            s.delivered.push(Delivered {
                id: n.id.clone(),
                agent_id: who.to_string(),
                text: n.text.clone(),
                at_ms: n.at_ms,
                delivered_at_ms: now_ms,
                tool: tool.to_string(),
                tool_use_id: tool_use_id.to_string(),
            });
        }
        let over = s.delivered.len().saturating_sub(DELIVERED_CAP);
        s.delivered.drain(..over);
        notes
    })?;
    words(&notes, who == MAIN)
}

/// What the model reads. A subagent is told it is from the person, sent
/// while it runs, and to take it from its next step; the main thread is
/// told its subagent was sent it.
pub fn words(notes: &[Queued], main: bool) -> Option<String> {
    if notes.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for n in notes {
        let when = clock(n.at_ms);
        out.push(if n.raw {
            n.text.trim().to_string()
        } else if main {
            format!(
                "Swaraag (the user) sent a note at {when} to your subagent{} while it runs; it reaches the \
                 subagent on its next tool call. His note: {}",
                n.about
                    .as_deref()
                    .filter(|a| !a.trim().is_empty())
                    .map(|a| format!(" \u{201c}{a}\u{201d}"))
                    .unwrap_or_default(),
                n.text.trim()
            )
        } else {
            format!(
                "A note from Swaraag (the user), typed under your transcript at {when} while you run. \
                 Take it into account from your next step on: {}",
                n.text.trim()
            )
        });
    }
    Some(out.join("\n\n"))
}

/// A clock time, 12-hour, in this Mac's zone ("6:41 PM").
fn clock(ms: i64) -> String {
    use chrono::TimeZone as _;
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|t| t.format("%-I:%M %p").to_string())
        .unwrap_or_else(|| "just now".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("nightloom-steer-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn note(id: &str, text: &str) -> Queued {
        Queued {
            id: id.into(),
            text: text.into(),
            at_ms: 1_000,
            about: None,
            raw: false,
        }
    }

    #[test]
    fn a_queued_note_goes_once_on_its_agents_next_call_and_is_recorded() {
        let d = scratch("once");
        queue(&d, "a1", note("n1", "check the tests too")).unwrap();
        // Another agent's call does not take it.
        assert_eq!(take(&d, "a2", "Read", "t0", 2_000), None);
        let w = take(&d, "a1", "Read", "t1", 3_000).unwrap();
        assert!(w.contains("check the tests too"));
        assert!(w.contains("from Swaraag"));
        // Once only.
        assert_eq!(take(&d, "a1", "Bash", "t2", 4_000), None);
        let s = read(&d);
        assert!(s.queued.is_empty());
        assert_eq!(s.delivered.len(), 1);
        let r = &s.delivered[0];
        assert_eq!(
            (r.agent_id.as_str(), r.tool.as_str(), r.tool_use_id.as_str()),
            ("a1", "Read", "t1")
        );
        assert_eq!(r.delivered_at_ms, 3_000);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn two_notes_go_together_and_a_resend_is_not_queued_twice() {
        let d = scratch("two");
        queue(&d, "a1", note("n1", "first")).unwrap();
        queue(&d, "a1", note("n1", "first")).unwrap();
        queue(&d, "a1", note("n2", "second")).unwrap();
        let w = take(&d, "a1", "Read", "t1", 3_000).unwrap();
        assert!(w.contains("first") && w.contains("second"));
        assert_eq!(w.matches("first").count(), 1);
        // A resend of a delivered id stays delivered.
        queue(&d, "a1", note("n1", "first")).unwrap();
        assert_eq!(take(&d, "a1", "Read", "t2", 4_000), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_note_taken_back_before_its_call_never_goes() {
        let d = scratch("back");
        queue(&d, "a1", note("n1", "never mind")).unwrap();
        assert!(unqueue(&d, "a1", "n1"));
        assert!(!unqueue(&d, "a1", "n1"));
        assert_eq!(take(&d, "a1", "Read", "t1", 3_000), None);
        assert!(read(&d).delivered.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_delivered_note_cannot_be_taken_back() {
        let d = scratch("late");
        queue(&d, "a1", note("n1", "x")).unwrap();
        take(&d, "a1", "Read", "t1", 3_000).unwrap();
        assert!(!unqueue(&d, "a1", "n1"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_main_thread_is_told_what_its_subagent_was_sent() {
        let d = scratch("main");
        queue(
            &d,
            MAIN,
            Queued {
                about: Some("Survey the tests".into()),
                ..note("n1", "skip the e2e folder")
            },
        )
        .unwrap();
        let w = take(&d, MAIN, "Read", "t1", 3_000).unwrap();
        assert!(w.contains("your subagent \u{201c}Survey the tests\u{201d}"));
        assert!(w.contains("skip the e2e folder"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_empty_note_or_agent_is_refused() {
        let d = scratch("empty");
        assert!(queue(&d, "", note("n1", "x")).is_err());
        assert!(queue(&d, "a1", note("n1", "  ")).is_err());
        assert_eq!(take(&d, "", "Read", "t", 1), None);
        let _ = std::fs::remove_dir_all(&d);
    }
}
