//! Context commands: the context view, prompt layers, a chat's starting context and the CLI prompt snapshot (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// Itemize the request the active chat would send right now.
///
/// Needs both locks because the view is the *request*, not the log: the
/// preamble and the sidecar live on the `Chat` and only the `Session` knows
/// the conversation. Taking them in the same order `compact` does (chat,
/// then session) so the two can never deadlock against each other.
///
/// On the Claude Code engine the view is the bridged preamble alone, with
/// no messages: the CLI holds the conversation and assembles its own
/// request, so there is no history of ours to itemize — but the layers
/// Nightloom appends are ours, and "what does this chat know at the start"
/// deserves the same answer on both engines. It used to refuse here; that
/// was the right call while the popover could only rank items to remove,
/// and the wrong one once it shows what was sent. No limit either: the
/// CLI's window is reported per turn, not known at connect.
#[tauri::command]
pub(crate) async fn context_view(state: State<'_, AppState>) -> Result<WireView, String> {
    // The flag, not the lock (backlog 159, A1): a turn holds the agent.
    if state.agent_live.load(std::sync::atomic::Ordering::SeqCst) {
        let built = state.prompt.lock().await;
        return Ok(WireView::assemble(
            built.agent.as_ref(),
            &Session::new(),
            None,
            None,
        ));
    }
    // Out of its lock (A4): another chat's provider turn does not hold it.
    let chat = state
        .chat
        .lock()
        .await
        .clone()
        .ok_or_else(|| "not connected".to_string())?;
    let session_guard = state.chats.lock_focused().await;
    let Some(session) = session_guard.as_ref() else {
        // Sessions are created lazily by `send`, so "no session yet" is the
        // ordinary state at launch rather than a failure. An empty session
        // still has a preamble worth showing, which is the answer to "what
        // am I starting with".
        return Ok(chat.context_view(&Session::new()));
    };
    Ok(chat.context_view(session))
}

/// Remove or restore the content of log events, returning the new view and
/// transcript together.
///
/// Both come back for the same reason [`rewind`] returns the transcript: the
/// UI re-syncs from the log rather than patching its own copy, and an
/// elision changes what every projection reads.
#[tauri::command]
pub(crate) async fn edit_context(
    state: State<'_, AppState>,
    targets: Vec<usize>,
    remove: bool,
) -> Result<ContextEdit, String> {
    not_in_agent_mode(&state, "edit the context").await?;
    // Out of its lock (A4), as `send`.
    let chat = state
        .chat
        .lock()
        .await
        .clone()
        .ok_or_else(|| "not connected".to_string())?;
    let mut session_guard = state.chats.lock_focused().await;
    let session = session_guard
        .as_mut()
        .ok_or_else(|| "no active session".to_string())?;

    let changed = context_ops::edit_context(session, targets, remove)?;
    Ok(ContextEdit {
        view: chat.context_view(session),
        events: session.events().to_vec(),
        changed,
    })
}

#[tauri::command]
pub(crate) async fn prompt_layers(state: State<'_, AppState>) -> Result<PromptLayersInfo, String> {
    let off = layers_off(&state).await;
    let edits = layer_edits(&state).await;
    let mode = session_mode(&state).await;
    let kind = session_kind(&state).await;
    let thread = chat_thread(&state).await;
    let built = state.prompt.lock().await;
    Ok(PromptLayersInfo {
        thread,
        built_thread: built.thread.as_ref().map(|t| t.slug.clone()),
        off,
        built: built.off.clone(),
        edits,
        built_edits: built.edits.clone(),
        mode,
        built_mode: built.mode,
        kind,
        built_kind: built.kind,
    })
}

/// The layers whose file is newer than the text the chat the live
/// connection was built for holds (nightshift backlog 174): the Context
/// page's *newer version exists* marks. Empty on the provider engine.
#[tauri::command]
pub(crate) async fn prompt_pending(
    holds: State<'_, prompt_hold::Pending>,
) -> Result<prompt_hold::PendingView, String> {
    Ok(holds.view.lock().await.clone())
}

