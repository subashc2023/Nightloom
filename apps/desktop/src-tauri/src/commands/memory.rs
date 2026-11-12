//! Memory commands: the dream, capture and the memory centre (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// How many observations await the next dream — the badge over the Dream
/// button. Cheap on purpose: one file read, no locks, no model, so the UI
/// can ask after every turn.
#[tauri::command]
pub(crate) async fn dream_status() -> Result<usize, String> {
    Ok(project::config_dir()
        .map(|c| nightloom_service::observe::pending_count_in(&c))
        .unwrap_or(0))
}

/// What one dream did, flattened for the UI. `git` is a finished sentence
/// rather than an enum, because the frontend has nothing to add to it; with
/// the project layer it is one clause per folder the pass touched, joined.
/// `filed` is the split by target in the order the turns ran, projects
/// first and the vault last, for the toast's "N into Lanternfish, M into
/// the vault".
#[derive(Serialize)]
pub(crate) struct DreamReport {
    consolidated: usize,
    filed: Vec<FiledReport>,
    remaining: usize,
    interrupted: bool,
    git: String,
    /// "proposed a change to Lanternfish's instructions …", the service's
    /// own sentence (`dream::proposed_line`), or `None` when no turn
    /// proposed — a finished clause like `git`, for the same reason.
    proposed: Option<String>,
    cost_usd: Option<f64>,
    /// Lines the no-invention check took out and kept out (item 280).
    refused: usize,
}

/// One target's count. `project` is `None` for the vault.
#[derive(Serialize)]
pub(crate) struct FiledReport {
    project: Option<String>,
    consolidated: usize,
    /// The turn proposed a change to the target's always-loaded file.
    proposed: bool,
}

/// Run one consolidation pass over the observation log.
///
/// Takes its connection from the arguments rather than reusing the window's
/// `Chat`: a dream is its own job with its own system prompt and tool set
/// (see `service::dream::prepare`), and it works the same whichever engine
/// the window is on — which is why this is deliberately *not* gated by
/// `not_in_agent_mode`. Progress streams out as `dream-event`s, the same
/// `TurnEvent` shape `turn-event` carries but on its own channel, so a
/// running chat and a running dream cannot interleave in the transcript.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn dream(
    app: AppHandle,
    state: State<'_, AppState>,
    power: State<'_, power::Holder>,
    provider: String,
    model: Option<String>,
    base_url: Option<String>,
    thinking: Option<String>,
    binary: Option<String>,
    safe_mode: Option<bool>,
) -> Result<DreamReport, String> {
    let Some(config) = project::config_dir() else {
        return Err("no user config directory — there is no observation log to consolidate".into());
    };
    let Some(vault) = nightloom_service::knowledge::vault_dir() else {
        return Err("no user config directory — there is no vault to consolidate into".into());
    };
    let Ok(_running) = state.dreaming.try_lock() else {
        return Err("a dream is already running".into());
    };
    // A dream runs with nobody at the keyboard by design; the Mac stays
    // awake for it (nightshift backlog 101).
    let _awake = power.acquire();
    // A first dream on a fresh install: an empty folder is a better start
    // than a pass that opens by erroring on list_dir.
    std::fs::create_dir_all(&vault).map_err(|e| e.to_string())?;

    let cancel = CancellationToken::new();
    *state.dream_cancel.lock().unwrap() = cancel.clone();
    let emitter = app.clone();
    let mut on_event = move |event: TurnEvent| {
        let _ = emitter.emit("dream-event", &event);
    };
    let outcome = match pass_engine(&provider)? {
        // The Claude Code engine (2026-09-16, nightshift backlog 070): the
        // rail's binary and safe mode, the Settings model alias, this
        // binary as the MCP server for `propose_instructions`, billed to
        // the subscription.
        PassEngine::Agent => {
            let pass = pass_spec(binary, model, safe_mode)?;
            nightloom_service::dream::run_on_agent(&pass, &vault, &config, &cancel, &mut on_event)
                .await?
        }
        PassEngine::Provider(kind) => {
            let thinking = match thinking {
                Some(s) => s.parse::<Thinking>()?,
                None => Thinking::Default,
            };
            let (provider, model) = nightloom_service::connect(
                kind,
                model,
                credentials::provider_key(kind),
                base_url,
                None,
            )
            .map_err(|e| e.to_string())?;
            let mut chat = Chat::new(provider, model);
            chat.thinking = thinking;
            chat.context_limit = nightloom_service::context_limit(kind, &chat.model);
            chat.price = nightloom_service::price(kind, &chat.model);
            // The pass prepares the chat itself, once per target (the vault,
            // each project's memory folder), so there is no `prepare` here.
            nightloom_service::dream::run(&mut chat, &vault, &config, &cancel, &mut on_event)
                .await?
        }
    }
    // Checked non-empty by the UI before offering the button; a race
    // with a CLI dream is the only way here, and "nothing left" is
    // its honest report.
    .ok_or_else(|| "nothing left to consolidate".to_string())?;
    Ok(DreamReport {
        consolidated: outcome.consolidated,
        filed: outcome
            .filed
            .iter()
            .map(|f| FiledReport {
                project: f.project.clone(),
                consolidated: f.consolidated,
                proposed: f.proposed,
            })
            .collect(),
        remaining: outcome.remaining,
        interrupted: outcome.interrupted,
        proposed: nightloom_service::dream::proposed_line(&outcome.filed),
        refused: outcome.refused,
        git: outcome
            .filed
            .iter()
            .map(|f| {
                let what = match &f.project {
                    Some(name) => format!("{name}'s .agents"),
                    None => "vault".to_string(),
                };
                dream_git_line(&what, &f.git_before, &f.git_after)
            })
            .collect::<Vec<_>>()
            .join("; "),
        cost_usd: outcome.cost_usd,
    })
}

