//! Turn commands: send, send to the agent, prewarm, compact, cancel and approve a call (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// Run one user turn, streaming progress as `turn-event` window events.
///
/// `images` and `documents` are base64 payloads the frontend already read
/// off a paste or a drop. They go into the session log verbatim rather than
/// as file paths, so the transcript keeps rendering after the source file
/// moves — see [`nightloom_core::ImageInput`].
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn send(
    app: AppHandle,
    state: State<'_, AppState>,
    power: State<'_, power::Holder>,
    text: String,
    images: Option<Vec<ImageInput>>,
    documents: Option<Vec<DocumentInput>>,
    stop_key: Option<String>,
    // Said aloud in the phone's voice mode (item 246 wave 3, 3C): recorded
    // `spoken`, and the sidecar carries the "answer for the ear" note.
    spoken: Option<bool>,
) -> Result<TurnOutcome, String> {
    // The chat this message was typed into, read once, as `send_agent`
    // does since A3 (A4 review, 2026-09-29): ~~`lock_or_start`, reading
    // the focus after the awaits below~~ — a provider turn can run off
    // screen since A4, and a chat opened in that gap got this message.
    let target = state.chats.target();
    // The engine out of its lock (backlog 159, A4): nothing else waits on
    // this turn for it.
    let chat = state
        .chat
        .lock()
        .await
        .clone()
        .ok_or_else(|| "not connected".to_string())?;
    // One provider turn at a time, refused in words — before a New chat's
    // log is made for a turn that cannot run.
    let one = ProviderTurn::claim(&state.gate.turn, PROVIDER_TURN_BUSY)?;
    // The Mac stays awake for the turn (nightshift backlog 101): held to
    // the end of this function, whichever way it ends.
    let _awake = power.acquire();

    let log_dir = state.log_dir().await;
    let pending = *state.pending_mode.lock().await;
    let pending_kind = *state.pending_kind.lock().await;
    let (mut held, _) = state
        .chats
        .lock_or_start_at(&target, pending, pending_kind, &log_dir)
        .await?;
    let session: &mut Session = &mut held;
    state.chats.mark_turn(&session.id);
    let chat_id = session.id.clone();
    // The chat's id as the turn starts, as the agent engine sends it
    // (nightshift backlog 211): a New chat's sidebar row appears now, not
    // when the turn ends. An ephemeral chat has no row to show.
    if session.log_path().is_some() {
        let _ = app.emit("turn-chat", session.id.clone());
    }

    let cancel = CancellationToken::new();
    *state.cancel.lock().unwrap() = cancel.clone();
    // Its chat and its own token, for its prompts (A4 review).
    one.name(&chat_id, &cancel);
    // Stop by chat and by the window's turn key, as `send_agent` (A4): the
    // turn can run off screen now, and a Stop must name it.
    let _stop = TurnStop::register(&state.turn_cancels, &chat_id, &cancel);
    let _stop_key = stop_key
        .as_deref()
        .map(|k| TurnStop::register(&state.turn_cancels, k, &cancel));
    if let Some(k) = &stop_key
        && take_early_stop(&state.early_stops, k)
    {
        cancel.cancel();
    }

    // Each event names its chat (A4), as the agent engine's do: the window
    // routes a turn running off screen to its own tab.
    let mut on_event = |e: TurnEvent| {
        let _ = app.emit("turn-event", ChatEvent::new(&chat_id, &e));
    };
    let input = TurnInput {
        text,
        images: images.unwrap_or_default(),
        documents: documents.unwrap_or_default(),
    };
    let sealed_before = session.write_failure().is_some();
    let outcome = if spoken == Some(true) {
        chat.run_spoken_turn(session, input, &cancel, &mut on_event)
            .await
    } else {
        chat.run_turn(session, input, &cancel, &mut on_event).await
    };
    // On the transition only, which needs no flag to remember: a log seals
    // once, and a turn that sealed it looks from here exactly like one that
    // did not. There is no stderr behind this window for the notice to go to,
    // and a chat that stopped being saved goes on answering as if it were.
    if !sealed_before && let Some(failure) = session.write_failure() {
        let _ = app.emit("turn-notice", failure.summary());
    }
    outcome.map_err(|e| e.to_string())
}

