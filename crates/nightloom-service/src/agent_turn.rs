//! One Claude Code turn, recorded (nightshift item 268, step 1).
//!
//! The body of the desktop's `send_agent`, lifted out of the Tauri crate so
//! the desktop and the headless `serve` ([`crate::serve`]) run a turn through
//! the same function: the typed message on the log first, the council's
//! seats when asked, the replay and kind-switch notes on the wire, the
//! stream rendered and recorded in one pass, the Ask position's round trip
//! (a deferred call asked, answered, resumed, until a process ends without
//! deferring), the council's blocks, and the log's end of turn.
//!
//! What it needs of the app around it is a [`TurnEnv`]: where events,
//! notices and approval prompts go, and how a folder granted "for the
//! project" is kept. What it leaves to the caller: which chat and which
//! agent (their locks), Stop's registry, keeping the Mac awake, the ask
//! directory's pointing and the checkpoint beside it, and whatever the
//! caller builds from the outcome (the desktop's `AgentTurn`, a chat name).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use nightloom_core::{ChatMode, ContentBlock, Session, SessionEvent};
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::agent::{
    AgentOutcome, Answer, AskDir, AskGate, ClaudeCodeAgent, FolderGrant, GrantScope, Recorder,
    carry_transcript, outside_folder,
};
use crate::council::{self, CouncilRequest};
use crate::tools::add_folder;
use crate::turn::{TurnEvent, TurnInput};
use crate::turn_timing::{self, Mark, TurnTiming};
use crate::{ProviderKind, mcp_server, project};

/// Which agent a recorded [`SessionEvent::AgentSession`] belongs to.
pub const AGENT: &str = "claude-code";

/// The model the last recorded exchange ran on, whatever superseded it since.
///
/// Read off the whole log rather than the live projection: a compaction or a
/// rewind changes what the next request carries and says nothing about which
/// snapshot the CLI resolves an alias to.
pub fn last_model(session: &Session) -> Option<String> {
    session.events().iter().rev().find_map(|e| match e {
        SessionEvent::AssistantMessage { model, .. } if !model.is_empty() => Some(model.clone()),
        _ => None,
    })
}

/// Every tree a Claude Code chat's tools may open without a prompt: the
/// working directory and each `--add-dir`. What a path is measured against
/// to be *outside* (backlog 143, pass 2).
pub fn agent_trees(agent: &ClaudeCodeAgent) -> Vec<PathBuf> {
    let spec = agent.spec();
    let mut trees = vec![spec.workspace.clone()];
    trees.extend(spec.add_dirs.iter().cloned());
    trees
}

/// A `turn-event` with the chat it belongs to (backlog 159, A2): the
/// event's own fields, plus `chat` — the shape the window and the phone
/// both route by.
#[derive(Serialize, Clone)]
pub struct ChatEvent<'a> {
    pub chat: &'a str,
    #[serde(flatten)]
    pub event: &'a TurnEvent,
}

/// A `tool-approval` prompt for a deferred call: the desktop's payload,
/// which the phone renders as the same card.
#[derive(Serialize, Clone)]
pub struct ApprovalPrompt<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub input: &'a serde_json::Value,
    pub effect: nightloom_core::Effect,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outside: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat: Option<&'a str>,
    /// The model's text just before the call — the reason Playwright's
    /// card shows (nightshift backlog 367). Only on a Playwright call.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The card a read-only chat shows for this call (item 783):
    /// `connector` — Allow once / Allow always / Deny, where *always* adds
    /// the action to the reads he allows in read-only chats — or
    /// `remember` — a proposal he approves. `None`: the ordinary card.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    /// The call was set aside earlier in this reply and is back for its
    /// answer (items 743, 783): this time the card waits for him.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub back: bool,
}

/// A card nobody has answered (item 783), as the window and the phone
/// hear of it (`approval-nudge`): the reminder is due, or the call was set
/// aside and its card goes.
#[derive(Serialize, Clone)]
pub struct ApprovalNudge<'a> {
    pub id: &'a str,
    pub name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat: Option<&'a str>,
    pub stage: crate::agent::ask::Nudge,
}

/// Playwright's *Allow once* and *Deny* last for one reply (nightshift
/// backlog 367): cleared as the turn starts — a crash may have left one —
/// and when it ends, whichever way it ends. His takeover of Claude's
/// browser ends at both edges too (item 552): a new message of his hands
/// the browser back, and so does the turn ending, so the model is never
/// left refused; his next click in the tab takes it again.
struct ReplyEnd(AskDir);

impl ReplyEnd {
    fn begin(dir: &Path) -> Self {
        let d = AskDir::new(dir);
        d.end_reply();
        if d.held_by_user() {
            let _ = d.set_held_by_user(false);
        }
        Self(d)
    }
}

impl Drop for ReplyEnd {
    fn drop(&mut self) {
        self.0.end_reply();
        if self.0.held_by_user() {
            let _ = self.0.set_held_by_user(false);
        }
    }
}

/// What became of a folder the card granted "for the project".
pub enum ProjectGrant {
    /// Written to the turn's project.
    Kept,
    /// No project to keep it: the chat keeps it instead.
    NoProject,
    /// Not written; the sentence goes out as a notice.
    Failed(String),
}

/// What a turn needs from the app around it.
#[async_trait::async_trait]
pub trait TurnEnv: Send + Sync {
    /// One streamed event of `chat`'s turn (`turn-event`).
    fn event(&self, chat: &str, event: &TurnEvent);
    /// A sentence about the turn that is not part of it (`turn-notice`).
    fn notice(&self, text: String);
    /// Ask about a deferred call (`tool-approval`). The answer comes back
    /// through the [`AskGate`] the turn was given.
    fn approval(&self, prompt: &ApprovalPrompt<'_>);
    /// A card nobody answered (item 783): at
    /// [`crate::agent::ask::ApprovalTimes::remind`] push the phone again;
    /// at `set_aside` the call was set aside — withdraw the card and say
    /// so. The first push is `approval`'s own.
    fn nudge(&self, nudge: &ApprovalNudge<'_>) {
        let _ = nudge;
    }
    /// Nobody is there to answer a card (item 783's finish): no phone
    /// connected and, on the Mac, nobody at it. A read-only chat's card is
    /// then set aside at once instead of holding the run.
    fn unattended(&self) -> bool {
        false
    }
    /// Keep `dir` on the turn's project (the card's *let the project see
    /// it*).
    async fn grant_to_project(&self, dir: &Path) -> ProjectGrant;
    /// The message's timing line, begun where the host's command was
    /// entered (item 256); `None` begins one at the turn's first line, as
    /// `serve` does, with no window stages.
    fn timing(&self) -> Option<Arc<TurnTiming>> {
        None
    }
    /// Item 784: nobody is watching `chat` now — he has left the Mac, or
    /// no phone is connected to the away server — so the runaway guard may
    /// pause it. Asked at the moment the guard trips. A job's run is
    /// always unattended ([`TurnEnv::job_of`]). Default: somebody is.
    /// Not [`TurnEnv::unattended`] (item 783's, "nobody can answer a
    /// card"): on the Mac a phone page left open does not count as
    /// watching here — a missed runaway costs more than a pause he can
    /// Continue from the phone.
    fn unwatched(&self, _chat: &str) -> bool {
        false
    }
    /// Item 784: the job `chat` runs for — its name and its recent runs'
    /// tool calls, for the guard's calls ceiling.
    fn job_of(&self, _chat: &str) -> Option<crate::runaway::JobUsual> {
        None
    }
}

/// One turn's inputs besides the environment.
pub struct AgentTurnRun<'a> {
    pub agent: &'a mut ClaudeCodeAgent,
    pub session: &'a mut Session,
    pub chat_id: &'a str,
    pub input: TurnInput,
    /// Heard by the phone's voice mode (item 246 wave 3): recorded
    /// `spoken`, and sent with the "answer for the ear" note on the wire.
    pub spoken: bool,
    /// Appended after the message on the wire, never the log: the
    /// subagent rules changed on a warm chat (nightshift backlog 293).
    pub wire_note: Option<String>,
    pub council: Option<CouncilRequest>,
    pub cancel: &'a CancellationToken,
    /// The chat's ask directory (`<log dir>/ask/<chat id>/`), already
    /// pointed at by the caller; `None` for a chat with no log.
    pub ask_dir: Option<PathBuf>,
    pub ask: &'a AskGate,
}

/// How a turn ended, when it did not fail.
pub enum AgentTurnEnd {
    /// Stopped while the council's seats ran: no chair ran, and the log
    /// has a reply saying so.
    StoppedInCouncil,
    Done {
        /// The CLI's outcome, already followed on (`follow_on`).
        outcome: Box<AgentOutcome>,
        /// A folder was granted this turn (the rail's list is stale).
        granted_any: bool,
        /// The window of the model the CLI reported.
        context_limit: Option<u64>,
    },
}

/// Run one user turn on the agent engine, streaming `turn-event`s through
/// `env` and recording into the session log (see [`Recorder`]).
///
/// Every turn writes its timing line (item 256, [`turn_timing`]) when it
/// returns, whichever way.
pub async fn run_agent_turn(
    run: AgentTurnRun<'_>,
    env: &dyn TurnEnv,
) -> Result<AgentTurnEnd, String> {
    let timing = env
        .timing()
        .unwrap_or_else(|| TurnTiming::begin(turn_timing::SERVE, None, turn_timing::log_path()));
    timing.set_chat(run.chat_id);
    timing.mark(Mark::Started);
    let cancel = run.cancel;
    let result = turn_body(run, env, &timing).await;
    let outcome = match &result {
        _ if cancel.is_cancelled() => "stopped",
        Ok(AgentTurnEnd::StoppedInCouncil) => "stopped",
        Ok(AgentTurnEnd::Done { outcome, .. }) if outcome.is_error => "error",
        Ok(_) => "ok",
        Err(_) => "error",
    };
    timing.end(outcome);
    result
}

