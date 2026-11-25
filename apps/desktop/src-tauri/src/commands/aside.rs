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
    /// The first round's cache read and write (item 699): the miss test
    /// reads the first, since a later round reads back what it wrote.
    /// `None` when no round reported.
    first_read: Option<u64>,
    first_write: Option<u64>,
    /// The answer's share of the plan, estimated from `cost_usd` at the
    /// rates fitted over lone chat replies (item 674): an aside takes no
    /// readings of its own. `None` before the fit has enough replies.
    plan_est: Option<nightloom_service::turn_usage::Estimate>,
    /// The plan's usage limit stopped the answer (item 674): the shared
    /// transcript draws the chat's limit card under it, with Ask again.
    limit: Option<nightloom_service::agent::LimitHit>,
    /// The files the aside changed (item 775): its edit calls, and what a
    /// shell command moved in the workspace. The window carries them to
    /// the main chat at the end of his next message there.
    changes: Vec<nightloom_service::aside_changes::Change>,
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
    aside: Option<String>,
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
    // Item 766 (merge round T review): the secrets he typed for this chat
    // are scrubbed from the aside too, even before the chat's first turn
    // since launch has loaded them.
    if let Some(chat) = target.id() {
        agent.learn_secrets(chat);
    }
    // Awake while the aside runs (nightshift backlog 101).
    let _awake = power.acquire();
    *state.cancel.lock().unwrap() = cancel.clone();
    let mut answer = String::new();
    let marks = timing.clone();
    // Item 775: what it changes on disk — its edit calls from the stream,
    // and a look at the workspace before, for what a shell command moves.
    use nightloom_service::aside_changes::{Collector, Snapshot};
    let workspace = agent.spec().workspace.clone();
    let mut collector = Collector::new();
    // Item 919: the model's words before a call, for the aside's card.
    let reasons = std::sync::Arc::new(std::sync::Mutex::new(
        nightloom_service::agent::own_browser::ReasonTracker::default(),
    ));
    let tracked = reasons.clone();
    let mut on_event = |e: TurnEvent| {
        collector.on_event(&e);
        tracked.lock().unwrap().push(&e);
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
    let look_at = workspace.clone();
    let before = tokio::task::spawn_blocking(move || Snapshot::take(&look_at))
        .await
        .ok()
        .flatten();
    // Item 919: the aside's own place — its browser tab, its cards.
    let seat = aside
        .as_deref()
        .and_then(|key| seat_for(&app, agent.spec(), target.id(), key));
    let _seated = seat.as_ref().map(|s| Seated::register(seq, s.dir.clone()));
    let watch = seat
        .as_ref()
        .map(|s| watch_pending(app.clone(), seq, s.dir.clone(), reasons.clone()));
    let outcome = agent
        .ask_aside_at(
            input,
            model.as_deref(),
            effort.as_deref(),
            seat.as_ref(),
            Some(timing.clone()),
            &cancel,
            &mut on_event,
        )
        .await;
    if let Some(w) = watch {
        w.abort();
    }
    if let Some(s) = &seat {
        release_pending(&app, seq, &s.dir);
    }
    // Item 775: the look after, only when it ran a shell command.
    let after = match (&before, collector.ran_shell()) {
        (Some(_), true) => {
            let look_at = workspace.clone();
            tokio::task::spawn_blocking(move || Snapshot::take(&look_at))
                .await
                .ok()
                .flatten()
        }
        _ => None,
    };
    let changes = collector.finish(&workspace, before.as_ref().zip(after.as_ref()));
    let outcome = outcome
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
    // ~~read only~~ (aside-cache research 2026-11-23): an aside on the
    // chat's own model and effort marks the chat's prefix
    // (`AgentSpec::side_cache_mark`), so what its round wrote is the chat's
    // too: a cold chat's aside leaves the chat warm (its next send read
    // 97.3%, run R2). On another model or effort its write is its own copy
    // and only the read counts, as before.
    // Item 949: whether the aside ran on the chat's model, by what the CLI
    // resolved each to (an alias pick and the chat's full id are one model);
    // only then is its read a read of the chat's cache.
    let chat_resolved = agent.resolved_model().map(String::from).or_else(|| {
        target
            .try_lock()
            .ok()
            .and_then(|open| open.as_ref().and_then(crate::commands::agent::last_model))
    });
    let same_model = same_model_aside(
        model.as_deref(),
        agent.spec().model.as_deref(),
        outcome.model.as_deref(),
        chat_resolved.as_deref(),
    );
    let own_cache = same_model
        && agent
            .spec()
            .aside_with(model.as_deref(), effort.as_deref())
            .is_some_and(|f| f.side_cache_mark && f.effort == agent.spec().effort);
    let round_read = outcome.last_round.map_or(0, |u| {
        cached_for_chat(u.cache_read_tokens, u.cache_write_tokens, own_cache)
    });
    // Item 786: a stopped aside's read counts too, when the CLI reported it
    // on its way out (measured on 2.1.326: the interrupt's `message_delta`
    // carries the round's prompt side; a stopped aside on a warm chat had
    // read 67,172 of 67,174 before its first word).
    // Item 949: an aside on another model reads its own copy, never the
    // chat's, so it moves neither keep-warm's schedule nor the hand-off's
    // cache edge.
    if !outcome.is_error
        && same_model
        && outcome.last_round.is_some()
        && let Some(chat) = target.id()
    {
        keep_warm::aside_read(&app, chat, sent_ms, round_read);
        // Item 792: the automatic hand-off waits for the cache edge, and an
        // aside that read the cache moved it, keep-warm on or off. A chat
        // busy with a turn is skipped: its new reply sets a new edge.
        if let Ok(open) = target.try_lock()
            && let Some(session) = open.as_ref()
            && let Some(dir) = nightloom_service::cache_miss::ask_dir_of(session)
        {
            nightloom_service::hand_off::note_aside_read(&dir, sent_ms, round_read);
        }
    }
    // Item 727: the aside's prefix print and the cache-miss check, against
    // the chat's newest reply. Its log is read without waiting: busy (a
    // turn took the chat meanwhile) skips the check, never the answer.
    if !outcome.is_error
        && !cancel.is_cancelled()
        && let Some(first) = outcome.first_round
        && let Ok(open) = target.try_lock()
        && let Some(session) = open.as_ref()
        && let Some(fork) = agent.spec().aside_with(model.as_deref(), effort.as_deref())
    {
        use nightloom_service::cache_miss;
        let dir = cache_miss::ask_dir_of(session);
        if let Some(d) = &dir {
            cache_miss::record_print_quiet(d, cache_miss::Kind::Aside, sent_ms, &fork);
        }
        let spec = agent.spec();
        let other = fork.model != spec.model || fork.effort != spec.effort;
        if let Some(req) = cache_miss::aside_request(
            session,
            dir.as_deref(),
            &spec.workspace,
            spec.resume.as_deref(),
            sent_ms,
            first.cache_read_tokens.unwrap_or(0),
            outcome.cost_usd,
            other,
        ) {
            crate::commands::cli::check_request(&app, req);
        }
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
        first_read: outcome
            .first_round
            .map(|u| u.cache_read_tokens.unwrap_or(0)),
        first_write: outcome
            .first_round
            .map(|u| u.cache_write_tokens.unwrap_or(0)),
        changes,
    })
}

