//! Steering commands: steering and stopping subagents, injected messages (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// A note he typed under a running subagent (nightshift backlog 295),
/// queued in the chat's directory for the brief hook, which hands it to
/// that subagent on its next call (`agent::steer`). `tell_main` queues a
/// copy for the chat's own next call too. `Err` leaves the window to hold
/// the note the old way, for when the agent finishes.
#[tauri::command]
pub(crate) async fn steer_subagent(
    state: State<'_, AppState>,
    session: String,
    agent_id: String,
    id: String,
    text: String,
    about: Option<String>,
    tell_main: Option<bool>,
) -> Result<(), String> {
    use nightloom_service::agent::steer;
    let dir = budget_dir(&state, &session)
        .await
        .ok_or_else(|| "no chat to steer in".to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let note = steer::Queued {
        id,
        text,
        at_ms: now,
        about,
        raw: false,
    };
    tokio::task::spawn_blocking(move || {
        steer::queue(&dir, &agent_id, note.clone())?;
        if tell_main.unwrap_or(false) {
            steer::queue(&dir, steer::MAIN, note)?;
        }
        Ok::<(), std::io::Error>(())
    })
    .await
    .map_err(|e| format!("queueing the note failed: {e}"))?
    .map_err(|e| format!("queueing the note failed: {e}"))
}

/// A message he sent while the chat's turn runs (nightshift backlog 328),
/// into that turn: the CLI takes it at the turn's next step, and a
/// `message_delivered` turn event says so. `turn` is the chat's id or the
/// window's turn key. `false` when no turn takes messages now (none runs,
/// or it has no stdin) — the window keeps it queued for the next turn.
#[tauri::command]
pub(crate) async fn inject_message(
    state: State<'_, AppState>,
    turn: String,
    id: String,
    text: String,
    images: Option<Vec<nightloom_core::ImageInput>>,
    documents: Option<Vec<nightloom_core::DocumentInput>>,
) -> Result<bool, String> {
    use nightloom_service::agent::inbox::SendError;
    let inbox = state
        .inboxes
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&turn)
        .cloned();
    let Some(inbox) = inbox else {
        return Ok(false);
    };
    // Files ride along (backlog 339), as on a turn's opening line.
    match inbox.send_with(
        &id,
        &text,
        images.unwrap_or_default(),
        documents.unwrap_or_default(),
    ) {
        Ok(()) => Ok(true),
        Err(SendError::NotRunning) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// Take back a message sent into the running turn (backlog 328):
/// `cancelled` when it never reached the model (it is his again),
/// `delivered` when the turn had already taken it.
#[tauri::command]
pub(crate) async fn take_back_injected(
    state: State<'_, AppState>,
    turn: String,
    id: String,
) -> Result<nightloom_service::agent::inbox::TakeBack, String> {
    let inbox = state
        .inboxes
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&turn)
        .cloned();
    Ok(match inbox {
        Some(inbox) => inbox.take_back(&id).await,
        None => nightloom_service::agent::inbox::TakeBack::Cancelled,
    })
}

/// Send now (nightshift backlog 339): a message already sent into the
/// running turn is re-sent with the CLI's `priority: "now"`, which stops
/// the step it is in and delivers the message at once. `delivered` when
/// the turn had already taken it, `not_hurried` when the CLI did not
/// confirm the cancel, `taken_back` when a Take back won (backlog 341),
/// `not_running` when no turn takes it.
#[tauri::command]
pub(crate) async fn send_now_injected(
    state: State<'_, AppState>,
    turn: String,
    id: String,
) -> Result<nightloom_service::agent::inbox::SendNow, String> {
    let inbox = state
        .inboxes
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&turn)
        .cloned();
    Ok(match inbox {
        Some(inbox) => inbox.send_now(&id).await,
        None => nightloom_service::agent::inbox::SendNow::NotRunning,
    })
}

/// Stop the subagents still running in a turn whose reply has ended
/// (nightshift backlog 329, his "wait or stop them?"): the CLI's
/// `stop_task` for each. How many were asked to stop.
///
/// Item 593 (his "sends a notice to the main agent so that it can … figure
/// out what to do next"): with `note`, Nightloom's words on what he stopped
/// go to the main agent too — as the next command when it sits idle (the
/// CLI's own `stopped` notification says only that it stopped), else queued
/// for its next tool call in the chat's steering file, as 329's nested-spawn
/// note is. Best-effort: the stop stands whether or not the note lands.
#[tauri::command]
pub(crate) async fn stop_subagents(
    state: State<'_, AppState>,
    turn: String,
    session: Option<String>,
    note: Option<String>,
) -> Result<usize, String> {
    use nightloom_service::agent::steer;
    let inbox = state
        .inboxes
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&turn)
        .cloned();
    let Some(inbox) = inbox else {
        return Ok(0);
    };
    let stopped = inbox.stop_agents();
    let note = note.filter(|t| !t.trim().is_empty());
    if let (true, Some(note)) = (stopped > 0, note)
        && !inbox.note_if_idle(&note)
        && let Some(dir) = match session.as_deref() {
            Some(s) => budget_dir(&state, s).await,
            None => None,
        }
    {
        let at_ms = chrono::Utc::now().timestamp_millis();
        let _ = tokio::task::spawn_blocking(move || {
            steer::queue(
                &dir,
                steer::MAIN,
                steer::Queued {
                    id: format!("stopped-{turn}-{at_ms}"),
                    text: note,
                    at_ms,
                    about: None,
                    raw: true,
                },
            )
        })
        .await;
    }
    Ok(stopped)
}

/// The chat's steering notes, queued and delivered (backlog 295), for
/// the window to mark each delivered and when.
#[tauri::command]
pub(crate) async fn steer_state(
    state: State<'_, AppState>,
    session: String,
) -> Result<nightloom_service::agent::steer::SteerState, String> {
    let Some(dir) = budget_dir(&state, &session).await else {
        return Ok(Default::default());
    };
    tokio::task::spawn_blocking(move || nightloom_service::agent::steer::read(&dir))
        .await
        .map_err(|e| format!("reading the notes failed: {e}"))
}

/// Take back a note not yet delivered (backlog 295): `true` when it was
/// still waiting — the agent finished without another call, or he took
/// it back — and `false` when it had already gone. The main thread's
/// copy goes with it.
#[tauri::command]
pub(crate) async fn unsteer_subagent(
    state: State<'_, AppState>,
    session: String,
    agent_id: String,
    id: String,
) -> Result<bool, String> {
    use nightloom_service::agent::steer;
    let Some(dir) = budget_dir(&state, &session).await else {
        return Ok(false);
    };
    tokio::task::spawn_blocking(move || {
        let took = steer::unqueue(&dir, &agent_id, &id);
        if took {
            steer::unqueue(&dir, steer::MAIN, &id);
        }
        took
    })
    .await
    .map_err(|e| format!("taking the note back failed: {e}"))
}
