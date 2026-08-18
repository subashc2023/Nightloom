//! Nightloom desktop shell: Tauri commands over `nightloom-service`.
//!
//! Streaming goes out as `turn-event` window events (serialized
//! [`TurnEvent`]s); retry stalls surface as `turn-notice` strings. Commands
//! mirror the service API and return plain serializable values.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use nightloom_core::{ImageInput, ProviderError, Session, SessionEvent, Thinking};
use nightloom_service::approval::{Approver, AutoApprove, Decision, PendingCall};
use nightloom_service::store::{self, SessionSummary};
use nightloom_service::{
    Chat, CompactOutcome, Price, PromptConfig, ProviderKind, TurnEvent, TurnInput, TurnOutcome,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

struct AppState {
    chat: tokio::sync::Mutex<Option<Chat>>,
    session: tokio::sync::Mutex<Option<Session>>,
    /// Swapped per turn. Shared with [`WindowApprover`], which has to wait on
    /// whichever token is current at the moment it asks.
    cancel: Arc<std::sync::Mutex<CancellationToken>>,
    log_dir: PathBuf,
    /// The approval policy, built once for the process and reused by every
    /// `connect`. Rebuilding it there would silently forget every "always
    /// allow" the user granted, because the rail re-connects on every
    /// provider, model or knob change.
    approval: Arc<AutoApprove>,
    /// The half that resolves prompts, kept separately so `approve_call` can
    /// reach it without downcasting out of the policy.
    gate: Arc<WindowApprover>,
}

/// Puts a `mutating` tool call to the user and waits for the answer.
///
/// The request goes out as a `tool-approval` window event and parks a
/// oneshot keyed by the call id; the `approve_call` command completes it.
/// The wait is raced against the turn's cancellation token, because
/// otherwise a prompt the user dismisses — or a window they close — leaves
/// the turn parked forever with no way back.
struct WindowApprover {
    app: AppHandle,
    cancel: Arc<std::sync::Mutex<CancellationToken>>,
    pending: std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<Decision>>>,
}

#[derive(Serialize, Clone)]
struct ApprovalRequest<'a> {
    id: &'a str,
    name: &'a str,
    input: &'a serde_json::Value,
    effect: nightloom_core::Effect,
}

impl WindowApprover {
    /// Resolve one pending prompt. Unknown ids are ignored rather than
    /// erroring: a decision arriving after the turn was cancelled is a race
    /// the UI cannot avoid, not a bug to report.
    fn resolve(&self, id: &str, decision: Decision) {
        if let Some(tx) = self.pending.lock().unwrap().remove(id) {
            let _ = tx.send(decision);
        }
    }

    /// Refuse everything still waiting. Called on cancel so an interrupted
    /// turn does not leave prompts on screen that can no longer do anything.
    fn deny_all(&self, reason: &str) {
        let pending: Vec<_> = self.pending.lock().unwrap().drain().collect();
        for (_, tx) in pending {
            let _ = tx.send(Decision::Deny(reason.to_string()));
        }
    }
}