async fn turn_body(
    run: AgentTurnRun<'_>,
    env: &dyn TurnEnv,
    timing: &Arc<TurnTiming>,
) -> Result<AgentTurnEnd, String> {
    let AgentTurnRun {
        agent,
        session,
        chat_id,
        mut input,
        spoken,
        wire_note,
        council,
        cancel,
        ask_dir,
        ask,
    } = run;
    if let Some(c) = &council {
        c.validate().map_err(|e| e.to_string())?;
    }
    // Item 323: the turn's share of the plan's windows, read from its own
    // `rate_limit_event` and the next reading after it (`turn_usage`).
    // Dropped on any other way out, it records nothing.
    let usage_turn = ask_dir.as_deref().map(crate::turn_usage::begin);
    let _reply_end = ask_dir.as_deref().map(ReplyEnd::begin);
    // Sampled before the first append of the turn: a log that seals during
    // it says so once, as a notice.
    let sealed_before = session.write_failure().is_some();
    // The log keeps the message as typed, whatever the wire carries.
    let typed = input.text.clone();

    // The typed message is on the log *before* the seats run (backlog
    // 167); the ephemeral replay and the kind switch's note are asked
    // first and put on the wire after, around whatever the chair is sent.
    let carry_head = (session.mode() == ChatMode::Ephemeral).then(|| carry_transcript(session, ""));
    let switch_note = session.kind_switch_note();
    session.record_user_message(
        typed.clone(),
        input.images.clone(),
        input.documents.clone(),
        spoken,
    );
    let mut council_run: Option<(CouncilRequest, Vec<council::SeatResult>)> = None;
    let mut council_notices: Vec<String> = Vec::new();
    if let Some(mut request) = council {
        if request.areas.is_empty() {
            request.areas = council::areas_for_next(session);
        }
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(1);
        // A seat's stream goes out as a subagent's does (backlog 169).
        let mut on_seat = |seat: usize, e: TurnEvent| {
            let e = if matches!(e, TurnEvent::SubagentStatus { .. }) {
                e
            } else {
                TurnEvent::Subagent {
                    parent_tool_use_id: council::seat_key(seed, seat),
                    event: Box::new(e),
                }
            };
            env.event(chat_id, &e);
        };
        let results = council::run_seats(
            agent,
            agent.spec(),
            Some(&*session),
            &request,
            &typed,
            seed,
            cancel,
            &mut on_seat,
        )
        .await;
        // Stopped during the seats (backlog 167): no chair on a cancelled
        // token; the log gets a reply that says so.
        if cancel.is_cancelled() {
            let model = last_model(session)
                .or_else(|| agent.resolved_model().map(String::from))
                .or_else(|| agent.spec().model.clone())
                .unwrap_or_else(|| AGENT.into());
            let mut recorder = Recorder::new(session, model);
            recorder.push_block(ContentBlock::Text {
                text: council::STOPPED_REPLY.into(),
            });
            for r in &results {
                recorder.push_block(ContentBlock::Text {
                    text: council::seat_block(r),
                });
            }
            recorder.finish(Some("end_turn"));
            if !sealed_before && let Some(failure) = session.write_failure() {
                env.notice(failure.summary());
            }
            return Ok(AgentTurnEnd::StoppedInCouncil);
        }
        let answered = results.iter().filter(|r| r.error.is_none()).count();
        for r in results.iter().filter(|r| r.error.is_some()) {
            council_notices.push(format!(
                "council seat {} ({}) did not answer: {}",
                r.index + 1,
                r.seat.model,
                r.error.as_deref().unwrap_or("")
            ));
        }
        if answered == 0 {
            council_notices.push("no council seat answered; answered as an ordinary turn".into());
        } else {
            let answers = council::anonymised(&results);
            input.text = council::chair_prompt(request.mode, &typed, &answers, &request.areas);
            council_run = Some((request, results));
        }
        // The chair continues the seats' budget ledger (backlog 187).
        agent.arm_chair();
    }
    // An ephemeral chat's replay, and the kind switch's note (backlog
    // 144): on the wire only; the log keeps the text as typed.
    // A spoken turn's "answer for the ear" note (`~/.nightloom/voice.md`,
    // item 246 wave 3, 3C) rides the wire after his words — or the chair's
    // prompt — never the log.
    if spoken {
        input.text = crate::voice::for_the_ear(&input.text);
    }
    if let Some(head) = carry_head {
        input.text = format!("{head}{}", input.text);
    }
    if let Some(note) = switch_note {
        input.text = format!("{note}\n\n{}", input.text);
    }
    if let Some(note) = wire_note {
        input.text = format!("{}\n\n{note}", input.text);
    }
    // `context_status` describes this chat before the turn (review
    // 2026-09-17 FC-d, backlog 134). Best-effort.
    if let Some(config) = project::config_dir() {
        let model = last_model(session);
        let window = model
            .as_deref()
            .and_then(|m| crate::context_limit(ProviderKind::Anthropic, m));
        if let Err(e) = mcp_server::refresh_context_status(
            &config,
            &session.id,
            model,
            window,
            session.events(),
        ) {
            env.notice(format!("context status not refreshed: {e}"));
        }
    }

    // Seeded from the last turn rather than from the rail: the rail may
    // hold an alias, and only the CLI can say which snapshot it means.
    let seed = last_model(session)
        .or_else(|| agent.resolved_model().map(String::from))
        .or_else(|| agent.spec().model.clone())
        .unwrap_or_else(|| AGENT.into());
    // Backlog 361: named on a reply that never came, if none does.
    let seed_model = seed.clone();
    // Rendered live and recorded in one pass.
    let mut recorder = Recorder::new(session, seed);
    // What a change would lose this turn's cache to (backlog 408).
    recorder.key_cache_from(agent.spec());
    // The first text handed to the window (or the phone) — item 256.
    let mut emitted = false;
    // The model's words before a call, for Playwright's card (backlog 367).
    let reason = std::sync::Mutex::new(crate::agent::own_browser::ReasonTracker::default());
    // Item 784: the runaway guard. A trip while nobody watches interrupts
    // the CLI through the run's own token (a child of the turn's, so his
    // Stop is still told apart) and leaves the trip for the pause below.
    let job = env.job_of(chat_id);
    let guard = std::sync::Mutex::new(crate::runaway::Guard::new(job.as_ref()));
    let halt = std::sync::Mutex::new((cancel.child_token(), None::<crate::runaway::Trip>));
    let run_token = || {
        halt.lock()
            .map(|h| h.0.clone())
            .unwrap_or_else(|_| cancel.clone())
    };
    let mut on_event = |e: TurnEvent| {
        if let Ok(mut r) = reason.lock() {
            r.push(&e);
        }
        env.event(chat_id, &e);
        if !emitted && matches!(e, TurnEvent::TextDelta { .. }) {
            emitted = true;
            timing.mark(Mark::Emitted);
        }
        recorder.push(&e);
        if let Ok(mut g) = guard.lock()
            && let Some(trip) = g.see(&e)
        {
            if job.is_some() || env.unwatched(chat_id) {
                if let Ok(mut h) = halt.lock()
                    && h.1.is_none()
                {
                    h.1 = Some(trip);
                    h.0.cancel();
                }
            } else {
                g.passed();
            }
        }
    };
    // The chat's own processes mark the spawn, `init` and the first text;
    // a council's seats above ran without it.
    agent.set_timing(Some(timing.clone()));
    // A card the app was closed on (item 522): nobody can answer it now, so
    // the call is refused on disk for this turn's hook to deliver, and the
    // turn opens with that result instead of parking on the same question.
    if let Some(dir) = ask_dir.as_deref() {
        let resume = agent.spec().resume.clone();
        if let Some(call) = AskDir::new(dir).settle_waiting(resume.as_deref()) {
            agent.note_refused(resume.as_deref(), call);
        }
    }
    let mut result = agent.run_turn(input, &run_token(), &mut on_event).await;

    // The Ask position's round trip (backlog 084): one Nightloom turn spans
    // every CLI process it takes. The folder entrance (backlog 143, pass
    // 2): a grant on the answer reaches the process at once; who keeps it
    // is settled here for the project and after the turn for the chat.
    let mut granted_to_chat: Vec<PathBuf> = Vec::new();
    let mut granted_any = false;
    // What the turn's earlier processes spent (item 675): each outcome
    // carries its own process's cost, and a turn that paused on a question
    // spans several.
    let mut spent_before: Option<f64> = None;
    // Calls he answered "Not now — carry on" (item 743) that have not come
    // back yet. The model is told to make the call again at the end; one
    // that never returns is said at the turn's end, never silently lost.
    // With each, why (item 783): his word, nobody answering, or nobody there.
    let mut set_aside: Vec<(crate::agent::DeferredCall, Aside)> = Vec::new();
    // Calls already set aside unattended this turn (item 788): the same
    // call again is set aside without a second push.
    let mut pushed_aside: Vec<(String, serde_json::Value)> = Vec::new();
    loop {
        while let Ok(outcome) = &result
            && let Some(call) = outcome.deferred.clone()
        {
            let Some(dir) = ask_dir.clone() else {
                break;
            };
            // The same call again is the one set aside, back for its answer.
            let before = set_aside.len();
            set_aside.retain(|(c, _)| !(c.name == call.name && c.input == call.input));
            let back = set_aside.len() != before;
            // A read-only chat's own cards (item 783): a connector action that
            // is not a known read, and `remember`.
            let rules_home = ask.rules_home();
            let card_kind = agent
                .spec()
                .refuses_mcp_writers()
                .then(|| crate::agent::ask::read_only_card(rules_home.as_deref(), &call.name))
                .flatten();
            let session_id = outcome.session_id.clone();
            let ask_files = AskDir::new(dir);
            // On disk while the card waits (item 522): a launch after a quit
            // mid-wait refuses the call rather than meeting it again.
            let _ = ask_files.set_waiting(session_id.as_deref(), &call);
            // `add_folder` (nightshift item 613): the card offers the folder
            // the model named — exactly it, never a parent the walk-up would
            // find — and a call the card has nothing to ask about is answered
            // here: a path that is not a folder refused with the reason, one
            // already among the chat's folders allowed (and noted, so the tool
            // says so).
            let folder_ask = (call.name == crate::mcp_server::mcp_name(add_folder::NAME))
                .then(|| add_folder::requested_dir(&call.input));
            let trees = agent_trees(agent);
            let preanswer = match &folder_ask {
                Some(Err(e)) => Some(Answer::Deny { reason: e.clone() }),
                Some(Ok(d)) if add_folder::inside(d, &trees) => {
                    let _ = add_folder::note_granted(ask_files.path(), d, add_folder::ALREADY);
                    Some(Answer::Allow {
                        updated_input: None,
                        plan_then: None,
                        grant: None,
                    })
                }
                _ => None,
            };
            let answered_here = preanswer.is_some();
            let mut aside: Option<Aside> = None;
            // A read-only chat's card in a run nobody is there for (item 783's
            // finish): never shown, never waited on — the phone is pushed, the
            // call set aside at once, the run finishes and lists it at its end.
            let unattended = !answered_here && card_kind.is_some() && env.unattended();
            let answer = if let Some(a) = preanswer {
                Some(a)
            } else if unattended {
                let again = pushed_aside
                    .iter()
                    .any(|(n, i)| *n == call.name && *i == call.input);
                if !again {
                    pushed_aside.push((call.name.clone(), call.input.clone()));
                    env.nudge(&ApprovalNudge {
                        id: &call.id,
                        name: &call.name,
                        chat: Some(chat_id),
                        stage: crate::agent::ask::Nudge::Unattended,
                    });
                }
                aside = Some(Aside::Unattended);
                Some(Answer::Deny {
                    reason: crate::agent::ask::UNATTENDED_REASON.into(),
                })
            } else {
                let rx = ask.wait(&call.id);
                let outside = match &folder_ask {
                    Some(Ok(d)) => Some(d.clone()),
                    _ => outside_folder(&call.input, &trees),
                };
                // An Allow or a Deny that nobody gives is reminded of and then
                // set aside (item 783) — once: a call that is back after a
                // set-aside waits for him, or a reply would never end. A
                // question, a plan and a folder are answers only he can give.
                let times = (!back
                    && folder_ask.is_none()
                    && crate::push::What::for_prompt(&call.name) == crate::push::What::Approval)
                    .then(|| ask.times());
                env.approval(&ApprovalPrompt {
                    kind: card_kind,
                    back,
                    id: &call.id,
                    name: &call.name,
                    input: &call.input,
                    // Nightloom's own tools by their own effect (backlog 317);
                    // every other deferred call is `Mutating`, as before.
                    effect: crate::mcp_server::effect_of(&call.name),
                    outside,
                    chat: Some(chat_id),
                    reason: crate::agent::own_browser::is_playwright(&call.name)
                        .then(|| reason.lock().ok().and_then(|r| r.reason()))
                        .flatten(),
                });
                let nudge = |stage| {
                    env.nudge(&ApprovalNudge {
                        id: &call.id,
                        name: &call.name,
                        chat: Some(chat_id),
                        stage,
                    });
                };
                use crate::agent::ask::{Nudge, Waited, wait_for_answer};
                match wait_for_answer(rx, cancel, times, || nudge(Nudge::Remind)).await {
                    Waited::Answer(a) => Some(a),
                    Waited::Gone => None,
                    Waited::SetAside => {
                        // Nobody answered: the card goes, the call is set
                        // aside — never run — and comes back at the end.
                        ask.abandon(&call.id);
                        nudge(Nudge::SetAside);
                        aside = Some(Aside::Unanswered);
                        Some(Answer::Deny {
                            reason: crate::agent::ask::AUTO_LATER_REASON.into(),
                        })
                    }
                }
            };
            // The read-only chat's cards (item 783): *Allow always* on a
            // connector action makes it a read he allows — on this host now,
            // on the other at the next sync — and never a standing allow in
            // the chat's own list; a `remember` is approved one at a time.
            let answer = match (card_kind, answer) {
                (Some(kind), Some(Answer::AllowForChat { updated_input })) => {
                    if kind == "connector"
                        && let Some(home) = &rules_home
                        && let Err(e) = crate::approval_rules::allow_read(home, &call.name)
                    {
                        env.notice(format!("could not keep that as always allowed: {e}"));
                    }
                    Some(Answer::Allow {
                        updated_input,
                        plan_then: None,
                        grant: None,
                    })
                }
                (_, a) => a,
            };
            // His *Allow* on an `add_folder` card is the grant the call asked
            // for, at the model's scope unless his button named one; *Allow for
            // this chat* is the same single grant — the gate reads no rule.
            let answer = match (&folder_ask, answer) {
                (
                    Some(Ok(d)),
                    Some(Answer::Allow {
                        grant: None,
                        updated_input,
                        plan_then,
                    }),
                ) if !answered_here => Some(Answer::Allow {
                    updated_input,
                    plan_then,
                    grant: Some(FolderGrant {
                        dir: d.clone(),
                        scope: GrantScope::parse(add_folder::requested_scope(&call.input))
                            .unwrap_or(GrantScope::Chat),
                    }),
                }),
                (Some(Ok(d)), Some(Answer::AllowForChat { updated_input })) => {
                    Some(Answer::Allow {
                        updated_input,
                        plan_then: None,
                        grant: Some(FolderGrant {
                            dir: d.clone(),
                            scope: GrantScope::parse(add_folder::requested_scope(&call.input))
                                .unwrap_or(GrantScope::Chat),
                        }),
                    })
                }
                (_, a) => a,
            };
            let Some(answer) = answer else {
                // Stopped, or the prompt let go: refused on disk now, for the
                // next turn's hook to deliver (`m084-9-deny-stale.jsonl`).
                let _ = ask_files.write(
                    &call,
                    &Answer::Deny {
                        reason: "the turn was stopped before this was approved".into(),
                    },
                );
                agent.note_refused(session_id.as_deref(), call.clone());
                ask_files.clear_waiting();
                ask.abandon(&call.id);
                if let Ok(o) = &mut result {
                    o.notices
                        .push("stopped while waiting for your answer".into());
                    o.deferred = None;
                }
                break;
            };
            // A set-aside without his word writes only this call's refusal
            // (item 783's review: a Deny would also refuse Playwright's next
            // call for the reply, the one that comes back for its card).
            let wrote = match (&aside, &answer) {
                (Some(_), Answer::Deny { reason }) => ask_files.write_set_aside(&call, reason),
                _ => ask_files.write(&call, &answer),
            };
            if let Err(e) = wrote {
                ask_files.clear_waiting();
                if let Ok(o) = &mut result {
                    o.notices.push(format!("could not record the answer: {e}"));
                    o.deferred = None;
                }
                break;
            }
            if let Some(id) = &session_id {
                agent.set_resume(Some(id.clone()));
            }
            if let Some(why) = aside.or(matches!(answer, Answer::Later).then_some(Aside::Later)) {
                set_aside.push((call.clone(), why));
            }
            if let Answer::Allow {
                grant: Some(grant), ..
            } = &answer
            {
                agent.grant_dir(grant.dir.clone());
                granted_any = true;
                let kept = match grant.scope {
                    GrantScope::Chat => {
                        granted_to_chat.push(grant.dir.clone());
                        Some("chat")
                    }
                    GrantScope::Project => match env.grant_to_project(&grant.dir).await {
                        ProjectGrant::Kept => Some("project"),
                        ProjectGrant::NoProject => {
                            granted_to_chat.push(grant.dir.clone());
                            Some("chat")
                        }
                        ProjectGrant::Failed(e) => {
                            env.notice(format!("folder not granted: {e}"));
                            None
                        }
                    },
                };
                // For `add_folder`'s own result (item 613): it says "added" only
                // for a folder noted here.
                if let (Some(Ok(_)), Some(kept)) = (&folder_ask, kept) {
                    let _ = add_folder::note_granted(ask_files.path(), &grant.dir, kept);
                }
            }
            // An approved plan (backlog 085).
            let plan_then = match &answer {
                Answer::Allow { plan_then, .. }
                    if call.name == crate::agent::ask::EXIT_PLAN_TOOL =>
                {
                    *plan_then
                }
                _ => None,
            };
            if let Some(then) = plan_then {
                agent.plan_approved(then);
            }
            // His message in place of an answer (item 522): the refusal carries
            // his words, and once it has landed as the call's result the turn
            // reports the message delivered — after the result, the order the
            // model read them in — so the window's row leaves its queue and the
            // log keeps it as his message. A resume that never delivers the
            // result reports nothing: the row stays queued, unsent.
            let mut reply = match &answer {
                Answer::Reply { id: Some(id), text } => Some((id.clone(), text.clone())),
                _ => None,
            };
            if let Some(c) = result.as_ref().ok().and_then(|o| o.cost_usd) {
                spent_before = Some(spent_before.unwrap_or(0.0) + c);
            }
            if reply.is_some() {
                let mut relay = |e: TurnEvent| {
                    let landed = matches!(
                        &e,
                        TurnEvent::ToolResult { tool_use_id, .. } if *tool_use_id == call.id
                    );
                    on_event(e);
                    if landed && let Some((id, text)) = reply.take() {
                        on_event(TurnEvent::MessageDelivered {
                            id,
                            text,
                            after: format!("in place of an answer to {}", call.name),
                            images: Vec::new(),
                            documents: Vec::new(),
                        });
                    }
                };
                result = agent.resume_deferred(&call, &run_token(), &mut relay).await;
            } else {
                result = agent
                    .resume_deferred(&call, &run_token(), &mut on_event)
                    .await;
            }
            // The resume's process asked the hook and the answer was read (or
            // the turn was stopped and refuses it itself): the wait is over.
            ask_files.clear_waiting();
            if plan_then.is_some() {
                agent.plan_exited();
            }
        }

        // Item 784: the runaway guard paused the run. The CLI was interrupted
        // as Stop interrupts it; the turn waits here on Continue or Stop, the
        // card on the same channel as a deferred call's (the phone's card and
        // push with it).
        let trip = halt.lock().ok().and_then(|mut h| h.1.take());
        let Some(trip) = trip else {
            break;
        };
        if cancel.is_cancelled() {
            break;
        }
        let session_id = result.as_ref().ok().and_then(|o| o.session_id.clone());
        if let Ok(o) = &mut result {
            // The interrupt's own line is not his Stop.
            o.notices.retain(|n| !n.starts_with("interrupted"));
        }
        // Item 788: the same call refused again and again, and nobody there
        // to press the card — waiting would hold a job "running" to its
        // six-hour mark for nothing. The run ends here with its record and
        // the line that says why; the refusals' own push (one, item 788's
        // `pushed_aside`) and the run's end push are what he gets. A run
        // somebody can answer keeps the card below.
        if trip.refused() && env.unattended() {
            on_event(TurnEvent::TextDelta {
                text: format!("\n\n{}", crate::runaway::ended_line(&trip)),
            });
            if let Ok(o) = &mut result {
                o.notices
                    .push("ended — the same call was refused, nobody to answer".into());
                o.deferred = None;
            }
            break;
        }
        let id = format!("{}-{}", crate::runaway::STUCK_TOOL, uuid::Uuid::new_v4());
        let rx = ask.wait(&id);
        let card = trip.card_input(job.as_ref().map(|j| j.title.as_str()));
        env.approval(&ApprovalPrompt {
            id: &id,
            name: crate::runaway::STUCK_TOOL,
            input: &card,
            effect: nightloom_core::Effect::ReadOnly,
            outside: None,
            chat: Some(chat_id),
            reason: Some(trip.sentence()),
            kind: None,
            back: false,
        });
        let answer = tokio::select! {
            _ = cancel.cancelled() => None,
            a = rx => a.ok(),
        };
        let go_on = match answer {
            Some(Answer::Allow { .. } | Answer::AllowForChat { .. }) => {
                Some((crate::runaway::continue_note(&trip), None))
            }
            // His message in place of an answer: a Continue that carries it.
            Some(Answer::Reply { id: reply, text }) => Some((
                format!("{}\n\n{text}", crate::runaway::continue_note(&trip)),
                reply.map(|r| (r, text)),
            )),
            _ => None,
        };
        let Some((note, reply)) = go_on else {
            ask.abandon(&id);
            // Stop: the run ends with everything it did on the log, and the
            // line that says why (the jobs list reads it as a stopped run).
            if !cancel.is_cancelled() {
                on_event(TurnEvent::TextDelta {
                    text: format!("\n\n{}", crate::runaway::stopped_line(&trip)),
                });
            }
            if let Ok(o) = &mut result {
                o.notices.push("stopped — the run looked stuck".into());
                o.deferred = None;
            }
            break;
        };
        if let Some((rid, text)) = reply {
            on_event(TurnEvent::MessageDelivered {
                id: rid,
                text,
                after: "in place of an answer to the stuck run's card".into(),
                images: Vec::new(),
                documents: Vec::new(),
            });
        }
        if let Ok(mut g) = guard.lock() {
            g.continued();
        }
        if let Ok(mut h) = halt.lock() {
            h.0 = cancel.child_token();
        }
        if let Some(sid) = &session_id {
            agent.set_resume(Some(sid.clone()));
        }
        // The paused process's cost, before its outcome is replaced (a
        // Stop keeps the outcome, so it is counted once there).
        if let Some(c) = result.as_ref().ok().and_then(|o| o.cost_usd) {
            spent_before = Some(spent_before.unwrap_or(0.0) + c);
        }
        result = agent
            .run_turn(
                TurnInput {
                    text: note,
                    images: Vec::new(),
                    documents: Vec::new(),
                },
                &run_token(),
                &mut on_event,
            )
            .await;
    }

    agent.set_timing(None);

    // Set aside and never asked again (item 743): the call did not run, and
    // he is told so rather than left to assume the card will return.
    if let Ok(o) = &mut result
        && !cancel.is_cancelled()
    {
        for (c, why) in &set_aside {
            o.notices.push(match why {
                Aside::Later => set_aside_notice(&c.name),
                Aside::Unanswered => unanswered_notice(&c.name),
                Aside::Unattended => unattended_notice(&c.name),
            });
        }
    }

    // The council's blocks (backlog 149), whichever way the chair ended.
    if let Some((request, results)) = &council_run {
        for r in results {
            recorder.push_block(ContentBlock::Text {
                text: council::seat_block(r),
            });
        }
        let chair_text = result.as_ref().map(|o| o.text.as_str()).unwrap_or("");
        let record = council::CouncilRecord::new(request.mode, results, &request.areas, chair_text);
        recorder.push_block(ContentBlock::Text {
            text: council::council_block(&record),
        });
    }
    if let Ok(o) = &mut result {
        o.notices.extend(council_notices);
        if let Some(before) = spent_before {
            o.cost_usd = Some(before + o.cost_usd.unwrap_or(0.0));
        }
    }

    match result {
        Ok(outcome) => {
            if let Some(model) = &outcome.model {
                recorder.set_model(model.clone());
            }
            // The reason rides in the stop reason (backlog 202).
            let reason = match (&outcome.api_error, outcome.is_error, &outcome.cut_off) {
                // Signed out (backlog 409): the mark the window reads.
                (Some(e), true, _) if outcome.signed_out => {
                    format!("{}{e}", nightloom_core::SIGNED_OUT_REASON)
                }
                (Some(e), true, _) => format!("error: {e}"),
                (None, true, _) => "error".to_string(),
                // Ended before its `result` (backlog 332): the footer
                // says "cut off · <why>" instead of a silent "0 out".
                (_, false, Some(why)) => format!("cut off: {why}"),
                (_, false, None) => "end_turn".to_string(),
            };
            recorder.finish(Some(&reason));
            // Stopped or failed before a word (backlog 361): say so.
            if cancel.is_cancelled() {
                record_unanswered(session, outcome.model.clone().unwrap_or(seed_model), None);
            } else if outcome.is_error {
                let why = outcome
                    .api_error
                    .clone()
                    .unwrap_or_else(|| "the turn failed before any reply arrived".into());
                let model = outcome.model.clone().unwrap_or(seed_model);
                if outcome.signed_out {
                    record_signed_out(session, model, &why);
                } else {
                    record_unanswered(session, model, Some(&why));
                }
            }
            // After the turn: an id from a run that failed to start is a
            // handle to nothing.
            if let Some(id) = &outcome.session_id {
                // A new CLI session (the CLI's own fork on an edit, or a
                // hand-off's first turn) keeps the chat's helpers (item 710).
                crate::chat_ops::carry_subagents_after_turn(session, &agent.spec().workspace, id);
                session.record_agent_session(AGENT, id);
            }
            if !granted_to_chat.is_empty() {
                let mut list: Vec<PathBuf> = session.folders().to_vec();
                list.append(&mut granted_to_chat);
                session.record_folders(list);
            }
            if !sealed_before && let Some(failure) = session.write_failure() {
                env.notice(failure.summary());
            }
            agent.follow_on(&outcome);
            let context_limit = outcome
                .model
                .as_deref()
                .and_then(|m| crate::context_limit(ProviderKind::Anthropic, m));
            // What the model may ask about its own window next turn
            // (backlog 073). Best-effort.
            if let Some(config) = project::config_dir() {
                let used = session
                    .events()
                    .iter()
                    .rev()
                    .find_map(|e| match e {
                        // A reply with no usage (backlog 361's stopped or
                        // failed turn) says nothing of the window.
                        SessionEvent::AssistantMessage { usage, .. }
                            if usage.input_tokens + usage.output_tokens > 0 =>
                        {
                            Some(usage.input_tokens + usage.output_tokens)
                        }
                        _ => None,
                    })
                    .unwrap_or(0);
                let turns = session
                    .events()
                    .iter()
                    .filter(|e| matches!(e, SessionEvent::UserMessage { .. }))
                    .count() as u32;
                let status = mcp_server::ContextStatus::new(
                    session.id.clone(),
                    outcome.model.clone(),
                    used,
                    context_limit,
                    turns,
                );
                if let Err(e) = mcp_server::write_context_status(&config, &status) {
                    env.notice(format!("context status not written: {e}"));
                }
            }
            if let Some(u) = usage_turn {
                u.end(
                    crate::turn_usage::last_reply(session.events()),
                    outcome.cost_usd,
                );
            }
            Ok(AgentTurnEnd::Done {
                outcome: Box::new(outcome),
                granted_any,
                context_limit,
            })
        }
        Err(e) => {
            // Whatever streamed before the failure is still what happened;
            // `finish` closes the calls a killed round left open.
            recorder.finish(Some("error"));
            let why = e.to_string();
            if cancel.is_cancelled() {
                record_unanswered(session, seed_model, None);
            } else if crate::cli_auth::is_sign_in_failure(None, None, &why) {
                // A CLI that will not start signed out (backlog 409).
                record_signed_out(session, seed_model, &why);
            } else {
                record_unanswered(session, seed_model, Some(&why));
            }
            Err(why)
        }
    }
}