/// The share of the chat's prefix an aside's round left in the cache
/// (item 677; aside-cache research 2026-11-23): its read, plus its write
/// when the aside marks the chat's own prefix on the chat's own model
/// (`own`), since that write is then an entry the chat's next send reads.
pub(crate) fn cached_for_chat(read: Option<u64>, write: Option<u64>, own: bool) -> u64 {
    let read = read.unwrap_or(0);
    if own {
        read.saturating_add(write.unwrap_or(0))
    } else {
        read
    }
}

/// Whether an aside ran on the chat's own model (item 949). No pick, or the
/// chat's own model string, is the chat's model by construction (that also
/// covers a model switch not sent yet: the aside runs what the next send
/// will). Another pick is compared by what the CLI resolved: the aside's
/// answer against the chat's last turn, ignoring case and a `[1m]`-style
/// suffix, so `opus` and `claude-opus-5-5` match. Either unknown: not the
/// same, so a cold chat is never painted warm.
pub(crate) fn same_model_aside(
    pick: Option<&str>,
    chat_spec: Option<&str>,
    aside_resolved: Option<&str>,
    chat_resolved: Option<&str>,
) -> bool {
    let pick = pick.map(str::trim).filter(|m| !m.is_empty());
    if pick.is_none() || pick == chat_spec.map(str::trim) {
        return true;
    }
    fn norm(m: &str) -> String {
        m.split('[').next().unwrap_or(m).trim().to_ascii_lowercase()
    }
    match (aside_resolved, chat_resolved) {
        (Some(a), Some(c)) => !norm(a).is_empty() && norm(a) == norm(c),
        _ => false,
    }
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

#[cfg(test)]
mod tests {
    use super::{cached_for_chat, same_model_aside};

    /// Item 949: an Opus aside on a Fable chat is another model; no pick,
    /// the chat's own string, or an alias that resolved to the chat's model
    /// is the same; an unknown resolution is not.
    #[test]
    fn only_an_aside_on_the_chats_resolved_model_is_the_chats_cache() {
        let fable = Some("claude-fable-5-2");
        let opus = Some("claude-opus-5-5");
        assert!(!same_model_aside(Some("opus"), fable, opus, fable));
        assert!(same_model_aside(None, fable, fable, fable));
        assert!(same_model_aside(Some(" "), fable, opus, fable));
        assert!(same_model_aside(
            Some("claude-fable-5-2"),
            fable,
            None,
            None
        ));
        // An alias against the chat's full id, nothing resolved: unknown.
        assert!(!same_model_aside(
            Some("opus"),
            Some("claude-opus-5-5"),
            None,
            None
        ));
        assert!(same_model_aside(
            Some("opus"),
            None,
            Some("claude-opus-5-5"),
            Some("Claude-Opus-5-5[1m]")
        ));
        assert!(!same_model_aside(Some("opus"), None, opus, None));
        assert!(!same_model_aside(Some("opus"), None, None, opus));
    }

    /// Aside-cache research 2026-11-23, run R2: a cold chat's aside read
    /// 27,014 (system and tools) and wrote 40,771 (the chat's messages);
    /// on the chat's own model both are the chat's cache now.
    #[test]
    fn an_own_model_asides_write_is_the_chats_cache() {
        assert_eq!(cached_for_chat(Some(27_014), Some(40_771), true), 67_785);
        assert_eq!(cached_for_chat(Some(27_014), Some(40_771), false), 27_014);
        assert_eq!(cached_for_chat(None, Some(5), true), 5);
        assert_eq!(cached_for_chat(None, None, false), 0);
    }
}

/// The asides that are seated now (item 919), by the card's `seq`: where
/// [`answer_aside_ask`] writes his answer. Gone when the aside ends.
static SEATED: std::sync::LazyLock<std::sync::Mutex<HashMap<u64, PathBuf>>> =
    std::sync::LazyLock::new(Default::default);

pub(crate) struct Seated(u64);

impl Seated {
    fn register(seq: u64, dir: PathBuf) -> Self {
        SEATED.lock().unwrap().insert(seq, dir);
        Self(seq)
    }
}

impl Drop for Seated {
    fn drop(&mut self) {
        SEATED.lock().unwrap().remove(&self.0);
    }
}

/// The aside's seat (item 919): its own directory under the chat's ask
/// directory, given the chat's standing answers, and the app's browser for
/// it — its own tab in the pane, keyed by
/// [`nightloom_service::claude_browser::aside_session`]. `None` when the
/// chat has no ask directory yet (nothing would read the seat).
fn seat_for(
    app: &AppHandle,
    spec: &nightloom_service::agent::AgentSpec,
    chat: Option<&str>,
    key: &str,
) -> Option<nightloom_service::agent::AsideSeat> {
    use nightloom_service::agent::AsideSeat;
    let chat_dir = spec
        .ask
        .as_ref()
        .map(|a| a.dir.clone())
        .filter(|d| !d.as_os_str().is_empty())
        .or_else(|| {
            spec.playwright
                .as_ref()
                .map(|p| p.dir.clone())
                .filter(|d| !d.as_os_str().is_empty())
        })?;
    let mut seat = AsideSeat::prepare(&chat_dir, key, None).ok()?;
    #[cfg(unix)]
    if let (Some(chat), Some(host)) = (
        chat.map(str::to_string).or_else(|| {
            chat_dir
                .file_name()
                .map(|c| c.to_string_lossy().into_owned())
        }),
        app.try_state::<crate::claude_browser::Host>(),
    ) && spec.playwright.as_ref().is_some_and(|p| !p.no_card)
    {
        let session = nightloom_service::claude_browser::aside_session(&chat, key);
        seat.endpoint = host.browsers.endpoint(&session, &seat.dir).ok();
    }
    #[cfg(not(unix))]
    let _ = (app, chat);
    Some(seat)
}

/// A call an aside's hook waits on (item 919), as the window's card reads
/// it: `call` is `null` once it is answered or gone.
#[derive(Serialize, Clone)]
pub(crate) struct AsideAsk {
    seq: u64,
    call: Option<nightloom_service::agent::ask::DeferredCall>,
    reason: Option<String>,
}

/// Watch the aside's directory for the call its hook waits on, and tell
/// the window each time it changes: the card shows in the aside.
fn watch_pending(
    app: AppHandle,
    seq: u64,
    dir: PathBuf,
    reasons: std::sync::Arc<std::sync::Mutex<nightloom_service::agent::own_browser::ReasonTracker>>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut last: Option<String> = None;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            let call = nightloom_service::agent::ask::aside_pending(&dir);
            let id = call.as_ref().map(|c| c.id.clone());
            if id != last {
                let reason = call.as_ref().and_then(|_| reasons.lock().unwrap().reason());
                let _ = app.emit("aside-ask", AsideAsk { seq, call, reason });
                last = id;
            }
        }
    })
}

