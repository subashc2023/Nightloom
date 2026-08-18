//! Nightloom desktop shell: Tauri commands over `nightloom-service`.
//!
//! Streaming goes out as `turn-event` window events (serialized
//! [`TurnEvent`]s); retry stalls surface as `turn-notice` strings. Commands
//! mirror the service API and return plain serializable values.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use nightloom_core::{ProviderError, Session, SessionEvent, Thinking};
use nightloom_service::store::{self, SessionSummary};
use nightloom_service::{Chat, CompactOutcome, PromptConfig, ProviderKind, TurnEvent, TurnOutcome};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

struct AppState {
    chat: tokio::sync::Mutex<Option<Chat>>,
    session: tokio::sync::Mutex<Option<Session>>,
    cancel: std::sync::Mutex<CancellationToken>,
    log_dir: PathBuf,
}

#[derive(Serialize)]
struct ProviderInfo {
    kind: String,
    available: bool,
    default_model: Option<String>,
    /// Where the key that would be used comes from: "stored" (entered in the
    /// app, OS credential store) or "env"; absent when there is no key.
    key_source: Option<&'static str>,
}

#[derive(Serialize)]
struct ConnectedInfo {
    provider: String,
    model: String,
}

const KEYRING_SERVICE: &str = "nightloom";

/// Key entered in the app for this provider, from the OS credential store.
/// `openai-chat` falls back to OpenAI's stored key, mirroring the shared
/// `OPENAI_API_KEY` env var.
fn stored_key(kind: ProviderKind) -> Option<String> {
    let lookup = |label: &str| {
        keyring::Entry::new(KEYRING_SERVICE, label)
            .ok()
            .and_then(|e| e.get_password().ok())
            .filter(|k| !k.is_empty())
    };
    lookup(kind.label()).or_else(|| match kind {
        ProviderKind::OpenaiChat => lookup(ProviderKind::Openai.label()),
        _ => None,
    })
}

fn key_source(kind: ProviderKind) -> Option<&'static str> {
    if stored_key(kind).is_some() {
        Some("stored")
    } else if kind.has_credentials() {
        Some("env")
    } else {
        None
    }
}

/// Every provider Nightloom knows, with whether credentials are present
/// (stored in-app or in the environment).
#[tauri::command]
fn providers() -> Vec<ProviderInfo> {
    ProviderKind::ALL
        .into_iter()
        .map(|kind| ProviderInfo {
            kind: kind.label().to_string(),
            available: key_source(kind).is_some(),
            default_model: kind.default_model().map(String::from),
            key_source: key_source(kind),
        })
        .collect()
}