/// What one agent turn spent and where it went.
///
/// Separate from [`TurnOutcome`] because almost none of it is the same
/// question. A provider turn's outcome is about the request; this is about a
/// subscription — which plan window the turn came out of, and what the same
/// turn would have cost on the API, which is worth showing precisely because
/// it is the number *not* being charged.
#[derive(Serialize)]
pub(crate) struct AgentTurn {
    /// The model the CLI resolved to, and its window if the table knows it.
    /// Reported rather than guessed at connect: `sonnet` is an alias, and
    /// only the CLI can say which snapshot it means today.
    model: Option<String>,
    context_limit: Option<u64>,
    /// The CLI's own client-side estimate, and **not** a bill.
    cost_usd: Option<f64>,
    /// Assistant turns the CLI took internally, tool rounds included.
    rounds: Option<u32>,
    /// The plan window. Present only on an OAuth run, which makes it the one
    /// honest signal that this turn was billed to the plan and not to a key.
    plan: Option<nightloom_service::agent::RateLimitInfo>,
    /// The usage limit that stopped the turn (nightshift backlog 164):
    /// the transcript marks the turn *paused by the limit* and offers a
    /// Resume that runs after `resets_at`. `None` on every other end.
    limit: Option<nightloom_service::agent::LimitHit>,
    notices: Vec<String>,
    is_error: bool,
    /// Folders outside every tree the chat may see that the CLI refused
    /// a read in this turn (nightshift backlog 143, pass 2), each once —
    /// the rail offers each for a grant, for the chat or the project.
    refused: Vec<String>,
    /// The rail's folder list, refreshed, when the approval card granted
    /// a folder this turn; absent otherwise (the connect's list stands).
    folders: Option<Vec<FolderInfo>>,
    /// The ids of the messages he sent mid-turn that the turn took
    /// (backlog 328); any other he sent is still his queue's.
    delivered: Vec<String>,
}

