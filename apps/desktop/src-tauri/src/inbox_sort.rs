//! The notes Inbox's "Sort inbox" (nightshift backlog 488), as the commands
//! around `nightloom_service::inbox_sort`: list the inbox, run the one-shot
//! Haiku turn that proposes a move plan, and apply the moves he ticked.
//!
//! The sort turn is its own CLI process with no tools, no MCP servers and
//! no session file, rooted at an empty scratch folder — it never touches a
//! chat's session or context. Only the Claude Code engine runs it.

use crate::power;
use crate::{AppState, NoteScope};
use nightloom_core::Usage;
use nightloom_service::inbox_sort::{self, Digest, Move, Moved, Proposal};
use nightloom_service::{ClaudeCodeAgent, PassSpec};
use serde::Serialize;
use std::sync::{LazyLock, Mutex};
use tauri::State;
use tokio_util::sync::CancellationToken;

/// The sort in flight, for Cancel. One at a time is all the sheet runs.
static RUNNING: LazyLock<Mutex<Option<CancellationToken>>> = LazyLock::new(Mutex::default);

fn notes_scope(scope: Option<NoteScope>) -> Result<NoteScope, String> {
    let scope = scope.unwrap_or_default();
    match scope {
        NoteScope::Project | NoteScope::Knowledge => Ok(scope),
        other => Err(format!("{other:?} has no inbox")),
    }
}

/// The inbox's entries and the folders around it; makes `Inbox/` when it is
/// not there, so the panel has a folder to drop on.
#[tauri::command]
pub async fn inbox_sort_list(
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
) -> Result<Digest, String> {
    let dir = crate::scope_dir(&state, notes_scope(scope)?).await?;
    inbox_sort::ensure_inbox(&dir)?;
    inbox_sort::gather(&dir)
}

#[derive(Serialize)]
pub struct SortPlan {
    pub proposals: Vec<Proposal>,
    pub folders: Vec<String>,
    pub left_out: usize,
    /// The model the CLI resolved to.
    pub model: Option<String>,
    pub usage: Usage,
    /// The CLI's estimate of the API cost — not a bill under a subscription.
    pub cost_usd: Option<f64>,
    pub interrupted: bool,
}

/// Ask the cheap model for a move plan. Nothing moves here.
#[tauri::command]
pub async fn inbox_sort_plan(
    power: State<'_, power::Holder>,
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
    instruction: Option<String>,
    binary: Option<String>,
    safe_mode: Option<bool>,
) -> Result<SortPlan, String> {
    let dir = crate::scope_dir(&state, notes_scope(scope)?).await?;
    let digest = inbox_sort::gather(&dir)?;
    if digest.items.is_empty() {
        return Err("the inbox is empty — drop files on the Inbox folder first".to_string());
    }
    let message = inbox_sort::compose(&digest, instruction.as_deref().unwrap_or(""));
    let mut pass = PassSpec::new(
        binary
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| "claude".into()),
        Vec::new(),
    );
    pass.safe_mode = safe_mode.unwrap_or(false);
    let scratch = std::env::temp_dir().join("nightloom-inbox-sort");
    std::fs::create_dir_all(&scratch)
        .map_err(|e| format!("could not make the sorter's scratch folder: {e}"))?;
    let spec = inbox_sort::spec_for(&pass, &scratch);
    let cancel = CancellationToken::new();
    *RUNNING.lock().unwrap_or_else(|p| p.into_inner()) = Some(cancel.clone());
    let _awake = power.acquire();
    let ran = ClaudeCodeAgent::new(spec)
        .run_turn(message.as_str(), &cancel, &mut |_| {})
        .await;
    RUNNING.lock().unwrap_or_else(|p| p.into_inner()).take();
    let outcome = ran.map_err(|e| format!("the sorter's Claude Code turn failed: {e}"))?;
    if cancel.is_cancelled() {
        return Ok(SortPlan {
            proposals: Vec::new(),
            folders: digest.folders,
            left_out: digest.left_out,
            model: outcome.model,
            usage: outcome.usage,
            cost_usd: outcome.cost_usd,
            interrupted: true,
        });
    }
    if outcome.is_error {
        let s = outcome.text.trim();
        return Err(if s.is_empty() {
            "the sorter's Claude Code turn failed".to_string()
        } else {
            format!("the sorter's Claude Code turn failed: {s}")
        });
    }
    let proposals = inbox_sort::parse_plan(&outcome.text, &digest)?;
    Ok(SortPlan {
        proposals,
        folders: digest.folders,
        left_out: digest.left_out,
        model: outcome.model,
        usage: outcome.usage,
        cost_usd: outcome.cost_usd,
        interrupted: false,
    })
}

/// Stop the sort in flight; nothing has moved.
#[tauri::command]
pub fn inbox_sort_cancel() {
    if let Some(t) = RUNNING.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        t.cancel();
    }
}

/// Move the ticked entries. Each stands alone; nothing is deleted or
/// written over (a taken name is numbered, item 492's Keep both).
#[tauri::command]
pub async fn inbox_sort_apply(
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
    moves: Vec<Move>,
) -> Result<Vec<Moved>, String> {
    let dir = crate::scope_dir(&state, notes_scope(scope)?).await?;
    Ok(inbox_sort::apply(&dir, &moves))
}
