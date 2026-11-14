//! Session commands: list, search, open, rename, delete, restore and move a chat's session (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// The open project's chats, or the unfiled ones when none is open.
///
/// On the blocking pool, like the search below it: both walk a directory of
/// logs, and an imported history is thousands of them. Holding a runtime
/// thread for that stalls whatever turn is streaming into the window.
#[tauri::command]
pub(crate) async fn list_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<SessionSummary>, String> {
    let dir = state.log_dir().await;
    blocking(move || store::list(&dir)).await
}

/// The same chats, filtered to the ones that mention `query`.
///
/// A backend call rather than a filter over the list the sidebar already
/// holds, because that list carries a name and an opening message and the
/// thing you are trying to find is usually neither — it is a sentence from
/// the middle of a conversation, which only the log has.
#[tauri::command]
pub(crate) async fn search_sessions(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<SessionMatch>, String> {
    let dir = state.log_dir().await;
    blocking(move || store::search(&dir, &query)).await
}

/// Which chats and notes the search panel looks through (nightshift
/// backlog 117): `this` is the sidebar's directory; `all` every project's
/// chats plus the unfiled ones (blocker 154's default — a hit elsewhere
/// carries its project and the jump switches to it); `notes` the open
/// project's docspace and the vault.
#[derive(serde::Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SearchScope {
    This,
    All,
    Notes,
}

/// The search-everywhere panel's query (nightshift backlog 117, with 106's
/// second half): results per *message*, grouped by chat, each row carrying
/// the message's position in its log so ↵ opens the chat there. Unlike
/// `search_sessions` above it, which answers "which chat" with one excerpt.
/// The registry is cloned out under its own lock and the guard dropped, as
/// the chat tools do it (the lock discipline on `workspaces`).
#[tauri::command]
pub(crate) async fn search_everywhere(
    state: State<'_, AppState>,
    query: String,
    scope: SearchScope,
) -> Result<store::search::SearchResult, String> {
    let active = state.active().await;
    let chats: Vec<store::search::ChatSource> = match scope {
        SearchScope::This => vec![store::search::ChatSource {
            project: None,
            dir: state.log_dir().await,
        }],
        SearchScope::All => {
            let projects = state.workspaces.lock().await.registry.projects();
            store::search::all_sources(&projects, &state.default_log_dir)
        }
        SearchScope::Notes => Vec::new(),
    };
    let notes: Vec<store::search::NoteSource> = match scope {
        SearchScope::Notes => {
            let mut sources = Vec::new();
            if let Some(p) = &active {
                sources.push(store::search::NoteSource {
                    scope: "project",
                    dir: p.notes_dir(),
                });
            }
            if let Some(vault) = nightloom_service::knowledge::vault_dir() {
                sources.push(store::search::NoteSource {
                    scope: "knowledge",
                    dir: vault,
                });
            }
            sources
        }
        _ => Vec::new(),
    };
    blocking(move || store::search::search(&chats, &notes, &query)).await
}

/// Rename a session, recording a `Title` event on its log.
///
/// The escape hatch the generated name needs: a name is written once, from
/// the first exchange, so a long conversation that has moved on keeps
/// describing where it started. It is an append like everything else here —
/// the old name stays in the log and the projection takes the latest.
///
/// Renaming the *active* session goes through the handle already open on its
/// log rather than loading a second one, which would leave two writers
/// appending to one file.
#[tauri::command]
pub(crate) async fn rename_session(
    state: State<'_, AppState>,
    id: String,
    title: String,
    active: Option<String>,
) -> Result<(), String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("a name cannot be empty".into());
    }
    // `try_lock`, not `lock` (review 2026-09-17 FD4, backlog 136): a turn
    // holds the session for its length, and a rename of *another* chat
    // waited behind it — the control looked dead for the turn. Locked
    // means a turn is live, and `active` (the window's open chat) says
    // which: that one is refused with a sentence, any other is a file
    // the turn is not writing.
    //
    // Since backlog 159 A1 (2026-09-24) each chat has its own lock, so
    // the question is exact: a held chat (open, or running a turn) is
    // renamed through its one writer, or refused while its turn holds
    // it; any other chat is a file no one is writing. `active` is no
    // longer needed to tell which chat runs; kept for the API.
    let _ = active;
    if let Some((_, log)) = state.chats.find(&id) {
        return match log.try_lock() {
            Ok(mut open) => {
                // His name: a naming pass never touches it (backlog 209).
                open.record_title_by(title, nightloom_core::TitleBy::User);
                Ok(())
            }
            Err(_) => Err("that chat is running a turn — rename it when the turn ends".into()),
        };
    }

    let path = store::find_by_prefix(&state.log_dir().await, &id).map_err(|e| e.to_string())?;
    let mut session = Session::load(&path).map_err(|e| e.to_string())?;
    session.record_title_by(title, nightloom_core::TitleBy::User);
    Ok(())
}

