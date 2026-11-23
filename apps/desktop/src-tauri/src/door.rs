//! The door's Settings card and sidebar mark (nightshift item 767): what
//! the window reads and sets of `nightloom_service::door`. The socket
//! itself is opened in `remote::Remote::install`, over the same host the
//! phone's listener uses.

use std::collections::BTreeMap;

use nightloom_service::{door, project};
use serde::Serialize;

/// What Settings → Outside control shows.
#[derive(Serialize)]
pub(crate) struct DoorCard {
    /// `start` and `send` are allowed.
    writes: bool,
    /// The socket's path, when this app is listening on it.
    socket: Option<String>,
    /// How this binary is run as the command (`<exe> --chat`).
    command: String,
}

fn card(config: &std::path::Path) -> DoorCard {
    let socket = door::socket_path(config);
    DoorCard {
        writes: door::access(config).writes,
        socket: socket.exists().then(|| socket.display().to_string()),
        command: std::env::current_exe()
            .map(|e| format!("{} {}", e.display(), door::cli::DESKTOP_FLAG))
            .unwrap_or_default(),
    }
}

#[tauri::command]
pub(crate) fn door_card() -> Result<DoorCard, String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    Ok(card(&config))
}

/// The switch: read only (`false`) or start and message (`true`). Read at
/// every call through the door, so it takes effect at once.
#[tauri::command]
pub(crate) fn door_set_writes(writes: bool) -> Result<DoorCard, String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    door::set_access(&config, door::Access { writes })?;
    Ok(card(&config))
}

/// Chat id → who started it from outside, for the sidebars' mark.
#[tauri::command]
pub(crate) fn door_started() -> BTreeMap<String, String> {
    project::config_dir()
        .map(|config| {
            door::started(&config)
                .into_iter()
                .map(|(id, s)| (id, s.by))
                .collect()
        })
        .unwrap_or_default()
}