/// Run one user turn on the agent engine, streaming the same `turn-event`s
/// the provider path does.
///
/// The turn is recorded into the session log in the ordinary shape — see
/// [`Recorder`] for why, and for the pairing guarantee that keeps the log
/// replayable if the rail is later switched back to a provider. What the log
/// is *not* is the thing the next turn replays: that is the agent's own
/// session, resumed by the id recorded alongside.
///
/// `images` and `documents` are the same base64 payloads `send` takes, and
/// they land in the log the same way — the user event carries them verbatim,
/// so a chat that started on this engine projects onto a provider request
/// with its attachments intact if the rail is switched. How they reach the
/// CLI is the agent's business (`ClaudeCodeAgent::run_turn`: a stdin line
/// rather than argv, for that one turn).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn send_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    power: State<'_, power::Holder>,
    holds: State<'_, prompt_hold::Pending>,
    text: String,
    images: Option<Vec<ImageInput>>,
    documents: Option<Vec<DocumentInput>>,
    council: Option<nightloom_service::council::CouncilRequest>,
    stop_key: Option<String>,
    // Said aloud in the phone's voice mode (item 246 wave 3, 3C): the log
    // keeps his words marked `spoken`; the CLI gets them with the note.
    spoken: Option<bool>,
    // Files neither an image, a PDF nor text (nightshift item 277, layer
    // 3): copied into the chat's own folder under the workspace, and the
    // message names where, for the model to open with its tools.
    files: Option<Vec<nightloom_service::attach::FileInput>>,
    // A queued message sent in the background at its chat's own turn's
    // end (nightshift blocker 1467): the chat it was queued in and that
    // chat's project. That chat or nothing — never the focus.
    chat: Option<String>,
    project: Option<String>,
) -> Result<AgentTurn, String> {
    // The message's timing line (nightshift item 256): begun here, before
    // any lock, under the window's name for the turn — its Send, call and
    // first-paint marks arrive by `turn_timing_window`.
    let timing = nightloom_service::turn_timing::TurnTiming::begin(
        nightloom_service::turn_timing::DESKTOP,
        stop_key.clone(),
        nightloom_service::turn_timing::log_path(),
    );
    let _timing_end = timing.end_guard();
    if let Some(c) = &council {
        c.validate().map_err(|e| e.to_string())?;
    }
    // The chat this message was typed into, read once (backlog 159, A3;
    // A2 review finding 2): the agent and the log below are both its,
    // however fast he switches chats meanwhile. ~~`lock_agent` and then
    // `lock_or_start`, each reading the focus afresh~~.
    let target = match &chat {
        // Held, or read now from its own project's folder (backlog 535: a
        // scheduled message goes into its chat whatever is open).
        Some(id) => chat_target(&state, id, project.as_deref()).await?,
        None => state.chats.target(),
    };
    let active_project = state
        .workspaces
        .lock()
        .await
        .active
        .as_ref()
        .map(|p| p.id.clone());
    let mut agent_guard = match &chat {
        // Its own agent, built for its own project (1467); a new one from
        // the rail's spec only when that spec is its project's.
        Some(id) => match state.agents.existing(id) {
            Some(slot) => agents::Guard::new(slot.lock_owned().await),
            // The spec kept for it when something was scheduled in it
            // (backlog 535): its own project's, whatever is open now.
            None if state.agents.reserved(id) => {
                let resume = target.lock().await.as_ref().and_then(resume_of);
                match state.agents.make_reserved(id, resume) {
                    Some(slot) => agents::Guard::new(slot.lock_owned().await),
                    None => agents::Guard::none(),
                }
            }
            None if project == active_project => lock_agent_at(&state, &target).await,
            None => {
                return Err("that chat's project is not open and it has no agent now — its message stays queued there".to_string());
            }
        },
        None => lock_agent_at(&state, &target).await,
    };
    // Its slot, for New chat's first turn to hand to the chat it makes.
    let agent_slot = agent_guard.is_some().then(|| agent_guard.slot().clone());
    let agent = agent_guard
        .as_mut()
        .ok_or_else(|| "not connected".to_string())?;
    // Awake for the whole turn, every resume of a deferred call included
    // (nightshift backlog 101); the guard drops with the function.
    let _awake = power.acquire();

    let log_dir = state.log_dir().await;
    // The project the turn runs in (backlog 159, A4; blocker 630: he may
    // switch projects while it runs off screen): a folder granted "for the
    // project" mid-turn goes to this one, not the one open by then.
    // A background send's is its chat's own (1467).
    let turn_project = if chat.is_some() {
        project.clone()
    } else {
        active_project
    };
    let pending = *state.pending_mode.lock().await;
    let pending_kind = *state.pending_kind.lock().await;
    // The open chat's own lock, held for the turn — no other chat's
    // (backlog 159, A1): he may open another chat meanwhile and every
    // command there answers at once.
    let (mut held, created) = state
        .chats
        .lock_or_start_at(&target, pending, pending_kind, &log_dir)
        .await?;
    let session: &mut Session = &mut held;
    if let Some(id) = &chat
        && session.id != *id
    {
        return Err("the chat named is not the chat locked — nothing was sent".to_string());
    }
    // A background send's log folder is its chat's, not the open project's (1467).
    let log_dir = match (&chat, session.log_path().and_then(|p| p.parent())) {
        (Some(_), Some(dir)) => dir.to_path_buf(),
        _ => log_dir,
    };
    state.chats.mark_turn(&session.id);
    // The chat this turn runs in, on every event it sends the window
    // (backlog 159, A2): two chats may be streaming at once.
    let chat_id = session.id.clone();
    // New chat's agent is the chat's it just made (backlog 159, A2).
    if created && let Some(slot) = &agent_slot {
        state.agents.adopt_new(&chat_id, slot);
    }
    // A connection built on New chat now belongs to the chat this turn
    // created; what it sends is that chat's hold (nightshift backlog 174).
    if created {
        holds
            .bind_new_chat(
                &session.id,
                (session.mode() != ChatMode::Ephemeral)
                    .then(|| prompt_hold::file_for(&log_dir, &session.id)),
            )
            .await;
    }
    // (Whether the log was sealed before the turn is sampled in
    // `run_agent_turn`, before its first append.)
    // The files go where the CLI can read them (its working directory),
    // under this chat's id, before the turn; the note is part of what he
    // sent, so the log and the transcript say where they went too.
    let mut text = text;
    let files = files.unwrap_or_default();
    if !files.is_empty() {
        let paths =
            nightloom_service::attach::save_chat_files(&agent.spec().workspace, &chat_id, &files)?;
        let note = nightloom_service::attach::files_note_for(&paths, &files);
        text = if text.trim().is_empty() {
            note
        } else {
            format!("{text}\n\n{note}")
        };
    }
    let input = TurnInput {
        text,
        images: images.unwrap_or_default(),
        documents: documents.unwrap_or_default(),
    };
    let cancel = CancellationToken::new();
    *state.cancel.lock().unwrap() = cancel.clone();
    // Stop by chat (backlog 159, A2); the entry goes when the turn does.
    let _stop = TurnStop::register(&state.turn_cancels, &chat_id, &cancel);
    // The window's own name for this turn (backlog 159, A3): a New chat's
    // first turn is stopped by it before its first event tells the window
    // the chat's id. A Stop that came before this line is applied now.
    let _stop_key = stop_key
        .as_deref()
        .map(|k| TurnStop::register(&state.turn_cancels, k, &cancel));
    if let Some(k) = &stop_key
        && take_early_stop(&state.early_stops, k)
    {
        cancel.cancel();
    }
    // What he sends while it runs goes into it (backlog 328).
    let inbox = agent.inbox();
    let _inbox = InboxReg::register(
        &state.inboxes,
        std::iter::once(chat_id.clone())
            .chain(stop_key.clone())
            .collect(),
        &inbox,
    );

    // The Ask position's files live beside the chat's log, per chat
    // (`agent::ask`): `<log dir>/ask/<chat id>/`. An ephemeral chat has no
    // log and no Ask (`AgentSpec::apply_mode` drops it), so nothing to
    // point at is the expected case there. Pointed *before* the council's
    // seats since 2026-09-22 (nightshift backlog 165, pass 2): the seats
    // start the message's budget ledger in this directory, so it has to
    // be the chat's — on a chat's first turn it was still empty here.
    let ask_dir = session
        .log_path()
        .and_then(|p| p.file_stem().map(|s| s.to_os_string()))
        .map(|stem| log_dir.join("ask").join(stem));
    // His message is going out: a keep-warm ping in flight stops (582).
    keep_warm::sent(&app, &session.id, ask_dir.as_deref());
    if let Some(dir) = &ask_dir {
        agent.set_ask_dir(dir.clone());
        // Claude's browser (nightshift item 508): the chat's Playwright
        // server attaches to the browser the app keeps for the chat.
        claude_browser::point(
            app.try_state::<claude_browser::Host>().as_deref(),
            agent,
            dir,
        );
        // The chat's id for the window's budget meter and stop card on a
        // chat's first turn, which it otherwise learns only at the end
        // (nightshift backlog 192; review 2026-09-23 finding 4).
        if let Some(id) = dir.file_name() {
            let _ = app.emit("turn-chat", id.to_string_lossy());
        }
        // The checkpoint and the fork's command line beside the brief
        // (nightshift backlog 104, pass 3), for a checkpoint helper this
        // turn may spawn.
        sync_checkpoint(session, agent, dir);
    }

    // The turn itself (nightshift item 268, step 1): the typed message on
    // the log, the council's seats, the stream rendered and recorded, the
    // Ask position's round trip and the log's end of turn now live in
    // `nightloom_service::agent_turn::run_agent_turn`, which the headless
    // `serve` runs too. What stays here is what only the window has: its
    // events, the project registry it holds, a chat name, the checkpoint,
    // and the rail's `AgentTurn`.
    // Subagent rules changed while the cache is warm (nightshift backlog
    // 293): the new rules ride after this message, on the wire only.
    let wire_note = holds.take_rules_note(&chat_id).await;
    // The chat's preview ended since the model last heard (item 445): it
    // is told now, on the wire, rather than by failing tool calls.
    let wire_note = preview::with_ended_note(&app, ask_dir.as_deref(), wire_note);
    let env = DesktopTurnEnv {
        app: &app,
        state: &state,
        turn_project,
        timing: timing.clone(),
    };
    let end = run_agent_turn(
        AgentTurnRun {
            agent,
            session,
            chat_id: &chat_id,
            input,
            spoken: spoken == Some(true),
            wire_note,
            council,
            cancel: &cancel,
            ask_dir: ask_dir.clone(),
            ask: &state.ask,
        },
        &env,
    )
    .await?;
    let (outcome, granted_any, context_limit) = match end {
        AgentTurnEnd::StoppedInCouncil => {
            return Ok(AgentTurn {
                model: None,
                context_limit: None,
                cost_usd: None,
                rounds: None,
                plan: None,
                limit: None,
                notices: vec!["stopped during the council's seats; no chair ran".into()],
                is_error: false,
                refused: Vec::new(),
                folders: None,
                delivered: Vec::new(),
            });
        }
        AgentTurnEnd::Done {
            outcome,
            granted_any,
            context_limit,
        } => (*outcome, granted_any, context_limit),
    };
    // Re-borrowed: the run took the guards' references for its length.
    let session: &mut Session = &mut held;
    let agent = agent_guard
        .as_mut()
        .ok_or_else(|| "not connected".to_string())?;
    // A name for the chat (nightshift backlog 209): spawned, never
    // awaited — the turn returns as it would without it.
    if !outcome.is_error && !cancel.is_cancelled() {
        chat_name::after_turn(&app, session, agent.spec());
    }
    // The checkpoint again, now that the CLI's file holds this turn
    // (backlog 104): the first exchange sets it, and its uuid resolves
    // here rather than at the next send, so the transcript's marker shows
    // at once.
    if let Some(dir) = &ask_dir {
        sync_checkpoint(session, agent, dir);
    }
    // Keep-warm starts again from this reply, if the chat's switch is on
    // (582) — not from a turn paused on his answer or by the plan's limit.
    if outcome.deferred.is_none() && outcome.limit.is_none() {
        keep_warm::replied(&app, session, agent.spec(), ask_dir.as_deref());
    }
    // The reads the CLI refused outside the trees (backlog 143, pass 2):
    // each folder once, for the rail to offer the grant after the fact.
    let trees = agent_trees(agent);
    let mut refused: Vec<String> = Vec::new();
    for d in &outcome.denied {
        if let Some(dir) = nightloom_service::agent::outside_folder(&d.tool_input, &trees) {
            let shown = dir.to_string_lossy().into_owned();
            if !refused.contains(&shown) {
                refused.push(shown);
            }
        }
    }
    // The rail's list, refreshed, when a grant landed this turn — it
    // otherwise reads it at connect, and no reconnect happened.
    let folders = if granted_any {
        let active = state.active().await;
        Some(
            extra_folders(active.as_ref(), Some(&*session))
                .iter()
                .map(|(path, source)| FolderInfo {
                    path: path.to_string_lossy().into_owned(),
                    source: (*source).into(),
                    alias: None,
                })
                .collect(),
        )
    } else {
        None
    };
    Ok(AgentTurn {
        model: outcome.model,
        context_limit,
        cost_usd: outcome.cost_usd,
        rounds: outcome.rounds,
        plan: outcome.rate_limit,
        limit: outcome.limit,
        notices: outcome.notices,
        is_error: outcome.is_error,
        refused,
        folders,
        delivered: inbox.taken(),
    })
}