/// Leave the open chat and say what kind the next one will be — an ordinary
/// one when `mode` is absent, which is what every caller before 2026-09-15
/// meant.
///
/// Nothing is created here (nightshift backlog 061, 2026-09-15). Until
/// today this made the log at once, and the sidebar filled with empty
/// rows: each click on New chat was a file. Now the click is a state —
/// no session, a pending kind — and the first message creates the log in
/// that kind (`ensure_session`), which is when the row appears and gets
/// its name. Clicking twice is a no-op; a project switch resets the kind.
/// Incognito gets a log marked on its first line; ephemeral gets no log
/// at all (`Session::ephemeral`), so nothing of it is ever on disk and
/// there is no listing row to reopen it from.
///
/// The mode is the chat's, not the connection's: the engine is built per
/// rail change, so after this returns the UI reconnects the way it does for
/// a switched-off prompt layer (`prompt_layers` reports the chat's mode
/// beside the one the engine was built with) and `connect` /
/// `connect_agent` read it back through `session_mode` — which reads the
/// pending kind while there is no chat, so a pending incognito chat's
/// engine has no writers before its first message, not after.
///
/// Returns `{ "mode": … }` rather than an id, since there is no id yet.
/// The command keeps its name so the frontend's API surface is unchanged.
#[tauri::command]
pub(crate) async fn new_session(
    state: State<'_, AppState>,
    mode: Option<ChatMode>,
    kind: Option<ChatKind>,
) -> Result<serde_json::Value, String> {
    let mode = mode.unwrap_or_default();
    // Absent is a Build chat — the caller that predates kinds, and the
    // sidebar's plain button when the frontend has not said otherwise.
    let kind = kind.unwrap_or_default();
    state.chats.focus_new();
    *state.pending_mode.lock().await = mode;
    *state.pending_kind.lock().await = kind;
    // A new chat is a new conversation on the agent too. Left set, the next
    // turn would resume the previous chat's history behind an empty
    // transcript — the same lie in the other direction from the one
    // `SessionEvent::AgentSession` exists to prevent.
    adopt_agent_session(&state, None).await;
    Ok(serde_json::json!({ "mode": mode, "kind": kind }))
}

/// Point the agent at `resume` (or at nothing), if the agent engine is live.
///
/// Nothing happens on the provider engine, which is what lets the session
/// commands call this unconditionally instead of each asking which engine is
/// running.
pub(crate) async fn adopt_agent_session(state: &AppState, resume: Option<String>) {
    // The open chat's own agent (backlog 159, A2), and never waiting: a
    // running turn's agent carries its own resume, and a chat with no
    // agent yet reads its resume when one is made (`lock_agent`).
    // ~~One agent, `try_lock`ed, else `agent_readopt` set (A1)~~.
    state.agents.adopt(state.chats.focus().as_deref(), resume);
}

/// The `--resume` a chat's next agent turn continues: the Claude Code
/// session its log last recorded. What `open_session` adopts.
pub(crate) fn resume_of(session: &Session) -> Option<String> {
    session
        .agent_session()
        .filter(|(agent, _)| *agent == AGENT)
        .map(|(_, id)| id.to_string())
}