/// The reply recorded for a turn stopped before anything arrived (backlog
/// 361); core's, so the projection and the CLI edits can tell it apart.
pub use nightloom_core::STOPPED_BEFORE_REPLY;

/// A turn that ended — stopped (`error` `None`) or failed — with nothing
/// recorded after his message leaves a reply that says so (backlog 361,
/// 2026-10-13). Without it his message sat with nothing under it once the
/// window re-read the log, which read as a reply that had vanished. The
/// reply carries no usage (the gauges skip it) and no cache window; its
/// stop reason is `stopped` or `error: <why>`, which the footer names.
pub(crate) fn record_unanswered(session: &mut Session, model: String, error: Option<&str>) {
    let (text, reason) = match error {
        None => (STOPPED_BEFORE_REPLY.to_string(), "stopped".to_string()),
        Some(why) => (
            format!("{}{why}", nightloom_core::NO_REPLY_PREFIX),
            format!("error: {why}"),
        ),
    };
    record_stand_in(session, model, text, reason);
}

/// Backlog 409: the same stand-in for a turn Claude Code refused because it
/// is signed out, its stop reason marked so the window offers Sign in
/// (`error: signed out: <why>`).
pub(crate) fn record_signed_out(session: &mut Session, model: String, why: &str) {
    let text = format!("{}{why}", nightloom_core::NO_REPLY_PREFIX);
    let reason = format!("{}{why}", nightloom_core::SIGNED_OUT_REASON);
    record_stand_in(session, model, text, reason);
}

