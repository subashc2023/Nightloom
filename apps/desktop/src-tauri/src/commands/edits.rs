//! Transcript-edit commands: rewind, edit, remove and restore messages and blocks, fork and continue (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// Rewind the active session to the turn at log index `to`, returning the
/// transcript that results.
///
/// Returns the events rather than an acknowledgement so the UI re-syncs from
/// the log in the same call: a rewind changes what every projection reads,
/// and a UI that updated its own copy optimistically would be describing a
/// conversation the model is no longer having.
///
/// Safe against a turn in flight without a check of its own: `send` holds the
/// session lock for the whole turn, so this waits rather than cutting the log
/// out from under a reply being recorded. It would still be a surprising
/// thing to have queued, which is why the UI hides the control while busy.
///
/// On the Claude Code engine (since 2026-09-15) the CLI's session file is
/// copied truncated before the turn and the copy resumed — see
/// [`edit_on_cli`]; the log gets its `Rewind` marker either way.
///
/// `at`, when the window sends it, is when the message at `to` was sent: a
/// rewind is aimed at that message as a fork is (backlog 361's
/// `aim_user_message`; wave 8b review, 2026-10-13) — from a window whose
/// list was out of step with the log, the bare index named a message
/// exchanges earlier and would have hidden everything after it.
#[tauri::command]
pub(crate) async fn rewind(
    state: State<'_, AppState>,
    to: usize,
    at: Option<chrono::DateTime<chrono::Utc>>,
) -> Result<Vec<SessionEvent>, String> {
    let (mut agent_guard, mut session_guard) = lock_agent_and_chat(&state).await;
    let session = session_guard
        .as_mut()
        .ok_or_else(|| "no active session".to_string())?;
    let to = match at {
        Some(at) => session.aim_user_message(to, at)?,
        None => to,
    };
    chat_ops::rewind(session, agent_guard.as_mut().map(OnCli::of), to)?;
    Ok(session.events().to_vec())
}

/// Move the files a rewound turn wrote aside (nightshift item 259): into
/// `<config dir>/rewound/<local date-time>-<chat>/`, outside the project so
/// the next run cannot read them, never deleted. `workspace` is the folder
/// the chat's tools ran in, which relative paths are read against. The
/// disk work runs on a blocking thread.
#[tauri::command]
pub(crate) async fn set_aside_files(
    chat: Option<String>,
    workspace: Option<String>,
    paths: Vec<String>,
) -> Result<set_aside::SetAside, String> {
    let root = project::config_dir()
        .ok_or("no config folder to set the files aside in")?
        .join("rewound");
    let short: String = chat.unwrap_or_default().chars().take(8).collect();
    let mut stamp = chrono::Local::now().format("%Y-%m-%d-%H%M%S").to_string();
    if !short.is_empty() {
        stamp = format!("{stamp}-{short}");
    }
    let workspace = workspace
        .map(|w| PathBuf::from(w.trim()))
        .filter(|w| !w.as_os_str().is_empty());
    blocking(move || -> Result<_, String> {
        Ok(set_aside::set_aside(
            &root,
            &stamp,
            workspace.as_deref(),
            &paths,
        ))
    })
    .await
}

/// Lift the rewind recorded at log index `of` — the undo of a rewind
/// (nightshift backlog 064, 2026-09-15) — returning the transcript the way
/// [`rewind`] does and for the same reason.
///
/// The log gets its `Unrewind` marker ([`Session::unrewind`]); nothing is
/// struck out. On the Claude Code engine the rewind resumed a truncated
/// copy of the CLI's file and recorded that copy's id; the file it was
/// cut from is still on disk, untouched, so no rewrite is needed here —
/// the chat goes back to resuming *that* id, which is the latest one
/// recorded before the rewind's marker, live again now that the rewind
/// is lifted. It is recorded as a fresh `AgentSession` line rather than
/// found by projection because the copy's own line is still live and
/// later. A rewind that left the CLI nothing to resume (`CliChange::Fresh`)
/// recorded no id; lifting it points the agent back at whichever id
/// stood before, or at nothing if there was none.
#[tauri::command]
pub(crate) async fn unrewind(
    state: State<'_, AppState>,
    of: usize,
) -> Result<Vec<SessionEvent>, String> {
    let (mut agent_guard, mut session_guard) = lock_agent_and_chat(&state).await;
    let session = session_guard
        .as_mut()
        .ok_or_else(|| "no active session".to_string())?;
    chat_ops::unrewind(session, agent_guard.as_mut().map(OnCli::of), of)?;
    Ok(session.events().to_vec())
}

