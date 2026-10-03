//! Edit a note by prompt (nightshift backlog 151), as commands: one edit
//! turn on one note file, and its cancel. The command line and its tests
//! are the service's (`nightloom_service::note_edit`); this is the process
//! around it.
//!
//! Pass 2 (blocker 414): the model edits the file itself with the Edit tool,
//! confined to that one path. Each Edit that lands is read back from disk
//! and sent to the window as `note-edit-landed`, so the note updates per
//! edit; the model's closing sentences stream as `note-edit-delta`.
//!
//! Its own job, not the chat's: a fresh CLI process with no session, so it
//! neither waits for a running turn nor touches one, and a note can be
//! edited with no chat connected at all.

use crate::power;
use crate::{AppState, NoteScope};
use nightloom_service::agent::AsideCancels;
use nightloom_service::note_edit;
use nightloom_service::project;
use nightloom_service::{ClaudeCodeAgent, PassSpec, TurnEvent};
use serde::Serialize;
use std::sync::LazyLock;
use tauri::{AppHandle, Emitter, State};

/// One token per turn, by the window's `seq` — the aside's registry,
/// reused as is, in its own map so the two numberings cannot collide.
static CANCELS: LazyLock<AsideCancels> = LazyLock::new(AsideCancels::default);

/// The model's text as it streams; `seq` is the window's number for the
/// exchange, so a delta from a stopped one is dropped.
#[derive(Serialize, Clone)]
struct NoteEditDelta {
    seq: u64,
    text: String,
}

/// The note as it reads on disk after one Edit landed.
#[derive(Serialize, Clone)]
struct NoteEditLanded {
    seq: u64,
    text: String,
    edits: u32,
}

/// How the turn ended. Returned whether it succeeded or not, because the
/// note may have changed either way and the window needs its final text
/// (and Undo its `before`) in every case.
#[derive(Serialize)]
pub struct NoteEditResult {
    /// The note on disk when the turn ended.
    text: String,
    /// The model's closing sentences.
    summary: String,
    /// Edits that landed.
    edits: u32,
    interrupted: bool,
    /// What went wrong, when something did (the CLI failed, or the
    /// tripwire stopped the turn).
    error: Option<String>,
    /// The file's text before the window's buffer was written to it, when
    /// the two differed (an unsaved draft went in first) — kept by the
    /// window so nothing he had saved is lost.
    was_on_disk: Option<String>,
    /// The CLI's estimate of the API cost — not a bill under a subscription.
    cost_usd: Option<f64>,
    notices: Vec<String>,
}

/// Edit one note to fit `request`, on the Claude Code engine with the
/// rail's binary, model and safe mode. `text` is the note as the editor
/// holds it — the buffer, draft included — because that is what he is
/// looking at when he asks: when it differs from the file, it is written
/// to the file first, so the model edits what he sees.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn edit_note_by_prompt(
    app: AppHandle,
    power: State<'_, power::Holder>,
    state: State<'_, AppState>,
    scope: NoteScope,
    name: String,
    text: String,
    request: String,
    strike: bool,
    today: String,
    seq: u64,
    binary: Option<String>,
    model: Option<String>,
    safe_mode: Option<bool>,
) -> Result<NoteEditResult, String> {
    if request.trim().is_empty() {
        return Err("say what changed first".to_string());
    }
    crate::check_fixed_name(scope, &name)?;
    let dir = crate::scope_dir(&state, scope).await?;
    let file = project::note_file(&dir, &name)?;
    let on_disk = std::fs::read_to_string(&file).ok();
    let was_on_disk = match &on_disk {
        Some(d) if *d == text => None,
        other => {
            // The buffer goes to the file (and a missing file is made), so
            // there is a file to Read and Edit and it reads as he sees it.
            project::write_note(&dir, &name, &text)?;
            other.clone()
        }
    };
    // The canonical path: the CLI matches rules against it (`/private` on
    // a macOS temp folder), and the tripwire compares with it.
    let file = std::fs::canonicalize(&file)
        .map_err(|e| format!("cannot resolve {}: {e}", file.display()))?;

    let registered = CANCELS.begin(seq);
    let cancel = registered.token().clone();
    let mut pass = PassSpec::new(
        binary
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| "claude".into()),
        Vec::new(),
    );
    pass.model = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
    pass.safe_mode = safe_mode.unwrap_or(false);
    // An empty folder of its own: the note's folder would hand the CLI a
    // project's CLAUDE.md, and reads inside the working folder need no rule.
    let scratch = std::env::temp_dir().join("nightloom-note-edit");
    std::fs::create_dir_all(&scratch)
        .map_err(|e| format!("could not make the note editor's scratch folder: {e}"))?;
    let spec = note_edit::spec_for(&pass, &scratch, &file);
    let instruction = note_edit::compose_instruction(&name, &file, &request, strike, &today);
    // Awake while the turn runs (nightshift backlog 101).
    let _awake = power.acquire();
    let mut said = String::new();
    let mut edits = 0u32;
    let mut tripped: Option<String> = None;
    let mut on_event = |e: TurnEvent| match &e {
        TurnEvent::TextDelta { text } => {
            said.push_str(text);
            let _ = app.emit(
                "note-edit-delta",
                NoteEditDelta {
                    seq,
                    text: text.clone(),
                },
            );
        }
        TurnEvent::ToolCall { name, input, .. } => {
            if let Err(why) = note_edit::check_call(&file, name, input)
                && tripped.is_none()
            {
                tripped = Some(why);
                cancel.cancel();
            }
        }
        TurnEvent::ToolResult { name, is_error, .. } if name == "Edit" && !is_error => {
            edits += 1;
            if let Ok(now) = std::fs::read_to_string(&file) {
                let _ = app.emit(
                    "note-edit-landed",
                    NoteEditLanded {
                        seq,
                        text: now,
                        edits,
                    },
                );
            }
        }
        _ => {}
    };
    let ran = ClaudeCodeAgent::new(spec)
        .run_turn(instruction.as_str(), &cancel, &mut on_event)
        .await;
    let final_text = std::fs::read_to_string(&file).unwrap_or_else(|_| text.clone());
    let interrupted = cancel.is_cancelled() && tripped.is_none();
    let (summary, error, cost_usd, notices) = match ran {
        Ok(outcome) => {
            let error = if let Some(why) = &tripped {
                Some(format!("stopped: {why}"))
            } else if outcome.is_error && !interrupted {
                let s = outcome.text.trim();
                Some(if s.is_empty() {
                    "the note editor's Claude Code turn failed".to_string()
                } else {
                    format!("the note editor's Claude Code turn failed: {s}")
                })
            } else {
                None
            };
            let summary = if said.trim().is_empty() {
                outcome.text
            } else {
                said
            };
            (summary, error, outcome.cost_usd, outcome.notices)
        }
        Err(e) => (
            said,
            Some(match &tripped {
                Some(why) => format!("stopped: {why}"),
                None => format!("the note editor's Claude Code turn failed: {e}"),
            }),
            None,
            Vec::new(),
        ),
    };
    Ok(NoteEditResult {
        text: final_text,
        summary: summary.trim().to_string(),
        edits,
        interrupted,
        error,
        was_on_disk,
        cost_usd,
        notices,
    })
}

/// Stop turn `seq`. Edits that already landed stay; Undo puts the note
/// back as it was before the turn.
#[tauri::command]
pub fn cancel_note_edit(seq: u64) {
    let _ = CANCELS.cancel(seq);
}
