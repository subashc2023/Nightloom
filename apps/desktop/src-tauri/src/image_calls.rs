//! The image tool's count for Settings → Usage (nightshift item 823,
//! stage 1). The tool and its log are `nightloom_service::image_tool`.

use nightloom_service::image_tool::{self, Summary};

use crate::blocking;

/// Every `generate_image` call so far: the total, the last 14 days, and
/// the newest calls to read.
#[tauri::command]
pub async fn image_tool_calls() -> Result<Summary, String> {
    let config = nightloom_service::project::config_dir()
        .ok_or_else(|| "no user config directory".to_string())?;
    blocking(move || Ok::<_, String>(image_tool::summary(&config))).await
}