/// A click on a pending layer's mark: *Update at the next cold moment*
/// (`cold`), *Keep this version* (`keep`), or back to the Settings default
/// (`auto`). Written to the chat's hold file at once, so a reconnect —
/// or a restart — reads it back; *Update now* is a reconnect instead
/// (`connect_agent`'s `update_now`).
///
/// `session` is the chat whose Context page was clicked; refused when the
/// connection was built for another one (`Pending::choose_for`).
#[tauri::command]
pub(crate) async fn set_prompt_layer_choice(
    holds: State<'_, prompt_hold::Pending>,
    session: String,
    kind: SegmentKind,
    choice: prompt_hold::Choice,
) -> Result<prompt_hold::PendingView, String> {
    holds.choose_for(&session, kind, choice).await
}

/// Record which prompt layers this chat excludes, returning the transcript.
///
/// The log is the only thing written here: the live engine still carries
/// the prompt it was built with, and the UI reconnects after this returns —
/// the same path a rail knob takes — so `connect` / `connect_agent` read the
/// new set back the one way they read it. A session is created if the chat
/// has none yet, as `send` would create one and in the same pending kind:
/// the exclusion is a fact about the chat, and a chat has to exist to have
/// it. So this is the one way a row can appear before the first message —
/// a layer unchecked on a fresh New chat creates the log then.
///
/// Allowed on the Claude Code engine, unlike a rewind or an elision: those
/// change what the *log* projects, which that engine never reads, while
/// this changes what the next connect appends to the CLI's prompt, which it
/// does read — after the next compaction on a resumed session (see
/// `docs/service-agent.md`), and the popover says so there.
#[tauri::command]
pub(crate) async fn set_prompt_layers(
    state: State<'_, AppState>,
    off: Vec<SegmentKind>,
) -> Result<Vec<SessionEvent>, String> {
    let log_dir = state.log_dir().await;
    let pending = *state.pending_mode.lock().await;
    let pending_kind = *state.pending_kind.lock().await;
    let (mut held, _) = state
        .chats
        .lock_or_start(pending, pending_kind, &log_dir)
        .await?;
    let session: &mut Session = &mut held;
    context_ops::set_layers_off(session, off);
    Ok(session.events().to_vec())
}

/// Record the chat's own text for one layer — or drop it, with `text`
/// absent — returning the transcript (nightshift backlog 057, 2026-09-15).
///
/// The same shape and the same rules as [`set_prompt_layers`]: only the log
/// is written, the caller reconnects, a session is created if the chat has
/// none, and the Claude Code engine is allowed for the same reason. The
/// text is the file's *body* as the user would write it — the assembler
/// wraps it (`nightloom_service::prompt::assemble`) — and a body that trims
/// to nothing is recorded as no override, since "send nothing" is what the
/// switch is for; the core says so too and normalizes it the same way.
#[tauri::command]
pub(crate) async fn set_prompt_layer_text(
    state: State<'_, AppState>,
    kind: SegmentKind,
    text: Option<String>,
) -> Result<Vec<SessionEvent>, String> {
    context_ops::check_editable(kind)?;
    let log_dir = state.log_dir().await;
    let pending = *state.pending_mode.lock().await;
    let pending_kind = *state.pending_kind.lock().await;
    let (mut held, _) = state
        .chats
        .lock_or_start(pending, pending_kind, &log_dir)
        .await?;
    let session: &mut Session = &mut held;
    context_ops::set_layer_text(session, kind, text)?;
    Ok(session.events().to_vec())
}

