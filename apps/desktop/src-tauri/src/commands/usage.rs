//! Usage commands: the ledger, budgets and turn caps, checkpoints, plan figures (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// What Claude Code has cost, from the user-global ledger under `~/.claude`
/// (nightshift backlog 045). Reads three files the collector there owns and
/// writes none; the shape is [`nightloom_service::usage::UsageSummary`],
/// which carries `available: false` and a reason rather than an error when
/// the collector has never run here, so Settings opens either way. On a
/// blocking thread because it reads and prices a whole CSV, small as it is.
#[tauri::command]
pub(crate) async fn usage_ledger() -> Result<nightloom_service::usage::UsageSummary, String> {
    tokio::task::spawn_blocking(nightloom_service::usage::summary)
        .await
        .map_err(|e| format!("reading the usage ledger failed: {e}"))
}

/// Run the usage collector once and hand back the fresh summary. The only
/// write to the ledger the app ever causes, and it is the collector's own.
#[tauri::command]
pub(crate) async fn refresh_usage_ledger() -> Result<nightloom_service::usage::UsageSummary, String>
{
    tokio::task::spawn_blocking(|| {
        nightloom_service::usage::refresh()?;
        Ok(nightloom_service::usage::summary())
    })
    .await
    .map_err(|e| format!("refreshing the usage ledger failed: {e}"))?
}

/// The plan's own five-hour and seven-day percentages, for the top bar of
/// a Claude Code chat (nightshift backlog 073). Read from the Claude
/// desktop app's sample file and the CLI's cache, whichever was sampled
/// more recently — `nightloom_service::plan_usage` says why both. Nothing
/// is estimated: a machine with neither file answers `source: "none"`.
/// The frontend asks at turn end and on connect, never on a timer faster
/// than the sample changes.
/// One row of Settings → Council's table (nightshift backlog 149, blocker
/// 244): a council turn as its chat's `<council>` record names it.
#[derive(Serialize)]
pub(crate) struct CouncilTurnRow {
    session: String,
    title: String,
    at: String,
    mode: nightloom_service::council::CouncilMode,
    seats: Vec<String>,
    tokens: u64,
    cost_usd: Option<f64>,
    shared_by_all: f64,
    fired: bool,
}

/// The recent council turns of this store's chats, newest first: the
/// newest `limit` records, read from the newest chats' logs on the
/// blocking pool (a council record is a block of a reply, so the logs
/// are opened; the listing alone cannot say which chats held one).
#[tauri::command]
pub(crate) async fn council_turns(
    state: State<'_, AppState>,
    limit: usize,
) -> Result<Vec<CouncilTurnRow>, String> {
    use nightloom_core::{ContentBlock, SessionEvent};
    use nightloom_service::council::parse_council_block;
    let dir = state.log_dir().await;
    blocking(move || -> Result<Vec<CouncilTurnRow>, String> {
        let mut rows = Vec::new();
        let list = store::list(&dir).map_err(|e| e.to_string())?;
        for summary in list.iter().take(200) {
            let Ok(session) = nightloom_core::Session::load(&summary.path) else {
                continue;
            };
            let title = summary.label(60);
            for e in session.events() {
                let SessionEvent::AssistantMessage { blocks, .. } = e else {
                    continue;
                };
                for b in blocks {
                    let ContentBlock::Text { text } = b else {
                        continue;
                    };
                    let Some(r) = parse_council_block(text) else {
                        continue;
                    };
                    let usage = r.total_usage();
                    rows.push(CouncilTurnRow {
                        session: summary.id.clone(),
                        title: title.clone(),
                        at: r.at.to_rfc3339(),
                        mode: r.mode,
                        seats: r.seats.iter().map(|s| s.model.clone()).collect(),
                        tokens: usage.input_tokens + usage.output_tokens,
                        cost_usd: r.total_cost(),
                        shared_by_all: r.overlap.shared_by_all,
                        fired: r.fired,
                    });
                }
            }
        }
        rows.sort_by(|a, b| b.at.cmp(&a.at));
        rows.truncate(limit.max(1));
        Ok(rows)
    })
    .await
}

