//! Files for him (nightshift backlog 377): what the model marked with
//! `mark_file` as for the user, for the open project, as the top bar's
//! folder button and the + new-tab list draw it. The manifest and its
//! rules are the service's (`nightloom_service::tools::mark_file`); this is
//! the window's reading of it.
//!
//! **Freshness.** The marks come from two processes — the API engine's tool
//! in this one, the Claude Code engine's in the `--mcp-serve` child — so
//! there is no event to listen for. The window asks for [`for_you_stamp`]
//! (the manifest's length and modified time, one `stat`) every few seconds
//! and reads the list only when it changed: "within seconds" of the mark,
//! at the cost of a `stat`.

use std::path::{Path, PathBuf};

use nightloom_service::project;
use nightloom_service::tools::mark_file;
use serde::Serialize;
use tauri::State;

use crate::AppState;

/// The most rows the window is sent; the newest.
const CAP: usize = 50;

/// One file or folder for him, as a row draws it.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ForYou {
    /// Absolute.
    pub path: String,
    /// The path inside the chat's folder it was marked in, for the row.
    pub rel: String,
    pub folder: bool,
    pub title: Option<String>,
    /// When it was marked, RFC 3339.
    pub at: String,
}

fn manifest() -> Option<PathBuf> {
    project::config_dir().map(|c| mark_file::manifest_in(&c))
}

/// The rows for `project` (`None`: the unfiled chats) from `manifest`.
pub fn rows(manifest: &Path, project: Option<&str>) -> Vec<ForYou> {
    mark_file::for_user(manifest, project, CAP)
        .into_iter()
        .map(|m| {
            let rel = Path::new(&m.path)
                .strip_prefix(&m.root)
                .map(|r| r.to_string_lossy().into_owned())
                .ok()
                .filter(|r| !r.is_empty())
                .unwrap_or_else(|| m.path.clone());
            ForYou {
                path: m.path,
                rel,
                folder: m.folder,
                title: m.title,
                at: m.at,
            }
        })
        .collect()
}

/// The manifest's length and modified time as one string, or `""` when
/// there is none — what the window compares to know whether to re-read.
pub fn stamp(manifest: &Path) -> String {
    std::fs::metadata(manifest)
        .ok()
        .map(|m| {
            let at = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis());
            format!("{}:{at}", m.len())
        })
        .unwrap_or_default()
}

/// Whether `path` is one marked for him — the file tab and Reveal serve
/// such a path without a chat to vouch for it.
pub fn is_for_you(path: &Path) -> bool {
    manifest().is_some_and(|m| mark_file::is_for_user(&m, path))
}

/// The open project's files for him, newest first; the unfiled chats'
/// when no project is open.
#[tauri::command]
pub async fn for_you_files(state: State<'_, AppState>) -> Result<Vec<ForYou>, String> {
    let active = state.active().await;
    let Some(manifest) = manifest() else {
        return Ok(Vec::new());
    };
    let id = active.map(|p| p.id);
    tokio::task::spawn_blocking(move || rows(&manifest, id.as_deref()))
        .await
        .map_err(|e| e.to_string())
}

/// See the module's *Freshness*.
#[tauri::command]
pub fn for_you_stamp() -> String {
    manifest().map(|m| stamp(&m)).unwrap_or_default()
}

/// A row's Finder button: a file shown selected in its folder, a folder
/// opened. Only a path marked for him.
#[tauri::command]
pub fn for_you_reveal(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("{path} is no longer there"));
    }
    if !is_for_you(&target) {
        return Err(format!("{path} is not a file marked for you"));
    }
    if target.is_dir() {
        project::reveal(&target).map_err(|e| e.to_string())
    } else {
        project::reveal_file(&target).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mark_file::For;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nl-for-you-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn rows_name_the_path_inside_the_folder_and_the_stamp_moves_with_a_mark() {
        let base = scratch("rows");
        let root = base.join("chat");
        std::fs::create_dir_all(root.join("out")).unwrap();
        std::fs::write(root.join("out/plan.md"), "# p").unwrap();
        let manifest = base.join(mark_file::MANIFEST);
        assert_eq!(stamp(&manifest), "");
        mark_file::mark(&root, &manifest, Some("p"), "out/plan.md", For::User, None).unwrap();
        let first = stamp(&manifest);
        assert!(!first.is_empty());
        let r = rows(&manifest, Some("p"));
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].rel, "out/plan.md");
        assert!(!r[0].folder);
        mark_file::mark(&root, &manifest, Some("p"), "out", For::User, None).unwrap();
        assert_ne!(stamp(&manifest), first, "a new mark changes the stamp");
        let r = rows(&manifest, Some("p"));
        assert_eq!(r[0].rel, "out");
        assert!(r[0].folder);
        assert!(rows(&manifest, None).is_empty());
    }
}