/// What an editable layer reads from disk right now, as the body a user
/// could edit — the seed for *Edit for this chat* before the chat has its
/// own text. `None` when nothing is on disk. Read by the model id and the
/// workspace the live prompt was built with (`PromptBuilt`), so the seed is
/// the file the prompt would read and not a guess at it.
#[tauri::command]
pub(crate) async fn prompt_layer_file(
    state: State<'_, AppState>,
    kind: SegmentKind,
) -> Result<Option<String>, String> {
    let built = state.prompt.lock().await;
    // The thread's Start here (backlog 271), from the thread the prompt
    // was built with.
    if kind == SegmentKind::Thread {
        return Ok(built
            .thread
            .as_ref()
            .and_then(nightloom_service::thread::layer_source));
    }
    let cwd = built
        .cwd
        .clone()
        .ok_or_else(|| "not connected".to_string())?;
    Ok(nightloom_service::layer_source(
        kind,
        built.model.as_deref(),
        &cwd,
    ))
}

/// What the open New chat already holds before its first message
/// (nightshift item 574): the new-chat dial's parts — Claude Code's own
/// prompt and tools (measured from the newest chat in the same folder, else
/// in any project's), Nightloom's built layers, the instruction files and
/// the auto memory the CLI loads itself. `None` on the provider engine and
/// before a connect. `safe_mode` is the connection's (the window has it);
/// with it, or in an incognito chat, the CLI reads no user `CLAUDE.md`.
/// Reads a few small files and the head of one session file (cached by
/// mtime), off the async runtime.
#[tauri::command]
pub(crate) async fn start_context(
    state: State<'_, AppState>,
    safe_mode: bool,
) -> Result<Option<nightloom_service::start_context::StartContext>, String> {
    use nightloom_service::agent::cli_session;
    use nightloom_service::start_context as sc;
    let (layers, cwd, off, mode, agents_md) = {
        let built = state.prompt.lock().await;
        let Some(agent) = built.agent.clone() else {
            return Ok(None);
        };
        let Some(cwd) = built.cwd.clone() else {
            return Ok(None);
        };
        (
            agent,
            cwd,
            built.off.clone(),
            built.mode,
            built.cli_agents_md,
        )
    };
    // The fallback folders: every project's, after the open folder's own.
    let others: Vec<PathBuf> = state
        .workspaces
        .lock()
        .await
        .registry
        .projects()
        .iter()
        .map(|p| p.workspace_dir())
        .collect();
    blocking(move || {
        let projects = cli_session::projects_dir();
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(p) = &projects {
            dirs.push(p.join(cli_session::project_folder(&cwd)));
            for o in &others {
                let d = p.join(cli_session::project_folder(o));
                if !dirs.contains(&d) {
                    dirs.push(d);
                }
            }
        }
        let measured = sc::newest_baseline(&dirs);
        let claude_dir = projects
            .as_ref()
            .and_then(|p| p.parent().map(Path::to_path_buf));
        let user_level = !safe_mode && mode != ChatMode::Incognito;
        // The CLI's `AGENTS.md` copies exactly when the walk left them out
        // (nightshift 575), so the dial counts each file once.
        let files = sc::instruction_files(&cwd, claude_dir.as_deref(), user_level, agents_md);
        let memory = if off.contains(&SegmentKind::CliMemory) {
            None
        } else {
            cli_session::project_dir(&cwd)
                .and_then(|d| std::fs::read_to_string(d.join("memory").join("MEMORY.md")).ok())
        };
        let mut out = sc::compose(&sc::StartInputs {
            baseline: measured.as_ref().map(|(_, b)| b),
            layers: Some(&layers),
            instructions: &files,
            memory: memory.as_deref(),
        });
        out.measured_from = measured.map(|(p, _)| p.to_string_lossy().into_owned());
        Ok::<_, String>(Some(out))
    })
    .await
}

