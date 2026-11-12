//! Thread commands: a chat's thread, the thread list, handoffs, logs and upkeep (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// Bind the open chat to a research thread, or unbind it with `None`
/// (nightshift backlog 271, step 1), returning the transcript. The same
/// shape and rules as [`set_chat_folders`]: only the log is written — a
/// `thread` event, the latest live one winning — the caller reconnects and
/// both connects read the binding back for the thread layer; a session is
/// created if the chat has none. Refused for a slug that is not a thread
/// in the open project, so a binding always names a folder that exists.
#[tauri::command]
pub(crate) async fn set_chat_thread(
    state: State<'_, AppState>,
    thread: Option<String>,
) -> Result<Vec<SessionEvent>, String> {
    let thread = thread
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    if let Some(slug) = &thread {
        let project = state
            .active()
            .await
            .ok_or_else(|| "open a project first — threads live in a project".to_string())?;
        let dir = nightloom_service::thread::thread_dir(&project.notes_dir(), slug)
            .ok_or_else(|| format!("{slug:?} is not a thread name"))?;
        if !dir.join(nightloom_service::thread::THREAD_FILE).is_file() {
            return Err(format!("no thread {slug} in {}", project.name));
        }
    }
    let log_dir = state.log_dir().await;
    let pending = *state.pending_mode.lock().await;
    let pending_kind = *state.pending_kind.lock().await;
    let (mut held, _) = state
        .chats
        .lock_or_start(pending, pending_kind, &log_dir)
        .await?;
    let session: &mut Session = &mut held;
    session.record_thread(thread);
    Ok(session.events().to_vec())
}

/// Bind any listed chat to a research thread, or unbind it with `None`
/// (nightshift backlog 288: a drag in the sidebar, or a row's Move to
/// thread ▸ / Remove from thread). The same `thread` event the picker
/// writes and the same refusal for a slug that is not a thread in the open
/// project. Like [`rename_session`]: a held chat is written through its
/// one writer, refused while its turn holds it; any other chat is a file
/// no one is writing. Never creates a log — the chat must exist. The
/// window's open chat goes through [`set_chat_thread`] instead, which the
/// shell follows with the reconnect that loads the thread layer.
#[tauri::command]
pub(crate) async fn set_session_thread(
    state: State<'_, AppState>,
    id: String,
    thread: Option<String>,
) -> Result<(), String> {
    let thread = thread
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    if let Some(slug) = &thread {
        let project = state
            .active()
            .await
            .ok_or_else(|| "open a project first — threads live in a project".to_string())?;
        let dir = nightloom_service::thread::thread_dir(&project.notes_dir(), slug)
            .ok_or_else(|| format!("{slug:?} is not a thread name"))?;
        if !dir.join(nightloom_service::thread::THREAD_FILE).is_file() {
            return Err(format!("no thread {slug} in {}", project.name));
        }
    }
    if let Some((_, log)) = state.chats.find(&id) {
        return match log.try_lock() {
            Ok(mut open) => {
                open.record_thread(thread);
                Ok(())
            }
            Err(_) => Err("that chat is running a turn — move it when the turn ends".into()),
        };
    }
    let path = store::find_by_prefix(&state.log_dir().await, &id).map_err(|e| e.to_string())?;
    let mut session = Session::load(&path).map_err(|e| e.to_string())?;
    session.record_thread(thread);
    Ok(())
}

/// The open project's threads (backlog 271) for the picker, most recently
/// touched first; empty without a project.
#[tauri::command]
pub(crate) async fn list_threads(
    state: State<'_, AppState>,
) -> Result<Vec<nightloom_service::thread::ThreadInfo>, String> {
    let Some(project) = state.active().await else {
        return Ok(Vec::new());
    };
    let notes = project.notes_dir();
    blocking(move || Ok::<_, String>(nightloom_service::thread::list_threads(&notes))).await
}

/// Start a thread from the template in the open project (backlog 271):
/// `threads/<slug>/thread.md` and `log.md`, the index rewritten. Refused
/// for a slug that exists — nothing is overwritten.
#[tauri::command]
pub(crate) async fn new_thread(
    state: State<'_, AppState>,
    slug: String,
    name: String,
) -> Result<nightloom_service::thread::ThreadInfo, String> {
    let project = state
        .active()
        .await
        .ok_or_else(|| "open a project first — threads live in a project".to_string())?;
    let notes = project.notes_dir();
    blocking(move || nightloom_service::thread::create_thread(&notes, slug.trim(), &name)).await
}

/// The open project's docspace, for the thread commands that need one.
pub(crate) async fn thread_notes(state: &AppState) -> Result<PathBuf, String> {
    state
        .active()
        .await
        .map(|p| p.notes_dir())
        .ok_or_else(|| "open a project first — threads live in a project".to_string())
}

/// Rename a thread in the open project (nightshift backlog 424): the title
/// in its `thread.md` heading only; the slug and folder stay, so bound
/// chats still find it (`thread::rename_thread`).
#[tauri::command]
pub(crate) async fn rename_thread(
    state: State<'_, AppState>,
    slug: String,
    name: String,
) -> Result<nightloom_service::thread::ThreadInfo, String> {
    let notes = thread_notes(&state).await?;
    blocking(move || nightloom_service::thread::rename_thread(&notes, slug.trim(), &name)).await
}