/// Reword the turn at `index` (nightshift backlog 062, 2026-09-15).
///
/// `mode: "save"` is his "edit and save": an `Edit` marker on this log,
/// so the next turn goes out with the new text and everything else in
/// place — the original stays in the log, greyed, for the transcript to
/// unfold. `mode: "send"` is "edit and send": a fork of this chat cut
/// before the turn ([`Session::fork_from`]), which becomes the open chat;
/// the UI then sends the new text as its first turn, so this command
/// records nothing of the text itself. A fork cuts at a user message, so
/// `send` on an assistant reply is refused; `save` takes either.
///
/// On the Claude Code engine both also rewrite the CLI's history by copy
/// ([`edit_on_cli`]) — the target's text replaced for `save`, the file
/// cut before the turn for `send` — and the copy's id is recorded on
/// whichever log the next turn resumes from. The CLI copy is made
/// *before* the marker: a refusal there leaves the log as it was, rather
/// than a log that says one thing and a history that says another.
///
/// `block` (nightshift backlog 066) names one text block of a reply, as
/// an index into its `blocks`: that block says `text` and the rest of
/// the reply — its calls included — stays where it was
/// (`Session::edit_block`; on Claude Code `CliSession::rewrite_block`, the
/// block found by its count among the reply's text nodes). Absent, a
/// reply's first text block, as before; meaningless on a user message.
///
/// `attachments` (2026-10-11, nightshift item 336): on a `save` of a user
/// message, its whole set of images and documents from here on — the edit
/// box's chips, sent only when they changed. On Claude Code the turn's
/// node is rebuilt with them (`CliSession::rewrite_user`). `send` ignores
/// it: the fork's first message carries the chips itself.
///
/// `at` and `nth` (nightshift backlog 364, 2026-10-13), when the window
/// sends them: on a `save`, the turn is aimed by the send time of the
/// message that opened its exchange and, for a reply, its place among that
/// exchange's replies (`chat_ops::aimed`) — or refused; on a `send`, `at`
/// aims the fork as backlog 361 made it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn edit_message(
    state: State<'_, AppState>,
    index: usize,
    text: String,
    mode: String,
    block: Option<usize>,
    attachments: Option<nightloom_core::EditedAttachments>,
    at: Option<chrono::DateTime<chrono::Utc>>,
    nth: Option<usize>,
) -> Result<MessageEdit, String> {
    match mode.as_str() {
        "save" => {
            let (mut agent_guard, mut session_guard) = lock_agent_and_chat(&state).await;
            let session = session_guard
                .as_mut()
                .ok_or_else(|| "no active session".to_string())?;
            let index = chat_ops::aimed(session, index, at, nth)?;
            chat_ops::edit_saved(
                session,
                agent_guard.as_mut().map(OnCli::of),
                index,
                text,
                block,
                attachments,
            )?;
            Ok(MessageEdit {
                events: session.events().to_vec(),
                session: session.id.clone(),
                forked: false,
            })
        }
        "send" => fork_session(state, index, at).await,
        other => Err(format!(
            "unknown edit mode {other:?}; use \"save\" or \"send\""
        )),
    }
}

/// Remove the turn at `index` from the context — the `Elide` marker the
/// context panel records, offered on the transcript (nightshift backlog
/// 062). Asks nothing: it is a marker, the transcript shows the
/// placeholder greyed with the original a click away, and backlog 064
/// will undo it. On the Claude Code engine the CLI's copy drops a text
/// turn outright and marks a turn with tool calls ([`CliSession::remove`]).
#[tauri::command]
pub(crate) async fn remove_message(
    state: State<'_, AppState>,
    index: usize,
    at: Option<chrono::DateTime<chrono::Utc>>,
    nth: Option<usize>,
) -> Result<MessageEdit, String> {
    let (mut agent_guard, mut session_guard) = lock_agent_and_chat(&state).await;
    let session = session_guard
        .as_mut()
        .ok_or_else(|| "no active session".to_string())?;
    // Backlog 364: aimed as `edit_message`'s save is.
    let index = chat_ops::aimed(session, index, at, nth)?;
    chat_ops::remove_message(session, agent_guard.as_mut().map(OnCli::of), index)?;
    Ok(MessageEdit {
        events: session.events().to_vec(),
        session: session.id.clone(),
        forked: false,
    })
}

