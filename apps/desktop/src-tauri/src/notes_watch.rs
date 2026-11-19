//! Item 869: the Notes list follows its folders when they change outside
//! Nightloom. `watch_notes` subscribes to the window's open project's notes
//! folder and to the knowledge base (`nightloom_service::notes_watch`); a
//! change emits `notes-changed` (the scope and paths) to that window, which re-reads.

use crate::AppState;
use crate::commands::notes::{NoteScope, scope_dir_in};
use nightloom_service::nightshift::watch::ChangeWatcher;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{Emitter, State, Window};

/// The payload of `notes-changed`: which folder, and the batch's paths
/// relative to it (review of 869: the open note re-reads itself only when
/// its own file, or a folder above it, is among them).
#[derive(serde::Serialize, Clone)]
pub struct NotesChanged {
    pub scope: &'static str,
    pub paths: Vec<String>,
}

/// The live notes watches, keyed `<window label>:<scope>`, each with the
/// folder it watches so an unchanged one is kept rather than re-subscribed.
#[derive(Default)]
pub struct NotesWatches(std::sync::Mutex<HashMap<String, (PathBuf, ChangeWatcher)>>);

/// Watch the open project's notes and the knowledge base for this window.
/// Idempotent: a folder already watched is kept; a moved one is replaced; a
/// missing one (no notes yet, no project) is dropped and reported as an
/// error so the caller asks again at its next read.
#[tauri::command]
pub async fn watch_notes(
    window: Window,
    state: State<'_, AppState>,
    watches: State<'_, NotesWatches>,
) -> Result<(), String> {
    let mut missing = Vec::new();
    for (scope, word) in [
        (NoteScope::Project, "project"),
        (NoteScope::Knowledge, "knowledge"),
    ] {
        let key = format!("{}:{word}", window.label());
        let dir = scope_dir_in(&state, scope, None).await.ok();
        let mut table = watches
            .0
            .lock()
            .map_err(|_| "notes watch table poisoned".to_string())?;
        let Some(dir) = dir.filter(|d| d.is_dir()) else {
            table.remove(&key);
            missing.push(word);
            continue;
        };
        if table.get(&key).is_some_and(|(d, _)| *d == dir) {
            continue;
        }
        let w = window.clone();
        let label = window.label().to_string();
        let watcher = nightloom_service::notes_watch::watch_notes(&dir, move |paths| {
            let _ = w.emit_to(
                label.as_str(),
                "notes-changed",
                NotesChanged { scope: word, paths },
            );
        });
        match watcher {
            Ok(watcher) => {
                table.insert(key, (dir, watcher));
            }
            Err(_) => {
                table.remove(&key);
                missing.push(word);
            }
        }
    }
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("not watched: {}", missing.join(", ")))
    }
}