fn record_stand_in(session: &mut Session, model: String, text: String, reason: String) {
    let last = session.events().iter().rev().find(|e| {
        matches!(
            e,
            SessionEvent::UserMessage { .. }
                | SessionEvent::AssistantMessage { .. }
                | SessionEvent::ToolResult { .. }
        )
    });
    if !matches!(last, Some(SessionEvent::UserMessage { .. })) {
        return;
    }
    session.record_assistant_timed(
        model,
        vec![ContentBlock::Text { text }],
        Some(reason),
        nightloom_core::Usage::default(),
        None,
        chrono::Utc::now(),
        None,
    );
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::agent::AgentSpec;
    use crate::turn_timing::{Stages, TurnTiming, median};
    use nightloom_core::{ChatKind, Usage};

    /// A stand-in `claude`: the `init` line, one word streamed, the result.
    fn stand_in(dir: &Path) -> String {
        let body = r##"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-1"}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}},"parent_tool_use_id":null,"session_id":"s-1"}'
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"parent_tool_use_id":null}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"hi","session_id":"s-1","stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2}}'
"##;
        let path = dir.join("claude-stand-in");
        std::fs::write(&path, body).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    struct Env {
        timing: Arc<TurnTiming>,
    }

    #[async_trait::async_trait]
    impl TurnEnv for Env {
        fn event(&self, _chat: &str, _event: &TurnEvent) {}
        fn notice(&self, _text: String) {}
        fn approval(&self, _prompt: &ApprovalPrompt<'_>) {}
        async fn grant_to_project(&self, _dir: &Path) -> ProjectGrant {
            ProjectGrant::NoProject
        }
        fn timing(&self) -> Option<Arc<TurnTiming>> {
            Some(self.timing.clone())
        }
    }

    /// `turns` stand-in turns in one chat whose log already holds
    /// `history` exchanges; each turn's stages.
    async fn run_turns(turns: usize, history: usize) -> (Vec<Stages>, String) {
        crate::project::set_config_dir(
            std::env::temp_dir().join(format!("nightloom-home-{}", std::process::id())),
        );
        let root = std::env::temp_dir().join(format!("nightloom-256-{}", uuid::Uuid::new_v4()));
        let logs = root.join("sessions");
        std::fs::create_dir_all(&logs).unwrap();
        let mut session = Session::start(&logs, ChatMode::Normal, ChatKind::Build).unwrap();
        for i in 0..history {
            session.record_user_message(
                format!("question {i} {}", "x".repeat(400)),
                vec![],
                vec![],
                false,
            );
            session.record_assistant(
                "claude-haiku-4-5",
                vec![ContentBlock::Text {
                    text: format!("answer {i} {}", "y".repeat(1600)),
                }],
                Some("end_turn".into()),
                Usage::default(),
            );
        }
        let mut spec = AgentSpec::new(&root);
        spec.binary = stand_in(&root);
        let mut agent = ClaudeCodeAgent::new(spec);
        let ask = AskGate::new();
        let log = root.join("turn-timing.log");
        let chat = session.id.clone();
        let mut all = Vec::new();
        for _ in 0..turns {
            let timing = TurnTiming::begin(turn_timing::DESKTOP, None, Some(log.clone()));
            let env = Env {
                timing: timing.clone(),
            };
            let cancel = CancellationToken::new();
            let end = run_agent_turn(
                AgentTurnRun {
                    agent: &mut agent,
                    session: &mut session,
                    chat_id: &chat,
                    input: TurnInput::from("hello"),
                    spoken: false,
                    wire_note: None,
                    council: None,
                    cancel: &cancel,
                    ask_dir: None,
                    ask: &ask,
                },
                &env,
            )
            .await;
            assert!(matches!(end, Ok(AgentTurnEnd::Done { .. })));
            all.push(timing.stages());
        }
        (all, std::fs::read_to_string(&log).unwrap_or_default())
    }

    /// Item 256: every turn writes one line with each Rust stage reached,
    /// in order, and no message text.
    #[tokio::test]
    async fn each_turn_writes_one_timing_line_with_every_stage_in_order() {
        let (stages, text) = run_turns(3, 0).await;
        assert_eq!(text.lines().count(), 3, "{text}");
        for l in text.lines() {
            assert!(l.contains("turn desktop chat "), "{l}");
            assert!(
                !l.contains("hello") && !l.contains(" hi"),
                "message text on the line: {l}"
            );
            for stage in [
                "turn +",
                "spawned +",
                "init +",
                "first event +",
                "first text +",
                "emitted +",
                "end +",
            ] {
                assert!(l.contains(stage), "{stage} missing: {l}");
            }
            // No window here: its stages are absent, not zero.
            assert!(l.contains("sent -") && l.contains("painted -"), "{l}");
            assert!(l.trim_end().ends_with("; ok"), "{l}");
            // Nothing was warmed in this test: each turn spawned its own.
            assert!(l.contains("ms; spawn cold; "), "{l}");
            // Item 723: how the process ended, before the outcome.
            assert!(l.contains("; result seen, 1 stream events, exit "), "{l}");
        }
        for s in &stages {
            let order = [
                s.entered,
                s.turn,
                s.spawned,
                s.init,
                s.first_text,
                s.emitted,
                s.end,
            ];
            let v: Vec<u64> = order
                .iter()
                .map(|x| x.expect("every stage reached"))
                .collect();
            assert!(v.windows(2).all(|w| w[0] <= w[1]), "{v:?}");
        }
    }

    /// One turn against a stand-in `claude` with `body`; `stop_after`
    /// stops it that long after it starts. The chat's events after.
    async fn one_turn(body: &str, stop_after: Option<u64>) -> Vec<SessionEvent> {
        let root = std::env::temp_dir().join(format!("nightloom-361-{}", uuid::Uuid::new_v4()));
        let logs = root.join("sessions");
        std::fs::create_dir_all(&logs).unwrap();
        let bin = root.join("claude-stand-in");
        std::fs::write(&bin, body).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut session = Session::start(&logs, ChatMode::Normal, ChatKind::Build).unwrap();
        let mut spec = AgentSpec::new(&root);
        spec.binary = bin.to_string_lossy().into_owned();
        let mut agent = ClaudeCodeAgent::new(spec);
        let ask = AskGate::new();
        let chat = session.id.clone();
        let env = Env {
            timing: TurnTiming::begin(turn_timing::DESKTOP, None, None),
        };
        let cancel = CancellationToken::new();
        if let Some(ms) = stop_after {
            let c = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                c.cancel();
            });
        }
        let _ = run_agent_turn(
            AgentTurnRun {
                agent: &mut agent,
                session: &mut session,
                chat_id: &chat,
                input: TurnInput::from("Fareed Mosavat in brief"),
                spoken: false,
                wire_note: None,
                council: None,
                cancel: &cancel,
                ask_dir: None,
                ask: &ask,
            },
            &env,
        )
        .await;
        // What the window reads back at the turn's end: the file.
        let path = session.log_path().unwrap().to_path_buf();
        let events = Session::load(&path).unwrap().events().to_vec();
        let _ = std::fs::remove_dir_all(&root);
        events
    }

    /// The last assistant message after his message, with its stop reason.
    fn reply_after_his(events: &[SessionEvent]) -> Option<(String, Option<String>)> {
        let his = events
            .iter()
            .rposition(|e| matches!(e, SessionEvent::UserMessage { .. }))?;
        events[his + 1..].iter().find_map(|e| match e {
            SessionEvent::AssistantMessage {
                blocks,
                stop_reason,
                usage,
                ..
            } => {
                assert_eq!(usage.input_tokens + usage.output_tokens, 0);
                let text = blocks
                    .iter()
                    .filter_map(|b| match b {
                        ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<String>();
                Some((text, stop_reason.clone()))
            }
            _ => None,
        })
    }

    /// Backlog 361 (found live, 2026-10-13): a turn stopped before its
    /// first word left his message with nothing under it once the window
    /// re-read the log — it read as a reply that had vanished. Now the log
    /// says it was stopped.
    #[tokio::test]
    async fn a_turn_stopped_before_any_reply_leaves_a_reply_that_says_so() {
        let body = r##"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-1"}'
sleep 30
"##;
        let events = one_turn(body, Some(400)).await;
        let (text, reason) = reply_after_his(&events).expect("a reply under his message");
        assert_eq!(text, STOPPED_BEFORE_REPLY);
        assert_eq!(reason.as_deref(), Some("stopped"));
    }

    /// Backlog 361: the same for a turn that ended in an error before any
    /// text (the "Can't reach the API server" turn of 2026-10-13).
    #[tokio::test]
    async fn a_turn_that_fails_before_any_reply_leaves_a_reply_that_says_so() {
        let body = r##"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-1"}'
printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":1,"session_id":"s-1","usage":{"input_tokens":0,"output_tokens":0}}'
"##;
        let events = one_turn(body, None).await;
        let (text, reason) = reply_after_his(&events).expect("a reply under his message");
        assert!(text.starts_with("No reply: "), "{text}");
        assert!(
            reason.as_deref().is_some_and(|r| r.starts_with("error")),
            "{reason:?}"
        );
    }

    /// Backlog 409: the CLI signed out — its own failure line (2.1.310,
    /// `external`, ids trimmed) — leaves the stand-in with the stop reason
    /// marked signed out, which the window reads to offer Sign in.
    #[tokio::test]
    async fn a_signed_out_cli_leaves_a_reply_marked_signed_out() {
        let body = r##"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-1"}'
printf '%s\n' '{"type":"assistant","message":{"id":"61cfc640","model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","usage":{"input_tokens":0,"output_tokens":0},"content":[{"type":"text","text":"Failed to authenticate: OAuth session expired and could not be refreshed"}]},"parent_tool_use_id":null,"error":"authentication_failed","isApiErrorMessage":true,"session_id":"s-1"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":true,"num_turns":1,"result":"Failed to authenticate: OAuth session expired and could not be refreshed","session_id":"s-1","usage":{"input_tokens":0,"output_tokens":0}}'
"##;
        let events = one_turn(body, None).await;
        let (text, reason) = reply_after_his(&events).expect("a reply under his message");
        assert_eq!(
            text,
            "No reply: Failed to authenticate: OAuth session expired and could not be refreshed"
        );
        assert_eq!(
            reason.as_deref(),
            Some(
                "error: signed out: Failed to authenticate: OAuth session expired and could not be refreshed"
            )
        );
        // Still the stand-in core keeps off the wire.
        assert!(reason.unwrap().starts_with("error: "));
    }

    /// Backlog 361: a turn that answered gets no second, empty-handed reply.
    #[tokio::test]
    async fn a_turn_that_answered_gets_no_extra_reply() {
        let root = std::env::temp_dir().join(format!("nightloom-361b-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let body = std::fs::read_to_string(stand_in(&root)).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        let events = one_turn(&body, None).await;
        let replies = events
            .iter()
            .filter(|e| matches!(e, SessionEvent::AssistantMessage { .. }))
            .count();
        assert_eq!(replies, 1);
        assert!(!events.iter().any(|e| matches!(
            e,
            SessionEvent::AssistantMessage { blocks, .. }
                if blocks.iter().any(|b| matches!(b, ContentBlock::Text { text } if text == STOPPED_BEFORE_REPLY))
        )));
    }

    /// Two stages of a turn, the span between them.
    type Span = dyn Fn(&Stages) -> (Option<u64>, Option<u64>);

    /// The 256 measurement (`cargo test … measure_ -- --ignored
    /// --nocapture`): the medians of Nightloom's own stages over 10
    /// stand-in turns, on a fresh chat and on one with 400 exchanges.
    #[tokio::test]
    #[ignore]
    async fn measure_nightloom_stages_over_ten_stand_in_turns() {
        for history in [0usize, 400] {
            let (stages, _) = run_turns(10, history).await;
            let d = |f: &Span| {
                median(
                    stages
                        .iter()
                        .map(|s| {
                            let (a, b) = f(s);
                            b.unwrap() as i64 - a.unwrap() as i64
                        })
                        .collect(),
                )
                .unwrap()
            };
            println!(
                "history {history}: entered→turn {} ms, turn→spawned {} ms, spawned→init {} ms, \
                 init→first text {} ms, first text→emitted {} ms, emitted→end {} ms, total {} ms",
                d(&|s| (s.entered, s.turn)),
                d(&|s| (s.turn, s.spawned)),
                d(&|s| (s.spawned, s.init)),
                d(&|s| (s.init, s.first_text)),
                d(&|s| (s.first_text, s.emitted)),
                d(&|s| (s.emitted, s.end)),
                d(&|s| (s.entered, s.end)),
            );
        }
    }

    /// Item 323 end to end: a chat's turn takes its start from its own
    /// `rate_limit_event` and its end from the next turn's; the line lands
    /// beside the turn budget under the first turn's last reply.
    #[tokio::test]
    async fn a_turn_s_plan_share_is_written_once_the_next_turn_reads_the_window() {
        let root = std::env::temp_dir().join(format!("nightloom-323-{}", uuid::Uuid::new_v4()));
        let logs = root.join("sessions");
        std::fs::create_dir_all(&logs).unwrap();
        // The stand-in reports the five-hour window at 41 %, then 43 %.
        let body = r##"#!/bin/sh
n=$(cat "$0.count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$0.count"
u=$([ "$n" = 1 ] && echo 0.41 || echo 0.43)
printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-1"}'
printf '%s\n' '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1791493200,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":'"$u"',"resetsAt":1791493200},"seven_day":{"utilization":0.12,"resetsAt":1791972000}}}}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}},"parent_tool_use_id":null,"session_id":"s-1"}'
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"parent_tool_use_id":null}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"hi","session_id":"s-1","stop_reason":"end_turn","total_cost_usd":0.25,"usage":{"input_tokens":3,"output_tokens":2}}'
"##;
        let bin = root.join("claude-stand-in");
        std::fs::write(&bin, body).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut session = Session::start(&logs, ChatMode::Normal, ChatKind::Build).unwrap();
        let ask_dir = root.join("ask").join(&session.id);
        let mut spec = AgentSpec::new(&root);
        spec.binary = bin.to_string_lossy().into_owned();
        spec.brief = Some(crate::agent::BriefSpec {
            hook: vec!["/usr/bin/true".into()],
            dir: PathBuf::new(),
            text: "brief".into(),
        });
        let mut agent = ClaudeCodeAgent::new(spec);
        agent.set_ask_dir(ask_dir.clone());
        let ask = AskGate::new();
        let chat = session.id.clone();
        let mut first_reply = None;
        for _ in 0..2 {
            let timing = TurnTiming::begin(turn_timing::DESKTOP, None, None);
            let env = Env { timing };
            let cancel = CancellationToken::new();
            let end = run_agent_turn(
                AgentTurnRun {
                    agent: &mut agent,
                    session: &mut session,
                    chat_id: &chat,
                    input: TurnInput::from("hello"),
                    spoken: false,
                    wire_note: None,
                    council: None,
                    cancel: &cancel,
                    ask_dir: Some(ask_dir.clone()),
                    ask: &ask,
                },
                &env,
            )
            .await;
            assert!(
                matches!(end, Ok(AgentTurnEnd::Done { .. })),
                "{:?}",
                end.as_ref().err()
            );
            first_reply = first_reply.or(crate::turn_usage::last_reply(session.events()));
        }
        let lines = crate::turn_usage::read_lines(&ask_dir);
        assert_eq!(
            lines.len(),
            1,
            "the second turn waits for a later reading: {lines:?}"
        );
        let l = &lines[0];
        assert_eq!(Some(l.target), first_reply);
        assert_eq!(l.five_hour.map(|s| (s.start, s.end)), Some((41.0, 43.0)));
        assert_eq!(l.seven_day.map(|s| s.delta()), Some(0.0));
        assert_eq!(l.cost_usd, Some(0.25));
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- item 522: the model's question must never trap him ----------------

    /// A stand-in `claude` that defers an `AskUserQuestion` on its first
    /// run and, on the resume, does what `<root>/resume` says: `refuse`
    /// prints the call's refusal (the decision file's reason, as the CLI's
    /// hook error) and a reply; `die` prints nothing and exits 1.
    fn asking_stand_in(root: &Path, ask_dir: &Path) -> String {
        let body = format!(
            r##"#!/bin/sh
D="{d}"
A="{a}"
if [ -f "$D/deferred" ]; then
  rm "$D/deferred"
  if [ "$(cat "$D/resume")" = die ]; then exit 1; fi
  printf '%s\n' '{{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-1"}}'
  cp "$A/decision.json" "$D/decision-seen.json" 2>/dev/null
  printf '%s\n' '{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"toolu_q","content":"PreToolUse:AskUserQuestion hook error: refused","is_error":true}}]}},"parent_tool_use_id":null}}'
  printf '%s\n' '{{"type":"stream_event","event":{{"type":"content_block_delta","index":0,"delta":{{"type":"text_delta","text":"carrying on"}}}},"parent_tool_use_id":null,"session_id":"s-1"}}'
  printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"carrying on"}}]}},"parent_tool_use_id":null}}'
  printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"carrying on","session_id":"s-1","stop_reason":"end_turn","usage":{{"input_tokens":3,"output_tokens":2}}}}'
  exit 0
