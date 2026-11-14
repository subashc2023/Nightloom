//! System commands: reveal and open files and URLs, file tabs, notifications, power and zoom, the build stamp, a chat's Playwright switch (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// What build is running: the crate's version and the binary's
/// modification time. The frontend keeps the last stamp it saw and reads a
/// change as "a release was installed" — the bell's fifth kind — since a
/// release roll is the only thing that rewrites the binary.
#[derive(Serialize)]
pub(crate) struct BuildStamp {
    version: String,
    exe_modified: Option<String>,
}

#[tauri::command]
pub(crate) fn build_stamp() -> BuildStamp {
    BuildStamp {
        version: env!("CARGO_PKG_VERSION").to_string(),
        exe_modified: nightloom_service::centre::exe_modified(),
    }
}

/// Show a folder in the OS file manager.
///
/// The docspace is a real directory and its whole appeal is that it is: the
/// user can drop a PDF in it, edit a note in their own editor, or put it under
/// version control. A button that opens it is what makes that discoverable.
#[tauri::command]
pub(crate) async fn reveal(state: State<'_, AppState>, path: Option<String>) -> Result<(), String> {
    let target = match path {
        Some(p) => PathBuf::from(p),
        None => scope_dir(&state, NoteScope::Project).await?,
    };
    // Created on demand: the docspace does not exist until something is in it,
    // and "open the folder" is a reasonable way to put the first thing there.
    if !target.exists() {
        std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    }
    project::reveal(&target).map_err(|e| e.to_string())
}

/// Which of the paths a reply named are real files, for the file cards
/// under the reply (nightshift backlog 078). One answer per path, in order;
/// null for anything that is not an existing regular file.
#[tauri::command]
pub(crate) fn named_files(paths: Vec<String>) -> Vec<Option<project::NamedFile>> {
    project::named_files(&paths)
}

/// Show one file in the OS file manager, selected — the file card's Reveal.
/// Nothing is created: a card names a file that was there when it was drawn,
/// and if it has gone since, the error is the answer.
#[tauri::command]
pub(crate) fn reveal_file(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.is_file() {
        return Err(format!("{} is no longer there", target.display()));
    }
    project::reveal_file(&target).map_err(|e| e.to_string())
}

/// Open a file in the application the OS pairs it with — the file card's
/// Open. Same terms as `reveal_file` — except a file the OS would *run*
/// rather than show (review 2026-09-17 FD4b, backlog 136; blocker 205's
/// list): the card's path is the model's choice, and `open` on a `.pkg`
/// is the Installer, on a `.command` a Terminal running it, on an `.app`
/// the app. Those are refused with a sentence naming Reveal, which only
/// shows the file; `open_url` refuses everything but `https://` for the
/// same reason.
#[tauri::command]
pub(crate) fn open_file(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.is_file() {
        return Err(format!("{} is no longer there", target.display()));
    }
    if let Some(kind) = launchable(&target) {
        return Err(format!(
            "{} is {kind} — Open would run it; Reveal shows it in the Finder instead",
            target.display()
        ));
    }
    project::reveal(&target).map_err(|e| e.to_string())
}

