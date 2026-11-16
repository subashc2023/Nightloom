//! What changed in the volatile prompt layers since the chat's held text,
//! told in the turn rather than in the system prompt (nightshift item 725).
//!
//! The project-notes index, the thread's Start here and the vault index are
//! built from files the chat itself writes: every size, the recency order
//! and the thread's open questions move with an edit. On the Claude Code
//! engine the desktop holds each layer's text (`prompt_hold`) so the cached
//! prefix stays byte-identical while the cache is warm — measured on
//! 2026-11-15 (chat 8e2f20a1, CLI session 53146e33), a changed block 2 made
//! the next turn read 12,781 of 73,956 tokens from cache instead of the
//! whole history. Holding keeps the prefix, but then the model reads an
//! index that is out of date. This module closes that gap: at each send it
//! rebuilds the volatile layers from disk, lays them against the held text
//! (or the last text a note already carried) and returns a short line diff
//! to ride after the message, where it costs only its own tokens.

use std::collections::{BTreeMap, BTreeSet};

use nightloom_core::SegmentKind;

use crate::prompt::{KnowledgeContext, ProjectContext};
use crate::thread::ThreadContext;

/// The layers whose text moves with the chat's own writes.
pub const VOLATILE: [SegmentKind; 3] = [
    SegmentKind::ProjectNotes,
    SegmentKind::Thread,
    SegmentKind::Knowledge,
];

/// Past this many characters of diff a layer's note is only a pointer.
const NOTE_CAP: usize = 1_500;

/// Where the volatile layers are read from: the same contexts the connect
/// assembled them from, `None` for a layer that is off or carries the
/// chat's own text (an edited layer does not follow the file).
#[derive(Debug, Clone, Default)]
pub struct LayerSources {
    pub project: Option<ProjectContext>,
    pub thread: Option<ThreadContext>,
    pub knowledge: Option<KnowledgeContext>,
}

impl LayerSources {
    /// Each volatile layer's text as the files have it now.
    pub fn fresh(&self) -> Vec<(SegmentKind, String)> {
        let mut out = Vec::new();
        if let Some(p) = &self.project {
            out.push((
                SegmentKind::ProjectNotes,
                crate::prompt::project_notes_segment(p).text,
            ));
        }
        if let Some(t) = &self.thread {
            out.push((SegmentKind::Thread, crate::thread::thread_segment(t).text));
        }
        if let Some(k) = &self.knowledge {
            out.push((
                SegmentKind::Knowledge,
                crate::prompt::knowledge_segment(k).text,
            ));
        }
        out
    }
}

fn label(kind: SegmentKind) -> (&'static str, &'static str) {
    match kind {
        SegmentKind::ProjectNotes => ("project notes index", "list the notes directory"),
        SegmentKind::Thread => ("thread layer (Start here)", "read thread.md's Start here"),
        _ => ("knowledge index", "list @kb"),
    }
}

/// Lines of `new` not in `old` (`+`) and of `old` not in `new` (`-`):
/// a re-order alone says nothing, a resized file is one line out and one in.
fn line_diff(old: &str, new: &str) -> Vec<String> {
    let old_set: BTreeSet<&str> = old.lines().collect();
    let new_set: BTreeSet<&str> = new.lines().collect();
    let mut out: Vec<String> = old
        .lines()
        .filter(|l| !l.trim().is_empty() && !new_set.contains(l))
        .map(|l| format!("- {}", l.trim_start()))
        .collect();
    out.extend(
        new.lines()
            .filter(|l| !l.trim().is_empty() && !old_set.contains(l))
            .map(|l| format!("+ {}", l.trim_start())),
    );
    out
}