fi
printf '%s\n' '{{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-1"}}'
if [ -f "$D/plain" ]; then
  cp "$A/decision.json" "$D/decision-seen.json" 2>/dev/null
  printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"hello again"}}]}},"parent_tool_use_id":null}}'
  printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"hello again","session_id":"s-1","stop_reason":"end_turn","usage":{{"input_tokens":3,"output_tokens":2}}}}'
  exit 0
fi
printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"toolu_q","name":"AskUserQuestion","input":{{"questions":[]}}}}]}},"parent_tool_use_id":null}}'
touch "$D/deferred"
printf '%s\n' '{{"type":"result","subtype":"success","stop_reason":"tool_deferred","terminal_reason":"tool_deferred","is_error":false,"num_turns":1,"result":"","permission_denials":[],"session_id":"s-1","deferred_tool_use":{{"id":"toolu_q","name":"AskUserQuestion","input":{{"questions":[]}}}}}}'
"##,
            d = root.display(),
            a = ask_dir.display(),
        );
        let path = root.join("claude-asking");
        std::fs::write(&path, body).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    // ---- item 783: an approval nobody answers is set aside, never run ------

    /// A stand-in `claude` whose task needs one gated `Bash` call: it
    /// defers it; on the first resume it reads the refusal, "does the
    /// rest" and makes the same call again as its last step (a new id);
    /// on the second resume it ends. Each resume keeps the decision it was
    /// handed, and a call that was allowed leaves `ran-<n>`.
    fn publishing_stand_in(root: &Path, ask_dir: &Path) -> String {
        stand_in_deferring(root, ask_dir, "Bash")
    }

    /// [`publishing_stand_in`] with the gated call made to `tool`.
    fn stand_in_deferring(root: &Path, ask_dir: &Path, tool: &str) -> String {
        let body = format!(
            r##"#!/bin/sh
D="{d}"
A="{a}"
INIT='{{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-1"}}'
defer() {{
  printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"'"$1"'","name":"{t}","input":{{"command":"./publish.sh"}}}}]}},"parent_tool_use_id":null}}'
  printf '%s\n' '{{"type":"result","subtype":"success","stop_reason":"tool_deferred","terminal_reason":"tool_deferred","is_error":false,"num_turns":1,"result":"","permission_denials":[],"session_id":"s-1","deferred_tool_use":{{"id":"'"$1"'","name":"{t}","input":{{"command":"./publish.sh"}}}}}}'
}}
N=$(cat "$D/n" 2>/dev/null || echo 0)
printf '%s\n' "$INIT"
if [ "$N" = 0 ]; then
  echo 1 > "$D/n"
  defer toolu_1
  exit 0
fi
cp "$A/decision.json" "$D/decision-$N.json" 2>/dev/null
if grep -q '"decision":"allow"' "$D/decision-$N.json" 2>/dev/null; then touch "$D/ran-$N"; fi
if [ "$N" = 1 ]; then
  echo 2 > "$D/n"
  printf '%s\n' '{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"toolu_1","content":"set aside","is_error":true}}]}},"parent_tool_use_id":null}}'
  defer toolu_2
  exit 0