/// The window's marks for one agent turn (nightshift item 256): when Send
/// was pressed, when `send_agent` was called, and the frame that drew the
/// first text, as epoch ms (`turnTiming.ts`). `key` is the turn's stop key.
/// The line in `turn-timing.log` is written with them.
#[tauri::command]
pub(crate) fn turn_timing_window(
    key: String,
    sent: u64,
    invoked: Option<u64>,
    painted: Option<u64>,
) {
    nightloom_service::turn_timing::window_marks(
        &key,
        nightloom_service::turn_timing::WindowMarks {
            sent,
            invoked,
            painted,
        },
    );
}

/// Start the open chat's next `claude` process while he types (nightshift
/// item 256, `agent::warm`): the CLI, his hooks and the MCP servers are
/// then done by Send, and the message's first text comes ~1 s sooner
/// (measured 2026-10-03). The window calls this as the composer gets a
/// draft, and as the open chat's turn ends (blocker 1240). Nothing waits: a chat whose turn or aside holds its agent, or
/// whose log is busy, is skipped (`false`), and the turn spawns as before.
/// The ask folder is pointed as `send_agent` points it, so the chat's
/// first message after opening it is the same command too.
#[tauri::command]
pub(crate) async fn prewarm_agent(
    state: State<'_, AppState>,
    browsers: State<'_, claude_browser::Host>,
) -> Result<bool, String> {
    let target = state.chats.target();
    let slot = match state.agents.slot(target.id()) {
        agents::Found::Off => return Ok(false),
        agents::Found::Ready(slot) => slot,
        agents::Found::Make => {
            // The chat's lock taken and let go before the agent's, as in
            // `lock_agent_at`.
            let resume = match target.try_lock() {
                Ok(open) => open.as_ref().and_then(resume_of),
                Err(_) => return Ok(false),
            };
            match state.agents.make(target.id(), resume) {
                Some(slot) => slot,
                None => return Ok(false),
            }
        }
    };
    let Ok(mut agent) = slot.try_lock() else {
        return Ok(false);
    };
    let log_dir = state.log_dir().await;
    let ask_dir = match target.try_lock() {
        Ok(open) => open
            .as_ref()
            .and_then(|s| s.log_path())
            .and_then(|p| p.file_stem().map(|s| s.to_os_string()))
            .map(|stem| log_dir.join("ask").join(stem)),
        Err(_) => return Ok(false),
    };
    if let Some(dir) = ask_dir {
        let spec = agent.spec();
        let pointed = spec.ask.as_ref().is_none_or(|a| a.dir == dir)
            && spec.brief.as_ref().is_none_or(|b| b.dir == dir)
            && spec.playwright.as_ref().is_none_or(|p| p.dir == dir);
        if !pointed {
            agent.set_ask_dir(dir.clone());
        }
        // As `send_agent` points it (item 508), so the warm process is
        // the same command the turn would spawn.
        claude_browser::point(Some(&*browsers), &mut agent, &dir);
    }
    agent.prewarm().map_err(|e| e.to_string())
}