/// One clause about rollback for one folder — the CLI's `print_git`,
/// phrased for a toast. `what` names the folder (the vault, or a project's
/// `.agents`); both snapshots ran on it, so `after` carries the story.
pub(crate) fn dream_git_line(
    what: &str,
    before: &nightloom_service::dream::GitNote,
    after: &nightloom_service::dream::GitNote,
) -> String {
    use nightloom_service::dream::GitNote;
    if let GitNote::Failed(e) = before
        && !matches!(after, GitNote::Failed(_))
    {
        return format!("pre-dream git snapshot of {what} failed: {e}");
    }
    // What the pre-dream snapshot committed was the user's own uncommitted
    // work — necessary, so that reverting the dream does not take an edit of
    // theirs with it, and worth saying rather than leaving to be found in
    // `git log`.
    let swept = match before {
        GitNote::Committed { paths, .. } if *paths > 0 => format!(
            ", {paths} uncommitted {what} file{} committed first so this pass reverts on its own",
            if *paths == 1 { " was" } else { "s were" }
        ),
        _ => String::new(),
    };
    // A folder with no history got one first (backlog 372) — said, not
    // left to be found in `git log`.
    let started = match before {
        GitNote::Initialised { hash } => {
            format!(" (it had no version history, so Nightloom started one first: {hash})")
        }
        _ => String::new(),
    };
    let line = match after {
        GitNote::Untouched => format!("{what} untouched"),
        GitNote::NotARepo => {
            format!("{what} is not in a git repository, so there is no rollback for it")
        }
        GitNote::Committed { hash, .. } if hash.is_empty() => format!("{what} committed{swept}"),
        GitNote::Committed { hash, .. } => format!("{what} committed ({hash}){swept}"),
        GitNote::Clean => format!("{what} unchanged"),
        GitNote::Initialised { hash } => format!("{what} version history started ({hash})"),
        GitNote::Failed(e) => format!("git snapshot of {what} failed: {e}"),
    };
    format!("{line}{started}")
}