/// A file card's Open as a tab (nightshift backlog 161): the file read for
/// the pane, when `chat` may see it — inside its folders (the project's,
/// the chat's own, the extra folders, the vault) or written by its own
/// tools, known from its log (guess pass 2026-09-25, question 17). The
/// rules and the refusal's words are `filetab`'s. The chat's log is read
/// from memory when it is held and free, else from disk, so a card under a
/// running turn still opens.
#[tauri::command]
pub(crate) async fn read_file_tab(
    state: State<'_, AppState>,
    path: String,
    chat: Option<String>,
) -> Result<filetab::FileTab, String> {
    let target = PathBuf::from(&path);
    let active = state.active().await;
    // The trees and the written paths, from the chat's log however it is
    // reached; `Session` is not `Clone`, so both are taken under one look.
    let facts = |session: Option<&Session>| -> (Vec<PathBuf>, Vec<PathBuf>) {
        let mut trees: Vec<PathBuf> = Vec::new();
        if let Some(p) = &active {
            trees.push(p.workspace_dir());
        }
        if let Some(w) = session.and_then(|s| s.kind_workspace()) {
            trees.push(w.to_path_buf());
        }
        trees.extend(
            extra_folders(active.as_ref(), session)
                .into_iter()
                .map(|(p, _)| p),
        );
        if let Some(config) = project::config_dir() {
            trees.push(nightloom_service::knowledge::vault_dir_in(&config));
            // Item 499: the copies `send_file` keeps of what a chat sent
            // him are Nightloom's own store; its chip opens them here.
            trees.push(nightloom_service::tools::send_file::store_in(&config));
        }
        trees.push(nightloom_service::tools::send_file::scratch_store());
        let written = session
            .map(|s| filetab::written_paths(s.events(), trees.first().map(PathBuf::as_path)))
            .unwrap_or_default();
        (trees, written)
    };
    let held = chat.as_deref().and_then(|id| state.chats.find(id));
    let from_memory = held
        .as_ref()
        .and_then(|(_, log)| log.try_lock().ok().map(|s| facts(Some(&*s))));
    let (trees, written) = match (from_memory, &chat) {
        (Some(f), _) => f,
        (None, Some(id)) => {
            let loaded = store::find_by_prefix(&state.log_dir().await, id)
                .ok()
                .and_then(|p| Session::load(p).ok());
            facts(loaded.as_ref())
        }
        (None, None) => facts(None),
    };
    // A file he opened from the Finder (backlog 378) or one the model
    // marked for him (backlog 377) needs no chat to vouch for it.
    if opened_files::is_opened(&target) || for_you::is_for_you(&target) {
        return filetab::read(&target, filetab::Via::Chosen);
    }
    let via = filetab::permitted(&target, &trees, &written)?;
    filetab::read(&target, via)
}

/// What a file the OS would run rather than show is, by extension or the
/// executable bit; `None` for a document. The list is blocker 205's.
pub(crate) fn launchable(path: &Path) -> Option<&'static str> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    let by_ext = match ext.as_deref() {
        Some("app") => Some("an application"),
        Some("pkg" | "mpkg" | "dmg") => Some("an installer image"),
        Some("command" | "tool" | "sh" | "zsh" | "bash" | "terminal") => Some("a shell script"),
        Some("scpt" | "workflow" | "applescript") => Some("a script"),
        Some("webloc" | "url") => Some("a link file"),
        Some("lnk" | "exe" | "msi" | "bat" | "cmd" | "ps1" | "vbs" | "scr") => Some("a program"),
        Some("jar" | "py" | "rb" | "pl") => Some("a script the OS may run"),
        _ => None,
    };
    if by_ext.is_some() {
        return by_ext;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 != 0) {
            return Some("marked executable");
        }
    }
    None
}

/// Open an `https://` link in the browser — the artifact card's Open.
#[tauri::command]
pub(crate) fn open_url(url: String) -> Result<(), String> {
    project::open_url(&url).map_err(|e| e.to_string())
}

/// Post a banner through the OS notification centre (nightshift backlog
/// 079): a turn finished, or a call is waiting on an answer, while the
/// window is not the one in front. The frontend decides *whether* — it is
/// the one that knows the window's focus and the setting — and this only
/// posts. From Rust rather than the webview so the capability set gains
/// nothing and no npm package is needed, as with the folder picker.
///
/// macOS shows a banner only for a bundled, signed app; a `cargo tauri dev`
/// build posts into nothing, without an error.
#[tauri::command]
pub(crate) fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// The event a click on the Refresh-now banner raises (backlog 116). Only
/// the macOS branch below can see a click, so only it reads this — the
/// Windows job's clippy runs with `-D warnings` and dead code fails it.
#[cfg(target_os = "macos")]
pub(crate) const USAGE_BANNER_CLICKED: &str = "usage-banner-clicked";