/// What [`run_agent_turn`] needs of the window (item 268, step 1): its
/// events, and the project registry a folder granted "for the project"
/// is kept in — the turn's own project (backlog 159, A4), which may no
/// longer be the open one.
pub(crate) struct DesktopTurnEnv<'a> {
    app: &'a AppHandle,
    state: &'a AppState,
    turn_project: Option<String>,
    /// Begun at `send_agent`'s first line (item 256).
    timing: Arc<nightloom_service::turn_timing::TurnTiming>,
}

#[async_trait::async_trait]
impl TurnEnv for DesktopTurnEnv<'_> {
    fn event(&self, chat: &str, event: &TurnEvent) {
        let _ = self.app.emit("turn-event", ChatEvent::new(chat, event));
    }

    fn notice(&self, text: String) {
        let _ = self.app.emit("turn-notice", text);
    }

    fn approval(&self, prompt: &ApprovalPrompt<'_>) {
        let _ = self.app.emit("tool-approval", prompt);
    }

    fn timing(&self) -> Option<Arc<nightloom_service::turn_timing::TurnTiming>> {
        Some(self.timing.clone())
    }

    async fn grant_to_project(&self, dir: &Path) -> ProjectGrant {
        let mut guard = self.state.workspaces.lock().await;
        let written = self
            .turn_project
            .as_deref()
            .and_then(|id| guard.registry.find(id).cloned())
            .map(|p| {
                let mut list = p.extra_folders.clone();
                list.push(dir.to_path_buf());
                guard.registry.set_extra_folders(&p.id, list)
            });
        match written {
            Some(Ok(project)) => {
                if guard.active.as_ref().is_some_and(|a| a.id == project.id) {
                    guard.active = Some(project);
                }
                ProjectGrant::Kept
            }
            Some(Err(e)) => ProjectGrant::Failed(e),
            // No project to keep it: the chat keeps it instead, which is
            // the nearest thing to what was asked and still on a log.
            None => ProjectGrant::NoProject,
        }
    }
}

