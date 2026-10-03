//! A chat's Context page as functions of its log — hiding and showing
//! items, the prompt layers switched off, a layer's own text — shared by
//! the desktop's commands and the away server (nightshift item 246 wave 4,
//! 4A; [`crate::chat_ops`] is the same lift for the chat's edits).
//!
//! Only the log is written here. The desktop then reconnects so the live
//! engine reads the change back; `serve` builds every turn's prompt fresh
//! from the log, so the next turn reads it with no reconnect.

use std::collections::BTreeMap;
use std::path::Path;

use nightloom_core::context::WireView;
use nightloom_core::{ChatKind, ChatMode, SegmentKind, Session, SessionEvent};
use serde::{Deserialize, Serialize};

/// The sentence a log edit gets on the Claude Code engine, which keeps its
/// own history (the desktop's `not_in_agent_mode`; `serve` runs only that
/// engine, so it answers the same).
pub fn not_on_claude_code(what: &str) -> String {
    format!(
        "cannot {what} on the Claude Code engine: it keeps its own history, and this log is a record of it"
    )
}

/// What removing items changed: the new view, plus the transcript, because
/// an elision moves both.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextEdit {
    pub view: WireView,
    pub events: Vec<SessionEvent>,
    /// How many items the call actually changed. Zero is not an error — a UI
    /// re-sending a selection that is already hidden is not a mistake.
    pub changed: usize,
}

/// Hide (`remove`) or show again the log events at `targets` — the
/// `Elide` / `Unelide` markers — returning how many changed.
pub fn edit_context(
    session: &mut Session,
    targets: Vec<usize>,
    remove: bool,
) -> Result<usize, String> {
    if remove {
        session.elide(targets)
    } else {
        session.unelide(targets)
    }
}

/// The chat's switched-off layers and its own texts, beside the set and
/// the texts the live engine was built with. The UI reconnects when either
/// pair differs — after opening another chat, or a new one — so the prompt
/// on the wire is always the open chat's.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PromptLayersInfo {
    pub off: Vec<SegmentKind>,
    pub built: Vec<SegmentKind>,
    pub edits: BTreeMap<SegmentKind, String>,
    pub built_edits: BTreeMap<SegmentKind, String>,
    /// The open chat's mode and the mode the engine was built for, the
    /// third pair the UI compares (2026-09-15): an incognito chat's engine
    /// has no writers, and the normal chat opened after it needs them back.
    pub mode: ChatMode,
    pub built_mode: ChatMode,
    /// The fourth pair (nightshift backlog 102): the open chat's kind and
    /// the kind the engine was built for.
    pub kind: ChatKind,
    pub built_kind: ChatKind,
    /// The fifth pair (nightshift backlog 271): the open chat's research
    /// thread and the one the engine was built with.
    pub thread: Option<String>,
    pub built_thread: Option<String>,
}

impl PromptLayersInfo {
    /// A chat whose prompt is built from its own log each turn (`serve`):
    /// what it has is what the next turn is built with, so each pair is
    /// equal and nothing asks for a reconnect.
    pub fn as_built(session: &Session) -> Self {
        let off = session.prompt_layers_off().to_vec();
        let edits = session.prompt_layer_edits().clone();
        Self {
            built: off.clone(),
            off,
            built_edits: edits.clone(),
            edits,
            mode: session.mode(),
            built_mode: session.mode(),
            kind: session.kind(),
            built_kind: session.kind(),
            thread: session.thread().map(str::to_string),
            built_thread: session.thread().map(str::to_string),
        }
    }
}

/// Record which prompt layers the chat excludes (the whole set).
pub fn set_layers_off(session: &mut Session, off: Vec<SegmentKind>) {
    session.record_prompt_layers(off);
}

/// Refuse a layer a chat cannot rewrite.
pub fn check_editable(kind: SegmentKind) -> Result<(), String> {
    if SegmentKind::EDITABLE.contains(&kind) {
        Ok(())
    } else {
        Err(format!("{kind:?} is not a layer a chat can rewrite"))
    }
}

/// Record the chat's own text for one layer — or drop it, with `text`
/// absent or blank (backlog 057): a body that trims to nothing is no
/// override, since "send nothing" is what the switch is for.
pub fn set_layer_text(
    session: &mut Session,
    kind: SegmentKind,
    text: Option<String>,
) -> Result<(), String> {
    check_editable(kind)?;
    let mut edits = session.prompt_layer_edits().clone();
    match text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        Some(text) => {
            edits.insert(kind, text);
        }
        None => {
            edits.remove(&kind);
        }
    }
    session.record_prompt_layer_edits(edits);
    Ok(())
}

/// Each editable layer's file text as it is on disk now (`None`: nothing
/// there) — the phone editor's seed when the chat has no text of its own
/// (the Mac's `layers.sources`, 2B's patch note), read by `model` and the
/// folder the prompt is built from.
pub fn layer_sources(model: Option<&str>, cwd: &Path) -> BTreeMap<SegmentKind, Option<String>> {
    SegmentKind::EDITABLE
        .iter()
        .map(|&k| (k, crate::layer_source(k, model, cwd)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_layer_text_trims_and_blank_drops_it() {
        let mut s = Session::new();
        s.record_user("q");
        set_layer_text(&mut s, SegmentKind::UserMemory, Some("  mine  ".into())).unwrap();
        assert_eq!(
            s.prompt_layer_edits().get(&SegmentKind::UserMemory),
            Some(&"mine".to_string())
        );
        set_layer_text(&mut s, SegmentKind::UserMemory, Some("   ".into())).unwrap();
        assert!(s.prompt_layer_edits().is_empty());
        assert!(set_layer_text(&mut s, SegmentKind::Pacing, Some("x".into())).is_err());
    }

    #[test]
    fn as_built_has_equal_pairs() {
        let mut s = Session::new();
        set_layers_off(&mut s, vec![SegmentKind::Pacing]);
        let info = PromptLayersInfo::as_built(&s);
        assert_eq!(info.off, vec![SegmentKind::Pacing]);
        assert_eq!(info.off, info.built);
        assert_eq!(info.kind, info.built_kind);
    }
}