/// Store (or, with an empty key, remove) an API key in the OS credential
/// store. The key is write-only from the UI's perspective: it is never sent
/// back, only its presence (`key_source`) is.
#[tauri::command]
fn set_api_key(provider: String, key: String) -> Result<(), String> {
    let kind: ProviderKind = provider.parse()?;
    let entry = keyring::Entry::new(KEYRING_SERVICE, kind.label()).map_err(|e| e.to_string())?;
    let key = key.trim();
    if key.is_empty() {
        return clear_api_key(provider);
    }
    entry.set_password(key).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_api_key(provider: String) -> Result<(), String> {
    let kind: ProviderKind = provider.parse()?;
    let entry = keyring::Entry::new(KEYRING_SERVICE, kind.label()).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Model ids the provider's API currently offers (for the settings modal).
#[tauri::command]
async fn list_models(provider: String, base_url: Option<String>) -> Result<Vec<String>, String> {
    let kind: ProviderKind = provider.parse()?;
    let key = stored_key(kind);
    nightloom_service::list_models(kind, key, base_url)
        .await
        .map_err(|e| e.to_string())
}

/// Build the provider + `Chat` for this window; retry stalls are reported as
/// `turn-notice` events. Sessions are created lazily by `send`, so switching
/// providers (or auto-connecting at launch) never leaves empty session logs.
///
/// `preamble` gates the assembled system prompt (identity, environment,
/// project instructions, user memory) and `sidecar` the per-turn status
/// block. Both default to on when absent, so a frontend that predates them
/// keeps the full behaviour.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
    model: Option<String>,
    base_url: Option<String>,
    thinking: Option<String>,
    system: Option<String>,
    tools: bool,
    preamble: Option<bool>,
    sidecar: Option<bool>,
) -> Result<ConnectedInfo, String> {
    let kind: ProviderKind = provider.parse()?;
    let thinking = match thinking {
        Some(s) => s.parse::<Thinking>()?,
        None => Thinking::Default,
    };
    let on_retry = {
        let app = app.clone();
        Box::new(move |e: &ProviderError, attempt: u32| {
            let _ = app.emit(
                "turn-notice",
                format!("transient provider error (attempt {attempt}): {e}; retrying…"),
            );
        })
    };
    let (provider, model) =
        nightloom_service::connect(kind, model, stored_key(kind), base_url, Some(on_retry))
            .map_err(|e| e.to_string())?;

    let preamble = preamble.unwrap_or(true);
    let mut chat = Chat::new(provider, model);
    // The textarea's text is the `custom` layer, appended after whatever the
    // preamble discovered; with the preamble off it is the whole prompt.
    chat.system = nightloom_service::prompt::assemble(&PromptConfig {
        identity: preamble,
        environment: preamble,
        project_instructions: preamble,
        user_memory: preamble,
        cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        custom: system,
    });
    chat.thinking = thinking;
    if tools {
        chat.tools = nightloom_service::tools::builtin();
    }
    if !sidecar.unwrap_or(true) {
        chat.sidecar = Vec::new();
    }
    let info = ConnectedInfo {
        provider: chat.provider.name().to_string(),
        model: chat.model.clone(),
    };
    *state.chat.lock().await = Some(chat);
    Ok(info)
}

#[tauri::command]
fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummary>, String> {
    store::list(&state.log_dir).map_err(|e| e.to_string())
}

#[tauri::command]
async fn new_session(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let session = Session::with_log(&state.log_dir).map_err(|e| e.to_string())?;
    let id = session.id.clone();
    *state.session.lock().await = Some(session);
    Ok(serde_json::json!({ "id": id }))
}

/// Resolve a session ID (or unique prefix), make it active, and return its
/// full event log for the UI to render.
#[tauri::command]
async fn open_session(state: State<'_, AppState>, id: String) -> Result<Vec<SessionEvent>, String> {
    let path = store::find_by_prefix(&state.log_dir, &id).map_err(|e| e.to_string())?;
    let session = Session::load(path).map_err(|e| e.to_string())?;
    let events = session.events().to_vec();
    *state.session.lock().await = Some(session);
    Ok(events)
}

#[tauri::command]
async fn transcript(state: State<'_, AppState>) -> Result<Vec<SessionEvent>, String> {
    Ok(state
        .session
        .lock()
        .await
        .as_ref()
        .map(|s| s.events().to_vec())
        .unwrap_or_default())
}

/// Run one user turn, streaming progress as `turn-event` window events.
#[tauri::command]
async fn send(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
) -> Result<TurnOutcome, String> {
    let chat_guard = state.chat.lock().await;
    let chat = chat_guard
        .as_ref()
        .ok_or_else(|| "not connected".to_string())?;

    let mut session_guard = state.session.lock().await;
    if session_guard.is_none() {
        *session_guard = Some(Session::with_log(&state.log_dir).map_err(|e| e.to_string())?);
    }
    let session = session_guard.as_mut().expect("session ensured above");

    let cancel = CancellationToken::new();
    *state.cancel.lock().unwrap() = cancel.clone();

    let mut on_event = |e: TurnEvent| {
        let _ = app.emit("turn-event", &e);
    };
    chat.run_turn(session, &text, &cancel, &mut on_event)
        .await
        .map_err(|e| e.to_string())
}

/// Compact the active session: earlier turns are superseded by a
/// model-written summary (recorded as a session event; the log keeps the
/// full history). Cancellable via `cancel`, which leaves the session
/// unchanged.
#[tauri::command]
async fn compact(state: State<'_, AppState>) -> Result<CompactOutcome, String> {
    let chat_guard = state.chat.lock().await;
    let chat = chat_guard
        .as_ref()
        .ok_or_else(|| "not connected".to_string())?;
    let mut session_guard = state.session.lock().await;
    let session = session_guard
        .as_mut()
        .ok_or_else(|| "no active session".to_string())?;

    let cancel = CancellationToken::new();
    *state.cancel.lock().unwrap() = cancel.clone();
    chat.compact(session, &cancel)
        .await
        .map_err(|e| e.to_string())
}

/// Delete a session log. If it is the active session, the open log handle is
/// dropped first (the next send starts a fresh session).
#[tauri::command]
async fn delete_session(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let path = store::find_by_prefix(&state.log_dir, &id).map_err(|e| e.to_string())?;
    let full_id = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    {
        let mut session_guard = state.session.lock().await;
        if session_guard.as_ref().is_some_and(|s| s.id == full_id) {
            *session_guard = None;
        }
    }
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(full_id)
}

/// Interrupt the in-flight turn or compaction, if any.
#[tauri::command]
fn cancel(state: State<'_, AppState>) {
    state.cancel.lock().unwrap().cancel();
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let log_dir = app.path().app_data_dir()?.join("sessions");
            app.manage(AppState {
                chat: tokio::sync::Mutex::new(None),
                session: tokio::sync::Mutex::new(None),
                cancel: std::sync::Mutex::new(CancellationToken::new()),
                log_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            providers,
            set_api_key,
            clear_api_key,
            list_models,
            connect,
            list_sessions,
            new_session,
            open_session,
            transcript,
            send,
            cancel,
            compact,
            delete_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nightloom");
}
