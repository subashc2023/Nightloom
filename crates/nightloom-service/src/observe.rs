//! The observation log: the fast half of memory.
//!
//! The vault is what the user knows; this is the inbox in front of it. During
//! a chat the model drops one-sentence observations here through the
//! `remember` tool — cheap by design, an append and nothing else: no
//! embedding, no tagging, no model call on the write path, because every
//! measured system puts the cost of memory on the write side and the write
//! side runs inside a turn the user is waiting on. The expensive half —
//! deciding what holds up, filing it, superseding what it contradicts — is
//! [`crate::dream`], a batch job the user invokes between conversations.
//!
//! Three properties are load-bearing rather than incidental:
//!
//! - **Nothing reads the log back into a conversation.** It is not memory,
//!   it is evidence awaiting review. A model that could read its own
//!   unreviewed observations would be trusting last week's guess as this
//!   week's fact, which is the drift the dream pass exists to filter.
//! - **The log is never pruned**, consolidation included. A derived note is
//!   a navigation aid over the record, not a replacement for it — systems
//!   that delete the source after deriving from it were measured losing
//!   double digits of accuracy to exactly that substitution. The watermark
//!   (`dream.json`) records how far consolidation has read; the bytes stay.
//! - **Every observation is typed by provenance.** `user_stated` outranks
//!   `inferred`, and `external` — text that arrived through a fetched page
//!   or another tool's output — is never promoted to an unqualified claim.
//!   That typing is the defense against a durable store quietly laundering
//!   untrusted content into "something I know", which is how memory gets
//!   poisoned, and against a vault of the model's own conclusions becoming
//!   a machine for agreeing with itself.
//!
//! The file is JSONL beside `projects.json`, and reading it is total on
//! [`Session::load`](nightloom_core::Session::load)'s argument: a line this
//! build cannot parse is counted and skipped, never fatal, and a torn final
//! line (the process died mid-append) is left unconsumed for the next read
//! rather than half-parsed on this one.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::project;

/// The log, beside `projects.json` under the config dir.
pub const LOG_FILE: &str = "observations.jsonl";
/// Where the dream's watermark lives, beside the log.
const STATE_FILE: &str = "dream.json";

/// Where one observation came from, in descending order of trust.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObservationKind {
    /// The user said it, in so many words.
    UserStated,
    /// The model concluded it from the session's work.
    Inferred,
    /// It arrived through content — a fetched page, a tool result. Never
    /// promoted past attribution by the dream pass.
    External,
}

impl ObservationKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ObservationKind::UserStated => "user_stated",
            ObservationKind::Inferred => "inferred",
            ObservationKind::External => "external",
        }
    }
}

/// One line of the log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Observation {
    #[serde(default = "schema_version")]
    pub v: u32,
    pub at: DateTime<Utc>,
    /// Where the model was working when it noticed this — a project name or
    /// a workspace folder name. Absent for an unfiled chat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    pub kind: ObservationKind,
    pub text: String,
}

fn schema_version() -> u32 {
    1
}

/// The log's path, or `None` in a stripped environment with no config dir —
/// which reads as "no memory" the same way it reads as "no vault".
pub fn log_path() -> Option<PathBuf> {
    project::config_dir().map(|c| c.join(LOG_FILE))
}

/// Append one observation. Creates the config dir and the log on first use.
pub fn append_in(config: &Path, obs: &Observation) -> Result<(), String> {
    fs::create_dir_all(config)
        .map_err(|e| format!("could not create {}: {e}", config.display()))?;
    let line = serde_json::to_string(obs).map_err(|e| e.to_string())?;
    let path = config.join(LOG_FILE);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| format!("could not append to {}: {e}", path.display()))
}

/// An observation the dream has not consumed, with the byte offset just past
/// its newline — what the watermark advances to once it is consolidated.
#[derive(Debug, Clone)]
pub struct Pending {
    pub obs: Observation,
    pub end: u64,
}

/// Everything appended since the watermark.
#[derive(Debug, Default)]
pub struct Backlog {
    pub pending: Vec<Pending>,
    /// Complete lines this build could not parse. Counted, not fatal — the
    /// log is another build's output on its own release cadence.
    pub unreadable: usize,
}

/// Read the log from the watermark to its last *complete* line.
///
/// A torn final line — no trailing newline, the process died mid-append —
/// is left for the next read rather than parsed short here: its bytes are
/// not consumed, so once the next append completes the line, it is read
/// whole. If the watermark points past the end of the file, the log was
/// replaced; reading restarts from the top rather than skipping into the
/// middle of somebody's fresh file.
pub fn backlog_in(config: &Path) -> Backlog {
    let path = config.join(LOG_FILE);
    let Ok(bytes) = fs::read(&path) else {
        return Backlog::default();
    };
    let mut start = state_in(config).consumed;
    if start > bytes.len() as u64 {
        start = 0;
    }
    let mut out = Backlog::default();
    let mut pos = start as usize;
    while let Some(nl) = bytes[pos..].iter().position(|&b| b == b'\n') {
        let line = &bytes[pos..pos + nl];
        let end = (pos + nl + 1) as u64;
        match serde_json::from_slice::<Observation>(line) {
            Ok(obs) => out.pending.push(Pending { obs, end }),
            // Blank lines cost nothing to skip; anything else is a real
            // line this build cannot read, and saying how many is the
            // difference between "empty" and "unreadable".
            Err(_) if !line.iter().all(u8::is_ascii_whitespace) => out.unreadable += 1,
            Err(_) => {}
        }
        pos += nl + 1;
    }
    out
}