/// Interrupt the in-flight dream, if any. Separate from `cancel` because a
/// dream is not a turn: the Stop button over the transcript must not kill a
/// consolidation, and stopping a consolidation must not kill the reply the
/// user is reading.
#[tauri::command]
pub(crate) fn cancel_dream(state: State<'_, AppState>) {
    state.dream_cancel.lock().unwrap().cancel();
}

/// How many session logs have bytes past their capture watermark — the
/// count on the Capture button. Directory scans only, no log opened, no
/// locks, so the UI can ask after every turn. The button is always shown:
/// the inbox count says nothing about what the logs hold, and the chat
/// open right now is always one of the unread.
#[tauri::command]
pub(crate) async fn capture_status() -> Result<usize, String> {
    let Some(config) = project::config_dir() else {
        return Ok(0);
    };
    blocking(move || Ok::<_, String>(nightloom_service::capture::pending_count_in(&config))).await
}

/// Milliseconds since the Mac last saw a key or the pointer — the HID
/// system's idle time, no permission needed — or `None` when it cannot be
/// read. The nightly pass waits for an idle Mac (nightshift item 278).
#[tauri::command]
pub(crate) async fn mac_idle_ms() -> Result<Option<i64>, String> {
    blocking(|| Ok::<_, String>(nightloom_service::agent::brief::mac_idle_ms())).await
}

/// What one capture did, flattened for the toast. `per_project` is the
/// split by source in the order the dirs were walked, "unfiled" for the
/// chats with no project.
#[derive(Serialize)]
pub(crate) struct CaptureReport {
    observations: usize,
    logs_read: usize,
    skipped: usize,
    /// Lines the no-invention check refused twice and dropped (item 280).
    refused: usize,
    deferred: usize,
    remaining: usize,
    /// Incognito chats seen and deliberately not read (2026-09-15).
    incognito: usize,
    per_project: Vec<CapturedReport>,
    interrupted: bool,
    cost_usd: Option<f64>,
}

#[derive(Serialize)]
pub(crate) struct CapturedReport {
    project: String,
    observations: usize,
}