/// Compact the active session: earlier turns are superseded by a
/// model-written summary (recorded as a session event; the log keeps the
/// full history). Cancellable via `cancel`, which leaves the session
/// unchanged.
#[tauri::command]
pub(crate) async fn compact(
    state: State<'_, AppState>,
    power: State<'_, power::Holder>,
) -> Result<CompactOutcome, String> {
    not_in_agent_mode(&state, "compact").await?;
    // Out of its lock (A4), as `send`.
    let chat = state
        .chat
        .lock()
        .await
        .clone()
        .ok_or_else(|| "not connected".to_string())?;
    // Not beside another chat's provider turn (A4 review, 2026-09-29):
    // it would take over the one `AppState::cancel`, and its Stop (which
    // names no chat) would refuse that turn's open prompts. Before A4 it
    // waited for the turn on the engine's lock; now it says so.
    let _one = ProviderTurn::claim(
        &state.gate.turn,
        "a turn is running in another chat — compact this one when it ends",
    )?;
    // A compaction is a model call too (nightshift backlog 101).
    let _awake = power.acquire();
    let mut session_guard = state.chats.lock_focused().await;
    let session = session_guard
        .as_mut()
        .ok_or_else(|| "no active session".to_string())?;

    let cancel = CancellationToken::new();
    *state.cancel.lock().unwrap() = cancel.clone();
    chat.compact(session, &cancel)
        .await
        .map_err(|e| e.to_string())
}

