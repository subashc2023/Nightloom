//! Nightloom desktop shell: Tauri commands over `nightloom-service`.
//!
//! Streaming goes out as `turn-event` window events (serialized
//! [`TurnEvent`]s); retry stalls surface as `turn-notice` strings. Commands
//! mirror the service API and return plain serializable values.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use nightloom_core::{ProviderError, Session, SessionEvent, Thinking};
use nightloom_service::store::{self, SessionSummary};
use nightloom_service::{Chat, ProviderKind, TurnEvent, TurnOutcome};
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
}

#[derive(Serialize)]
struct ConnectedInfo {
    provider: String,
    model: String,
}

/// Every provider Nightloom knows, with whether env credentials are present.
#[tauri::command]
fn providers() -> Vec<ProviderInfo> {
    ProviderKind::ALL
        .into_iter()
        .map(|kind| ProviderInfo {
            kind: kind.label().to_string(),
            available: kind.has_credentials(),
            default_model: kind.default_model().map(String::from),
        })
        .collect()
}

/// Build the provider + `Chat` for this window; retry stalls are reported as
/// `turn-notice` events. Sessions are created lazily by `send`, so switching
/// providers (or auto-connecting at launch) never leaves empty session logs.
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
    let (provider, model) = nightloom_service::connect(kind, model, base_url, Some(on_retry))
        .map_err(|e| e.to_string())?;

    let mut chat = Chat::new(provider, model);
    chat.system = system;
    chat.thinking = thinking;
    if tools {
        chat.tools = nightloom_service::tools::builtin();
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

/// Interrupt the in-flight turn, if any.
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
            connect,
            list_sessions,
            new_session,
            open_session,
            transcript,
            send,
            cancel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nightloom");
}
