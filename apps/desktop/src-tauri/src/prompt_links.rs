//! Prompt links (nightshift item 976, from 762's survey of T3 Code):
//! `nightloom://new?project=<name>&prompt=<text>` opens a new chat in that
//! project with the prompt in its message box — never sent.
//!
//! The bundle claims the scheme (`Info.plist`'s `CFBundleURLTypes`, merged
//! by Tauri). macOS hands an opened URL to the running app, or launches it
//! with the URL, as `RunEvent::Opened` — the same event Finder's Open With
//! uses (`opened_files.rs`) — so no second instance starts and no plugin is
//! needed. A launch delivers the URL before the page has loaded, so links
//! wait here ([`PENDING`]) until the page takes them ([`take_prompt_links`]),
//! at its start and whenever [`EVENT`] says more arrived. The page parses
//! the link and decides where it goes (`promptLinks.svelte.ts`): nothing in
//! a link is ever run or sent here.

use std::sync::{LazyLock, Mutex};

use tauri::{AppHandle, Emitter, Manager};

/// The URL scheme the bundle claims.
pub const SCHEME: &str = "nightloom";

/// What the page is told when a link arrived; it then takes them.
pub const EVENT: &str = "prompt-links";

/// A link longer than this is dropped whole (a prompt is words, not a
/// payload): 256 KB.
pub const MAX_LINK: usize = 256 * 1024;

/// Arrived and not yet taken by the page, oldest first.
static PENDING: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));

/// The `nightloom:` links among `urls`, as their text; a file or any other
/// scheme is not one, nor a link past [`MAX_LINK`].
pub fn links_of(urls: &[tauri::Url]) -> Vec<String> {
    urls.iter()
        .filter(|u| u.scheme() == SCHEME)
        .map(|u| u.as_str().to_string())
        .filter(|s| s.len() <= MAX_LINK)
        .collect()
}

/// Keep `links` for the page.
pub fn accept(links: Vec<String>) {
    PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .extend(links);
}

/// `RunEvent::Opened`: keep the links, tell the page, bring the window
/// forward. Files in the same event are `opened_files`'s.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn on_opened(app: &AppHandle, urls: &[tauri::Url]) {
    let links = links_of(urls);
    if links.is_empty() {
        return;
    }
    accept(links);
    let _ = app.emit(EVENT, ());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The links waiting for the page, emptied — each opens once.
#[tauri::command]
pub fn take_prompt_links() -> Vec<String> {
    std::mem::take(&mut *PENDING.lock().unwrap_or_else(|e| e.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_nightloom_links_wait_once_for_the_page() {
        let link = "nightloom://new?project=Nightloom&prompt=Read%20HANDOFF.md";
        let long = format!("nightloom://new?prompt={}", "a".repeat(MAX_LINK));
        let urls = vec![
            tauri::Url::parse(link).unwrap(),
            tauri::Url::parse("https://example.com/?prompt=x").unwrap(),
            tauri::Url::from_file_path(std::env::temp_dir()).unwrap(),
            tauri::Url::parse(&long).unwrap(),
        ];
        let links = links_of(&urls);
        assert_eq!(links, vec![link.to_string()], "the nightloom link alone");
        accept(links);
        assert_eq!(take_prompt_links(), vec![link.to_string()]);
        assert!(take_prompt_links().is_empty(), "each opens once");
    }
}
