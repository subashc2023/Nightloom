//! A record of every hand-off, for scoring them (nightshift item 757,
//! 2026-11-16; his words: "make sure ur tracking everything ... over the
//! next few days hopefully we get enough data").
//!
//! The window builds each line (`apps/desktop/src/lib/handoffLog.ts`) and
//! this appends it to `<config dir>/logs/handoffs.jsonl`, one JSON object
//! per line, stamped with `at` (UTC) here:
//!
//! - `"kind": "handoff"` — a next chat opened from a hand-off: the route
//!   (the card's *Continue*, the no-prompt line, the unattended hand-off),
//!   both chats, the goal, the first message as sent, his ticked messages
//!   and the ids of the ones left unticked, the list built from the tool
//!   calls (uncapped, with the caps the card used), the fixed-sections
//!   check and what the wrap-up cost;
//! - `"kind": "next_turn"` — one of the next chat's first 30 turns: the
//!   files it read, edited and named in shell commands.
//!
//! Nothing here sends anything anywhere, and nothing beyond what the
//! hand-off itself carried is in a line: the window leaves out the text of
//! the messages it did not carry. Best effort for the app: a line that
//! cannot be written is an error to the window, which drops it.

use std::io::Write;
use std::path::{Path, PathBuf};

/// The log's file name under `<config dir>/logs/`.
pub const LOG_FILE: &str = "handoffs.jsonl";

/// The kinds of line the log holds.
pub const KINDS: [&str; 2] = ["handoff", "next_turn"];

/// A line longer than this is refused: a record is a few kilobytes, and a
/// runaway one must not fill the disk.
pub const MAX_LINE: usize = 512 * 1024;

/// `<config dir>/logs/handoffs.jsonl`, or `None` with no config dir.
pub fn log_path() -> Option<PathBuf> {
    nightloom_service::project::config_dir().map(|c| c.join("logs").join(LOG_FILE))
}

/// The line for `record`: an object with a known `kind`, stamped with `at`
/// (left as it is when the record carries one).
pub fn line(
    mut record: serde_json::Value,
    at: chrono::DateTime<chrono::Utc>,
) -> Result<String, String> {
    let obj = record
        .as_object_mut()
        .ok_or_else(|| "a hand-off record must be a JSON object".to_string())?;
    let kind = obj.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    if !KINDS.contains(&kind) {
        return Err(format!("unknown hand-off record kind {kind:?}"));
    }
    obj.entry("at").or_insert_with(|| {
        serde_json::Value::String(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    });
    let text = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    if text.len() > MAX_LINE {
        return Err(format!(
            "hand-off record of {} bytes is over the {MAX_LINE}-byte cap",
            text.len()
        ));
    }
    Ok(text)
}

/// Append `record`'s line to `path`, making its folder.
pub fn append_to(path: &Path, record: serde_json::Value) -> Result<(), String> {
    let text = line(record, chrono::Utc::now())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    // One write per line, so two lines written at once never interleave.
    f.write_all(format!("{text}\n").as_bytes())
        .map_err(|e| e.to_string())
}

/// The window's hand-off line (`api.ts` `logHandoff`).
#[tauri::command]
pub fn handoff_log(record: serde_json::Value) -> Result<(), String> {
    let path = log_path().ok_or_else(|| "no config dir".to_string())?;
    append_to(&path, record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-handoff-log-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("logs").join(LOG_FILE)
    }

    fn lines(path: &Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn a_hand_off_and_its_next_turns_append_one_stamped_line_each() {
        let path = scratch("append");
        append_to(
            &path,
            json!({"kind": "handoff", "v": 1, "route": "card", "from_chat": "a", "to_chat": "b",
                   "goal": "re-run tiers 1-3", "sent": "Goal: re-run tiers 1-3\n\nRead HANDOFF.md"}),
        )
        .unwrap();
        append_to(
            &path,
            json!({"kind": "next_turn", "v": 1, "chat": "b", "turn": 1, "read": [{"path": "HANDOFF.md", "count": 1}]}),
        )
        .unwrap();
        let got = lines(&path);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["kind"], "handoff");
        assert_eq!(got[0]["goal"], "re-run tiers 1-3");
        assert_eq!(
            got[0]["sent"], "Goal: re-run tiers 1-3\n\nRead HANDOFF.md",
            "a newline in the text stays inside its one line"
        );
        assert_eq!(got[1]["turn"], 1);
        for g in &got {
            let at = g["at"].as_str().unwrap();
            assert!(chrono::DateTime::parse_from_rfc3339(at).is_ok(), "{at}");
        }
    }

    #[test]
    fn a_record_that_is_not_an_object_or_has_no_known_kind_is_refused() {
        let path = scratch("refused");
        assert!(append_to(&path, json!(["kind", "handoff"])).is_err());
        assert!(append_to(&path, json!({"turn": 1})).is_err());
        assert!(append_to(&path, json!({"kind": "message", "text": "his words"})).is_err());
        assert!(!path.exists(), "nothing is written for a refused record");
    }

    #[test]
    fn a_record_s_own_stamp_is_kept() {
        let at = chrono::Utc::now();
        let text = line(
            json!({"kind": "handoff", "at": "2026-11-16T12:00:00.000Z"}),
            at,
        )
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["at"], "2026-11-16T12:00:00.000Z");
    }

    /// Item 757's check on real hand-offs, run by hand: the lines the
    /// window's builders made from his chat logs
    /// (`nightshift-code/notes/runner-design/757-probe/replay.ts`), file
    /// `NIGHTLOOM_757_REPLAY`, appended by this writer to `NIGHTLOOM_757_OUT`.
    #[test]
    #[ignore]
    fn replay_real_hand_offs_into_a_scratch_log() {
        let (Ok(src), Ok(out)) = (
            std::env::var("NIGHTLOOM_757_REPLAY"),
            std::env::var("NIGHTLOOM_757_OUT"),
        ) else {
            return;
        };
        let text = std::fs::read_to_string(src).unwrap();
        let mut n = 0;
        for l in text.lines().filter(|l| !l.trim().is_empty()) {
            append_to(Path::new(&out), serde_json::from_str(l).unwrap()).unwrap();
            n += 1;
        }
        assert!(n > 0);
        assert_eq!(lines(Path::new(&out)).len(), n);
    }

    #[test]
    fn an_oversized_record_is_refused() {
        let big = "x".repeat(MAX_LINE + 1);
        assert!(line(json!({"kind": "handoff", "sent": big}), chrono::Utc::now()).is_err());
    }
}
