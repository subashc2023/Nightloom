//! The chat retrospective at hand-off (nightshift item 796): the no-model
//! digest of the open chat's Claude Code transcript, and the page kept in
//! its thread. The review pass between them is an ordinary aside
//! (`ask_aside`): a throwaway fork on the chat's warm cache.

#[allow(unused_imports)]
use crate::*;

/// What the window needs to run the review pass and draw the card's line.
#[derive(Serialize)]
pub(crate) struct RetroDigest {
    /// The digest as Markdown — the page's lower half.
    markdown: String,
    /// The aside's question: the instructions, then the digest.
    prompt: String,
    /// The counts the card's line shows.
    issues: usize,
    corrections: usize,
    misses: usize,
    miss_cost_usd: f64,
}

/// The digest of Claude Code session `agent_session` (item 796). Reads the
/// CLI's transcript only; no model, nothing written.
#[tauri::command]
pub(crate) async fn retro_digest(agent_session: String) -> Result<RetroDigest, String> {
    blocking(move || {
        let d = nightloom_service::retrospective::digest_session(&agent_session)?;
        let markdown = nightloom_service::retrospective::render(&d);
        let prompt = nightloom_service::retrospective::review_prompt(&markdown);
        Ok::<_, String>(RetroDigest {
            prompt,
            markdown,
            issues: d.issues.len(),
            corrections: d.corrections.len(),
            misses: d.misses.len(),
            miss_cost_usd: d.miss_cost_usd,
        })
    })
    .await
}

/// Keep the review page (item 796) under the chat's thread's
/// `retrospectives/`, or the open project's when the chat has no thread;
/// a new file each time, never over an earlier one. Returns its path.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn retro_save(
    state: State<'_, AppState>,
    chat: String,
    title: String,
    thread: Option<String>,
    review: String,
    review_cost: Option<f64>,
    digest: String,
) -> Result<String, String> {
    let notes = commands::threads::thread_notes(&state).await?;
    let now = chrono::Local::now();
    let date = now.format("%Y-%m-%d").to_string();
    let when = now.format("%Y-%m-%d %-I:%M %p").to_string();
    blocking(move || {
        let body = nightloom_service::retrospective::page(
            &title,
            &chat,
            &when,
            &review,
            review_cost,
            &digest,
        );
        nightloom_service::retrospective::save_page(&notes, thread.as_deref(), &chat, &date, &body)
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
}