/// The open chat's agent, locked (backlog 159, A2): it waits only on that
/// chat's own turn. A chat with no agent yet gets one from the newest
/// connection, pointed at its recorded resume. Lock order as everywhere:
/// the agent, then a chat. ~~The one agent, re-pointed at the open chat
/// when `agent_readopt` said so (A1)~~.
///
/// For a chat read once at the command's start (backlog 159, A3; A2
/// review finding 2): the agent and the log a command locks are then the
/// same chat's even if he switches chats in between. ~~`lock_agent`, the
/// same for `state.chats.target()`~~ — removed 2026-10-20 (item 404): the
/// aside, its last caller, now reads the target itself for its timing line.
pub(crate) async fn lock_agent_at(state: &AppState, target: &chats::Target) -> agents::Guard {
    let slot = match state.agents.slot(target.id()) {
        agents::Found::Off => return agents::Guard::none(),
        agents::Found::Ready(slot) => slot,
        agents::Found::Make => {
            // The chat's lock is taken and let go before the agent's, so
            // the order above holds.
            let resume = target.lock().await.as_ref().and_then(resume_of);
            match state.agents.make(target.id(), resume) {
                Some(slot) => slot,
                None => return agents::Guard::none(),
            }
        }
    };
    agents::Guard::new(slot.lock_owned().await)
}

/// The open chat's agent and log, both of the chat open when this was
/// called (backlog 159, A3): what every command that locks the two takes,
/// so a switch between the two locks cannot pair one chat's agent with
/// another's log. Lock order as everywhere: the agent, then the chat.
pub(crate) async fn lock_agent_and_chat(state: &AppState) -> (agents::Guard, chats::Open) {
    let target = state.chats.target();
    let agent = lock_agent_at(state, &target).await;
    let chat = target.lock().await;
    (agent, chat)
}

