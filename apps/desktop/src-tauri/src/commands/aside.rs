//! Aside commands: asking an aside question beside a chat, and cancelling one (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// An aside's answer (nightshift backlog 081): the model's text, what the
/// CLI estimated it would have cost, and nothing that touches the chat.
#[derive(Serialize)]
pub(crate) struct AsideResult {
    answer: String,
    /// The CLI's estimate of the API cost — not a bill under a subscription.
    /// What this answer itself added (item 675): the fork's process
    /// restores the chat's running cost, which the agent takes off.
    cost_usd: Option<f64>,
    /// The aside read the chat's prefix from cache: this many tokens.
    cache_read: u64,
    is_error: bool,
    notices: Vec<String>,
    /// The model the CLI resolved (backlog 283): the aside's answer is
    /// drawn as the chat's replies are, under the model's name.
    model: Option<String>,
    /// Summed over the answer's rounds, as `cache_read` is.
    input_tokens: u64,
    output_tokens: u64,
    /// The newest round's prompt plus its output (item 675): what the
    /// next follow-up carries. The sums above count the chat's prefix once
    /// per round, which an aside that reads before it answers has several
    /// of. `None` when no round reported.
    context_tokens: Option<u64>,
    /// When the aside's request went out, unix ms (item 677): its read of
    /// the chat's cache restarts the cache's hour from here.
    sent_ms: i64,
    /// The newest round's cache read (item 677): the share of the chat's
    /// prefix found warm, which `cache_read` (summed) overcounts.
    round_read: u64,
    /// The answer's share of the plan, estimated from `cost_usd` at the
    /// rates fitted over lone chat replies (item 674): an aside takes no
    /// readings of its own. `None` before the fit has enough replies.
    plan_est: Option<nightloom_service::turn_usage::Estimate>,
    /// The plan's usage limit stopped the answer (item 674): the shared
    /// transcript draws the chat's limit card under it, with Ask again.
    limit: Option<nightloom_service::agent::LimitHit>,
}

/// A piece of an aside's answer as it streams (nightshift backlog 128):
/// the card draws the text as it arrives, the way a reply's does, instead
/// of waiting for the whole of it. `seq` is the card's own number, so a
/// delta from an aside that was cancelled or replaced is dropped by the
/// window rather than typed into the next one.
#[derive(Serialize, Clone)]
pub(crate) struct AsideDelta {
    seq: u64,
    text: String,
}

/// The rest of an aside's stream (item 403, 2026-10-20): its thinking, a
/// redacted block, a call and its result, as `aside-turn-event`, so the
/// window draws an aside's turn with the chat's own pieces — the thinking
/// block and its arrival, the activity rows, the working moon. Text stays
/// on `aside-delta` (the phone's relay reads it, `remote.rs`).
#[derive(Serialize, Clone)]
pub(crate) struct AsideTurnEvent {
    seq: u64,
    event: TurnEvent,
}

/// Where an aside stands before its first event (item 404): `queued` once
/// it has waited [`ASIDE_QUEUED_AFTER`] for the chat's agent — the chat's
/// own turn holds it, and the aside runs after that turn ends — and
/// `running` once it has the agent. The window says which on the moon's
/// row instead of showing dots that say nothing.
#[derive(Serialize, Clone)]
pub(crate) struct AsidePhase {
    seq: u64,
    phase: &'static str,
}

/// How long an aside waits for the chat's agent before the window is told
/// it is queued: a free agent is taken in microseconds.
pub(crate) const ASIDE_QUEUED_AFTER: std::time::Duration = std::time::Duration::from_millis(250);

/// The part of an aside's turn the window draws besides its text.
pub(crate) fn aside_drawn(e: &TurnEvent) -> bool {
    matches!(
        e,
        TurnEvent::ThinkingDelta { .. }
            | TurnEvent::RedactedThinking
            | TurnEvent::ToolCall { .. }
            | TurnEvent::ToolResult { .. }
            | TurnEvent::ToolDenied { .. }
            // Item 649: an aside's running command passes its output too.
            | TurnEvent::ToolOutput { .. }
    )
}

