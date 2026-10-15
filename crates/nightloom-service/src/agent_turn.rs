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
    AgentOutcome, Answer, AskDir, AskGate, ClaudeCodeAgent, GrantScope, Recorder, carry_transcript,
    outside_folder,
};
use crate::council::{self, CouncilRequest};
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
}

/// Playwright's *Allow once* and *Deny* last for one reply (nightshift
/// backlog 367): cleared as the turn starts — a crash may have left one —
/// and when it ends, whichever way it ends.
struct ReplyEnd(AskDir);

impl ReplyEnd {
    fn begin(dir: &Path) -> Self {
        let d = AskDir::new(dir);
        d.end_reply();
        Self(d)
    }
}

impl Drop for ReplyEnd {
    fn drop(&mut self) {
        self.0.end_reply();
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
    /// Keep `dir` on the turn's project (the card's *let the project see
    /// it*).
    async fn grant_to_project(&self, dir: &Path) -> ProjectGrant;
    /// The message's timing line, begun where the host's command was
    /// entered (item 256); `None` begins one at the turn's first line, as
    /// `serve` does, with no window stages.
    fn timing(&self) -> Option<Arc<TurnTiming>> {
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
    // The first text handed to the window (or the phone) — item 256.
    let mut emitted = false;
    // The model's words before a call, for Playwright's card (backlog 367).
    let reason = std::sync::Mutex::new(crate::agent::own_browser::ReasonTracker::default());
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
    };
    // The chat's own processes mark the spawn, `init` and the first text;
    // a council's seats above ran without it.
    agent.set_timing(Some(timing.clone()));
    let mut result = agent.run_turn(input, cancel, &mut on_event).await;

    // The Ask position's round trip (backlog 084): one Nightloom turn spans
    // every CLI process it takes. The folder entrance (backlog 143, pass
    // 2): a grant on the answer reaches the process at once; who keeps it
    // is settled here for the project and after the turn for the chat.
    let mut granted_to_chat: Vec<PathBuf> = Vec::new();
    let mut granted_any = false;
    while let Ok(outcome) = &result
        && let Some(call) = outcome.deferred.clone()
    {
        let Some(dir) = ask_dir.clone() else {
            break;
        };
        let session_id = outcome.session_id.clone();
        let rx = ask.wait(&call.id);
        let outside = outside_folder(&call.input, &agent_trees(agent));
        env.approval(&ApprovalPrompt {
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
        let answer = tokio::select! {
            _ = cancel.cancelled() => None,
            a = rx => a.ok(),
        };
        let ask_files = AskDir::new(dir);
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
            ask.abandon(&call.id);
            if let Ok(o) = &mut result {
                o.notices
                    .push("stopped while waiting for your answer".into());
                o.deferred = None;
            }
            break;
        };
        if let Err(e) = ask_files.write(&call, &answer) {
            if let Ok(o) = &mut result {
                o.notices.push(format!("could not record the answer: {e}"));
                o.deferred = None;
            }
            break;
        }
        if let Some(id) = &session_id {
            agent.set_resume(Some(id.clone()));
        }
        if let Answer::Allow {
            grant: Some(grant), ..
        } = &answer
        {
            agent.grant_dir(grant.dir.clone());
            granted_any = true;
            match grant.scope {
                GrantScope::Chat => granted_to_chat.push(grant.dir.clone()),
                GrantScope::Project => match env.grant_to_project(&grant.dir).await {
                    ProjectGrant::Kept => {}
                    ProjectGrant::NoProject => granted_to_chat.push(grant.dir.clone()),
                    ProjectGrant::Failed(e) => env.notice(format!("folder not granted: {e}")),
                },
            }
        }
        // An approved plan (backlog 085).
        let plan_then = match &answer {
            Answer::Allow { plan_then, .. } if call.name == crate::agent::ask::EXIT_PLAN_TOOL => {
                *plan_then
            }
            _ => None,
        };
        if let Some(then) = plan_then {
            agent.plan_approved(then);
        }
        result = agent.resume_deferred(&call, cancel, &mut on_event).await;
        if plan_then.is_some() {
            agent.plan_exited();
        }
    }

    agent.set_timing(None);

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
    }

    match result {
        Ok(outcome) => {
            if let Some(model) = &outcome.model {
                recorder.set_model(model.clone());
            }
            // The reason rides in the stop reason (backlog 202).
            let reason = match (&outcome.api_error, outcome.is_error, &outcome.cut_off) {
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
                record_unanswered(
                    session,
                    outcome.model.clone().unwrap_or(seed_model),
                    Some(&why),
                );
            }
            // After the turn: an id from a run that failed to start is a
            // handle to nothing.
            if let Some(id) = &outcome.session_id {
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
    let (text, reason) = match error {
        None => (STOPPED_BEFORE_REPLY.to_string(), "stopped".to_string()),
        Some(why) => (
            format!("{}{why}", nightloom_core::NO_REPLY_PREFIX),
            format!("error: {why}"),
        ),
    };
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
            assert!(l.contains("ms; spawn cold; ok"), "{l}");
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
}