/// What each provider says is left on its key (backlog 149, blocker 244):
/// OpenRouter's credits endpoint; the rest `not exposed`.
#[tauri::command]
pub(crate) async fn provider_credits()
-> Result<Vec<nightloom_service::credits::ProviderCredit>, String> {
    Ok(nightloom_service::credits::provider_credits().await)
}

/// The message's budget ledger for the live meter (nightshift backlog
/// 165, pass 2): `turn-budget.json` in the chat's ask directory, written
/// by the hook on every tool call. By session id rather than through the
/// session lock, which the running turn holds. `None` before a chat's
/// first turn or when the file is unreadable.
#[tauri::command]
pub(crate) async fn turn_budget(
    state: State<'_, AppState>,
    session: String,
) -> Result<Option<nightloom_service::agent::brief::TurnBudget>, String> {
    if session.is_empty() || session.contains('/') || session.contains("..") {
        return Ok(None);
    }
    let dir = state.log_dir().await.join("ask").join(session);
    tokio::task::spawn_blocking(move || nightloom_service::agent::brief::read_turn_budget(&dir))
        .await
        .map_err(|e| format!("reading the turn budget failed: {e}"))
}

/// The chat's ask directory by session id, as [`turn_budget`] finds it;
/// `None` for an id that is not a plain file stem.
pub(crate) async fn budget_dir(state: &State<'_, AppState>, session: &str) -> Option<PathBuf> {
    if session.is_empty() || session.contains('/') || session.contains("..") {
        return None;
    }
    Some(state.log_dir().await.join("ask").join(session))
}

/// The checkpoint helpers fork from (nightshift backlog 104, pass 3), kept
/// current before and after each turn of a chat: set automatically at the
/// end of the chat's first exchange when none is set (blocker 289), its
/// uuid read from the CLI's session file once that file holds the turn —
/// and again whenever the chat's CLI session changed (an edit fork, a
/// rewind) — and the fork's command line written beside it for the hook
/// (`agent::fork`). Best-effort: nothing here may fail a turn.
pub(crate) fn sync_checkpoint(session: &Session, agent: &ClaudeCodeAgent, dir: &Path) {
    use nightloom_service::agent::fork;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mut cp = match fork::read_checkpoint(dir) {
        Some(cp) => cp,
        None => match auto_checkpoint_index(session) {
            Some(index) => fork::Checkpoint {
                index,
                uuid: None,
                resolved_in: None,
                set_by: fork::CheckpointSetBy::Auto,
                at_ms: now,
            },
            None => return,
        },
    };
    let current = agent.spec().resume.clone();
    if cp.uuid.is_none() || cp.resolved_in != current {
        cp.uuid = current
            .as_deref()
            .and_then(|id| checkpoint_uuid(session, &agent.spec().workspace, id, cp.index));
        cp.resolved_in = cp.uuid.as_ref().and(current);
    }
    let _ = fork::write_checkpoint(dir, &cp);
    if let Some(spec) = agent.spec().fork_spec() {
        let _ = fork::write_fork_spec(dir, &spec);
    }
}

/// The automatic checkpoint (blocker 289): the reply that closes the
/// chat's first exchange — the end of its general context, the preamble
/// plus his opening brief and its answer. `None` until that reply exists.
pub(crate) fn auto_checkpoint_index(session: &Session) -> Option<usize> {
    let live = session.live_events();
    let first = live
        .iter()
        .position(|(_, e)| matches!(e, SessionEvent::UserMessage { .. }))?;
    live[first..]
        .iter()
        .find(|(_, e)| matches!(e, SessionEvent::AssistantMessage { .. }))
        .map(|(i, _)| *i)
}

/// The uuid a fork from the checkpoint at log `index` resumes at: the last
/// node of that exchange's turn in the CLI session `id`'s file, found the
/// way the edit code finds a turn (`turns_after` → `from_last`).
pub(crate) fn checkpoint_uuid(
    session: &Session,
    workspace: &Path,
    id: &str,
    index: usize,
) -> Option<String> {
    let from_last = turns_after(session, index).ok()?;
    let projects = cli_session::projects_dir()?;
    let path = cli_session::find(&projects, workspace, id).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    CliSession::parse(&text)
        .ok()?
        .turn_leaf_uuid(from_last)
        .ok()
}