/// The note for this turn, if a volatile layer moved since the chat last
/// heard. `held` is each layer's text in the system prompt; `noted` the
/// text a note already carried, updated here so the next turn tells only
/// what moved after it. `None` when nothing moved (or only the order did).
pub fn update_note(
    held: &BTreeMap<SegmentKind, String>,
    noted: &mut BTreeMap<SegmentKind, String>,
    fresh: &[(SegmentKind, String)],
) -> Option<String> {
    let mut parts = Vec::new();
    for (kind, now) in fresh {
        let Some(held_text) = held.get(kind) else {
            continue;
        };
        if now == held_text {
            noted.remove(kind);
            continue;
        }
        let base = noted.get(kind).unwrap_or(held_text);
        if now == base {
            continue;
        }
        let diff = line_diff(base, now);
        noted.insert(*kind, now.clone());
        if diff.is_empty() {
            continue;
        }
        let (name, how) = label(*kind);
        let body = diff.join("\n");
        if body.len() > NOTE_CAP {
            parts.push(format!(
                "[{name}] {} lines changed; {how} for the current text.",
                diff.len()
            ));
        } else {
            parts.push(format!("[{name}]\n{body}"));
        }
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!(
        "<prompt-layer-update>\nThe system prompt keeps these layers as they were when this \
         conversation took them, so its cache holds; the files have changed since \
         (- was, + is now):\n\n{}\n</prompt-layer-update>",
        parts.join("\n\n")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prompt::{PromptConfig, assemble};
    use std::path::PathBuf;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nightloom-725-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn thread_md(open: &str, pad: usize) -> String {
        format!(
            "# Thread: t\n\n## Start here\nAs of 2026-11-15 — fixture.\n\n**Front of the queue.**\n{open}\n\n## Queue\n{}\n",
            "x".repeat(pad)
        )
    }

    /// The item-725 case: a turn writes thread.md (bigger, Q-29 answered).
    /// What the held prompt sends is byte-identical, and the change reaches
    /// the model in the turn's note — once.
    #[test]
    fn a_thread_edit_keeps_the_system_text_and_reaches_the_turn() {
        let ws = scratch();
        let notes = ws.join(".agents");
        let ctx = ThreadContext::new(&notes, "t").unwrap();
        std::fs::create_dir_all(&ctx.dir).unwrap();
        let file = ctx.dir.join("thread.md");
        std::fs::write(
            &file,
            thread_md("1. Q-29: his answers.\n2. Q-30: paragraphs.", 2_000),
        )
        .unwrap();
        let sources = LayerSources {
            project: Some(ProjectContext {
                name: "P".into(),
                notes_dir: notes.clone(),
            }),
            thread: Some(ctx.clone()),
            knowledge: None,
        };
        let config = PromptConfig {
            identity: false,
            environment: false,
            project_instructions: false,
            user_memory: false,
            project: sources.project.clone(),
            thread: sources.thread.clone(),
            cwd: ws.clone(),
            ..PromptConfig::default()
        };
        let first = assemble(&config);
        let held: BTreeMap<SegmentKind, String> = first
            .segments()
            .iter()
            .map(|s| (s.kind, s.text.clone()))
            .collect();
        let sent_first = first.render_flat().unwrap();

        std::fs::write(
            &file,
            thread_md("1. Q-30: paragraphs given in chat.", 3_200),
        )
        .unwrap();
        // A fresh assembly would differ: this is the bust the hold prevents.
        let fresh_prompt = assemble(&config);
        assert_ne!(fresh_prompt.render_flat().unwrap(), sent_first);
        // What goes out is the held text, rebuilt from it byte for byte.
        let mut resent = nightloom_core::SystemPrompt::new();
        for s in first.segments() {
            resent.push(s.clone());
        }
        assert_eq!(resent.render_flat().unwrap(), sent_first);

        let mut noted = BTreeMap::new();
        let note = update_note(&held, &mut noted, &sources.fresh()).expect("a note");
        assert!(note.contains("- 1. Q-29: his answers."), "{note}");
        assert!(
            note.contains("+ 1. Q-30: paragraphs given in chat."),
            "{note}"
        );
        assert!(note.contains("[project notes index]"), "{note}");
        assert!(note.contains("thread.md ("), "the new size: {note}");
        // Once per change.
        assert_eq!(update_note(&held, &mut noted, &sources.fresh()), None);
        // Put back as it was: nothing to say, and the record is cleared.
        std::fs::write(
            &file,
            thread_md("1. Q-29: his answers.\n2. Q-30: paragraphs.", 2_000),
        )
        .unwrap();
        let back = sources.fresh();
        let thread_back = back
            .iter()
            .find(|(k, _)| *k == SegmentKind::Thread)
            .unwrap();
        assert_eq!(&thread_back.1, held.get(&SegmentKind::Thread).unwrap());
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_reorder_alone_says_nothing_and_a_long_diff_is_a_pointer() {
        let held: BTreeMap<_, _> = [(SegmentKind::ProjectNotes, "a\nb\nc".to_string())].into();
        let mut noted = BTreeMap::new();
        let fresh = vec![(SegmentKind::ProjectNotes, "c\na\nb".to_string())];
        assert_eq!(update_note(&held, &mut noted, &fresh), None);
        let long: String = (0..400).map(|i| format!("line {i}\n")).collect();
        let fresh = vec![(SegmentKind::ProjectNotes, long)];
        let note = update_note(&held, &mut noted, &fresh).unwrap();
        assert!(
            note.contains("lines changed; list the notes directory"),
            "{note}"
        );
        // A layer the prompt does not hold is not reported.
        let fresh = vec![(SegmentKind::Knowledge, "z".to_string())];
        assert_eq!(update_note(&held, &mut BTreeMap::new(), &fresh), None);
    }
}
