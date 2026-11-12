//! Chat commands: a chat's target, home, start, kind and folders, the project folders, its voice note and CLI memory file (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// The chat `id` as a [`chats::Target`] for a send that names its chat
/// (nightshift blocker 1467; backlog 535): the held one, or — when it is
/// not held — its log read from its own project's folder (`project`, the
/// app-data folder for none) and held without taking the focus. A chat
/// with no log there (an ephemeral one, a deleted one) is refused in
/// 1467's words, which the window reads as "nothing was sent".
pub(crate) async fn chat_target(
    state: &AppState,
    id: &str,
    project: Option<&str>,
) -> Result<chats::Target, String> {
    if let Some(t) = state.chats.target_at(id) {
        return Ok(t);
    }
    let refused = || "that chat is not loaded now — its message stays queued there".to_string();
    let dir = match project {
        Some(p) => state
            .workspaces
            .lock()
            .await
            .registry
            .find(p)
            .map(Project::session_dir)
            .ok_or_else(refused)?,
        None => state.default_log_dir.clone(),
    };
    let full = id.to_string();
    let session = blocking(move || -> Result<Session, String> {
        let path = dir.join(format!("{full}.jsonl"));
        if !path.is_file() {
            return Err("no log".into());
        }
        Session::load(path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| refused())?;
    if session.id != id {
        return Err(refused());
    }
    state.chats.hold(session);
    state.chats.target_at(id).ok_or_else(refused)
}

/// Whether a message could be sent into chat `chat` of `project` now,
/// off screen, without sending anything (backlog 535): the same two
/// lookups [`send_agent`] makes for a send that names its chat — the
/// chat's log, and an agent for it (its own, the spec kept for it, or the
/// rail's when its project is the open one). The window asks before it
/// takes a scheduled message out of its store; the refusal says which.
#[tauri::command]
pub(crate) async fn can_send_in_chat(
    state: State<'_, AppState>,
    chat: String,
    project: Option<String>,
) -> Result<(), String> {
    chat_target(&state, &chat, project.as_deref())
        .await
        .map_err(|_| "its chat's log could not be read".to_string())?;
    if state.agents.existing(&chat).is_some() || state.agents.reserved(&chat) {
        return Ok(());
    }
    let active = state.active().await.map(|p| p.id);
    if project != active {
        return Err("its project is not open".to_string());
    }
    if !state.agents.connected() {
        return Err("Claude Code is not connected".to_string());
    }
    Ok(())
}

/// Keep the agent spec of chat `chat` for a later send into it off screen
/// (backlog 535), or with `keep: false` let it go. Called when something
/// is scheduled in the chat on screen, and again whenever that chat is on
/// screen and connected, so the spec is the one it would run on now.
/// `true` when a spec is kept.
#[tauri::command]
pub(crate) fn reserve_chat_agent(state: State<'_, AppState>, chat: String, keep: bool) -> bool {
    if !keep {
        state.agents.release(&chat);
        return false;
    }
    let focused = state.chats.focus().as_deref() == Some(chat.as_str());
    state.agents.reserve(&chat, focused)
}

/// Where chat `chat` lives (backlog 535): the project whose chats folder
/// holds its log, `project: null` for the app-data folder, `found: false`
/// when no folder has it. A scheduled message made before 535 carries no
/// project; this is how it learns its own.
#[derive(Serialize)]
pub(crate) struct ChatHome {
    found: bool,
    project: Option<String>,
    name: Option<String>,
}

#[tauri::command]
pub(crate) async fn chat_home(
    state: State<'_, AppState>,
    chat: String,
) -> Result<ChatHome, String> {
    if chat.is_empty() || !chat.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("not a chat id".into());
    }
    let projects = state.workspaces.lock().await.registry.projects();
    let default_dir = state.default_log_dir.clone();
    blocking(move || -> Result<ChatHome, String> {
        let file = format!("{chat}.jsonl");
        for p in &projects {
            if p.session_dir().join(&file).is_file() {
                let unfiled = p.is_unfiled_holder();
                return Ok(ChatHome {
                    found: true,
                    project: Some(p.id.clone()),
                    name: (!unfiled).then(|| p.name.clone()),
                });
            }
        }
        Ok(ChatHome {
            found: default_dir.join(&file).is_file(),
            project: None,
            name: None,
        })
    })
    .await
}

/// Arm (or with `at_ms: null` clear) a named wake of the schedule clock
/// (backlog 535, `wake.rs`): the window is sent `wake-due` at that
/// wall-clock moment whatever its own timers are doing.
#[tauri::command]
pub(crate) fn arm_wake(wakes: State<'_, wake::Wakes>, name: String, at_ms: Option<u64>) {
    wakes.arm(&name, at_ms);
}

/// A line from the window for `<config dir>/logs/schedule.log` (backlog
/// 535): each tick that did something, each delivery and each refusal.
#[tauri::command]
pub(crate) fn schedule_log(text: String) {
    let text: String = text.chars().take(600).collect();
    wake::log("page", &text);
}

/// A debug build's schedule timing probe (item 535m, `wake::probe`): what
/// the page should schedule; nothing in a release build.
#[tauri::command]
pub(crate) fn schedule_probe() -> wake::Probe {
    wake::probe()
}

/// Make the open New chat a chat now, without sending, returning the
/// transcript (nightshift backlog 527): Send later from a New chat stores
/// the message under the chat's id, and a New chat has none until this.
/// The same `lock_or_start` as [`set_prompt_layers`], in the pending mode
/// and kind, so the chat is the one a first send would have made; nothing
/// but its creation is written. An open chat is returned as it is.
#[tauri::command]
pub(crate) async fn start_chat(state: State<'_, AppState>) -> Result<Vec<SessionEvent>, String> {
    let log_dir = state.log_dir().await;
    let pending = *state.pending_mode.lock().await;
    let pending_kind = *state.pending_kind.lock().await;
    let (held, _) = state
        .chats
        .lock_or_start(pending, pending_kind, &log_dir)
        .await?;
    Ok(held.events().to_vec())
}

/// Make the open chat the other kind from the next turn on, returning the
/// transcript (nightshift backlog 144, 2026-09-17; blocker 143 answered
/// *switchable*).
///
/// The same shape and the same rules as [`set_prompt_layers`]: only the
/// log is written — a `kind` event, the latest live one winning — the
/// caller reconnects, and `connect` / `connect_agent` read the new kind
/// back as the policy over a declaration that does not change
/// (`Session::declared_kind`), so the cached prefix survives. A session is
/// created if the chat has none yet, in the pending kind, so a switch on a
/// fresh New chat is a switch and not a different New chat. Allowed on the
/// Claude Code engine like a layer change: it changes what the next
/// process is started with, not what the log projects.
///
/// `workspace` is the folder for a switch to Claude Code on a chat born as
/// a Chat — the project's when absent; refused when it is not a directory,
/// since a folder that does not exist is not one the tools can be rooted
/// at. Ignored on a switch to a Chat, which has no folder to name.
#[tauri::command]
pub(crate) async fn set_chat_kind(
    state: State<'_, AppState>,
    kind: ChatKind,
    workspace: Option<String>,
) -> Result<Vec<SessionEvent>, String> {
    let workspace = chat_ops::kind_folder(workspace)?;
    let log_dir = state.log_dir().await;
    let pending = *state.pending_mode.lock().await;
    let pending_kind = *state.pending_kind.lock().await;
    let (mut held, _) = state
        .chats
        .lock_or_start(pending, pending_kind, &log_dir)
        .await?;
    let session: &mut Session = &mut held;
    chat_ops::set_kind(session, kind, workspace);
    Ok(session.events().to_vec())
}

/// Set the extra folders the open chat may see (nightshift backlog 143),
/// returning the transcript — the whole list, as the prompt layers are
/// set. The same shape and rules as [`set_prompt_layers`]: only the log is
/// written, the caller reconnects and both connects read the grant back;
/// a session is created if the chat has none. A folder that is not a
/// directory is refused. Allowed on the Claude Code engine: it changes
/// what the next process is started with (`--add-dir`), not the log's
/// projection.
#[tauri::command]
pub(crate) async fn set_chat_folders(
    state: State<'_, AppState>,
    folders: Vec<String>,
) -> Result<Vec<SessionEvent>, String> {
    let mut wanted: Vec<PathBuf> = Vec::new();
    for f in folders {
        let f = f.trim();
        if f.is_empty() {
            continue;
        }
        let dir = PathBuf::from(f);
        if !dir.is_dir() {
            return Err(format!("{} is not a folder", dir.display()));
        }
        wanted.push(dir);
    }
    let log_dir = state.log_dir().await;
    let pending = *state.pending_mode.lock().await;
    let pending_kind = *state.pending_kind.lock().await;
    let (mut held, _) = state
        .chats
        .lock_or_start(pending, pending_kind, &log_dir)
        .await?;
    let session: &mut Session = &mut held;
    session.record_folders(wanted);
    Ok(session.events().to_vec())
}

/// Set a project's extra folders (nightshift backlog 143) — the whole
/// list, replacing the registry's; applies to the project's chats at their
/// next connect, which the caller fires for the open one. Returns the
/// project as the rail shows it.
#[tauri::command]
pub(crate) async fn set_project_folders(
    state: State<'_, AppState>,
    id: String,
    folders: Vec<String>,
) -> Result<ProjectInfo, String> {
    let folders: Vec<PathBuf> = folders
        .into_iter()
        .map(|f| f.trim().to_string())
        .filter(|f| !f.is_empty())
        .map(PathBuf::from)
        .collect();
    let mut guard = state.workspaces.lock().await;
    let project = guard.registry.set_extra_folders(&id, folders)?;
    if guard.active.as_ref().is_some_and(|p| p.id == id) {
        guard.active = Some(project.clone());
    }
    Ok(ProjectInfo::of(&project))
}

/// The Context page's "Spoken turns" row (item 246 wave 3, 3C): the note a
/// message said aloud on the phone carries — `~/.nightloom/voice.md`, made
/// with the design's default the first time it is read. Not a layer: it
/// rides that turn's message, never the system prompt.
#[derive(Serialize)]
pub(crate) struct VoiceNoteFile {
    path: String,
    text: String,
}

#[tauri::command]
pub(crate) async fn voice_note_file() -> Result<VoiceNoteFile, String> {
    use nightloom_service::voice;
    let path = voice::note_path().ok_or_else(|| "no home directory".to_string())?;
    // Creates the file with the default when it is absent.
    let fallback = voice::note();
    let text = std::fs::read_to_string(&path).unwrap_or(fallback);
    Ok(VoiceNoteFile {
        path: path.to_string_lossy().into_owned(),
        text,
    })
}

/// Save the "Spoken turns" note. Empty is his "no note" (`voice::note`).
#[tauri::command]
pub(crate) async fn set_voice_note(text: String) -> Result<VoiceNoteFile, String> {
    let path =
        nightloom_service::voice::note_path().ok_or_else(|| "no home directory".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let body = match text.trim() {
        "" => String::new(),
        t => format!("{t}\n"),
    };
    std::fs::write(&path, &body).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(VoiceNoteFile {
        path: path.to_string_lossy().into_owned(),
        text: body,
    })
}

/// Claude Code's auto memory for the folder the live engine was built on
/// (nightshift backlog 088, 2026-09-16): the CLI's `MEMORY.md` under
/// `~/.claude/projects/<cwd>/memory/`, read for the Context page's card,
/// and the names of the topic files beside it, which the CLI reads on
/// demand and this card only lists. Read-only — Nightloom never writes
/// under `~/.claude/projects/`. `text` is `None` when there is no such
/// file, which the card says in words; the path is returned either way so
/// the card can name where the CLI would look.
#[derive(Serialize)]
pub(crate) struct CliMemoryFile {
    path: String,
    text: Option<String>,
    others: Vec<String>,
}

#[tauri::command]
pub(crate) async fn cli_memory_file(state: State<'_, AppState>) -> Result<CliMemoryFile, String> {
    use nightloom_service::agent::cli_session;
    let built = state.prompt.lock().await;
    let cwd = built
        .cwd
        .clone()
        .ok_or_else(|| "not connected".to_string())?;
    // Computed, not read from the init line's `memory_paths.auto`: the
    // review of 2026-09-16 (F17) feared the two could differ on a dotted
    // or non-ASCII cwd; the measurement in `cli_session::project_folder`'s
    // comment says they do not, so one encoding, in one place, is enough.
    let dir = cli_session::project_dir(&cwd)
        .ok_or_else(|| "no home directory".to_string())?
        .join("memory");
    let index = dir.join("MEMORY.md");
    let text = std::fs::read_to_string(&index).ok();
    let mut others: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_file())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n != "MEMORY.md")
                .collect()
        })
        .unwrap_or_default();
    others.sort();
    Ok(CliMemoryFile {
        path: index.to_string_lossy().into_owned(),
        text,
        others,
    })
}
