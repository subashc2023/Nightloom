//! Saved message prompts (nightshift item 800): Settings' list, read and
//! written whole through [`nightloom_service::saved_prompts`] under the
//! config directory — the same file the phone reads at
//! `GET /api/saved-prompts`. What a save means (the old version kept, a
//! delete to the trash) is `savedPrompts.ts`'s; these only move the file.

#[allow(unused_imports)]
use crate::*;

use nightloom_service::saved_prompts::{self, Doc, Reading};

fn dir() -> Result<std::path::PathBuf, String> {
    project::config_dir()
        .ok_or_else(|| "No config folder on this machine to keep saved prompts in.".to_string())
}

#[tauri::command]
pub(crate) async fn saved_prompts_read() -> Result<Reading, String> {
    let dir = dir()?;
    tokio::task::spawn_blocking(move || saved_prompts::read(&dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn saved_prompts_write(doc: Doc) -> Result<(), String> {
    let dir = dir()?;
    tokio::task::spawn_blocking(move || saved_prompts::write(&dir, &doc))
        .await
        .map_err(|e| e.to_string())?
}

/// The pasteboard's plain text, for a prompt's `{clipboard}` blank — read
/// natively, the way a paste's web archive already is (`paste_images.rs`),
/// so the webview's own clipboard read (which shows a Paste bubble) is not
/// needed. `None` when it holds no text.
#[tauri::command]
pub(crate) fn clipboard_text() -> Option<String> {
    paste_images::pasteboard_text()
}