/// How far the dream has read, and when it last ran.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DreamState {
    #[serde(default = "schema_version")]
    pub version: u32,
    /// Byte offset into the log: everything before it has been through a
    /// dream. An offset, not a count, so the log itself never needs
    /// rewriting to record progress.
    #[serde(default)]
    pub consumed: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run: Option<DateTime<Utc>>,
}

/// The watermark, or the default when the file is absent or unreadable —
/// a malformed state file costs the state, not the feature, and re-dreaming
/// an already-consolidated batch is the safe direction to fail in: the pass
/// dedupes against the vault it already wrote.
pub fn state_in(config: &Path) -> DreamState {
    fs::read_to_string(config.join(STATE_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Advance the watermark. Called only after a dream completed — a failed or
/// interrupted pass consumes nothing, so its batch is offered again.
pub fn advance_in(config: &Path, consumed: u64, at: DateTime<Utc>) -> Result<(), String> {
    let state = DreamState {
        version: 1,
        consumed,
        last_run: Some(at),
    };
    let body = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::create_dir_all(config)
        .map_err(|e| format!("could not create {}: {e}", config.display()))?;
    let path = config.join(STATE_FILE);
    fs::write(&path, body).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// How many observations await the next dream — what a shell's startup line
/// reports. Cheap: one read, no model.
pub fn pending_count_in(config: &Path) -> usize {
    backlog_in(config).pending.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_config(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "nightloom-observe-{label}-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn obs(text: &str, kind: ObservationKind) -> Observation {
        Observation {
            v: 1,
            at: Utc::now(),
            source: Some("test".into()),
            kind,
            text: text.into(),
        }
    }

    #[test]
    fn round_trips_through_the_log() {
        let dir = temp_config("roundtrip");
        append_in(&dir, &obs("one", ObservationKind::UserStated)).unwrap();
        append_in(&dir, &obs("two", ObservationKind::External)).unwrap();
        let backlog = backlog_in(&dir);
        assert_eq!(backlog.unreadable, 0);
        let texts: Vec<_> = backlog
            .pending
            .iter()
            .map(|p| p.obs.text.as_str())
            .collect();
        assert_eq!(texts, ["one", "two"]);
        assert_eq!(backlog.pending[1].obs.kind, ObservationKind::External);
    }

    #[test]
    fn watermark_consumes_and_later_appends_reappear() {
        let dir = temp_config("watermark");
        append_in(&dir, &obs("first", ObservationKind::Inferred)).unwrap();
        let backlog = backlog_in(&dir);
        advance_in(&dir, backlog.pending[0].end, Utc::now()).unwrap();
        assert!(backlog_in(&dir).pending.is_empty());
        append_in(&dir, &obs("second", ObservationKind::Inferred)).unwrap();
        let again = backlog_in(&dir);
        assert_eq!(again.pending.len(), 1);
        assert_eq!(again.pending[0].obs.text, "second");
    }

    #[test]
    fn a_torn_tail_is_left_for_the_next_read() {
        let dir = temp_config("torn");
        append_in(&dir, &obs("whole", ObservationKind::Inferred)).unwrap();
        let path = dir.join(LOG_FILE);
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        // A crash mid-append: valid JSON prefix, no newline.
        file.write_all(b"{\"v\":1,\"at\":\"2026-").unwrap();
        drop(file);
        let backlog = backlog_in(&dir);
        assert_eq!(backlog.pending.len(), 1);
        assert_eq!(backlog.unreadable, 0);
        // Completing the line makes it readable whole.
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"08-30T00:00:00Z\",\"kind\":\"user_stated\",\"text\":\"late\"}\n")
            .unwrap();
        drop(file);
        let again = backlog_in(&dir);
        assert_eq!(again.pending.len(), 2);
        assert_eq!(again.pending[1].obs.text, "late");
    }

    #[test]
    fn an_unreadable_line_is_counted_not_fatal() {
        let dir = temp_config("unreadable");
        append_in(&dir, &obs("good", ObservationKind::Inferred)).unwrap();
        let path = dir.join(LOG_FILE);
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"an\":\"event tag from a newer build\"}\n")
            .unwrap();
        drop(file);
        append_in(&dir, &obs("after", ObservationKind::Inferred)).unwrap();
        let backlog = backlog_in(&dir);
        assert_eq!(backlog.pending.len(), 2);
        assert_eq!(backlog.unreadable, 1);
    }

    #[test]
    fn a_replaced_log_restarts_from_the_top() {
        let dir = temp_config("replaced");
        append_in(
            &dir,
            &obs(
                "long-lived entry padding the offset out",
                ObservationKind::Inferred,
            ),
        )
        .unwrap();
        append_in(
            &dir,
            &obs("second entry, more padding", ObservationKind::Inferred),
        )
        .unwrap();
        let end = backlog_in(&dir).pending[1].end;
        advance_in(&dir, end, Utc::now()).unwrap();
        // The user deletes the log and a fresh chat appends one short line:
        // the watermark now points past EOF.
        fs::remove_file(dir.join(LOG_FILE)).unwrap();
        append_in(&dir, &obs("fresh", ObservationKind::Inferred)).unwrap();
        let backlog = backlog_in(&dir);
        assert_eq!(backlog.pending.len(), 1);
        assert_eq!(backlog.pending[0].obs.text, "fresh");
    }
}