/// Put back the turn at `index` that [`remove_message`] took out — the
/// `Unelide` marker, on both engines (nightshift backlog 064, 2026-09-15;
/// the Restore that nightshift blocker 067 said had to wait for the undo).
///
/// On the Claude Code engine the removal wrote a copy of the CLI's file
/// without the turn and recorded that copy's id. The file it was copied
/// from is still on disk — nothing here deletes — so the restore is a
/// rewrite of the *current* file with the turn's nodes put back from that
/// original ([`CliSession::restore`]), written as a third copy under a new
/// id, which is recorded and resumed. Not a plain return to the original
/// id, which the undo of a rewind can afford: anything done to the copy
/// since would be lost with it, and the rewrite keeps it. Which file is
/// the original: the latest `AgentSession` live before the `Elide` marker
/// that hid this turn. A turn removed while the chat had no CLI session
/// behind it needs no file work. The copy is made *before* the marker, as
/// every edit here is, so a refusal records nothing.
#[tauri::command]
pub(crate) async fn restore_message(
    state: State<'_, AppState>,
    index: usize,
    at: Option<chrono::DateTime<chrono::Utc>>,
    nth: Option<usize>,
) -> Result<MessageEdit, String> {
    let (mut agent_guard, mut session_guard) = lock_agent_and_chat(&state).await;
    let session = session_guard
        .as_mut()
        .ok_or_else(|| "no active session".to_string())?;
    // Backlog 364: aimed as `edit_message`'s save is.
    let index = chat_ops::aimed(session, index, at, nth)?;
    chat_ops::restore_message(session, agent_guard.as_mut().map(OnCli::of), index)?;
    Ok(MessageEdit {
        events: session.events().to_vec(),
        session: session.id.clone(),
        forked: false,
    })
}

/// Remove one block of the reply at `index` from the context (nightshift
/// backlog 066): a text block, or a tool call **with its result** — the
/// pair the core's `Session::elide_block` removes together and refuses to
/// split. On the Claude Code engine the CLI's copy drops the text node,
/// or the call's node and its result's node (`CliSession::remove_block`);
/// the copy is made before the marker, as every edit here is. A marker,
/// asked about nothing: the transcript draws the placeholder with the
/// original a click away, Restore beside it.
#[tauri::command]
pub(crate) async fn remove_block(
    state: State<'_, AppState>,
    index: usize,
    block: usize,
    at: Option<chrono::DateTime<chrono::Utc>>,
    nth: Option<usize>,
) -> Result<MessageEdit, String> {
    let (mut agent_guard, mut session_guard) = lock_agent_and_chat(&state).await;
    let session = session_guard
        .as_mut()
        .ok_or_else(|| "no active session".to_string())?;
    // Backlog 364: the reply aimed as `edit_message`'s save is.
    let index = chat_ops::aimed(session, index, at, nth)?;
    chat_ops::remove_block(session, agent_guard.as_mut().map(OnCli::of), index, block)?;
    Ok(MessageEdit {
        events: session.events().to_vec(),
        session: session.id.clone(),
        forked: false,
    })
}

/// Put back a block [`remove_block`] took out — the `Unelide` marker with
/// the block; on Claude Code the nodes back from the original the removal
/// copied from (`CliSession::restore_block`), on [`restore_message`]'s
/// terms.
#[tauri::command]
pub(crate) async fn restore_block(
    state: State<'_, AppState>,
    index: usize,
    block: usize,
    at: Option<chrono::DateTime<chrono::Utc>>,
    nth: Option<usize>,
) -> Result<MessageEdit, String> {
    let (mut agent_guard, mut session_guard) = lock_agent_and_chat(&state).await;
    let session = session_guard
        .as_mut()
        .ok_or_else(|| "no active session".to_string())?;
    // Backlog 364: the reply aimed as `edit_message`'s save is.
    let index = chat_ops::aimed(session, index, at, nth)?;
    chat_ops::restore_block(session, agent_guard.as_mut().map(OnCli::of), index, block)?;
    Ok(MessageEdit {
        events: session.events().to_vec(),
        session: session.id.clone(),
        forked: false,
    })
}

/// Fork the open chat before the user turn at `upto` and make the fork
/// the open chat (nightshift backlog 062). The parent stays in the list,
/// untouched; the fork's creation line names it (`forked_from`), and the
/// sidebar shows the lineage. On the Claude Code engine the CLI's file is
/// copied cut before that turn and the copy's id recorded on the fork,
/// so its next turn resumes a history that ends where the fork does.
///
/// The fork's own log is written in the same directory as the parent's;
/// an ephemeral parent forks to another chat with no log.
#[tauri::command]
pub(crate) async fn fork_session(
    state: State<'_, AppState>,
    upto: usize,
    at: Option<chrono::DateTime<chrono::Utc>>,
) -> Result<MessageEdit, String> {
    let target = state.chats.target();
    let mut agent_guard = lock_agent_at(&state, &target).await;
    let log_dir = state.log_dir().await;
    let session_guard = target.lock().await;
    let parent = session_guard
        .as_ref()
        .ok_or_else(|| "no active session".to_string())?;
    // The message the window meant, by when it was sent (backlog 361): its
    // place in the window's list may not be its place in the log.
    let upto = match at {
        Some(at) => parent.aim_user_message(upto, at)?,
        None => upto,
    };
    let fork = chat_ops::fork(parent, &log_dir, agent_guard.as_mut().map(OnCli::of), upto)?;
    let events = fork.events().to_vec();
    let id = fork.id.clone();
    // The new chat is held and focused; the parent's lock goes with the
    // guard and it is dropped from the held set (backlog 159, A1).
    drop(session_guard);
    state.chats.open(fork);
    Ok(MessageEdit {
        events,
        session: id,
        forked: true,
    })
}