/// The chat's checkpoint (backlog 104), for the transcript's marker.
#[tauri::command]
pub(crate) async fn checkpoint(
    state: State<'_, AppState>,
    session: String,
) -> Result<Option<nightloom_service::agent::fork::Checkpoint>, String> {
    let Some(dir) = budget_dir(&state, &session).await else {
        return Ok(None);
    };
    tokio::task::spawn_blocking(move || nightloom_service::agent::fork::read_checkpoint(&dir))
        .await
        .map_err(|e| format!("reading the checkpoint failed: {e}"))
}

/// "Fork from here" (backlog 104): helpers fork from the end of the
/// exchange the message at `index` belongs to. Written now; the uuid is
/// resolved at once when this is the open chat, else before its next turn.
#[tauri::command]
pub(crate) async fn set_checkpoint(
    state: State<'_, AppState>,
    session: String,
    index: usize,
) -> Result<nightloom_service::agent::fork::Checkpoint, String> {
    use nightloom_service::agent::fork;
    let dir = budget_dir(&state, &session)
        .await
        .ok_or_else(|| "no chat to set a checkpoint on".to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let cp = fork::Checkpoint {
        index,
        uuid: None,
        resolved_in: None,
        set_by: fork::CheckpointSetBy::User,
        at_ms: now,
    };
    fork::write_checkpoint(&dir, &cp).map_err(|e| format!("writing the checkpoint failed: {e}"))?;
    let (agent, open) = lock_agent_and_chat(&state).await;
    if let (Some(agent), Some(open)) = (agent.as_ref(), open.as_ref())
        && open
            .log_path()
            .and_then(|p| p.file_stem())
            .is_some_and(|s| s.to_string_lossy() == session)
    {
        sync_checkpoint(open, agent, &dir);
    }
    Ok(fork::read_checkpoint(&dir).unwrap_or(cp))
}

/// The window saw him in this chat (nightshift backlog 189): open in a
/// focused window, or (`input`) he just sent a message. The budget hook
/// holds a call past the stop line for his answer only when he is.
#[tauri::command]
pub(crate) async fn note_presence(
    state: State<'_, AppState>,
    session: String,
    input: Option<bool>,
) -> Result<(), String> {
    let Some(dir) = budget_dir(&state, &session).await else {
        return Ok(());
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    nightloom_service::agent::brief::note_presence(&dir, input.unwrap_or(false), now)
        .map_err(|e| format!("noting presence failed: {e}"))
}

/// His answer on the card at the 85 % stop line (backlog 189):
/// `continue` lets this message's calls through to the end of the turn,
/// `stop` refuses the held call as before. Since backlog 192 `continue`
/// covers the chat while he stays at the Mac, and `wrap` (with `text`,
/// the instruction) has the chat finish and write its hand-off now.
#[tauri::command]
pub(crate) async fn budget_override(
    state: State<'_, AppState>,
    session: String,
    decision: String,
    text: Option<String>,
) -> Result<(), String> {
    if !matches!(decision.as_str(), "continue" | "stop" | "wrap") {
        return Err(format!("unknown decision: {decision}"));
    }
    let dir = budget_dir(&state, &session)
        .await
        .ok_or_else(|| "no chat to answer for".to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    tokio::task::spawn_blocking(move || {
        nightloom_service::agent::brief::write_answer(&dir, &decision, text, now)
    })
    .await
    .map_err(|e| format!("writing the override failed: {e}"))?
}

/// His correction of the message's usage cap from the window (item 538,
/// the cap chip): a new cap (`cap_percent`, 1–100, of the 5-hour window),
/// a new mode (`finish_within` or `work_to_cap_then_continue`), both, or —
/// neither given — no cap at all for this message. It holds for the rest
/// of the message against the model's own `set_budget` calls. Returns the
/// ledger as it now stands (the same value `turn_budget` returns); an
/// error when the chat has no ledger yet or the mode is not one of the two.
#[tauri::command]
pub(crate) async fn set_turn_cap(
    state: State<'_, AppState>,
    session: String,
    cap_percent: Option<u8>,
    mode: Option<String>,
) -> Result<nightloom_service::agent::brief::TurnBudget, String> {
    use nightloom_service::agent::budget;
    let mode = match mode.as_deref() {
        None => None,
        Some(m) => Some(budget::BudgetMode::parse(m).ok_or_else(|| format!("unknown mode: {m}"))?),
    };
    if cap_percent.is_some_and(|p| !(1..=100).contains(&p)) {
        return Err("the cap is a percent from 1 to 100".into());
    }
    let dir = budget_dir(&state, &session)
        .await
        .ok_or_else(|| "no chat to set a cap for".to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    tokio::task::spawn_blocking(move || budget::correct(&dir, cap_percent, mode, now))
        .await
        .map_err(|e| format!("setting the cap failed: {e}"))?
}

#[tauri::command]
pub(crate) async fn plan_usage() -> Result<nightloom_service::plan_usage::PlanUsage, String> {
    tokio::task::spawn_blocking(|| observed(nightloom_service::plan_usage::read()))
        .await
        .map_err(|e| format!("reading the plan usage failed: {e}"))
}

/// The plan's per-model weeklies (item 569: /usage's "Weekly Fable"), from
/// the CLI cache.
#[tauri::command]
pub(crate) async fn plan_scoped_limits()
-> Result<nightloom_service::plan_usage::ScopedLimits, String> {
    tokio::task::spawn_blocking(nightloom_service::plan_usage::scoped_limits)
        .await
        .map_err(|e| format!("reading the scoped limits failed: {e}"))
}

/// A Claude Code chat's /usage "This session" figures (item 569): the
/// newest `cost-state` of its transcript and the split by subagent type.
/// `agent_session` is the chat's Claude Code session id; `earlier` the
/// sessions it ran on before — a rewind starts a new one — oldest first
/// (item 675): what those spent that the live one left behind stays in
/// the cost, so a rewind never lowers it.
#[tauri::command]
pub(crate) async fn session_figures(
    agent_session: String,
    earlier: Option<Vec<String>>,
) -> Result<nightloom_service::session_figures::SessionFigures, String> {
    tokio::task::spawn_blocking(move || {
        nightloom_service::session_figures::read_chat(
            &agent_session,
            earlier.as_deref().unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| format!("reading the chat's figures failed: {e}"))
}

/// A plan reading is also the end reading of any reply that finished
/// before its sample was taken (item 323, `turn_usage`).
pub(crate) fn observed(
    u: nightloom_service::plan_usage::PlanUsage,
) -> nightloom_service::plan_usage::PlanUsage {
    if let Some(r) = nightloom_service::turn_usage::Reading::from_plan(&u) {
        nightloom_service::turn_usage::reading(None, r);
    }
    u
}

/// The chat's per-reply share of the plan's windows (item 323): the lines
/// of `<log dir>/ask/<chat>/turn-usage.jsonl`, oldest first.
#[tauri::command]
pub(crate) async fn turn_usage(
    state: State<'_, AppState>,
    session: String,
) -> Result<Vec<nightloom_service::turn_usage::TurnUsageLine>, String> {
    if session.is_empty() || session.contains('/') || session.contains("..") {
        return Ok(Vec::new());
    }
    let dir = state.log_dir().await.join("ask").join(session);
    tokio::task::spawn_blocking(move || nightloom_service::turn_usage::read_lines(&dir))
        .await
        .map_err(|e| format!("reading the reply usage failed: {e}"))
}

/// The plan's figure refreshed through the CLI's print-mode `/usage` when
/// the files are over a minute old (nightshift backlog 166, blocker 264):
/// exact, zero tokens, ~12 s. The front end calls it every five minutes
/// while the Claude Code engine is connected.
///
/// `after_ms` (item 323 review): the reading taken at a reply's end — a
/// files' sample from before that moment does not count as fresh, so the
/// reading can close the reply's usage line.
#[tauri::command]
pub(crate) async fn plan_usage_refresh(
    after_ms: Option<i64>,
) -> Result<nightloom_service::plan_usage::PlanUsage, String> {
    tokio::task::spawn_blocking(move || {
        observed(nightloom_service::plan_usage::read_fresh_after(
            std::time::Duration::from_secs(60),
            after_ms,
        ))
    })
    .await
    .map_err(|e| format!("refreshing the plan usage failed: {e}"))
}