/// Delete a thread in the open project (nightshift backlog 424): its folder
/// moves to `.agents/.trash/threads/<slug>-<when>`, never unlinked
/// (`thread::trash_thread`). The shell unbinds its chats first. Returns
/// where the folder went.
#[tauri::command]
pub(crate) async fn delete_thread(
    state: State<'_, AppState>,
    slug: String,
) -> Result<String, String> {
    let notes = thread_notes(&state).await?;
    let when = chrono::Local::now().format("%Y-%m-%d-%H%M%S").to_string();
    blocking(move || {
        nightloom_service::thread::trash_thread(&notes, slug.trim(), &when)
            .map(|p| p.display().to_string())
    })
    .await
}

/// Show a thread's folder in the file manager, selected (backlog 424's
/// Reveal in Finder). Nothing is created: a thread that has gone says so.
#[tauri::command]
pub(crate) async fn reveal_thread(state: State<'_, AppState>, slug: String) -> Result<(), String> {
    let notes = thread_notes(&state).await?;
    let dir = nightloom_service::thread::thread_dir(&notes, slug.trim())
        .ok_or_else(|| format!("{slug:?} is not a thread name"))?;
    if !dir.is_dir() {
        return Err(format!("the thread {slug} is no longer there"));
    }
    project::reveal_file(&dir).map_err(|e| e.to_string())
}

/// Keep a thread chat's `<handoff>` prompt on its thread in the open project
/// (nightshift item 464): `handoff.json` beside `thread.md`, replacing any
/// earlier one (`thread_handoff::save_handoff`).
#[tauri::command]
pub(crate) async fn save_thread_handoff(
    state: State<'_, AppState>,
    slug: String,
    text: String,
    from_chat: String,
) -> Result<(), String> {
    let notes = thread_notes(&state).await?;
    let now = chrono::Local::now().to_rfc3339();
    blocking(move || {
        nightloom_service::thread_handoff::save_handoff(
            &notes,
            slug.trim(),
            &text,
            &from_chat,
            &now,
        )
        .map(|_| ())
    })
    .await
}

/// The thread's + (item 510): the saved hand-off's text when no child chat
/// has started from it yet, else null. Reads only; nothing exists yet.
#[tauri::command]
pub(crate) async fn peek_thread_handoff(
    state: State<'_, AppState>,
    slug: String,
) -> Result<Option<String>, String> {
    let notes = thread_notes(&state).await?;
    blocking(move || {
        Ok::<_, String>(nightloom_service::thread_handoff::peek_handoff(
            &notes,
            slug.trim(),
        ))
    })
    .await
}

/// The first send from a thread's + (item 464, 510): the saved hand-off's text
/// when no child chat has started from it yet, `chat` then named as the one
/// that did; else null.
#[tauri::command]
pub(crate) async fn take_thread_handoff(
    state: State<'_, AppState>,
    slug: String,
    chat: String,
) -> Result<Option<String>, String> {
    let notes = thread_notes(&state).await?;
    blocking(move || nightloom_service::thread_handoff::take_handoff(&notes, slug.trim(), &chat))
        .await
}

/// Append an aside's fold entry to a thread's `log.md` in the open project
/// (backlog 282). The shell builds the entry (dated, the aside and chat
/// named, the model's summary as he approved or edited it); this only
/// appends — `thread.md` stays the bound chat's to write.
#[tauri::command]
pub(crate) async fn append_thread_log(
    state: State<'_, AppState>,
    slug: String,
    entry: String,
) -> Result<usize, String> {
    let project = state
        .active()
        .await
        .ok_or_else(|| "open a project first — threads live in a project".to_string())?;
    let notes = project.notes_dir();
    blocking(move || -> Result<_, String> {
        let dir = nightloom_service::thread::thread_dir(&notes, &slug)
            .ok_or_else(|| format!("{slug:?} is not a thread name"))?;
        nightloom_service::thread::append_log(&dir, &entry)
    })
    .await
}

/// One thread's upkeep in the open project (backlog 271): a dry run for
/// the wrap-up's flags (`apply` false), or the mechanical moves — struck
/// lines from earlier rounds to `archive.md`, duplicate queue rows merged —
/// and the index rewritten (`apply` true), which the shell runs at
/// *Continue*, when no chat is writing the thread.
#[tauri::command]
pub(crate) async fn thread_upkeep(
    state: State<'_, AppState>,
    slug: String,
    apply: bool,
) -> Result<nightloom_service::thread::Upkeep, String> {
    let project = state
        .active()
        .await
        .ok_or_else(|| "open a project first — threads live in a project".to_string())?;
    let notes = project.notes_dir();
    blocking(move || -> Result<_, String> {
        let dir = nightloom_service::thread::thread_dir(&notes, &slug)
            .ok_or_else(|| format!("{slug:?} is not a thread name"))?;
        let today = chrono::Local::now().date_naive();
        let up = nightloom_service::thread::upkeep(&dir, today, apply)?;
        if apply {
            nightloom_service::thread::write_index(&notes)?;
        }
        Ok(up)
    })
    .await
}

/// The daily pass's thread step (backlog 271): every registered project's
/// threads, upkeep then index. Shares the dream's lock like `tidy_memory`.
#[tauri::command]
pub(crate) async fn tidy_threads(
    state: State<'_, AppState>,
    apply: bool,
) -> Result<Vec<nightloom_service::dream::ThreadTidy>, String> {
    let Some(config) = project::config_dir() else {
        return Ok(Vec::new());
    };
    let Ok(_running) = state.dreaming.try_lock() else {
        return Err("a dream or a capture is already running".into());
    };
    blocking(move || nightloom_service::dream::tidy_threads(&config, None, apply)).await
}