/// Claude Code's own system prompt for the open chat, read-only
/// (nightshift backlog 077, 2026-09-16; his ask of 00:55). Not in the init
/// event and no flag prints it: the one place it exists is the
/// `prompt_snapshot` attachment the CLI writes into its session file after
/// the first turn (`{"type":"attachment","attachment":{"type":
/// "prompt_snapshot","systemPrompt":[…sections…]}}`, measured on 2.1.263 —
/// nightshift `notes/runner-design/077-measurements-2026-09-16.md`), and
/// which `--system-prompt-snapshot on` (the default) reuses verbatim on
/// every request and resume. So: the chat's CLI session id from its log,
/// the file through `cli_session::find`, the *last* snapshot line in it.
/// `None` before the first turn, for an ephemeral chat (no file), and on
/// the other engine. Nothing is sent anywhere; it is his file on his disk.
#[derive(Serialize)]
pub(crate) struct CliPromptSnapshot {
    /// The prompt's sections, in the order the CLI sends them.
    sections: Vec<String>,
    /// The file it was read from.
    path: String,
}

#[tauri::command]
pub(crate) async fn cli_prompt_snapshot(
    state: State<'_, AppState>,
) -> Result<Option<CliPromptSnapshot>, String> {
    use nightloom_service::agent::cli_session;
    // A reader (backlog 136, as `transcript`): the turn holds `session`,
    // and the Context popover asking mid-turn would sit until it ended.
    let Ok(guard) = state.chats.try_lock_focused() else {
        return Err(
            "the open chat is running a turn — the prompt snapshot reads its log; open \
             the popover again when the turn ends"
                .into(),
        );
    };
    let id = match guard.as_ref() {
        Some(s) => match s.agent_session() {
            Some((agent, id)) if agent == AGENT => id.to_string(),
            _ => return Ok(None),
        },
        None => return Ok(None),
    };
    drop(guard);
    let cwd = match state.prompt.lock().await.cwd.clone() {
        Some(cwd) => cwd,
        None => return Ok(None),
    };
    let Some(projects) = cli_session::projects_dir() else {
        return Ok(None);
    };
    let path = match cli_session::find(&projects, &cwd, &id) {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut last: Option<Vec<String>> = None;
    for line in text.lines() {
        if !line.contains("prompt_snapshot") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v["type"] != "attachment" || v["attachment"]["type"] != "prompt_snapshot" {
            continue;
        }
        if let Some(arr) = v["attachment"]["systemPrompt"].as_array() {
            last = Some(
                arr.iter()
                    .filter_map(|s| s.as_str().map(str::to_string))
                    .collect(),
            );
        }
    }
    Ok(last.map(|sections| CliPromptSnapshot {
        sections,
        path: path.to_string_lossy().into_owned(),
    }))
}

/// The images tool calls returned (nightshift backlog 434): a browser
/// screenshot drawn in the transcript. The stream and the log carry only
/// `[image]` (`translate::flatten`); the bytes are in the CLI's session
/// file `session`, read here for the calls `ids`. Empty when the file is
/// not found (an ephemeral chat, another machine's session). Read-only;
/// the window asks only for results whose text names an image.
#[tauri::command]
pub(crate) async fn tool_result_images(
    state: State<'_, AppState>,
    session: String,
    ids: Vec<String>,
) -> Result<
    std::collections::HashMap<String, nightloom_service::agent::cli_session::ToolResultImages>,
    String,
> {
    use nightloom_service::agent::cli_session;
    if ids.is_empty() {
        return Ok(Default::default());
    }
    // `find` tries this folder first and then every project folder.
    let cwd = state.prompt.lock().await.cwd.clone().unwrap_or_default();
    blocking(move || -> Result<_, String> {
        let Some(projects) = cli_session::projects_dir() else {
            return Ok(Default::default());
        };
        let Ok(path) = cli_session::find(&projects, &cwd, &session) else {
            return Ok(Default::default());
        };
        // Its subagents' files too (item 476): their calls' screenshots.
        cli_session::tool_result_images_in(&path, &ids).map_err(|e| e.to_string())
    })
    .await
}