/// Resolve a session ID (or unique prefix), make it active, and return its
/// full event log for the UI to render.
///
/// A log that did not read back cleanly still opens — see
/// [`Session::load`] — and says so as a `turn-notice` toast rather than as a
/// failure. Refusing the session would be the wrong trade in both directions:
/// the events that did read are the user's conversation, and the ones that
/// did not are worth a sentence rather than silence.
#[tauri::command]
pub(crate) async fn open_session(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<SessionEvent>, String> {
    // A focus, not a swap (backlog 159, A1): a chat already held — the
    // one whose turn is running, most often — is focused as it is, never
    // loaded a second time (two writers on one log), and its events are
    // read without waiting for its turn: `try_lock`, and while the turn
    // holds it, the log on disk, which is what the turn has appended so
    // far (the window draws the rest from the stream).
    if let Some(log) = state.chats.focus_held(&id) {
        let (events, resume) = match log.try_lock() {
            Ok(session) => (session.events().to_vec(), resume_of(&session)),
            Err(_) => {
                let path = store::find_by_prefix(&state.log_dir().await, &id)
                    .map_err(|e| e.to_string())?;
                let session = Session::load(path).map_err(|e| e.to_string())?;
                (session.events().to_vec(), resume_of(&session))
            }
        };
        adopt_agent_session(&state, resume).await;
        return Ok(events);
    }
    let path = store::find_by_prefix(&state.log_dir().await, &id).map_err(|e| e.to_string())?;
    let session = Session::load(path).map_err(|e| e.to_string())?;
    if let Some(notice) = session.load_report().summary() {
        let _ = app.emit("turn-notice", notice);
    }
    let events = session.events().to_vec();
    // Reopening an agent chat resumes the conversation it is a record of.
    // Without this the transcript would scroll back a week and the next turn
    // would begin with a model that had never seen any of it.
    let resume = resume_of(&session);
    state.chats.open(session);
    adopt_agent_session(&state, resume).await;
    Ok(events)
}

/// A chat's log read from disk, opening nothing (nightshift backlog 159,
/// pass 1): what the window shows while he browses during a turn. Touches
/// no lock — the turn holds `session` from its first append to its last,
/// so `open_session` would wait a whole turn — and adopts no session: the
/// backend's open chat stays the running one until the turn ends, when
/// the window re-opens whatever is on screen through `open_session`.
#[tauri::command]
pub(crate) async fn peek_session(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<SessionEvent>, String> {
    let path = store::find_by_prefix(&state.log_dir().await, &id).map_err(|e| e.to_string())?;
    let session = Session::load(path).map_err(|e| e.to_string())?;
    Ok(session.events().to_vec())
}

/// The open chat's events, as the window re-syncs them after a turn.
///
/// A reader, so it does not queue behind a running turn (review 2026-09-17
/// FD4, nightshift backlog 136): the turn holds `session` from its first
/// append to its last, and a `transcript` that waited on it resolved a
/// whole turn later with a result the window had already streamed. Refused
/// at once instead, naming the reason; every caller keeps what is on screen
/// and asks again when the turn ends. Only the readers take this shape —
/// a command that must write the log (a layer switch, a folder grant, ⌘N)
/// still waits, so the write lands on the finished turn rather than being
/// lost to a toast.
///
/// `turn` (backlog 159, A1): the chat the latest turn ran in rather than
/// the open one — what the window re-syncs at a turn's end, since he may
/// have opened another chat (or New chat) while it ran. Empty when no
/// turn has run, or that chat has no log (ephemeral) and is no longer held.
#[tauri::command]
pub(crate) async fn transcript(
    state: State<'_, AppState>,
    turn: Option<bool>,
    chat: Option<String>,
) -> Result<Vec<SessionEvent>, String> {
    const RUNNING: &str = "the chat is running a turn — the transcript is what is on screen, \
                           and it refreshes when the turn ends";
    // A named chat (backlog 159, A2): the one a turn ran in, whichever is
    // open and whichever turn ran last — two may have. Held (in memory,
    // an ephemeral one included) or on disk.
    if let Some(id) = chat {
        if let Some((_, log)) = state.chats.find(&id) {
            let Ok(session) = log.try_lock() else {
                return Err(RUNNING.into());
            };
            return Ok(session.events().to_vec());
        }
        let Ok(path) = store::find_by_prefix(&state.log_dir().await, &id) else {
            return Ok(Vec::new());
        };
        let session = Session::load(path).map_err(|e| e.to_string())?;
        return Ok(session.events().to_vec());
    }
    if turn.unwrap_or(false) {
        let Some(log) = state.chats.last_turn_log() else {
            // Left and let go since (an idle chat not open is not held):
            // its log on disk is the whole record.
            let Some(id) = state.chats.last_turn() else {
                return Ok(Vec::new());
            };
            let Ok(path) = store::find_by_prefix(&state.log_dir().await, &id) else {
                return Ok(Vec::new());
            };
            let session = Session::load(path).map_err(|e| e.to_string())?;
            return Ok(session.events().to_vec());
        };
        let Ok(session) = log.try_lock() else {
            return Err(RUNNING.into());
        };
        return Ok(session.events().to_vec());
    }
    let Ok(guard) = state.chats.try_lock_focused() else {
        return Err(RUNNING.into());
    };
    Ok(guard
        .as_ref()
        .map(|s| s.events().to_vec())
        .unwrap_or_default())
}

/// The chat the latest turn ran in (backlog 159, A1): its id, for the
/// window to go back to a New chat's first turn it browsed away from —
/// the id exists from the turn's start, the window learns it at the end.
#[tauri::command]
pub(crate) fn turn_session(state: State<'_, AppState>) -> Option<String> {
    state.chats.last_turn()
}

/// Delete a session log the reversible way: it moves to `<logs>/trash/`
/// rather than being unlinked (review round 1, 2026-09-13 — the rule that
/// no click in the UI may lose work for good; `backlog/trash/` is the same
/// shape). The listing never descends into subdirectories, so a trashed log
/// is out of the sidebar at once and still on disk. If it is the active
/// session, the open log handle is dropped first (the next send starts a
/// fresh session).
#[tauri::command]
pub(crate) async fn delete_session(
    state: State<'_, AppState>,
    warm: State<'_, keep_warm::Holder>,
    previews: State<'_, preview::Host>,
    browsers: State<'_, claude_browser::Host>,
    id: String,
    active: Option<String>,
) -> Result<String, String> {
    let log_dir = state.log_dir().await;
    let path = store::find_by_prefix(&log_dir, &id).map_err(|e| e.to_string())?;
    let full_id = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    // As `rename_session`: no wait behind a running turn (FD4). The turn's
    // own chat is refused; another chat's log is not what the turn holds.
    // Since backlog 159 A1 each chat has its own lock: a held chat whose
    // turn is running is refused, any other is dropped from the held set
    // (New chat is open if it was the open one). `active` kept for the API.
    let _ = active;
    let was_active = match state.chats.forget(&full_id) {
        Ok(open) => open,
        Err(chats::Busy) => {
            return Err("that chat is running a turn — delete it when the turn ends".into());
        }
    };
    state.agents.forget(&full_id);
    warm.stop(&full_id);
    // The chat's preview goes with it (item 430): nothing could show it.
    let gone = std::sync::Arc::clone(&previews.previews);
    gone.stop(&full_id).await;
    // And Claude's browser for it (item 508), its logins with it.
    let gone = std::sync::Arc::clone(&browsers.browsers);
    gone.close(&full_id).await;
    if was_active {
        adopt_agent_session(&state, None).await;
    }
    chat_ops::move_to_trash(&log_dir, &path, &full_id)?;
    Ok(full_id)
}

/// Put a deleted session back: its log moves from `<logs>/trash/` to
/// `<logs>/`, where the listing finds it again (nightshift backlog 064,
/// 2026-09-15 — the undo of a delete, and the first way back the trash
/// has had from inside the app). `id` is the full id [`delete_session`]
/// returned; a chat deleted twice under one id (a re-import) comes back
/// newest first, by the stamp its second copy was filed under. Refused,
/// with nothing moved, when a live log already has the name — the trash
/// copy stays where it is rather than replace a chat that exists.
#[tauri::command]
pub(crate) async fn restore_session(
    state: State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    let log_dir = state.log_dir().await;
    chat_ops::restore_from_trash(&log_dir, &id)
}

/// Move a chat of the open project's list into another project, or out to
/// the unfiled chats when `to` is `None` (nightshift backlog 370, *Move to
/// project…*), while the app runs. Its log moves with its id unchanged —
/// drafts, queued rows and tabs are keyed by that id — and is touched so
/// capture reads it under its new project (`chat_ops::move_chat`). Like
/// [`delete_session`], a chat whose turn is running is refused in words and
/// any other is dropped from the held set first (the open one leaves New
/// chat open), so no writer appends to the old path after the move.
/// Returns the full id.
#[tauri::command]
pub(crate) async fn move_session(
    state: State<'_, AppState>,
    warm: State<'_, keep_warm::Holder>,
    id: String,
    to: Option<String>,
) -> Result<String, String> {
    let from_dir = state.log_dir().await;
    let path = store::find_by_prefix(&from_dir, &id).map_err(|e| e.to_string())?;
    let full_id = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let to_dir = match &to {
        Some(pid) => state
            .workspaces
            .lock()
            .await
            .registry
            .find(pid)
            .map(Project::session_dir)
            .ok_or_else(|| "that project is no longer in the list".to_string())?,
        None => state.default_log_dir.clone(),
    };
    if to_dir == from_dir {
        return Err("the chat is already there".into());
    }
    let was_active = match state.chats.forget(&full_id) {
        Ok(open) => open,
        Err(chats::Busy) => {
            return Err("that chat is running a turn — move it when the turn ends".into());
        }
    };
    state.agents.forget(&full_id);
    warm.stop(&full_id);
    if was_active {
        adopt_agent_session(&state, None).await;
    }
    let moved = full_id.clone();
    blocking(move || chat_ops::move_chat(&from_dir, &to_dir, &moved)).await?;
    Ok(full_id)
}
