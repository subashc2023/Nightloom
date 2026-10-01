//! Settings → Subscription → Models (nightshift item 272): the Claude Code
//! models the pickers offer and the away server's default, kept in
//! `~/.nightloom/model-list.json` (`nightloom_service::model_list`). This
//! module is that file's one writer on the Mac.

use nightloom_service::model_list::{self, ModelList};
use nightloom_service::project;

fn home() -> Result<std::path::PathBuf, String> {
    project::config_dir().ok_or_else(|| "no Nightloom home (set HOME)".to_string())
}

/// The list as the pickers read it: the file, else the built-in list.
#[tauri::command]
pub fn model_list_get() -> Result<ModelList, String> {
    Ok(model_list::load(&home()?))
}

/// Save the list (trimmed, de-duplicated; empty is the built-in) and answer
/// with what was written.
#[tauri::command]
pub fn model_list_set(list: ModelList) -> Result<ModelList, String> {
    model_list::save(&home()?, &list)
}
