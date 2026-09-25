//! Edit a note by prompt (nightshift backlog 151), as commands: one
//! rewrite, streamed to the window as `note-edit-delta` events, and its
//! cancel. The shape and the tests of the command line are the service's
//! (`nightloom_service::note_edit`); this is the process around it.
//!
//! Its own job, not the chat's: a rewrite runs a fresh CLI process with no
//! session, so it neither waits for a running turn nor touches one, and a
//! note can be edited with no chat connected at all. The window writes the
//! note — the model has no tool to — once the reply is whole.

use crate::power;
use nightloom_service::agent::AsideCancels;
use nightloom_service::note_edit;
use nightloom_service::{ClaudeCodeAgent, PassSpec, TurnEvent};
use serde::Serialize;
use std::sync::LazyLock;
use tauri::{AppHandle, Emitter, State};

/// One token per rewrite, by the window's `seq` — the aside's registry,
/// reused as is, in its own map so the two numberings cannot collide.
static CANCELS: LazyLock<AsideCancels> = LazyLock::new(AsideCancels::default);

/// A piece of the reply as it streams; `seq` is the window's number for the
/// exchange, so a delta from a cancelled one is dropped rather than typed
/// into the next.
#[derive(Serialize, Clone)]
struct NoteEditDelta {
    seq: u64,
    text: String,
}

/// The whole reply: the new note, the marker and the sentence, unsplit —
/// the window splits it with the same function it split the stream with.
#[derive(Serialize)]
pub struct NoteEditResult {
    reply: String,
    interrupted: bool,
    /// The CLI's estimate of the API cost — not a bill under a subscription.
    cost_usd: Option<f64>,
    notices: Vec<String>,
}

/// Rewrite one note to fit `request`, on the Claude Code engine with the
/// rail's binary, model and safe mode. `text` is the note as the editor
/// holds it — the buffer, draft included, not the file — because that is
/// what he is looking at when he asks.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn edit_note_by_prompt(
    app: AppHandle,
    power: State<'_, power::Holder>,
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
    // project's CLAUDE.md, and the model has no tool to look in this one.
    let scratch = std::env::temp_dir().join("nightloom-note-edit");
    std::fs::create_dir_all(&scratch)
        .map_err(|e| format!("could not make the note editor's scratch folder: {e}"))?;
    // The binary is resolved where the process is spawned (`drive`).
    let spec = note_edit::spec_for(&pass, &scratch);
    let instruction = note_edit::compose_instruction(&name, &text, &request, strike, &today);
    // Awake while the rewrite runs (nightshift backlog 101).
    let _awake = power.acquire();
    let mut reply = String::new();
    let mut on_event = |e: TurnEvent| {
        if let TurnEvent::TextDelta { text } = &e {
            reply.push_str(text);
            let _ = app.emit(
                "note-edit-delta",
                NoteEditDelta {
                    seq,
                    text: text.clone(),
                },
            );
        }
    };
    let outcome = ClaudeCodeAgent::new(spec)
        .run_turn(instruction.as_str(), &cancel, &mut on_event)
        .await
        .map_err(|e| format!("the note editor's Claude Code turn failed: {e}"))?;
    let interrupted = cancel.is_cancelled();
    if outcome.is_error && !interrupted {
        let said = outcome.text.trim();
        return Err(if said.is_empty() {
            "the note editor's Claude Code turn failed".to_string()
        } else {
            format!("the note editor's Claude Code turn failed: {said}")
        });
    }
    Ok(NoteEditResult {
        // A CLI that did not stream this turn still has the text on its
        // result line.
        reply: if reply.trim().is_empty() {
            outcome.text
        } else {
            reply
        },
        interrupted,
        cost_usd: outcome.cost_usd,
        notices: outcome.notices,
    })
}

/// Stop rewrite `seq`. The note is untouched either way: the window only
/// writes it from a whole reply.
#[tauri::command]
pub fn cancel_note_edit(seq: u64) {
    let _ = CANCELS.cancel(seq);
}
