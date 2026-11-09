//! The desktop's side of Claude's browser (nightshift item 508): the
//! browsers themselves (`nightloom_service::claude_browser::Browsers`),
//! their events to the window, the window's five commands (the contract is
//! nightshift `notes/runner-design/508-interface-2026-11-09.md`), and the
//! end of every browser at the app's exit. What an app-owned browser is and
//! why is in the service module's head.
//!
//! `session` in every command and event is the chat's id — its log's file
//! stem, the last part of its ask directory — as a preview's `chat` is.

use std::path::Path;
use std::sync::Arc;

use nightloom_service::claude_browser::{BrowserStatus, Browsers, Event};
use tauri::{AppHandle, Emitter, Manager};

pub struct Host {
    pub browsers: Arc<Browsers>,
}

/// `claude-browser-frame`: one JPEG, only while a tab watches.
#[derive(Clone, serde::Serialize)]
struct Frame<'a> {
    session: &'a str,
    seq: u64,
    jpeg: &'a str,
    w: u32,
    h: u32,
}

/// `claude-browser-status`: the status with the chat it is of.
#[derive(Clone, serde::Serialize)]
struct Status<'a> {
    session: &'a str,
    #[serde(flatten)]
    status: &'a BrowserStatus,
}

/// `claude-browser-dialog`: a dialog the page raised, for a line in the tab.
#[derive(Clone, serde::Serialize)]
struct Dialog<'a> {
    session: &'a str,
    kind: &'a str,
    message: &'a str,
}

/// At setup: the browsers as managed state, their events as window events,
/// and the idle watch. No browser is started here, or for any chat that
/// never uses Playwright.
pub fn setup(app: &AppHandle) {
    #[cfg(unix)]
    let dir = nightloom_service::preview::short_socket_dir();
    #[cfg(not(unix))]
    let dir = std::env::temp_dir().join("nightloom-browser");
    #[cfg(unix)]
    nightloom_service::claude_browser::sweep_sockets(&dir);
    let browsers = Arc::new(Browsers::new(dir));
    let handle = app.clone();
    browsers.set_on_event(Arc::new(move |session, event| {
        let _ = match event {
            Event::Frame { seq, jpeg, w, h } => handle.emit(
                "claude-browser-frame",
                Frame {
                    session,
                    seq: *seq,
                    jpeg,
                    w: *w,
                    h: *h,
                },
            ),
            Event::Status(status) => {
                handle.emit("claude-browser-status", Status { session, status })
            }
            Event::Dialog { kind, message } => handle.emit(
                "claude-browser-dialog",
                Dialog {
                    session,
                    kind,
                    message,
                },
            ),
        };
    }));
    let watch = Arc::clone(&browsers);
    tauri::async_runtime::spawn(async move { watch.spawn_idle_watch() });
    app.manage(Host { browsers });
}

/// Before a turn, after `set_ask_dir`: the chat's Playwright server is
/// attached to the app's browser for the chat (its socket; the browser
/// itself starts with the first call that runs). `ask_dir`'s last part is
/// the chat's id. Where the socket cannot be had — Playwright not
/// installed, no state — the server launches its own browser, as before.
pub fn point(
    host: Option<&Host>,
    agent: &mut nightloom_service::agent::ClaudeCodeAgent,
    ask_dir: &Path,
) {
    #[cfg(unix)]
    let endpoint = host.zip(ask_dir.file_name()).and_then(|(h, chat)| {
        agent
            .spec()
            .playwright
            .as_ref()
            .filter(|p| !p.no_card)
            .and_then(|_| h.browsers.endpoint(&chat.to_string_lossy(), ask_dir).ok())
    });
    #[cfg(not(unix))]
    let endpoint: Option<std::path::PathBuf> = {
        let _ = (host, ask_dir);
        None
    };
    agent.set_browser_endpoint(endpoint.as_deref());
}

/// At the app's exit: every browser ended, its in-memory logins with it.
pub fn on_exit(app: &AppHandle) {
    if let Some(host) = app.try_state::<Host>() {
        host.browsers.shutdown_all();
    }
}

/// The chat's browser, or `null` when the app has run none for it.
#[tauri::command]
pub fn claude_browser_status(
    host: tauri::State<'_, Host>,
    session: String,
) -> Option<BrowserStatus> {
    host.browsers.status(&session)
}

/// A tab shows or hides the browser: frames flow only while one watches.
#[tauri::command]
pub async fn claude_browser_watch(
    host: tauri::State<'_, Host>,
    session: String,
    on: bool,
) -> Result<(), String> {
    let browsers = Arc::clone(&host.browsers);
    browsers.watch(&session, on).await;
    Ok(())
}

/// His click, key, wheel or text in the picture; the first takes the hold.
#[tauri::command]
pub async fn claude_browser_input(
    host: tauri::State<'_, Host>,
    session: String,
    input: serde_json::Value,
) -> Result<(), String> {
    let browsers = Arc::clone(&host.browsers);
    browsers.input(&session, input).await
}

/// Back, forward, reload, or the address line; takes the hold too.
#[tauri::command]
pub async fn claude_browser_nav(
    host: tauri::State<'_, Host>,
    session: String,
    action: String,
    url: Option<String>,
) -> Result<(), String> {
    let browsers = Arc::clone(&host.browsers);
    browsers.nav(&session, &action, url.as_deref()).await
}

/// Take over (`true`) or Give back (`false`).
#[tauri::command]
pub async fn claude_browser_hold(
    host: tauri::State<'_, Host>,
    session: String,
    held: bool,
) -> Result<BrowserStatus, String> {
    let browsers = Arc::clone(&host.browsers);
    browsers.hold(&session, held).await
}