/// Run one capture pass over the session logs.
///
/// The dream's twin: its own job with its own system prompt and no tools
/// (see `service::capture::prepare`), connected from the arguments rather
/// than the window's `Chat`, and working the same whichever engine the
/// window is on. It shares the dream's `dreaming` mutex rather than
/// having its own, because the two are one pipeline — capture fills the
/// inbox the dream drains — and a dream started while a capture is
/// appending would read half of what the capture wrote. The refusal is
/// the same sentence a second dream gets. Progress streams as
/// `capture-event`s on their own channel.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn capture(
    app: AppHandle,
    state: State<'_, AppState>,
    power: State<'_, power::Holder>,
    provider: String,
    model: Option<String>,
    base_url: Option<String>,
    thinking: Option<String>,
    binary: Option<String>,
    safe_mode: Option<bool>,
    // "Save memory from this chat" (backlog 371): that one log, by id,
    // whatever the cutoff; absent, the whole pass.
    chat: Option<String>,
) -> Result<CaptureReport, String> {
    let Some(config) = project::config_dir() else {
        return Err("no user config directory — there are no session logs to read".into());
    };
    let Ok(_running) = state.dreaming.try_lock() else {
        return Err("a dream or a capture is already running".into());
    };
    // Same as the dream (nightshift backlog 101).
    let _awake = power.acquire();

    // The same token the dream swaps in: the two never run at once (the
    // mutex above), so one Stop reaches whichever is running.
    let cancel = CancellationToken::new();
    *state.dream_cancel.lock().unwrap() = cancel.clone();
    let emitter = app.clone();
    let mut on_event = move |event: TurnEvent| {
        let _ = emitter.emit("capture-event", &event);
    };
    let chat_id = chat;
    let outcome = match pass_engine(&provider)? {
        // The Claude Code engine (2026-09-16): one no-tool `claude -p` per
        // batch, the reply parsed as on the other engine.
        PassEngine::Agent => {
            let pass = pass_spec(binary, model, safe_mode)?;
            match &chat_id {
                Some(id) => {
                    nightloom_service::capture::run_chat_on_agent(
                        &pass,
                        &config,
                        id,
                        &cancel,
                        &mut on_event,
                    )
                    .await?
                }
                None => {
                    nightloom_service::capture::run_on_agent(
                        &pass,
                        &config,
                        false,
                        &cancel,
                        &mut on_event,
                    )
                    .await?
                }
            }
        }
        PassEngine::Provider(kind) => {
            let thinking = match thinking {
                Some(s) => s.parse::<Thinking>()?,
                None => Thinking::Default,
            };
            let (provider, model) = nightloom_service::connect(
                kind,
                model,
                credentials::provider_key(kind),
                base_url,
                None,
            )
            .map_err(|e| e.to_string())?;
            let mut chat = Chat::new(provider, model);
            chat.thinking = thinking;
            chat.context_limit = nightloom_service::context_limit(kind, &chat.model);
            chat.price = nightloom_service::price(kind, &chat.model);
            match &chat_id {
                Some(id) => {
                    nightloom_service::capture::run_chat(
                        &mut chat,
                        &config,
                        id,
                        &cancel,
                        &mut on_event,
                    )
                    .await?
                }
                None => {
                    nightloom_service::capture::run(
                        &mut chat,
                        &config,
                        false,
                        &cancel,
                        &mut on_event,
                    )
                    .await?
                }
            }
        }
    }
    .ok_or_else(|| {
        if chat_id.is_some() {
            "nothing new in this chat to save — it was saved to memory already".to_string()
        } else {
            "nothing left to capture".to_string()
        }
    })?;
    Ok(CaptureReport {
        observations: outcome.observations,
        logs_read: outcome.logs_read,
        skipped: outcome.skipped,
        refused: outcome.refused,
        deferred: outcome.deferred,
        incognito: outcome.incognito,
        remaining: outcome.remaining,
        per_project: outcome
            .per_project
            .iter()
            .map(|(project, observations)| CapturedReport {
                project: project.clone(),
                observations: *observations,
            })
            .collect(),
        interrupted: outcome.interrupted,
        cost_usd: outcome.cost_usd,
    })
}

/// Interrupt the in-flight capture, if any. The same token as the dream's
/// (they never overlap); a command of its own so the frontend's name says
/// what it stops.
#[tauri::command]
pub(crate) fn cancel_capture(state: State<'_, AppState>) {
    state.dream_cancel.lock().unwrap().cancel();
}

// ---- the notification centre and the daily pass (nightshift backlog 069) --

/// Every pending proposal, the user's and every project's — the bell's
/// first kind. `list_proposals` above answers for the open project only;
/// a daily pass dreams for every project with observations, so the centre
/// asks across the registry. Reads directories, no locks.
#[tauri::command]
pub(crate) async fn centre_proposals()
-> Result<Vec<nightloom_service::centre::ProposalNotice>, String> {
    let Some(config) = project::config_dir() else {
        return Ok(Vec::new());
    };
    blocking(move || Ok::<_, String>(nightloom_service::centre::proposals_in(&config))).await
}

/// The dream's own commits — the bell's "notes changed by a dream": the
/// newest `limit` per folder (the vault, each project's `.agents`), with
/// the files each touched. `git log` per folder, so a few hundred
/// milliseconds at most; asked after a pass and when the panel opens.
#[tauri::command]
pub(crate) async fn centre_dream_commits(
    limit: Option<usize>,
) -> Result<Vec<nightloom_service::centre::DreamCommit>, String> {
    let Some(config) = project::config_dir() else {
        return Ok(Vec::new());
    };
    let Some(vault) = nightloom_service::knowledge::vault_dir() else {
        return Ok(Vec::new());
    };
    let limit = limit.unwrap_or(10).clamp(1, 50);
    blocking(move || {
        Ok::<_, String>(nightloom_service::centre::dream_commits_in(
            &config, &vault, limit,
        ))
    })
    .await
}

