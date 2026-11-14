//! Edit-menu commands: retitle Undo and Redo, and paste into the focused field (moved from main.rs, item 642; the menu itself is built in main.rs).

#[allow(unused_imports)]
use crate::*;

/// Retitle and enable the Edit menu's Undo and Redo to match the
/// frontend's undo stack (nightshift backlog 064, 2026-09-15): `undo` /
/// `redo` name the operation each would reverse ("rewind", "remove") or
/// are absent when there is nothing to; `text_field` says the focus is in
/// a text box, where the item stays enabled under its plain title because
/// the key then undoes typing. A no-op off macOS, where there is no menu
/// bar and `App.svelte` binds the keys itself.
#[tauri::command]
pub(crate) async fn set_undo_menu(
    app: AppHandle,
    undo: Option<String>,
    redo: Option<String>,
    text_field: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let menu = app.menu().ok_or_else(|| "no menu".to_string())?;
        let edit = menu
            .get(EDIT_MENU_ID)
            .and_then(|m| m.as_submenu().cloned())
            .ok_or_else(|| "no Edit menu".to_string())?;
        for (id, verb, label) in [(UNDO_MENU_ID, "Undo", undo), (REDO_MENU_ID, "Redo", redo)] {
            let item = edit
                .get(id)
                .and_then(|m| m.as_menuitem().cloned())
                .ok_or_else(|| format!("no {verb} item"))?;
            let title = match (&label, text_field) {
                (Some(l), false) => format!("{verb} {l}"),
                _ => verb.to_string(),
            };
            item.set_text(title).map_err(|e| e.to_string())?;
            item.set_enabled(label.is_some() || text_field)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, undo, redo, text_field);
        Ok(())
    }
}

/// Paste, as Edit ▸ Paste does it (nightshift item 284): AppKit's `paste:`
/// sent down the key window's responder chain, so the focused text box gets
/// a real paste event with the clipboard's text and images. The composer
/// asks for one on ⌥⌘V, having marked that the next paste is to become an
/// attachment; the webview has no other way to read the clipboard without
/// macOS's "Paste" confirmation bubble. `false` off macOS, where the
/// frontend reads the clipboard itself.
#[tauri::command]
pub(crate) async fn paste_into_focus(app: AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let sent = app.run_on_main_thread(move || {
            use objc2::runtime::AnyObject;
            use objc2::{class, msg_send, sel};
            let none: *mut AnyObject = std::ptr::null_mut();
            // SAFETY: main thread; `sendAction:to:from:` with a nil target
            // walks the key window's responder chain, as a menu item does
            // (the same call `webtab::menu_route` makes for undo:).
            let ok: bool = unsafe {
                let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
                msg_send![ns_app, sendAction: sel!(paste:), to: none, from: none]
            };
            let _ = tx.send(ok);
        });
        if sent.is_err() {
            return false;
        }
        rx.await.unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        false
    }
}