#[async_trait::async_trait]
impl Approver for WindowApprover {
    async fn approve(&self, call: &PendingCall<'_>) -> Decision {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.lock().unwrap().insert(call.id.to_string(), tx);
        let token = self.cancel.lock().unwrap().clone();
        if self
            .app
            .emit(
                "tool-approval",
                ApprovalRequest {
                    id: call.id,
                    name: call.name,
                    input: call.input,
                    effect: call.effect,
                },
            )
            .is_err()
        {
            // No window to ask. Denying is the only safe reading: the
            // alternative is running a mutating tool because the UI failed.
            self.pending.lock().unwrap().remove(call.id);
            return Decision::Deny("the app could not show an approval prompt".into());
        }
        tokio::select! {
            _ = token.cancelled() => {
                self.pending.lock().unwrap().remove(call.id);
                Decision::Deny("the turn was interrupted before this was approved".into())
            }
            answer = rx => answer.unwrap_or_else(|_| {
                Decision::Deny("the approval prompt was dismissed".into())
            }),
        }
    }
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
    /// The model's context window, or `None` when the limits table doesn't
    /// know it — the UI gauge then shows a raw token count instead of a
    /// percentage rather than implying headroom nobody verified.
    context_limit: Option<u64>,
    /// The resolved workspace root, so the UI can show where the file tools
    /// actually point rather than leaving the user to guess.
    workspace: String,
    /// What this model charges, for the cost readout. `None` for a model with
    /// no verified price, which the UI shows as no dollar figure at all — a
    /// "$0.00" would read as free rather than as unknown.
    price: Option<Price>,
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

/// Everything `connect` was told, kept whole so a subagent can be built from
/// the same description rather than from a half-copied subset of it.
#[derive(Clone)]
struct ChatSpec {
    kind: ProviderKind,
    model: Option<String>,
    base_url: Option<String>,
    thinking: Thinking,
    system: Option<String>,
    tools: bool,
    preamble: bool,
    sidecar: bool,
    workspace: PathBuf,
    approval: bool,
}

/// Build a `Chat` from a spec: the window's own chat, and — through the
/// subagent factory — every subagent it spawns, so the two cannot drift into
/// having different tools or a different workspace.
fn build_chat(app: &AppHandle, policy: &Arc<AutoApprove>, spec: &ChatSpec) -> Result<Chat, String> {
    let on_retry = {
        let app = app.clone();
        Box::new(move |e: &ProviderError, attempt: u32| {
            let _ = app.emit(
                "turn-notice",
                format!("transient provider error (attempt {attempt}): {e}; retrying…"),
            );
        })
    };
    let (provider, model) = nightloom_service::connect(
        spec.kind,
        spec.model.clone(),
        stored_key(spec.kind),
        spec.base_url.clone(),
        Some(on_retry),
    )
    .map_err(|e| e.to_string())?;

    let mut chat = Chat::new(provider, model);
    // The textarea's text is the `custom` layer, appended after whatever the
    // preamble discovered; with the preamble off it is the whole prompt.
    chat.system = nightloom_service::prompt::assemble(&PromptConfig {
        identity: spec.preamble,
        environment: spec.preamble,
        project_instructions: spec.preamble,
        user_memory: spec.preamble,
        cwd: spec.workspace.clone(),
        custom: spec.system.clone(),
    });
    chat.thinking = spec.thinking.clone();
    // Gives the sidecar's context gauge a denominator; `None` for a model we
    // have no verified window for, which the gauge handles by reporting raw
    // token counts instead of a percentage.
    chat.context_limit = nightloom_service::context_limit(spec.kind, &chat.model);
    // Same table discipline as the limit: an unpriced model records no cost
    // rather than a zero, so the UI can distinguish free from unknown.
    chat.price = nightloom_service::price(spec.kind, &chat.model);
    // On unless the UI says otherwise. The shared policy instance is reused
    // rather than rebuilt, so "always allow bash" survives the re-connect the
    // rail fires on every knob change.
    if spec.approval {
        chat.approver = Some(policy.clone());
    }
    if spec.tools {
        chat.tools = nightloom_service::tools::builtin_in(spec.workspace.clone());
        // Tied to the same toggle rather than always on: `compact_context` is
        // still a tool, and a connection that asked for none should not
        // quietly get a tools array — it changes what the provider is sent.
        chat.enable_self_compaction();
        // Subagents are built from this same spec, so they inherit the
        // workspace and the tool set. The engine strips their own `task` tool
        // and replaces their approver, so this cannot recurse or route around
        // the gate.
        let (app, policy, spec) = (app.clone(), policy.clone(), spec.clone());
        chat.enable_subagents(Arc::new(move || build_chat(&app, &policy, &spec)));
    }
    if !spec.sidecar {
        chat.sidecar = Vec::new();
    }
    Ok(chat)
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
    workspace: Option<String>,
    approval: Option<bool>,
) -> Result<ConnectedInfo, String> {
    let kind: ProviderKind = provider.parse()?;
    let thinking = match thinking {
        Some(s) => s.parse::<Thinking>()?,
        None => Thinking::Default,
    };
    // The folder this conversation is about: it roots the file tools and is
    // where the preamble looks for NIGHTLOOM.md/AGENTS.md and the git branch.
    // A GUI process's cwd is whatever the launcher happened to set — the
    // install directory, or C:\Windows\System32 — so leaving it implicit
    // would point the tools somewhere arbitrary and unmentioned. An
    // unreadable or missing path falls back to cwd rather than failing the
    // connect, and the resolved value goes back to the UI to be shown.
    let workspace = workspace
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let spec = ChatSpec {
        kind,
        model,
        base_url,
        thinking,
        system,
        tools,
        preamble: preamble.unwrap_or(true),
        sidecar: sidecar.unwrap_or(true),
        workspace,
        approval: approval.unwrap_or(true),
    };
    let chat = build_chat(&app, &state.approval, &spec)?;
    let info = ConnectedInfo {
        provider: chat.provider.name().to_string(),
        model: chat.model.clone(),
        context_limit: chat.context_limit,
        price: chat.price,
        workspace: spec.workspace.to_string_lossy().into_owned(),
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
///
/// `images` are base64 payloads the frontend already read off a paste or a
/// drop. They go into the session log verbatim rather than as file paths, so
/// the transcript keeps rendering after the source file moves — see
/// [`nightloom_core::ImageInput`].
#[tauri::command]
async fn send(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    images: Option<Vec<ImageInput>>,
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
    let input = TurnInput {
        text,
        images: images.unwrap_or_default(),
    };
    chat.run_turn(session, input, &cancel, &mut on_event)
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
    state
        .gate
        .deny_all("the turn was interrupted before this was approved");
}

/// Answer one `tool-approval` prompt.
///
/// `decision` is "allow", "always" or "deny"; a `reason` on a denial is
/// handed to the model, which is the point — it is what lets it try something
/// else instead of repeating the same call.
#[tauri::command]
fn approve_call(
    state: State<'_, AppState>,
    id: String,
    name: String,
    decision: String,
    reason: Option<String>,
) -> Result<(), String> {
    let decision = match decision.as_str() {
        "allow" => Decision::Allow,
        "always" => {
            // Recorded on the policy, not the pending call: it has to outlive
            // this turn and every later re-connect.
            state.approval.always_allow(&name);
            Decision::AllowAlways
        }
        "deny" => Decision::Deny(
            reason
                .filter(|r| !r.trim().is_empty())
                .unwrap_or_else(|| "the user declined this call".into()),
        ),
        other => return Err(format!("unknown decision: {other}")),
    };
    state.gate.resolve(&id, decision);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let log_dir = app.path().app_data_dir()?.join("sessions");
            let cancel = Arc::new(std::sync::Mutex::new(CancellationToken::new()));
            let gate = Arc::new(WindowApprover {
                app: app.handle().clone(),
                cancel: cancel.clone(),
                pending: std::sync::Mutex::new(HashMap::new()),
            });
            app.manage(AppState {
                chat: tokio::sync::Mutex::new(None),
                session: tokio::sync::Mutex::new(None),
                cancel,
                log_dir,
                // `AutoApprove` answers read-only and session-only calls
                // itself, so the window is only ever asked about calls that
                // can change something outside the conversation.
                approval: Arc::new(AutoApprove::new(gate.clone())),
                gate,
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
            approve_call,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nightloom");
}