fi
printf '%s\n' '{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"toolu_2","content":"published","is_error":false}}]}},"parent_tool_use_id":null}}'
printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"all done"}}]}},"parent_tool_use_id":null}}'
printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"all done","session_id":"s-1","stop_reason":"end_turn","usage":{{"input_tokens":3,"output_tokens":2}}}}'
"##,
            d = root.display(),
            a = ask_dir.display(),
            t = tool,
        );
        let path = root.join("claude-publishing");
        std::fs::write(&path, body).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// Keeps every card and nudge; answers Allow only to a card that is
    /// back after a set-aside, and only after `answer_after`.
    struct AwayEnv {
        ask: Arc<AskGate>,
        cards: std::sync::Mutex<Vec<(String, bool)>>,
        nudges: std::sync::Mutex<Vec<(String, crate::agent::ask::Nudge)>>,
        answer_after: std::time::Duration,
    }

    #[async_trait::async_trait]
    impl TurnEnv for AwayEnv {
        fn event(&self, _chat: &str, _event: &TurnEvent) {}
        fn notice(&self, _text: String) {}
        fn approval(&self, prompt: &ApprovalPrompt<'_>) {
            self.cards
                .lock()
                .unwrap()
                .push((prompt.id.to_string(), prompt.back));
            if prompt.back {
                let (ask, id, after) = (self.ask.clone(), prompt.id.to_string(), self.answer_after);
                tokio::spawn(async move {
                    tokio::time::sleep(after).await;
                    ask.answer(
                        &id,
                        Answer::Allow {
                            updated_input: None,
                            plan_then: None,
                            grant: None,
                        },
                    );
                });
            }
        }
        fn nudge(&self, nudge: &ApprovalNudge<'_>) {
            self.nudges
                .lock()
                .unwrap()
                .push((nudge.id.to_string(), nudge.stage));
        }
        async fn grant_to_project(&self, _dir: &Path) -> ProjectGrant {
            ProjectGrant::NoProject
        }
    }

    /// Item 783 (blocker 2029, his timings of 2026-11-17, here on a short
    /// clock — the 2:30 and 3:30 themselves are
    /// `ask::tests::an_unanswered_approval_is_reminded_…`'s, on a paused
    /// one): an approval nobody answers gets its reminder, is then set
    /// aside — **never run** — the turn carries on, and the same call is
    /// asked again at the end, where it waits for him however long he
    /// takes and runs only on his Allow.
    #[tokio::test]
    async fn an_approval_left_unanswered_is_set_aside_never_run_and_asked_again_at_the_end() {
        use crate::agent::ask::{AUTO_LATER_REASON, ApprovalTimes, Nudge};
        use std::time::Duration;
        let root = std::env::temp_dir().join(format!("nightloom-783-{}", uuid::Uuid::new_v4()));
        let logs = root.join("sessions");
        std::fs::create_dir_all(&logs).unwrap();
        let mut session = Session::start(&logs, ChatMode::Normal, ChatKind::Build).unwrap();
        let ask_dir = root.join("ask").join(&session.id);
        let mut spec = AgentSpec::new(&root);
        spec.binary = publishing_stand_in(&root, &ask_dir);
        let mut agent = ClaudeCodeAgent::new(spec);
        agent.set_ask_dir(ask_dir.clone());
        let times = ApprovalTimes {
            remind: Duration::from_millis(60),
            set_aside: Duration::from_millis(150),
        };
        let ask = Arc::new(
            AskGate::new()
                .with_times(times)
                .with_rules_home(root.join("home")),
        );
        let env = AwayEnv {
            ask: ask.clone(),
            cards: Default::default(),
            nudges: Default::default(),
            // Four times the set-aside: a card that is back is not set
            // aside a second time.
            answer_after: Duration::from_millis(600),
        };
        let chat = session.id.clone();
        let cancel = CancellationToken::new();
        let started = std::time::Instant::now();
        let end = run_agent_turn(
            AgentTurnRun {
                agent: &mut agent,
                session: &mut session,
                chat_id: &chat,
                input: TurnInput::from("publish it"),
                spoken: false,
                wire_note: None,
                council: None,
                cancel: &cancel,
                ask_dir: Some(ask_dir.clone()),
                ask: &ask,
            },
            &env,
        )
        .await;
        let Ok(AgentTurnEnd::Done { outcome, .. }) = end else {
            panic!("{:?}", end.err());
        };
        // Two cards: the first, and the same call back at the end.
        assert_eq!(
            *env.cards.lock().unwrap(),
            [
                ("toolu_1".to_string(), false),
                ("toolu_2".to_string(), true)
            ]
        );
        // The first card: reminded, then set aside. The second: neither.
        assert_eq!(
            *env.nudges.lock().unwrap(),
            [
                ("toolu_1".to_string(), Nudge::Remind),
                ("toolu_1".to_string(), Nudge::SetAside)
            ]
        );
        // Set aside is a skip, in words that say so — and the call did not run.
        let first: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("decision-1.json")).unwrap()).unwrap();
        assert_eq!(first["tool_use_id"], "toolu_1");
        assert_eq!(first["decision"], "deny");
        assert_eq!(first["reason"], AUTO_LATER_REASON);
        assert!(
            !root.join("ran-1").exists(),
            "a set-aside call must never run"
        );
        // Asked again at the end, it waited for him (past the set-aside
        // time) and ran on his Allow.
        assert!(started.elapsed() >= times.set_aside + env.answer_after);
        let second: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("decision-2.json")).unwrap()).unwrap();
        assert_eq!(
            (&second["tool_use_id"], &second["decision"]),
            (&serde_json::json!("toolu_2"), &serde_json::json!("allow"))
        );
        assert!(root.join("ran-2").exists());
        // It came back, so the reply ends with no "did not run" notice.
        assert!(
            !outcome.notices.iter().any(|n| n.contains("set aside")),
            "{:?}",
            outcome.notices
        );
        assert!(!ask.has("toolu_1") && !ask.has("toolu_2"));
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- item 783's finish: Allow always, and runs nobody is there for ----

    /// Keeps every card (id, kind, back) and nudge; answers each card at
    /// once with the next of `answers`, unless `unattended`.
    struct CardEnv {
        ask: Arc<AskGate>,
        answers: std::sync::Mutex<Vec<Answer>>,
        cards: std::sync::Mutex<Vec<(String, Option<&'static str>, bool)>>,
        nudges: std::sync::Mutex<Vec<(String, crate::agent::ask::Nudge)>>,
        unattended: bool,
        /// He has left (the runaway guard applies), item 788's tests.
        left: bool,
    }

    impl CardEnv {
        fn left_alone(mut self) -> Self {
            self.left = true;
            self
        }

        fn new(ask: Arc<AskGate>, answers: Vec<Answer>, unattended: bool) -> Self {
            Self {
                ask,
                answers: std::sync::Mutex::new(answers),
                cards: Default::default(),
                nudges: Default::default(),
                unattended,
                left: false,
            }
        }
    }

    #[async_trait::async_trait]
    impl TurnEnv for CardEnv {
        fn event(&self, _chat: &str, _event: &TurnEvent) {}
        fn notice(&self, _text: String) {}
        fn approval(&self, prompt: &ApprovalPrompt<'_>) {
            self.cards
                .lock()
                .unwrap()
                .push((prompt.id.to_string(), prompt.kind, prompt.back));
            let mut answers = self.answers.lock().unwrap();
            if !answers.is_empty() {
                // The turn registers the wait before it shows the card.
                let a = answers.remove(0);
                assert!(self.ask.answer(prompt.id, a), "no wait for {}", prompt.id);
            }
        }
        fn nudge(&self, nudge: &ApprovalNudge<'_>) {
            self.nudges
                .lock()
                .unwrap()
                .push((nudge.id.to_string(), nudge.stage));
        }
        fn unattended(&self) -> bool {
            self.unattended
        }
        fn unwatched(&self, _chat: &str) -> bool {
            self.left
        }
        async fn grant_to_project(&self, _dir: &Path) -> ProjectGrant {
            ProjectGrant::NoProject
        }
    }

    /// One turn of a read-only chat whose task needs `tool` (the stand-in
    /// defers it, then makes it again as its last step), under `env`.
    async fn read_only_turn(
        root: &Path,
        tool: &str,
        env: &CardEnv,
    ) -> (Result<AgentTurnEnd, String>, PathBuf) {
        read_only_turn_by(root, tool, env, stand_in_deferring)
            .await
            .0
    }

    /// [`read_only_turn`] with its stand-in `claude` made by `stand_in`;
    /// the turn's log too.
    async fn read_only_turn_by(
        root: &Path,
        tool: &str,
        env: &CardEnv,
        stand_in: fn(&Path, &Path, &str) -> String,
    ) -> ((Result<AgentTurnEnd, String>, PathBuf), Vec<SessionEvent>) {
        let logs = root.join("sessions");
        std::fs::create_dir_all(&logs).unwrap();
        let mut session = Session::start(&logs, ChatMode::Normal, ChatKind::Build).unwrap();
        let ask_dir = root.join("ask").join(&session.id);
        let mut spec = AgentSpec::new(root);
        spec.binary = stand_in(root, &ask_dir, tool);
        spec.chat_policy = true;
        let mut agent = ClaudeCodeAgent::new(spec);
        agent.set_ask_dir(ask_dir.clone());
        let chat = session.id.clone();
        let cancel = CancellationToken::new();
        let end = run_agent_turn(
            AgentTurnRun {
                agent: &mut agent,
                session: &mut session,
                chat_id: &chat,
                input: TurnInput::from("do the thing"),
                spoken: false,
                wire_note: None,
                council: None,
                cancel: &cancel,
                ask_dir: Some(ask_dir.clone()),
                ask: &env.ask,
            },
            env,
        )
        .await
        .map_err(|e| format!("{e:?}"));
        ((end, ask_dir), session.events().to_vec())
    }

    /// Item 788's stand-in `claude`: makes the same call, is refused,
    /// makes it again — five times over, each a deferral like
    /// [`stand_in_deferring`]'s and each refusal the result the CLI hands
    /// back for a denied call — then ends. Each process notes the result
    /// count it reached in `<root>/refused`.
    fn stand_in_refusing(root: &Path, _ask_dir: &Path, tool: &str) -> String {
        let reason = crate::agent::ask::UNATTENDED_REASON;
        let body = format!(
            r##"#!/bin/sh
D="{d}"
printf '%s\n' '{{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-1"}}'
N=$(cat "$D/n" 2>/dev/null || echo 0)
if [ "$N" -gt 0 ]; then
  printf '%s\n' '{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"toolu_'"$N"'","content":"{reason}","is_error":true}}]}},"parent_tool_use_id":null}}'
  echo "$N" > "$D/refused"
fi
if [ "$N" -ge 5 ]; then
  printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"gave up"}}]}},"parent_tool_use_id":null}}'
  printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"gave up","session_id":"s-1","stop_reason":"end_turn","usage":{{"input_tokens":3,"output_tokens":2}}}}'
  exit 0
