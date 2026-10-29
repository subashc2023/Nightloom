//! A thread's next-chat prompt (nightshift item 464, 2026-10-28).
//!
//! When a reply in a thread chat ends with a `<handoff>` block, the shell
//! keeps its text here, in `handoff.json` beside the thread's `thread.md`, so
//! it outlives a restart and goes with the thread's folder (a delete moves
//! the folder to the trash whole). The thread's + takes it once: the first
//! child chat opened after it was saved gets the text in its box, and is
//! named here as having taken it; every later + opens an empty box until a
//! newer hand-off is saved. A newer one replaces the old whole.

use crate::thread::{THREAD_FILE, thread_dir};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const HANDOFF_FILE: &str = "handoff.json";

/// One saved hand-off.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThreadHandoff {
    /// The prompt, as the model wrote it between the tags, trimmed.
    pub text: String,
    /// The chat whose reply it came from.
    pub from_chat: String,
    /// When it was saved, RFC 3339, local time.
    pub saved_at: String,
    /// The child chat that started from it; none until the + takes it.
    #[serde(default)]
    pub taken_by: Option<String>,
}

fn file(notes_dir: &Path, slug: &str) -> Result<PathBuf, String> {
    let dir =
        thread_dir(notes_dir, slug).ok_or_else(|| format!("{slug:?} is not a thread name"))?;
    if !dir.join(THREAD_FILE).is_file() {
        return Err(format!("no thread {slug} here"));
    }
    Ok(dir.join(HANDOFF_FILE))
}

/// The thread's saved hand-off; none when there is none or it does not read.
pub fn read_handoff(notes_dir: &Path, slug: &str) -> Option<ThreadHandoff> {
    let path = file(notes_dir, slug).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write(path: &Path, h: &ThreadHandoff) -> Result<(), String> {
    let body = serde_json::to_string_pretty(h).map_err(|e| e.to_string())?;
    crate::tidy::write_whole(path, &(body + "\n"))
}

/// Save a hand-off on the thread, replacing any earlier one (taken or not).
/// The same text from the same chat again keeps the earlier record, so a
/// reply read twice does not hand the prompt out a second time.
pub fn save_handoff(
    notes_dir: &Path,
    slug: &str,
    text: &str,
    from_chat: &str,
    now: &str,
) -> Result<ThreadHandoff, String> {
    let path = file(notes_dir, slug)?;
    let text = text.trim();
    if text.is_empty() {
        return Err("a hand-off needs some text".into());
    }
    if let Some(old) = read_handoff(notes_dir, slug) {
        if old.text == text && old.from_chat == from_chat {
            return Ok(old);
        }
    }
    let h = ThreadHandoff {
        text: text.to_string(),
        from_chat: from_chat.to_string(),
        saved_at: now.to_string(),
        taken_by: None,
    };
    write(&path, &h)?;
    Ok(h)
}

/// The + on the thread: the saved text when no child chat has started from
/// it yet, and `chat` named as the one that did; none otherwise.
pub fn take_handoff(notes_dir: &Path, slug: &str, chat: &str) -> Result<Option<String>, String> {
    let path = file(notes_dir, slug)?;
    let Some(mut h) = read_handoff(notes_dir, slug) else {
        return Ok(None);
    };
    if h.taken_by.is_some() {
        return Ok(None);
    }
    h.taken_by = Some(chat.to_string());
    write(&path, &h)?;
    Ok(Some(h.text))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn docspace() -> (Scratch, PathBuf) {
        let notes = std::env::temp_dir().join(format!(
            "nightloom-handoff-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let tmp = Scratch(notes.clone());
        let dir = thread_dir(&notes, "alpha").unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(THREAD_FILE), "# Thread: Alpha\n").unwrap();
        (tmp, notes)
    }

    #[test]
    fn a_saved_hand_off_is_taken_once_by_the_first_child_chat() {
        let (_t, notes) = docspace();
        assert_eq!(take_handoff(&notes, "alpha", "c1").unwrap(), None);
        save_handoff(
            &notes,
            "alpha",
            "  Read the Queue, then run T-04.\n",
            "p",
            "2026-10-28T23:00:00",
        )
        .unwrap();
        assert_eq!(
            take_handoff(&notes, "alpha", "c1").unwrap().as_deref(),
            Some("Read the Queue, then run T-04.")
        );
        assert_eq!(
            read_handoff(&notes, "alpha").unwrap().taken_by.as_deref(),
            Some("c1")
        );
        assert_eq!(take_handoff(&notes, "alpha", "c2").unwrap(), None);
    }

    #[test]
    fn a_newer_hand_off_replaces_a_taken_one_and_the_same_one_again_does_not() {
        let (_t, notes) = docspace();
        save_handoff(&notes, "alpha", "First.", "p", "t1").unwrap();
        take_handoff(&notes, "alpha", "c1").unwrap();
        // The same reply read again: still taken.
        save_handoff(&notes, "alpha", "First.", "p", "t2").unwrap();
        assert_eq!(take_handoff(&notes, "alpha", "c2").unwrap(), None);
        save_handoff(&notes, "alpha", "Second.", "c1", "t3").unwrap();
        assert_eq!(
            take_handoff(&notes, "alpha", "c2").unwrap().as_deref(),
            Some("Second.")
        );
    }

    #[test]
    fn no_thread_or_a_blank_text_is_refused_and_a_bad_file_reads_as_none() {
        let (_t, notes) = docspace();
        assert!(save_handoff(&notes, "nope", "x", "p", "t").is_err());
        assert!(save_handoff(&notes, "alpha", "  \n", "p", "t").is_err());
        let dir = thread_dir(&notes, "alpha").unwrap();
        std::fs::write(dir.join(HANDOFF_FILE), "not json").unwrap();
        assert_eq!(read_handoff(&notes, "alpha"), None);
        assert_eq!(take_handoff(&notes, "alpha", "c1").unwrap(), None);
    }
}