/// The aside ended (item 919): a hook still waiting is answered with a
/// refusal so it ends, and the card goes.
fn release_pending(app: &AppHandle, seq: u64, dir: &Path) {
    use nightloom_service::agent::ask::{self, Answer, AskDir};
    if let Some(call) = ask::aside_pending(dir) {
        let _ = AskDir::new(dir).write(
            &call,
            &Answer::Deny {
                reason: ask::ASIDE_UNANSWERED.into(),
            },
        );
        let _ = std::fs::remove_file(dir.join(ask::PENDING_FILE));
    }
    let _ = app.emit(
        "aside-ask",
        AsideAsk {
            seq,
            call: None,
            reason: None,
        },
    );
}

/// His answer on an aside's card (item 919): `allow` or `deny`, for the
/// call `id` the aside `seq` waits on. Written to the aside's own
/// directory only, so nothing is approved in the chat.
#[tauri::command]
pub(crate) fn answer_aside_ask(
    seq: u64,
    id: String,
    decision: String,
    reason: Option<String>,
) -> Result<(), String> {
    use nightloom_service::agent::ask::{self, Answer, AskDir};
    let dir = SEATED
        .lock()
        .unwrap()
        .get(&seq)
        .cloned()
        .ok_or_else(|| "this aside is no longer asking".to_string())?;
    let call = ask::aside_pending(&dir)
        .filter(|c| c.id == id)
        .ok_or_else(|| "this card was already answered".to_string())?;
    let answer = if decision == "allow" {
        Answer::Allow {
            updated_input: None,
            plan_then: None,
            grant: None,
        }
    } else {
        let fallback = if nightloom_service::agent::own_browser::is_playwright(&call.name) {
            nightloom_service::agent::own_browser::DECLINED
        } else {
            "the user declined this call"
        };
        Answer::Deny {
            reason: reason
                .filter(|r| !r.trim().is_empty())
                .unwrap_or_else(|| fallback.into()),
        }
    };
    AskDir::new(&dir)
        .write(&call, &answer)
        .map_err(|e| e.to_string())
}
