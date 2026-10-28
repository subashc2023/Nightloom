//! Finder's Open With → Nightloom (nightshift backlog 378): a Markdown or
//! plain-text file he opens with Nightloom becomes a tab.
//!
//! The bundle declares the types (`tauri.conf.json`'s `fileAssociations`,
//! rank `Alternate`: listed in Open With, never made the default by
//! installing — blocker 1469, he makes it the default himself). macOS
//! hands the files over as `RunEvent::Opened`, whether the open launched
//! the app or found it running. A launch delivers them before the page has
//! loaded, so they wait here ([`PENDING`]) and the page takes them
//! ([`take_opened_files`]) when it starts and whenever [`EVENT`] says more
//! arrived.
//!
//! **What may be read.** The file tab reads a path only inside a chat's
//! folders or written by its tools (`filetab.rs`); a file he chose in the
//! Finder is neither, and his choosing it is the permission. [`ALLOWED`]
//! keeps every path that arrived this way for the life of the process, so
//! the page naming a path cannot widen what is read — only an open from
//! the Finder can.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use tauri::{AppHandle, Emitter, Manager};

/// What the page is told when files arrived; it then takes them.
pub const EVENT: &str = "files-opened";

/// Opened and not yet taken by the page.
static PENDING: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// Every file opened from the Finder this run.
static ALLOWED: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// The local files among `urls`, real paths, regular files only — a
/// folder or a URL that is not `file:` is not a tab.
pub fn files_of(urls: &[tauri::Url]) -> Vec<PathBuf> {
    urls.iter()
        .filter(|u| u.scheme() == "file")
        .filter_map(|u| u.to_file_path().ok())
        .filter_map(|p| p.canonicalize().ok())
        .filter(|p| p.is_file())
        .collect()
}

/// Record `files` as opened: allowed for the tab, and waiting for the page.
pub fn accept(files: Vec<PathBuf>) {
    if files.is_empty() {
        return;
    }
    let mut allowed = ALLOWED.lock().unwrap_or_else(|e| e.into_inner());
    let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    for f in files {
        let s = f.to_string_lossy().into_owned();
        if !pending.contains(&s) {
            pending.push(s);
        }
        allowed.insert(f);
    }
}

/// `RunEvent::Opened`: keep the files, tell the page, bring the window
/// forward. macOS only — the event is the system's open-documents call.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn on_opened(app: &AppHandle, urls: &[tauri::Url]) {
    let files = files_of(urls);
    if files.is_empty() {
        return;
    }
    accept(files);
    let _ = app.emit(EVENT, ());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Whether `path` is a file he opened from the Finder this run.
pub fn is_opened(path: &Path) -> bool {
    let Ok(real) = path.canonicalize() else {
        return false;
    };
    ALLOWED
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&real)
}

/// The files waiting for a tab, emptied — each opens once.
#[tauri::command]
pub fn take_opened_files() -> Vec<String> {
    std::mem::take(&mut *PENDING.lock().unwrap_or_else(|e| e.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_finder_open_waits_once_for_the_page_and_stays_readable() {
        let dir = std::env::temp_dir().join(format!("nl-opened-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let md = dir.join("notes.md");
        std::fs::write(&md, "# hi").unwrap();
        let urls = vec![
            tauri::Url::from_file_path(&md).unwrap(),
            tauri::Url::from_file_path(&dir).unwrap(),
            tauri::Url::parse("https://example.com/x.md").unwrap(),
            tauri::Url::from_file_path(dir.join("gone.md")).unwrap(),
        ];
        let files = files_of(&urls);
        assert_eq!(files, vec![md.canonicalize().unwrap()], "the file alone");
        assert!(!is_opened(&md));
        accept(files.clone());
        accept(files);
        let taken = take_opened_files();
        assert_eq!(
            taken,
            vec![md.canonicalize().unwrap().to_string_lossy().into_owned()],
            "once, however often it arrived before the page took it"
        );
        assert!(take_opened_files().is_empty());
        assert!(
            is_opened(&md),
            "still readable by the tab after it was taken"
        );
        assert!(!is_opened(&dir.join("other.md")));
    }
}
