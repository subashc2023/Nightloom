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
    let previews = Arc::new(Previews::new());
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
        let path = preview::socket_path(&config);
        // Bound here, before any chat connects, so the first connection's
        // server is already told where it is.
        match preview::bind_socket(&path) {
            Ok(listener) => {
                let _ = SOCKET.set(path);
                tauri::async_runtime::spawn(preview::serve_socket(listener, previews));
            }
            Err(e) => eprintln!("nightloom: the preview socket did not bind: {e}"),
        }
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

/// His Stop on the chip.
#[tauri::command]
pub async fn preview_stop(host: tauri::State<'_, Host>, chat: String) -> Result<(), String> {
    let previews = Arc::clone(&host.previews);
    previews.stop(&chat).await;
    Ok(())
}