/// One dream commit's patch, whole or for one file — what the panel's
/// `DiffView` shows before a Revert.
#[tauri::command]
pub(crate) async fn centre_dream_diff(
    repo: String,
    hash: String,
    file: Option<String>,
) -> Result<String, String> {
    blocking(move || {
        let repo = dream_repo(&repo)?;
        nightloom_service::centre::dream_diff(&repo, &hash, file.as_deref())
    })
    .await
}

/// The dream's writes to an `AGENTS.md` that no git commit carries
/// (backlog 344) — the user's own file, a project outside git — listed
/// beside the dream commits as *Show the diff*.
#[tauri::command]
pub(crate) async fn centre_applied(
    limit: Option<usize>,
) -> Result<Vec<nightloom_service::centre::AppliedNotice>, String> {
    let Some(config) = project::config_dir() else {
        return Ok(Vec::new());
    };
    let limit = limit.unwrap_or(10).clamp(1, 50);
    blocking(move || Ok::<_, String>(nightloom_service::centre::applied_in(&config, limit))).await
}

/// One such write's diff: the copy kept from before against the text
/// written. `project` is `None` for the user's file.
#[tauri::command]
pub(crate) async fn centre_applied_diff(
    project: Option<String>,
    id: String,
) -> Result<String, String> {
    let config = project::config_dir().ok_or("no config folder")?;
    blocking(move || nightloom_service::centre::applied_diff(&config, project.as_deref(), &id))
        .await
}

/// Put the file back from the copy kept before the dream wrote it. The
/// frontend confirms first; the sentence returned is the toast.
#[tauri::command]
pub(crate) async fn centre_revert_applied(
    project: Option<String>,
    id: String,
) -> Result<String, String> {
    let config = project::config_dir().ok_or("no config folder")?;
    blocking(move || nightloom_service::centre::revert_applied(&config, project.as_deref(), &id))
        .await
}

/// The repository a `repo` from the window may name: the vault or a
/// registered project's folder, as `centre::dream_repo` resolves it —
/// never any other repository on the machine (review 2026-09-17 FB3,
/// backlog 133).
pub(crate) fn dream_repo(repo: &str) -> Result<PathBuf, String> {
    let config = project::config_dir().ok_or("no config folder")?;
    let vault = nightloom_service::knowledge::vault_dir().ok_or("no vault folder")?;
    nightloom_service::centre::dream_repo(&config, &vault, Path::new(repo))
}

/// Put one file back as it was before a dream's commit, committed. The
/// frontend confirms first; the sentence returned is the toast.
#[tauri::command]
pub(crate) async fn centre_revert_file(
    repo: String,
    hash: String,
    file: String,
) -> Result<String, String> {
    blocking(move || {
        let repo = dream_repo(&repo)?;
        nightloom_service::centre::revert_dream_file(&repo, &hash, &file)
    })
    .await
}

/// The tidy step (nightshift backlog 072) over the vault and every project's
/// memory folder: struck lines older than `days` (30 when absent) move to
/// `archive/struck/` and the move is committed where the folder is a
/// repository. `apply = false` is the dry run the panel's count comes from.
/// Shares the dream's lock — a tidy under a running dream would move lines
/// the pass is about to read.
#[tauri::command]
pub(crate) async fn tidy_memory(
    state: State<'_, AppState>,
    apply: bool,
    days: Option<i64>,
) -> Result<Vec<nightloom_service::dream::TidyOutcome>, String> {
    let Some(config) = project::config_dir() else {
        return Ok(Vec::new());
    };
    let Some(vault) = nightloom_service::knowledge::vault_dir() else {
        return Ok(Vec::new());
    };
    let Ok(_running) = state.dreaming.try_lock() else {
        return Err("a dream or a capture is already running".into());
    };
    let days = days.unwrap_or(nightloom_service::tidy::DEFAULT_DAYS).max(1);
    blocking(move || nightloom_service::dream::tidy_targets(&vault, &config, days, None, apply))
        .await
}
