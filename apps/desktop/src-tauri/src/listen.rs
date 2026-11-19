//! Listen (nightshift backlog 801): the window's read-aloud. The text goes
//! to the host's Piper voice (`nightloom_service::voice::listen`) and comes
//! back as one WAV file, raw bytes over IPC; Brief first rewrites it for
//! the ear with a one-shot Haiku turn of the chat namer's shape.

use crate::remote::Remote;
use nightloom_service::voice::listen;
use nightloom_service::{ClaudeCodeAgent, PassSpec};
use tauri::State;
use tokio_util::sync::CancellationToken;

/// `text` read aloud, as a WAV file's bytes.
#[tauri::command]
pub async fn listen_audio(
    remote: State<'_, Remote>,
    text: String,
) -> Result<tauri::ipc::Response, String> {
    let engine = remote
        .voice_engine()
        .ok_or("Listen needs the host's voice — run bin/voice-setup.sh once")?;
    let wav = listen::read_aloud(&*engine, &text).await?;
    Ok(tauri::ipc::Response::new(wav))
}

/// `text` rewritten for the ear in under two minutes, ending with what was
/// left out.
#[tauri::command]
pub async fn listen_brief(
    text: String,
    binary: Option<String>,
    safe_mode: Option<bool>,
) -> Result<String, String> {
    let mut pass = PassSpec::new(
        binary
            .map(|b| b.trim().to_string())
            .filter(|b| !b.is_empty())
            .unwrap_or_else(|| "claude".into()),
        Vec::new(),
    );
    pass.safe_mode = safe_mode.unwrap_or(false);
    let scratch = std::env::temp_dir().join("nightloom-listen-brief");
    std::fs::create_dir_all(&scratch)
        .map_err(|e| format!("no scratch folder for the Brief: {e}"))?;
    let spec = listen::brief_spec(&pass, &scratch);
    let outcome = ClaudeCodeAgent::new(spec)
        .run_turn(
            listen::brief_message(&text).as_str(),
            &CancellationToken::new(),
            &mut |_| {},
        )
        .await
        .map_err(|e| format!("the Brief's Claude Code turn failed: {e}"))?;
    if outcome.is_error {
        return Err(format!(
            "the Brief's Claude Code turn failed: {}",
            outcome.text.trim()
        ));
    }
    listen::clean_brief(&outcome.text)
}
