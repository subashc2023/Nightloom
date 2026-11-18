//! The feedback box's commands (nightshift item 805). The work is
//! `nightloom_service::feedback`, which the chats' `send_feedback` tool and
//! the phone's `POST /api/feedback` share: his words become one backlog
//! item in Nightloom's own backlog (the Nightshift repo, always: item 816),
//! saved first under the config dir so nothing he sends is lost.

use nightloom_service::feedback::{self, FiledAs, Note, Sent};

use crate::blocking;

fn config() -> Result<std::path::PathBuf, String> {
    nightloom_service::project::config_dir()
        .ok_or_else(|| "no user config directory — feedback has nowhere to be saved".to_string())
}

/// Send what he typed in the box. `note.via` is set to `box` here.
#[tauri::command]
pub async fn feedback_send(note: Note) -> Result<Sent, String> {
    let config = config()?;
    blocking(move || {
        let mut note = note;
        note.via = "box".into();
        // No project picker any more (item 816); an old draft's pick is dropped.
        note.about = None;
        let targets = feedback::targets_in(&config);
        feedback::send(Some(&config), &targets, note)
    })
    .await
}

/// File what is waiting (at launch): the notes saved while a shift was
/// live or no project was registered. Returns what went in.
#[tauri::command]
pub async fn feedback_flush() -> Result<Vec<FiledAs>, String> {
    let config = config()?;
    blocking(move || {
        let targets = feedback::targets_in(&config);
        Ok::<_, String>(
            feedback::flush(&config, &targets)
                .into_iter()
                .map(|(_, f)| f)
                .collect(),
        )
    })
    .await
}