/// The outcome an aside's timing line ends on (item 404): how it ended and
/// what the question carried — counts only, never names or words.
pub(crate) fn aside_outcome(end: &str, images: usize, documents: usize, files: usize) -> String {
    let mut out = end.to_string();
    for (n, one) in [(images, "image"), (documents, "document"), (files, "file")] {
        if n > 0 {
            out.push_str(&format!(", {n} {one}{}", if n == 1 { "" } else { "s" }));
        }
    }
    out
}

/// Ask a side question of the open chat without adding to it (nightshift
/// backlog 081) — the CLI's interactive `/btw`, which `-p` refuses, done as
/// a throwaway fork of the chat's session on its warm cache
/// (`AgentSpec::aside` has the shape and the measurements). Nothing is
/// recorded: not in the chat's log, not in the CLI's files (the fork is
/// run without session persistence). The agent's lock serialises it with
/// turns, so an aside waits for a running turn rather than racing it, and
/// Stop cancels it like a turn. Refused with a sentence when the chat has
/// no CLI session yet.
///
/// Cancelling (review F13, 2026-09-16): the aside's token goes into
/// `aside_cancel` before the wait for the agent, so `cancel_aside` reaches
/// an aside that is still parked behind a turn — the wait is raced
/// against it — as well as one that is running; and into `cancel` once
/// the agent is held, as before, so Stop still ends a running aside.
///
/// Streaming (nightshift backlog 128): each text delta is also forwarded
/// to the window as an `aside-delta` event carrying `seq`, the way a
/// turn's events go out as `turn-event`; the answer is still collected
/// here so the result is whole for the card's final state.
///
/// Since backlog 283 (2026-10-02) the aside's composer is the chat's: its
/// images and documents go as a turn's do (a stdin line), files the CLI
/// opens itself are saved under the workspace's `asides` folder and named
/// in the question, and `model` / `effort` are the aside's own picks —
/// absent, the chat's (`AgentSpec::aside_with`).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn ask_aside(
    app: AppHandle,
    state: State<'_, AppState>,
    power: State<'_, power::Holder>,
    text: String,
    seq: u64,
    images: Option<Vec<ImageInput>>,
    documents: Option<Vec<DocumentInput>>,
    files: Option<Vec<nightloom_service::attach::FileInput>>,
    model: Option<String>,
    effort: Option<String>,
) -> Result<AsideResult, String> {
    // Its own token, by `seq` (backlog 176): the entry goes when this ends.
    let registered = state.aside_cancel.begin(seq);
    let cancel = registered.token().clone();
    // Its timing line (item 404): entered now, `turn` when the chat's agent
    // is taken, the process's stages from `drive_as`, the end below. A
    // return before the end writes it as `error` (the guard).
    use nightloom_service::turn_timing::{self, Mark, TurnTiming};
    let timing = TurnTiming::begin(turn_timing::ASIDE, None, turn_timing::log_path());
    let target = state.chats.target();
    if let Some(chat) = target.id() {
        timing.set_chat(chat);
    }
    let _ended = timing.end_guard();
    let carried = (
        images.as_ref().map_or(0, Vec::len),
        documents.as_ref().map_or(0, Vec::len),
        files.as_ref().map_or(0, Vec::len),
    );
    let ended = |end: &str| timing.end(&aside_outcome(end, carried.0, carried.1, carried.2));
    // The chat's own running turn holds its agent and the aside waits for
    // it (item 404): past a beat, the window is told, so the moon's row
    // can say what it waits for.
    let lock = lock_agent_at(&state, &target);
    tokio::pin!(lock);
    let agent_guard = tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            ended("stopped");
            return Err("the aside was cancelled".to_string());
        }
        guard = &mut lock => guard,
        _ = tokio::time::sleep(ASIDE_QUEUED_AFTER) => {
            let _ = app.emit("aside-phase", AsidePhase { seq, phase: "queued" });
            tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    ended("stopped");
                    return Err("the aside was cancelled".to_string());
                }
                guard = &mut lock => guard,
            }
        }
    };
    timing.mark(Mark::Started);
    // Item 677: the aside's request goes out from here on — the moment its
    // read of the chat's cache restarts the cache's hour (a little early:
    // the CLI starts first, so the hour is never overstated).
    let sent_ms = keep_warm::now();
    let _ = app.emit(
        "aside-phase",
        AsidePhase {
            seq,
            phase: "running",
        },
    );
    let agent = agent_guard
        .as_ref()
        .ok_or_else(|| "not connected".to_string())?;
    // Awake while the aside runs (nightshift backlog 101).
    let _awake = power.acquire();
    *state.cancel.lock().unwrap() = cancel.clone();
    let mut answer = String::new();
    let marks = timing.clone();
    let mut on_event = |e: TurnEvent| {
        if let TurnEvent::TextDelta { text } = &e {
            answer.push_str(text);
            let _ = app.emit(
                "aside-delta",
                AsideDelta {
                    seq,
                    text: text.clone(),
                },
            );
            marks.mark(Mark::Emitted);
        } else if aside_drawn(&e) {
            let _ = app.emit("aside-turn-event", AsideTurnEvent { seq, event: e });
        }
    };
    let mut text = text;
    let files = files.unwrap_or_default();
    if !files.is_empty() {
        let paths =
            nightloom_service::attach::save_chat_files(&agent.spec().workspace, "asides", &files)?;
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
    let outcome = agent
        .ask_aside(
            input,
            model.as_deref(),
            effort.as_deref(),
            Some(timing.clone()),
            &cancel,
            &mut on_event,
        )
        .await
        .ok_or_else(|| {
            "this chat has no Claude Code session to ask beside yet — send a message first"
                .to_string()
        })?
        .map_err(|e| e.to_string())?;
    ended(if cancel.is_cancelled() {
        "stopped"
    } else if outcome.is_error {
        "error"
    } else {
        "ok"
    });
    // Item 677: the newest round's read — every round sends the chat's
    // prefix, so it is the share of the prefix the aside found warm.
    let round_read = outcome
        .last_round
        .and_then(|u| u.cache_read_tokens)
        .unwrap_or(0);
    if !outcome.is_error
        && !cancel.is_cancelled()
        && let Some(chat) = target.id()
    {
        keep_warm::aside_read(&app, chat, sent_ms, round_read);
    }
    Ok(AsideResult {
        answer: if answer.trim().is_empty() {
            outcome.text
        } else {
            answer
        },
        cost_usd: outcome.cost_usd,
        plan_est: nightloom_service::turn_usage::estimate_cost(outcome.cost_usd),
        limit: outcome.limit,
        cache_read: outcome.usage.cache_read_tokens.unwrap_or(0),
        is_error: outcome.is_error,
        notices: outcome.notices,
        model: outcome.model,
        input_tokens: outcome.usage.input_tokens,
        output_tokens: outcome.usage.output_tokens,
        context_tokens: outcome.last_round.map(|u| u.input_tokens + u.output_tokens),
        sent_ms,
        round_read,
    })
}

/// Interrupt the aside, if any (review F13, 2026-09-16) — the × on the
/// aside card. Reaches an aside still parked behind a running turn as well
/// as one that is running, and never touches the turn: `ask_aside` races
/// its wait for the agent against this token, and the CLI it spawned gets
/// the same interrupt a turn gets on Stop.
/// Since backlog 176 (2026-09-23) it names the exchange (`seq`): several
/// cards may be open, and only the one clicked stops.
#[tauri::command]
pub(crate) fn cancel_aside(state: State<'_, AppState>, seq: u64) {
    state.aside_cancel.cancel(seq);
}
