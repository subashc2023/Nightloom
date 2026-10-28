//! The desktop's side of a chat's preview (nightshift item 430): the
//! previews themselves (`nightloom_service::preview::Previews`), the socket
//! a chat's MCP server reaches them by, the window's commands, and the kill
//! at the app's exit. What a preview is and why the app runs it is in the
//! service module's head.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use nightloom_service::preview::{Previews, Snapshot};
use tauri::{AppHandle, Emitter, Manager};

/// The socket this app process answers on, once bound. Read when a
/// connection builds its MCP server's arguments.
static SOCKET: OnceLock<PathBuf> = OnceLock::new();

/// Why the previews are not served in this app process, when they are
/// not (item 444): every bind attempt's error, for the window to show.
static UNAVAILABLE: OnceLock<String> = OnceLock::new();

pub struct Host {
    pub previews: Arc<Previews>,
}

/// What `preview-changed` carries: the chat, and its preview or `null`
/// once it is gone.
#[derive(Clone, serde::Serialize)]
struct Changed {
    chat: String,
    preview: Option<Snapshot>,
}

/// The socket path, if the previews are being served.
pub fn socket() -> Option<&'static PathBuf> {
    SOCKET.get()
}

/// At setup: the previews as managed state, their changes as window
/// events, and the socket bound and served.
pub fn setup(app: &AppHandle) {
    // Recorded across launches (item 445): what ended with the last run
    // comes back as ended, for the chip's Restart and the model's note.
    let previews = match nightloom_service::project::config_dir() {
        Some(config) => {
            let p = Previews::new().with_record(nightloom_service::preview::record_path(&config));
            p.restore_ended();
            p
        }
        None => Previews::new(),
    };
    let previews = Arc::new(previews);
    let handle = app.clone();
    previews.set_on_change(Arc::new(move |chat, snap| {
        let _ = handle.emit(
            "preview-changed",
            Changed {
                chat: chat.to_string(),
                preview: snap.cloned(),
            },
        );
    }));
    app.manage(Host {
        previews: Arc::clone(&previews),
    });
    #[cfg(unix)]
    if let Some(config) = nightloom_service::project::config_dir() {
        use nightloom_service::preview;
        preview::sweep_sockets(&config);
        // Bound here, before any chat connects, so the first connection's
        // server is already told where it is. Under the config dir, or a
        // short folder when that path is too long for a socket (item 444).
        match preview::bind_preview_socket(&config) {
            Ok((path, listener)) => {
                let _ = SOCKET.set(path);
                tauri::async_runtime::spawn(preview::serve_socket(listener, previews));
            }
            Err(e) => {
                eprintln!("nightloom: the preview socket did not bind: {e}");
                let _ = UNAVAILABLE.set(e);
            }
        }
    }
}

/// The message's note when the chat's preview ended since the model last
/// heard of it (item 445), after whatever note the turn already carries.
/// `ask_dir`'s last part is the chat's id, as `set_ask_dir` names it.
pub fn with_ended_note(
    app: &AppHandle,
    ask_dir: Option<&std::path::Path>,
    note: Option<String>,
) -> Option<String> {
    let chat = ask_dir
        .and_then(|d| d.file_name())
        .map(|c| c.to_string_lossy().into_owned());
    let ended = chat.and_then(|c| {
        app.try_state::<Host>()
            .and_then(|h| h.previews.take_ended_note(&c))
    });
    match (note, ended) {
        (Some(a), Some(b)) => Some(format!("{a}\n\n{b}")),
        (a, b) => a.or(b),
    }
}

/// At the app's exit: every preview's process group ended, and the socket
/// removed.
pub fn on_exit(app: &AppHandle) {
    if let Some(host) = app.try_state::<Host>() {
        host.previews.shutdown_all();
    }
    if let Some(path) = SOCKET.get() {
        let _ = std::fs::remove_file(path);
    }
}

/// Every chat's preview, for the window's first paint.
#[tauri::command]
pub fn preview_list(host: tauri::State<'_, Host>) -> Vec<Snapshot> {
    host.previews.all()
}

/// One chat's preview, the log's newest lines included.
#[tauri::command]
pub fn preview_get(host: tauri::State<'_, Host>, chat: String) -> Option<Snapshot> {
    host.previews.status(&chat)
}

/// Why previews are unavailable in this app process, or `None` when they
/// are served (item 444).
#[tauri::command]
pub fn preview_unavailable() -> Option<String> {
    #[cfg(unix)]
    {
        UNAVAILABLE.get().cloned()
    }
    #[cfg(not(unix))]
    {
        Some("previews run on macOS and Linux only".into())
    }
}

/// His Restart on the chip of a preview that ended (item 445).
#[tauri::command]
pub async fn preview_restart(
    host: tauri::State<'_, Host>,
    chat: String,
) -> Result<Snapshot, String> {
    let previews = Arc::clone(&host.previews);
    previews.restart(&chat).await
}

/// His Stop on the chip.
#[tauri::command]
pub async fn preview_stop(host: tauri::State<'_, Host>, chat: String) -> Result<(), String> {
    let previews = Arc::clone(&host.previews);
    previews.stop(&chat).await;
    Ok(())
}