/// The Refresh-now banner (nightshift backlog 116, blocker 169): posted
/// when the usage collector he *asked* to run finishes — never for the
/// six-hourly refresh — and, unlike `notify`, its click comes back. The
/// plugin's `show()` drops the handle its macOS backend returns, so this
/// posts through that backend itself (`mac-notification-sys`, under the
/// `notify-rust` the plugin already compiles; notify-rust itself until
/// 2026-09-25): the same `NSUserNotificationCenter` delegate, the
/// same banner, held synchronously on a thread of its own until it is
/// clicked or cleared. A click brings the window forward and emits
/// `usage-banner-clicked`; the frontend opens Settings on the Usage pane.
/// Off macOS it is `notify`, and the click is lost — said in the report.
///
/// The thread lives until the banner is acted on or cleared from the
/// notification centre; one per press of the button, which is rare.
#[tauri::command]
pub(crate) fn notify_usage_refreshed(
    app: AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::thread::Builder::new()
            .name("usage-banner".into())
            .spawn(move || {
                // Which app is posting: without this the library looks up
                // an application literally named "use_default" and macOS
                // opens a "Where is use_default?" chooser over his screen
                // (seen 2026-09-17 on the first Refresh now). Set once; a
                // second press gets AlreadySet, which is fine.
                let _ = mac_notification_sys::set_application("app.nightloom.desktop");
                // `wait_for_click` is what makes the send block until the
                // banner is clicked or cleared. notify-rust 4.18's
                // `wait_for_action` sets no such flag, so for a banner with
                // no buttons it returned at delivery and the click was lost
                // (found 2026-09-25 reading mac-notification-sys 0.6.15's
                // `needs_response`).
                let clicked = matches!(
                    mac_notification_sys::Notification::new()
                        .title(&title)
                        .message(&body)
                        .wait_for_click(true)
                        .send(),
                    Ok(mac_notification_sys::NotificationResponse::Click)
                );
                if !clicked {
                    return;
                }
                // The window, not the webview window: once a web tab's
                // page is a child of it (backlog 172) tauri no longer
                // answers `get_webview_window` for it.
                if let Some(w) = app.get_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                let _ = app.emit(USAGE_BANNER_CLICKED, ());
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        notify(app, title, body)
    }
}

/// The sleep-safe switches (nightshift backlog 101), sent by `sleep.ts` at
/// start-up and on every change. The frontend keeps them, the way it keeps
/// the notification switches; Rust only needs to know what to spawn. A
/// change while a turn runs restarts the child with the new flags.
#[tauri::command]
pub(crate) fn set_power_prefs(power: State<'_, power::Holder>, prefs: power::Prefs) {
    power.set_prefs(prefs);
}

/// Scale the whole window (nightshift backlog 108): `WebviewWindow::set_zoom`,
/// which on macOS is `WKWebView.pageZoom` (11+) — the same page zoom
/// Chrome's ⌘+ does, every CSS pixel scaled. The factor is the frontend's
/// (`zoom.ts` keeps it in localStorage and re-applies it at start-up, since
/// the webview forgets it between launches); Rust only sets it.
///
/// The main *webview*, not the webview window: tauri answers
/// `get_webview_window` only while the window holds a single webview, so
/// with a web tab open (backlog 172) that lookup found nothing and ⌘+/⌘−
/// failed with "no main window" (batch review 2026-09-23, finding 1).
#[tauri::command]
pub(crate) fn set_zoom(app: AppHandle, factor: f64) -> Result<(), String> {
    app.get_webview("main")
        .ok_or_else(|| "no main window".to_string())?
        .set_zoom(factor)
        .map_err(|e| e.to_string())
}

/// The chat's Playwright switch (nightshift backlog 367): whether
/// Playwright is installed, and whether this chat runs it without asking —
/// the card's *Allow for this chat*. `on` sets it first; off means the next
/// Playwright call shows the card again. `chat` is the chat's id (its log's
/// stem, the ask directory's name), in the open project's log folder.
#[derive(Serialize)]
pub(crate) struct PlaywrightSwitch {
    installed: bool,
    on: bool,
}

#[tauri::command]
pub(crate) async fn playwright_for_chat(
    state: State<'_, AppState>,
    chat: String,
    on: Option<bool>,
) -> Result<PlaywrightSwitch, String> {
    let chat = chat.trim();
    if chat.is_empty() || chat.contains(['/', '\\']) || chat.starts_with('.') {
        return Err(format!("not a chat id: {chat}"));
    }
    let dir = state.log_dir().await.join("ask").join(chat);
    if let Some(on) = on {
        nightloom_service::agent::own_browser::set_for_chat(&dir, on).map_err(|e| e.to_string())?;
    }
    Ok(PlaywrightSwitch {
        installed: nightloom_service::agent::own_browser::locate().is_some(),
        on: nightloom_service::agent::own_browser::for_chat(&dir),
    })
}