fi
M=$((N+1))
echo "$M" > "$D/n"
printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"toolu_'"$M"'","name":"{t}","input":{{"id":"r-7"}}}}]}},"parent_tool_use_id":null}}'
printf '%s\n' '{{"type":"result","subtype":"success","stop_reason":"tool_deferred","terminal_reason":"tool_deferred","is_error":false,"num_turns":1,"result":"","permission_denials":[],"session_id":"s-1","deferred_tool_use":{{"id":"toolu_'"$M"'","name":"{t}","input":{{"id":"r-7"}}}}}}'
"##,
            d = root.display(),
            t = tool,
        );
        let path = root.join("claude-refused");
        std::fs::write(&path, body).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn turn_text(log: &[SessionEvent]) -> String {
        log.iter()
            .filter_map(|e| match e {
                SessionEvent::AssistantMessage { blocks, .. } => Some(blocks),
                _ => None,
            })
            .flatten()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Item 788: an unattended run (a job's at night: nobody at the Mac, no
    /// phone connected) whose read-only connector call is refused three
    /// times the same way ends — its record and the line that says why,
    /// one push (the first set-aside's), no stuck card and no wait.
    #[tokio::test]
    async fn an_unattended_run_refused_three_times_ends_with_one_push() {
        let root = std::env::temp_dir().join(format!("nightloom-788-{}", uuid::Uuid::new_v4()));
        let tool = "mcp__claude_ai_Acme__inspect_record";
        let ask = Arc::new(AskGate::new().with_rules_home(root.join("home")));
        let env = CardEnv::new(ask.clone(), Vec::new(), true).left_alone();
        let started = std::time::Instant::now();
        let ((end, _), log) = read_only_turn_by(&root, tool, &env, stand_in_refusing).await;
        let Ok(AgentTurnEnd::Done { outcome, .. }) = end else {
            panic!("{:?}", end.err());
        };
        assert!(
            started.elapsed() < std::time::Duration::from_secs(30),
            "no wait"
        );
        assert!(
            env.cards.lock().unwrap().is_empty(),
            "no card, stuck or other"
        );
        assert_eq!(
            *env.nudges.lock().unwrap(),
            [("toolu_1".to_string(), crate::agent::ask::Nudge::Unattended)],
            "one push"
        );
        let refused = std::fs::read_to_string(root.join("refused")).unwrap_or_default();
        assert_eq!(refused.trim(), "3", "ended at the third refusal");
        let results = log
            .iter()
            .filter(|e| matches!(e, SessionEvent::ToolResult { .. }))
            .count();
        // The three refusals, and the fourth call's cut-off result the log
        // keeps so the transcript replays (that call was never refused).
        assert_eq!(results, 4, "the record is kept");
        let text = turn_text(&log);
        assert!(text.contains("was refused 3 times in a row"), "{text}");
        assert!(text.contains(crate::runaway::STOPPED_PREFIX), "{text}");
        assert!(outcome.deferred.is_none());
        assert!(
            outcome
                .notices
                .iter()
                .any(|n| *n == unattended_notice(tool)),
            "{:?}",
            outcome.notices
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The other side (item 788): he has left the Mac but his phone is
    /// connected, so somebody can press the card — the run keeps it.
    #[tokio::test]
    async fn a_refused_loop_somebody_can_answer_keeps_the_stuck_card() {
        let root = std::env::temp_dir().join(format!("nightloom-788w-{}", uuid::Uuid::new_v4()));
        let tool = "mcp__claude_ai_Acme__inspect_record";
        let ask = Arc::new(AskGate::new().with_rules_home(root.join("home")));
        let deny = || Answer::Deny {
            reason: "no".into(),
        };
        // A Deny for every card it may show: the connector's, each time, and
        // the stuck card's (his Stop).
        let env = CardEnv::new(ask.clone(), (0..6).map(|_| deny()).collect(), false).left_alone();
        let ((end, _), log) = read_only_turn_by(&root, tool, &env, stand_in_refusing).await;
        assert!(
            matches!(end, Ok(AgentTurnEnd::Done { .. })),
            "{:?}",
            end.err()
        );
        let cards = env.cards.lock().unwrap().clone();
        let stuck = cards
            .iter()
            .filter(|c| c.0.starts_with(crate::runaway::STUCK_TOOL))
            .count();
        assert_eq!(stuck, 1, "{cards:?}");
        assert!(
            cards
                .last()
                .unwrap()
                .0
                .starts_with(crate::runaway::STUCK_TOOL),
            "{cards:?}"
        );
        // His Stop on the card: the Stop line, not the unattended end's.
        let text = turn_text(&log);
        assert!(text.contains("you chose Stop"), "{text}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Item 783's finish (the spec's step 3): *Allow always* on a
    /// read-only chat's connector card runs the call and keeps the action
    /// as a read in the every-chat set — the shared allowance the other
    /// host gets at the next sync — and never in the chat's own "Allow for
    /// this chat" list; the next call to it is no longer a connector card.
    #[tokio::test]
    async fn allow_always_on_a_connector_card_saves_the_shared_allowance() {
        let root = std::env::temp_dir().join(format!("nightloom-783f-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        let tool = "mcp__claude_ai_Acme__inspect_record";
        let ask = Arc::new(AskGate::new().with_rules_home(home.clone()));
        let allow = Answer::Allow {
            updated_input: None,
            plan_then: None,
            grant: None,
        };
        let env = CardEnv::new(
            ask.clone(),
            vec![
                Answer::AllowForChat {
                    updated_input: None,
                },
                allow,
            ],
            false,
        );
        assert!(!crate::approval_rules::is_read(Some(&home), tool));
        let (end, ask_dir) = read_only_turn(&root, tool, &env).await;
        assert!(
            matches!(end, Ok(AgentTurnEnd::Done { .. })),
            "{:?}",
            end.err()
        );
        let cards = env.cards.lock().unwrap().clone();
        assert_eq!(cards[0], ("toolu_1".to_string(), Some("connector"), false));
        // Kept for every read-only chat, in the shared set…
        assert!(crate::approval_rules::is_read(Some(&home), tool));
        let shared = crate::approval_rules::shared::get(&home);
        assert_eq!(shared.shared.reads, [tool.to_string()]);
        // …not in this chat's own list.
        assert!(!AskDir::new(&ask_dir).allowed().contains(&tool.to_string()));
        // The call ran on that answer.
        let first: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("decision-1.json")).unwrap()).unwrap();
        assert_eq!(first["decision"], "allow");
        assert!(root.join("ran-1").exists());
        // The same action again is no longer a connector card.
        assert_eq!(cards.get(1).map(|c| c.1), Some(None));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Item 783's finish (step 2): in a run nobody is there for, a
    /// read-only chat's card is never shown and never waited on — the phone
    /// is told, the call is set aside at once and never runs, the run
    /// finishes, and its end lists the call. The model making it again is
    /// set aside again, not waited on.
    #[tokio::test]
    async fn an_unattended_run_sets_a_read_only_card_aside_at_once_and_finishes() {
        use crate::agent::ask::{Nudge, UNATTENDED_REASON};
        let root = std::env::temp_dir().join(format!("nightloom-783f-{}", uuid::Uuid::new_v4()));
        let tool = "mcp__claude_ai_Acme__inspect_record";
        let ask = Arc::new(AskGate::new().with_rules_home(root.join("home")));
        let env = CardEnv::new(ask.clone(), Vec::new(), true);
        let started = std::time::Instant::now();
        let (end, _) = read_only_turn(&root, tool, &env).await;
        let Ok(AgentTurnEnd::Done { outcome, .. }) = end else {
            panic!("{:?}", end.err());
        };
        // Well inside the 3:30 set-aside: nothing waited.
        assert!(started.elapsed() < std::time::Duration::from_secs(30));
        assert!(env.cards.lock().unwrap().is_empty(), "no card is shown");
        // The same call set aside again is not pushed again (item 788).
        assert_eq!(
            *env.nudges.lock().unwrap(),
            [("toolu_1".to_string(), Nudge::Unattended)]
        );
        for n in [1, 2] {
            let d: serde_json::Value = serde_json::from_slice(
                &std::fs::read(root.join(format!("decision-{n}.json"))).unwrap(),
            )
            .unwrap();
            assert_eq!(
                (&d["decision"], &d["reason"]),
                (
                    &serde_json::json!("deny"),
                    &serde_json::json!(UNATTENDED_REASON)
                )
            );
            assert!(!root.join(format!("ran-{n}")).exists(), "never run");
        }
        assert!(
            outcome
                .notices
                .iter()
                .any(|n| *n == unattended_notice(tool)),
            "{:?}",
            outcome.notices
        );
        assert!(!ask.has("toolu_1") && !ask.has("toolu_2"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The other side of it: an unattended run's *ordinary* card (not a
    /// read-only chat's) is not this rule's — it shows and waits as before.
    #[tokio::test]
    async fn an_unattended_run_still_shows_an_ordinary_card() {
        let root = std::env::temp_dir().join(format!("nightloom-783f-{}", uuid::Uuid::new_v4()));
        let logs = root.join("sessions");
        std::fs::create_dir_all(&logs).unwrap();
        let mut session = Session::start(&logs, ChatMode::Normal, ChatKind::Build).unwrap();
        let ask_dir = root.join("ask").join(&session.id);
        let mut spec = AgentSpec::new(&root);
        spec.binary = publishing_stand_in(&root, &ask_dir);
        let mut agent = ClaudeCodeAgent::new(spec);
        agent.set_ask_dir(ask_dir.clone());
        let allow = || Answer::Allow {
            updated_input: None,
            plan_then: None,
            grant: None,
        };
        let ask = Arc::new(AskGate::new().with_rules_home(root.join("home")));
        let env = CardEnv::new(ask.clone(), vec![allow(), allow()], true);
        let chat = session.id.clone();
        let cancel = CancellationToken::new();
        let end = run_agent_turn(
            AgentTurnRun {
                agent: &mut agent,
                session: &mut session,
                chat_id: &chat,
                input: TurnInput::from("publish it"),
                spoken: false,
                wire_note: None,
                council: None,
                cancel: &cancel,
                ask_dir: Some(ask_dir.clone()),
                ask: &ask,
            },
            &env,
        )
        .await;
        assert!(matches!(end, Ok(AgentTurnEnd::Done { .. })));
        assert_eq!(
            env.cards.lock().unwrap()[0],
            ("toolu_1".to_string(), None, false)
        );
        assert!(env.nudges.lock().unwrap().is_empty());
        assert!(root.join("ran-1").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Answers the card the moment it is shown, and keeps the turn's events.
    struct AskEnv {
        timing: Arc<TurnTiming>,
        ask: Arc<AskGate>,
        answer: std::sync::Mutex<Option<Answer>>,
        events: std::sync::Mutex<Vec<String>>,
        waiting_at_card: std::sync::Mutex<Option<bool>>,
        ask_dir: PathBuf,
    }

    #[async_trait::async_trait]
    impl TurnEnv for AskEnv {
        fn event(&self, _chat: &str, event: &TurnEvent) {
            let line = match event {
                TurnEvent::ToolResult { tool_use_id, .. } => format!("result {tool_use_id}"),
                TurnEvent::MessageDelivered {
                    id, text, after, ..
                } => format!("delivered {id} [{text}] {after}"),
                _ => return,
            };
            self.events.lock().unwrap().push(line);
        }
        fn notice(&self, _text: String) {}
        fn approval(&self, prompt: &ApprovalPrompt<'_>) {
            *self.waiting_at_card.lock().unwrap() =
                Some(AskDir::new(&self.ask_dir).waiting().is_some());
            if let Some(a) = self.answer.lock().unwrap().take() {
                self.ask.answer(prompt.id, a);
            }
        }
        async fn grant_to_project(&self, _dir: &Path) -> ProjectGrant {
            ProjectGrant::NoProject
        }
        fn timing(&self) -> Option<Arc<TurnTiming>> {
            Some(self.timing.clone())
        }
    }

    struct Asked {
        end: Result<AgentTurnEnd, String>,
        events: Vec<String>,
        log: Vec<SessionEvent>,
        root: PathBuf,
        ask_dir: PathBuf,
        waiting_at_card: Option<bool>,
    }

    /// One turn that asks a question, answered with `answer`; the resume
    /// behaves as `resume` says.
    async fn asked(answer: Answer, resume: &str) -> Asked {
        let root = std::env::temp_dir().join(format!("nightloom-522-{}", uuid::Uuid::new_v4()));
        let logs = root.join("sessions");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(root.join("resume"), resume).unwrap();
        let mut session = Session::start(&logs, ChatMode::Normal, ChatKind::Build).unwrap();
        let ask_dir = root.join("ask").join(&session.id);
        let mut spec = AgentSpec::new(&root);
        spec.binary = asking_stand_in(&root, &ask_dir);
        let mut agent = ClaudeCodeAgent::new(spec);
        agent.set_ask_dir(ask_dir.clone());
        let ask = Arc::new(AskGate::new());
        let env = AskEnv {
            timing: TurnTiming::begin(turn_timing::DESKTOP, None, None),
            ask: ask.clone(),
            answer: std::sync::Mutex::new(Some(answer)),
            events: Default::default(),
            waiting_at_card: Default::default(),
            ask_dir: ask_dir.clone(),
        };
        let chat = session.id.clone();
        let cancel = CancellationToken::new();
        let end = run_agent_turn(
            AgentTurnRun {
                agent: &mut agent,
                session: &mut session,
                chat_id: &chat,
                input: TurnInput::from("hello"),
                spoken: false,
                wire_note: None,
                council: None,
                cancel: &cancel,
                ask_dir: Some(ask_dir.clone()),
                ask: &ask,
            },
            &env,
        )
        .await
        .map_err(|e| e.to_string());
        Asked {
            end,
            events: env.events.lock().unwrap().clone(),
            log: session.events().to_vec(),
            waiting_at_card: *env.waiting_at_card.lock().unwrap(),
            root,
            ask_dir,
        }
    }

    fn users(log: &[SessionEvent]) -> Vec<String> {
        log.iter()
            .filter_map(|e| match e {
                SessionEvent::UserMessage { text, .. } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    /// Item 522: Skip resumes the turn and it ends idle — the refusal is
    /// the call's result, the reply follows, and nothing is left waiting.
    #[tokio::test]
    async fn a_skipped_question_resumes_and_the_turn_ends() {
        let a = asked(
            Answer::Deny {
                reason: "the user skipped the question; decide yourself".into(),
            },
            "refuse",
        )
        .await;
        assert!(
            matches!(a.end, Ok(AgentTurnEnd::Done { .. })),
            "{:?}",
            a.end.as_ref().err()
        );
        assert_eq!(a.events, vec!["result toolu_q"]);
        assert_eq!(
            a.waiting_at_card,
            Some(true),
            "the wait is on disk while the card is up"
        );
        assert!(
            AskDir::new(&a.ask_dir).waiting().is_none(),
            "and gone once resumed"
        );
        let seen = std::fs::read_to_string(a.root.join("decision-seen.json")).unwrap();
        assert!(
            seen.contains(r#""decision":"deny""#) && seen.contains("skipped the question"),
            "{seen}"
        );
        assert_eq!(users(&a.log), vec!["hello"]);
        let _ = std::fs::remove_dir_all(&a.root);
    }

    /// Item 522: a message sent while the question waits refuses the call
    /// with his words as the reason, and — once that result has landed —
    /// is reported delivered under the window's id and kept on the log as
    /// his message, after the call's result.
    #[tokio::test]
    async fn a_message_sent_instead_of_an_answer_is_the_refusal_and_his_message() {
        let a = asked(
            Answer::Reply {
                id: Some("row-7".into()),
                text: "you are missing context: nothing is decided yet".into(),
            },
            "refuse",
        )
        .await;
        assert!(
            matches!(a.end, Ok(AgentTurnEnd::Done { .. })),
            "{:?}",
            a.end.as_ref().err()
        );
        let seen = std::fs::read_to_string(a.root.join("decision-seen.json")).unwrap();
        assert!(seen.contains(r#""decision":"deny""#), "{seen}");
        assert!(seen.contains("replied with a message instead"), "{seen}");
        assert!(seen.contains("nothing is decided yet"), "{seen}");
        assert_eq!(
            a.events,
            vec![
                "result toolu_q".to_string(),
                "delivered row-7 [you are missing context: nothing is decided yet] in place of an answer to AskUserQuestion".to_string(),
            ]
        );
        assert_eq!(
            users(&a.log),
            vec!["hello", "you are missing context: nothing is decided yet"]
        );
        // The order the model read them in: the call, its result, his words, the reply.
        let kinds: Vec<&str> = a
            .log
            .iter()
            .filter_map(|e| match e {
                SessionEvent::UserMessage { .. } => Some("user"),
                SessionEvent::AssistantMessage { .. } => Some("assistant"),
                SessionEvent::ToolResult { .. } => Some("result"),
                _ => None,
            })
            .collect();
        assert_eq!(
            kinds,
            vec!["user", "assistant", "result", "user", "assistant"]
        );
        let _ = std::fs::remove_dir_all(&a.root);
    }

    /// Item 522: a resume that fails ends the turn with an error rather
    /// than waiting for ever, and reports no delivery — his message is
    /// still the window's to send.
    #[tokio::test]
    async fn a_failed_resume_ends_the_turn_with_an_error_and_delivers_nothing() {
        let a = asked(
            Answer::Reply {
                id: Some("row-8".into()),
                text: "more context".into(),
            },
            "die",
        )
        .await;
        let failed = match &a.end {
            Err(_) => true,
            Ok(AgentTurnEnd::Done { outcome, .. }) => outcome.is_error,
            Ok(_) => false,
        };
        assert!(failed, "{:?}", a.end.as_ref().err());
        assert!(a.events.is_empty(), "{:?}", a.events);
        assert_eq!(users(&a.log), vec!["hello"]);
        assert!(AskDir::new(&a.ask_dir).waiting().is_none());
        let _ = std::fs::remove_dir_all(&a.root);
    }

    /// Item 522: a card the app was closed on. The chat's next message
    /// refuses the call on disk before its process starts, so the turn
    /// runs instead of parking on a question nobody can see.
    #[tokio::test]
    async fn a_card_left_by_a_closed_app_is_refused_at_the_next_message() {
        let root = std::env::temp_dir().join(format!("nightloom-522-{}", uuid::Uuid::new_v4()));
        let logs = root.join("sessions");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(root.join("plain"), "").unwrap();
        let mut session = Session::start(&logs, ChatMode::Normal, ChatKind::Build).unwrap();
        let ask_dir = root.join("ask").join(&session.id);
        let call = crate::agent::DeferredCall {
            id: "toolu_q".into(),
            name: "AskUserQuestion".into(),
            input: serde_json::json!({ "questions": [] }),
        };
        AskDir::new(&ask_dir)
            .set_waiting(Some("s-1"), &call)
            .unwrap();
        let mut spec = AgentSpec::new(&root);
        spec.binary = asking_stand_in(&root, &ask_dir);
        spec.resume = Some("s-1".into());
        let mut agent = ClaudeCodeAgent::new(spec);
        agent.set_ask_dir(ask_dir.clone());
        let ask = Arc::new(AskGate::new());
        let env = AskEnv {
            timing: TurnTiming::begin(turn_timing::DESKTOP, None, None),
            ask: ask.clone(),
            answer: Default::default(),
            events: Default::default(),
            waiting_at_card: Default::default(),
            ask_dir: ask_dir.clone(),
        };
        let chat = session.id.clone();
        let cancel = CancellationToken::new();
        let end = run_agent_turn(
            AgentTurnRun {
                agent: &mut agent,
                session: &mut session,
                chat_id: &chat,
                input: TurnInput::from("my next message"),
                spoken: false,
                wire_note: None,
                council: None,
                cancel: &cancel,
                ask_dir: Some(ask_dir.clone()),
                ask: &ask,
            },
            &env,
        )
        .await;
        assert!(
            matches!(end, Ok(AgentTurnEnd::Done { .. })),
            "{:?}",
            end.as_ref().err()
        );
        let seen = std::fs::read_to_string(root.join("decision-seen.json")).unwrap();
        assert!(
            seen.contains("toolu_q") && seen.contains(r#""decision":"deny""#),
            "{seen}"
        );
        assert!(
            seen.contains("Nightloom was closed before the user answered"),
            "{seen}"
        );
        assert!(AskDir::new(&ask_dir).waiting().is_none());
        assert_eq!(
            *env.waiting_at_card.lock().unwrap(),
            None,
            "no card was shown"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// The turn's notice for a call he set aside that did not come back.
pub fn set_aside_notice(tool: &str) -> String {
    format!(
        "You set {tool} aside and the reply ended without that same call coming back, so it did not run. Ask for it when you want it."
    )
}

/// Why a call was set aside in this reply (items 743, 783).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Aside {
    /// His "Not now — carry on".
    Later,
    /// Nobody answered the card in time.
    Unanswered,
    /// A read-only chat's card in a run nobody was there for.
    Unattended,
}

/// The same for a read-only chat's card in an unattended run (item 783's
/// finish): never shown, so never "waited".
pub fn unattended_notice(tool: &str) -> String {
    format!(
        "{tool} needed your approval while nobody was there to give it, so it was set aside and did not run. Ask for it when you want it."
    )
}

/// The same for a call set aside because nobody answered (item 783).
pub fn unanswered_notice(tool: &str) -> String {
    format!(
        "{tool} waited for your answer, was set aside, and the reply ended without that same call coming back, so it did not run. Ask for it when you want it."
    )
}

#[cfg(test)]
mod reply_end_tests {
    use super::*;

    /// Item 552: his takeover of Claude's browser does not outlive a turn
    /// edge — a new turn starts with the browser the model's, and a turn
    /// that ends (any way: done, stopped, failed — the guard's drop) hands
    /// it back.
    #[test]
    fn a_turn_edge_hands_claudes_browser_back() {
        let dir = std::env::temp_dir().join(format!("nl-552-reply-end-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ask = AskDir::new(&dir);
        ask.set_held_by_user(true).unwrap();
        let guard = ReplyEnd::begin(&dir);
        assert!(
            !ask.held_by_user(),
            "a new turn starts with the model holding"
        );
        ask.set_held_by_user(true).unwrap();
        drop(guard);
        assert!(!ask.held_by_user(), "the turn's end hands it back");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Item 784: the runaway guard, end to end through a stand-in `claude`.
#[cfg(all(test, unix))]
mod runaway_tests {
    use super::*;
    use crate::agent::AgentSpec;
    use crate::runaway::STUCK_TOOL;
    use nightloom_core::ChatKind;

    /// A stand-in `claude`. Its first run does what `<root>/mode` says:
    /// `loop` runs `cargo test` and gets the same failure each time, then
    /// keeps going (slowly) until it is interrupted; `poll` runs `gh run
    /// view` five times with a changing output and ends. A later run (the
    /// Continue's resume) keeps its argv and says "carried on".
    fn stand_in(root: &Path) -> String {
        let d = root.display();
        let init = r#"{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-1"}"#;
        let body = format!(
            r##"#!/bin/sh
D="{d}"
trap 'exit 130' INT
printf '%s\n' '{init}'
if [ -f "$D/ran" ]; then
  printf '%s\n' "$@" > "$D/argv2"
  head -n 1 > "$D/stdin2"
  printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"carried on"}}]}},"parent_tool_use_id":null}}'
  printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"carried on","session_id":"s-1","stop_reason":"end_turn","usage":{{"input_tokens":3,"output_tokens":2}}}}'
  exit 0
fi
touch "$D/ran"
mode=$(cat "$D/mode")
i=0
while [ $i -lt 8 ]; do
  if [ "$mode" = poll ]; then cmd="gh run view"; out="$i of 5 done"; err=false; else cmd="cargo test"; out="error[E0425]: cannot find value"; err=true; fi
  if [ "$mode" = poll ] && [ $i -ge 5 ]; then break; fi
  printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"t'$i'","name":"Bash","input":{{"command":"'"$cmd"'"}}}}]}},"parent_tool_use_id":null}}'
  printf '%s\n' '{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t'$i'","content":"'"$out"'","is_error":'$err'}}]}},"parent_tool_use_id":null}}'
  echo $i > "$D/calls"
  i=$((i+1))
  if [ "$mode" = loop ]; then n=0; while [ $n -lt 10 ]; do sleep 0.05; n=$((n+1)); done; fi
done
printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"all done"}}]}},"parent_tool_use_id":null}}'
printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"all done","session_id":"s-1","stop_reason":"end_turn","usage":{{"input_tokens":3,"output_tokens":2}}}}'
"##
        );
        let path = root.join("claude-runaway");
        std::fs::write(&path, body).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    /// Answers the stuck card as told; keeps every card and push it made.
    struct GuardEnv {
        ask: Arc<AskGate>,
        answer: std::sync::Mutex<Option<Answer>>,
        cards: std::sync::Mutex<Vec<(String, serde_json::Value, Option<String>)>>,
        unattended: bool,
    }

    #[async_trait::async_trait]
    impl TurnEnv for GuardEnv {
        fn event(&self, _chat: &str, _event: &TurnEvent) {}
        fn notice(&self, _text: String) {}
        fn approval(&self, prompt: &ApprovalPrompt<'_>) {
            self.cards.lock().unwrap().push((
                prompt.name.to_string(),
                prompt.input.clone(),
                prompt.reason.clone(),
            ));
            if let Some(a) = self.answer.lock().unwrap().take() {
                self.ask.answer(prompt.id, a);
            }
        }
        async fn grant_to_project(&self, _dir: &Path) -> ProjectGrant {
            ProjectGrant::NoProject
        }
        fn unwatched(&self, _chat: &str) -> bool {
            self.unattended
        }
    }

    struct Ran {
        end: Result<AgentTurnEnd, String>,
        cards: Vec<(String, serde_json::Value, Option<String>)>,
        log: Vec<SessionEvent>,
        root: PathBuf,
        calls: u32,
    }

    async fn run(mode: &str, answer: Option<Answer>, unattended: bool) -> Ran {
        let root = std::env::temp_dir().join(format!("nightloom-784-{}", uuid::Uuid::new_v4()));
        let logs = root.join("sessions");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(root.join("mode"), mode).unwrap();
        let mut session = Session::start(&logs, ChatMode::Normal, ChatKind::Build).unwrap();
        let ask_dir = root.join("ask").join(&session.id);
        let mut spec = AgentSpec::new(&root);
        spec.binary = stand_in(&root);
        let mut agent = ClaudeCodeAgent::new(spec);
        agent.set_ask_dir(ask_dir.clone());
        let ask = Arc::new(AskGate::new());
        let env = GuardEnv {
            ask: ask.clone(),
            answer: std::sync::Mutex::new(answer),
            cards: std::sync::Mutex::new(Vec::new()),
            unattended,
        };
        let cancel = CancellationToken::new();
        let chat = session.id.clone();
        let end = run_agent_turn(
            AgentTurnRun {
                agent: &mut agent,
                session: &mut session,
                chat_id: &chat,
                input: TurnInput::from("fix the build"),
                spoken: false,
                wire_note: None,
                council: None,
                cancel: &cancel,
                ask_dir: Some(ask_dir),
                ask: &ask,
            },
            &env,
        )
        .await;
        let calls = std::fs::read_to_string(root.join("calls"))
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .map_or(0, |n| n + 1);
        Ran {
            end,
            cards: env.cards.into_inner().unwrap(),
            log: session.events().to_vec(),
            root,
            calls,
        }
    }

    fn reply_text(log: &[SessionEvent]) -> String {
        log.iter()
            .filter_map(|e| match e {
                SessionEvent::AssistantMessage { blocks, .. } => Some(blocks),
                _ => None,
            })
            .flatten()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// A run looping on one failing command pauses after the third
    /// identical call: the CLI is stopped there (no fourth), and the card
    /// — the push's source — says what it ran.
    #[tokio::test]
    async fn a_loop_on_one_failing_command_pauses_after_the_third_and_stop_keeps_the_record() {
        let r = run(
            "loop",
            Some(Answer::Deny {
                reason: "stop".into(),
            }),
            true,
        )
        .await;
        assert!(
            matches!(r.end, Ok(AgentTurnEnd::Done { .. })),
            "{:?}",
            r.end.as_ref().err()
        );
        assert_eq!(r.calls, 3, "interrupted after the third call");
        assert_eq!(r.cards.len(), 1);
        let (name, input, reason) = &r.cards[0];
        assert_eq!(name, STUCK_TOOL);
        assert_eq!(input["shown"], "cargo test");
        assert_eq!(input["count"], 3);
        let line = "Looks stuck: ran `cargo test` 3 times, same result";
        assert_eq!(reason.as_deref(), Some(line));
        // The push the card makes: its own kind, and the line as its body.
        assert_eq!(
            crate::push::What::for_prompt(name),
            crate::push::What::Stuck
        );
        // Stop: the record is kept — the three calls and their results, and
        // the line that says why — and nothing ran after.
        let results = r
            .log
            .iter()
            .filter(|e| matches!(e, SessionEvent::ToolResult { .. }))
            .count();
        assert_eq!(results, 3);
        let text = reply_text(&r.log);
        assert!(text.contains(crate::runaway::STOPPED_PREFIX), "{text}");
        assert!(!r.root.join("argv2").exists(), "no resume after Stop");
        let _ = std::fs::remove_dir_all(&r.root);
    }

    /// Continue resumes the same CLI session with the note, and the run
    /// ends as any turn does.
    #[tokio::test]
    async fn continue_resumes_the_same_session() {
        let r = run(
            "loop",
            Some(Answer::Allow {
                updated_input: None,
                plan_then: None,
                grant: None,
            }),
            true,
        )
        .await;
        assert!(matches!(r.end, Ok(AgentTurnEnd::Done { .. })));
        assert_eq!(r.cards.len(), 1);
        let argv = std::fs::read_to_string(r.root.join("argv2")).expect("resumed");
        assert!(argv.contains("--resume\ns-1"), "{argv}");
        let sent = std::fs::read_to_string(r.root.join("stdin2")).unwrap_or_default();
        assert!(sent.contains("chose Continue"), "{sent}");
        assert!(reply_text(&r.log).contains("carried on"));
        let _ = std::fs::remove_dir_all(&r.root);
    }

    /// A poll whose output changes is never paused.
    #[tokio::test]
    async fn a_poll_whose_output_changes_is_not_paused() {
        let r = run("poll", None, true).await;
        assert!(matches!(r.end, Ok(AgentTurnEnd::Done { .. })));
        assert!(r.cards.is_empty());
        assert_eq!(r.calls, 5);
        assert!(reply_text(&r.log).contains("all done"));
        let _ = std::fs::remove_dir_all(&r.root);
    }

    /// While he watches, the loop is his to see: no pause.
    #[tokio::test]
    async fn a_watched_run_is_not_paused() {
        let r = run("loop", None, false).await;
        assert!(matches!(r.end, Ok(AgentTurnEnd::Done { .. })));
        assert!(r.cards.is_empty());
        assert_eq!(r.calls, 8);
        let _ = std::fs::remove_dir_all(&r.root);
    }
}