/// Interrupt the in-flight turn or compaction, if any.
///
/// `chat` (backlog 159, A2): stop that chat's agent turn and nothing else
/// — two chats may be running. Without it, the latest turn (the phone's
/// Stop, a compaction, the provider engine), as before.
#[tauri::command]
pub(crate) fn cancel(state: State<'_, AppState>, chat: Option<String>) {
    if let Some(chat) = chat {
        let (token, others) = {
            let map = state.turn_cancels.lock().unwrap_or_else(|p| p.into_inner());
            let token = map.get(&chat).cloned();
            // A turn key with no turn registered yet (backlog 159, A3): the
            // turn has not reached its registration — a New chat's first
            // turn stopped at once. Held for it, and never the fallthrough
            // below, which stops whichever turn registered last: another
            // chat's. Held *under the map's lock* (A3 review, 2026-09-25):
            // `send_agent` registers the key and then takes a held Stop,
            // so a Stop checked before the registration and held after
            // the take was lost.
            if token.is_none() && is_turn_key(&chat) {
                hold_early_stop(&state.early_stops, &chat);
                return;
            }
            (token, !map.is_empty())
        };
        if let Some(token) = token {
            // The turn refuses its own deferred call and lets go of it
            // (`send_agent`); another chat's prompt stays.
            token.cancel();
            return;
        }
        // The named chat has no turn registered (it just ended, or has not
        // registered yet) while another chat's runs: the fallthrough below
        // would stop *that* turn — `state.cancel` is the latest turn's —
        // and let go of its prompts (review 2026-09-25, finding 1).
        if others {
            return;
        }
    }
    state.cancel.lock().unwrap().cancel();
    state
        .gate
        .deny_all("the turn was interrupted before this was approved");
    // A deferred call's wait is raced against the token above, and the
    // turn refuses the call on disk itself (`send_agent`); this only lets
    // go of the receiver so nothing is left keyed by a dead call.
    state.ask.abandon_all();
}

