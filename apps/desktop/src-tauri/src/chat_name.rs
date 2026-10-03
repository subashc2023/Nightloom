//! Chats name themselves (nightshift backlog 209), as the process around
//! `nightloom_service::chat_name`: after an agent turn lands, [`after_turn`]
//! asks the service whether a naming is due and, if so, spawns it — a
//! fresh Haiku CLI process with no tools and no session — and returns at
//! once. The turn has already ended and released nothing it waits on, so a
//! naming never delays or blocks a chat.
//!
//! When the title comes back, the chat's log is locked (its one writer if
//! it is held, else loaded from disk, as `rename_session` does) and the
//! title is recorded `by: model` only if the service's `may_record` still
//! holds — so a name he typed while it ran stands. The window is told by a
//! `chat-titled` event and refreshes its list. A failure keeps the old
//! title and is logged to stderr; nothing is shown.
//!
//! Only on the Claude Code engine (it is called from `send_agent` alone):
//! the API engine names its chats with its own model (`Chat::enable_titles`).

use crate::AppState;
use nightloom_core::{Session, TitleBy};
use nightloom_service::AgentSpec;
use nightloom_service::chat_name::{self, NamingJob};
use nightloom_service::{ClaudeCodeAgent, PassSpec, store};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio_util::sync::CancellationToken;

/// Chats with a naming in flight: a second reply before the first naming
/// lands does not start another.
static IN_FLIGHT: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Mutex::default);

#[derive(Serialize, Clone)]
struct ChatTitled {
    chat: String,
    title: String,
}

/// Start a naming for `session` if one is due. `chat` is the chat's own
/// agent spec, whose binary, safe mode and subscription the naming uses.
pub fn after_turn(app: &AppHandle, session: &Session, chat: &AgentSpec) {
    let Some(job) = chat_name::plan(session) else {
        return;
    };
    let id = session.id.clone();
    {
        let mut busy = IN_FLIGHT.lock().unwrap_or_else(|p| p.into_inner());
        if !busy.insert(id.clone()) {
            return;
        }
    }
    let mut pass = PassSpec::new(chat.binary.clone(), Vec::new());
    pass.safe_mode = chat.safe_mode;
    pass.use_subscription = chat.use_subscription;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match run(&app, &id, &job, &pass).await {
            Ok(Some(title)) => {
                let _ = app.emit(
                    "chat-titled",
                    ChatTitled {
                        chat: id.clone(),
                        title,
                    },
                );
            }
            Ok(None) => {}
            Err(e) => eprintln!("chat {id} not named ({:?}): {e}", job.pass),
        }
        IN_FLIGHT
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
    });
}

/// One naming: the turn, the cleanup, the guarded record. `Ok(None)` when
/// the chat's title changed meanwhile (his rename) and nothing was written.
async fn run(
    app: &AppHandle,
    id: &str,
    job: &NamingJob,
    pass: &PassSpec,
) -> Result<Option<String>, String> {
    let scratch = std::env::temp_dir().join("nightloom-chat-name");
    std::fs::create_dir_all(&scratch).map_err(|e| format!("no scratch folder: {e}"))?;
    let spec = chat_name::spec_for(pass, &scratch);
    let outcome = ClaudeCodeAgent::new(spec)
        .run_turn(job.message.as_str(), &CancellationToken::new(), &mut |_| {})
        .await
        .map_err(|e| format!("the naming turn failed: {e}"))?;
    if outcome.is_error {
        return Err(format!("the naming turn failed: {}", outcome.text.trim()));
    }
    let title = chat_name::clean_title(&outcome.text);
    if title.is_empty() {
        return Err(format!("no usable title in {:?}", outcome.text));
    }
    let state = app.state::<AppState>();
    let recorded = if let Some((_, log)) = state.chats.find(id) {
        let mut open = log.lock().await;
        record(&mut open, job, &title)
    } else {
        let path = store::find_by_prefix(&state.log_dir().await, id).map_err(|e| e.to_string())?;
        let mut session = Session::load(&path).map_err(|e| e.to_string())?;
        record(&mut session, job, &title)
    };
    Ok(recorded.then_some(title))
}

fn record(session: &mut Session, job: &NamingJob, title: &str) -> bool {
    if !chat_name::may_record(session, job.expected.as_deref()) {
        return false;
    }
    if session.title() == Some(title) {
        return false;
    }
    session.record_title_by(title, TitleBy::Model);
    true
}