/// Continue the open chat in a fresh one after a hand-off (nightshift
/// backlog 086, 2026-09-16): the window has filled, the model has written
/// `HANDOFF.md` in the project, and the next chat starts empty in the same
/// folder, linked to this one (`forked_from` with `reason: "handoff"`),
/// with no CLI conversation to resume — its first turn opens a new one.
/// The parent stays in the list, untouched and readable. Asked, never
/// automatic (nightshift blocker 092, default taken): the caller is the
/// *Continue in a new chat* card. Nothing is summarised here in
/// Nightloom's words; the hand-off is the model's file.
#[tauri::command]
pub(crate) async fn continue_session(state: State<'_, AppState>) -> Result<MessageEdit, String> {
    let target = state.chats.target();
    let mut agent_guard = lock_agent_at(&state, &target).await;
    let log_dir = state.log_dir().await;
    let session_guard = target.lock().await;
    let parent = session_guard
        .as_ref()
        .ok_or_else(|| "no active session".to_string())?;
    let next = chat_ops::continue_from(parent, &log_dir, agent_guard.as_mut())?;
    let events = next.events().to_vec();
    let id = next.id.clone();
    // The new chat is held and focused; the parent's lock goes with the
    // guard and it is dropped from the held set (backlog 159, A1).
    drop(session_guard);
    state.chats.open(next);
    Ok(MessageEdit {
        events,
        session: id,
        forked: true,
    })
}

/// Continue chat `chat` of `project` in a fresh linked chat **without
/// opening either** (nightshift backlog 544): an unattended chat that
/// wrote its hand-off off screen — he is away, another chat or project is
/// on screen — is continued where it lives, and the window then sends the
/// next chat's prompt into it by id ([`send_agent`]'s `chat`). The new
/// chat is held, not focused; its log is beside its parent's; it runs on
/// its parent's agent spec (same project, same thread). Returns its id.
/// Refused while the parent's turn runs, or when it has no spec to pass on
/// and its project is not the open one.
#[tauri::command]
pub(crate) async fn continue_chat(
    state: State<'_, AppState>,
    chat: String,
    project: Option<String>,
) -> Result<String, String> {
    let target = chat_target(&state, &chat, project.as_deref())
        .await
        .map_err(|_| "its chat's log could not be read".to_string())?;
    let active = state.active().await.map(|p| p.id);
    let guard = target
        .try_lock()
        .map_err(|_| "that chat is running a turn".to_string())?;
    let parent = guard
        .as_ref()
        .ok_or_else(|| "its chat's log could not be read".to_string())?;
    let dir = match parent.log_path().and_then(|p| p.parent()) {
        Some(dir) => dir.to_path_buf(),
        None => state.log_dir().await,
    };
    let next = chat_ops::continue_from(parent, &dir, None)?;
    let id = next.id.clone();
    drop(guard);
    if !state.agents.reserve_like(&chat, &id) && project != active {
        // Nothing to run it on off screen; the log just made is empty and
        // goes to the trash, so no orphan chat is left in the list.
        if let Some(path) = next.log_path() {
            let _ = chat_ops::move_to_trash(&dir, path, &id);
        }
        return Err("its project is not open".to_string());
    }
    state.chats.hold(next);
    Ok(id)
}

/// Seconds since the last input on this Mac (backlog 544, `wake.rs`).
#[tauri::command]
pub(crate) fn idle_seconds() -> Option<f64> {
    wake::idle_seconds()
}

/// Blocker 1757's one-time switch (his answer, 2026-11-10: "Yes, switch
/// them"): every chat's `subagent-limits.json` on Same, in the unfiled
/// chats and in every project, made Choose — no other field touched
/// (`brief::switch_same_to_choose`). The window calls it once, behind its
/// own marker, so it never overrides a chat he sets back to Same. Returns
/// how many chats were switched.
#[tauri::command]
pub(crate) async fn switch_subagents_same_to_choose(
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let mut dirs = vec![state.default_log_dir.clone()];
    dirs.extend(
        state
            .workspaces
            .lock()
            .await
            .registry
            .projects()
            .iter()
            .map(|p| p.session_dir()),
    );
    tokio::task::spawn_blocking(move || {
        dirs.iter()
            .map(|d| nightloom_service::agent::brief::switch_same_to_choose(d))
            .sum()
    })
    .await
    .map_err(|e| format!("switching the subagent model: {e}"))
}