/// Answer one `tool-approval` prompt.
///
/// `decision` is "allow", "always" or "deny"; a `reason` on a denial is
/// handed to the model, which is the point — it is what lets it try something
/// else instead of repeating the same call.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn approve_call(
    state: State<'_, AppState>,
    id: String,
    name: String,
    decision: String,
    reason: Option<String>,
    answer: Option<serde_json::Value>,
    then: Option<String>,
    grant_dir: Option<String>,
    grant_scope: Option<String>,
    reply: Option<String>,
    reply_id: Option<String>,
) -> Result<(), String> {
    // A call the CLI deferred (nightshift backlog 084) is answered on its
    // own gate, and "always" there is a rule for this chat, not the
    // process-wide policy: `agent::ask::Answer::AllowForChat`. `answer` is
    // the `updatedInput` a question or a plan sends back with an allow;
    // `then` is the plan card's pick, `ask` or `auto` (backlog 085);
    // `grant_dir` and `grant_scope` (`chat` or `project`) are the card's
    // *Allow, and let … see this folder* on a call outside the trees
    // (backlog 143, pass 2) — the turn takes the grant from the answer.
    if state.ask.has(&id) {
        use nightloom_service::agent::{Answer, FolderGrant, GrantScope, PlanThen};
        let grant = match (
            grant_dir,
            grant_scope.as_deref().and_then(GrantScope::parse),
        ) {
            (Some(dir), Some(scope)) if !dir.trim().is_empty() => Some(FolderGrant {
                dir: PathBuf::from(dir.trim()),
                scope,
            }),
            _ => None,
        };
        let answer = match decision.as_str() {
            "allow" => Answer::Allow {
                updated_input: answer,
                plan_then: then.as_deref().and_then(PlanThen::parse),
                grant,
            },
            "always" => Answer::AllowForChat {
                updated_input: answer,
            },
            // His message in place of an answer (nightshift item 522): the
            // refusal carries his words, and the turn reports the message
            // delivered under `reply_id`, the window's id for its queued row.
            "deny" if reply.as_deref().is_some_and(|t| !t.trim().is_empty()) => Answer::Reply {
                id: reply_id.filter(|i| !i.trim().is_empty()),
                text: reply.unwrap_or_default(),
            },
            "deny" => Answer::Deny {
                reason: reason
                    .filter(|r| !r.trim().is_empty())
                    .unwrap_or_else(|| "the user declined this call".into()),
            },
            other => return Err(format!("unknown decision: {other}")),
        };
        // Nothing took it (item 522): the turn let go of the call between
        // the check above and here. Said, so the window can put the card
        // back or say the turn is over — never a card that silently left.
        if !state.ask.answer(&id, answer) {
            return Err("that prompt is no longer waiting: its turn has ended".into());
        }
        return Ok(());
    }
    // A reply to a prompt nothing is waiting on must not be dropped as a
    // refusal of some other engine's call: the window keeps the message.
    if reply.is_some() {
        return Err("that prompt is no longer waiting: its turn has ended".into());
    }
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
