//! A message sent into a chat while its turn runs (nightshift backlog 328,
//! 2026-10-08).
//!
//! Measured on CLI 2.1.294 (nightshift `notes/runner-design/w4a-report.md`
//! and `328-measurements/`): a second `user` line written to the stdin of a
//! running `-p --input-format stream-json` process is taken by the running
//! turn at its next step — right after the tool result it was waiting on —
//! as Claude Code's own terminal does. With `--replay-user-messages` and a
//! `uuid` on the line, the CLI reports it as `command_lifecycle` lines keyed
//! by that uuid: `queued` when written, `started` when the model takes it,
//! `completed`. The control request `cancel_async_message` with the uuid
//! takes it back while it is still `queued` (`{"cancelled": true}`). A
//! message still queued when the turn's `result` comes is not dropped: the
//! CLI starts it ~70 ms later as a second command in the same process, with
//! its own `init` and `result` — so the turn simply runs on.
//!
//! So the turn's stdin stays open while the turn runs, owned by a writer
//! task fed through this inbox, and is closed (EOF, which ends the process
//! once it is idle) at a `result` with nothing of his still waiting, or at
//! a Stop. Nothing he typed is lost on any path: a message the turn never
//! took — Stop, a crash, a turn on the argv shape with no stdin at all — is
//! still in the window's queue, which sends it as the next message.
//!
//! Backlog 339 (2026-10-11, measured on 2.1.296, nightshift
//! `notes/runner-design/w6d-report.md`): **Send now.** A user line with
//! `"priority": "now"` — the value Claude Code's own queue uses for its
//! "send now" — makes the CLI abort the running tool ("Command was aborted
//! before completion"), end that command with `stop_reason: tool_use`, and
//! start the message at once as the next command in the same process; the
//! turn goes on with the aborted call in its history. A row already queued
//! is promoted by `cancel_async_message` and a re-send under a **fresh**
//! uuid (a reused uuid is replayed but silently never queued — measured), so
//! each message has the window's id and a separate wire uuid. A mid-turn
//! message may carry files (the same content blocks as a turn's opening
//! line), and while subagents run, the line carries a Nightloom note naming
//! them by agent id so the main model can pass a message on with
//! SendMessage; its call and result come back as [`Effect::Relayed`].

use nightloom_core::{DocumentInput, ImageInput};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

/// How long a Take back waits for the CLI's answer before saying it went.
const TAKE_BACK_WAIT: Duration = Duration::from_secs(5);

/// One message he sent mid-turn, written to the CLI and not yet taken.
#[derive(Debug, Clone, PartialEq)]
pub struct Waiting {
    pub id: String,
    pub text: String,
    /// The uuid on the CLI's stdin line (the lifecycle and a cancel name
    /// it): the window's id at first, a fresh one after a Send now.
    pub wire: String,
    pub images: Vec<ImageInput>,
    pub documents: Vec<DocumentInput>,
    /// Sent with `priority: "now"` (339).
    pub now: bool,
    /// A Send now's cancel is out: its `cancelled` lifecycle line is the
    /// promotion's, not a loss.
    promoting: bool,
}

/// A message the running turn took, for the window and the log.
#[derive(Debug, Clone, PartialEq)]
pub struct Taken {
    pub id: String,
    pub text: String,
    pub images: Vec<ImageInput>,
    pub documents: Vec<DocumentInput>,
    /// It went on a Send now (339).
    pub now: bool,
}

/// What a Send now did (backlog 339).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SendNow {
    /// Re-sent with `priority: "now"`: the CLI stops the running step and
    /// takes it at once.
    Sent,
    /// The turn had already taken it.
    Delivered,
    /// The CLI did not confirm the cancel (no answer in time, or
    /// `cancelled: false` with the message still waiting): it is still
    /// queued and goes at the next step, not hurried (backlog 341).
    NotHurried,
    /// A Take back won the race: the message was taken back, and its words
    /// are back in the box (backlog 341).
    TakenBack,
    /// No turn takes it now (it went nowhere; the window keeps it queued).
    NotRunning,
}

/// The main model passed something on to a subagent with SendMessage
/// (backlog 339): the call's `to` and `message`, the running agent it
/// names (by agent id or description), and how the call came back.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Relayed {
    pub to: String,
    pub agent_id: Option<String>,
    pub text: String,
    pub ok: bool,
    pub detail: String,
}

/// Why a message could not go to the running turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
    /// No turn is running with an open stdin (none at all, a slash command
    /// on argv, ~~a deferred call's resume~~ — on stdin since backlog 374;
    /// between a deferral and its answer no process runs): the window keeps
    /// it queued, and tries again when the turn's next process starts.
    NotRunning,
    /// The id is not a uuid — the CLI compares it as one.
    BadId,
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotRunning => f.write_str("no running turn takes messages now"),
            Self::BadId => f.write_str("the message id is not a uuid"),
        }
    }
}

/// What a Take back did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TakeBack {
    /// It never reached the model: back to him.
    Cancelled,
    /// The turn had already taken it.
    Delivered,
}

#[derive(Default)]
struct State {
    /// The writer's feed; `None` when no turn takes messages. Dropping it
    /// is the EOF.
    tx: Option<mpsc::UnboundedSender<String>>,
    waiting: Vec<Waiting>,
    /// Ids the turn took, since it began (the window's end-of-turn list).
    taken: Vec<String>,
    /// Ids still waiting when the turn closed: they went nowhere.
    left: Vec<String>,
    /// Ids a Take back cancelled (backlog 341): a Send now that lost the
    /// race to one says so.
    back: Vec<String>,
    /// A `result` came and no command has started since — the process is
    /// idle, and only a waiting message keeps it open.
    idle: bool,
    replies: HashMap<String, oneshot::Sender<bool>>,
    seq: u64,
    /// Subagents running now (backlog 329): `task_id` and description,
    /// from the CLI's `task_started` (`task_type: "local_agent"`) to its
    /// `task_notification`. Measured (2.1.294): the process outlives the
    /// main `result` while one runs, and its end wakes the main agent as a
    /// second command — so the stdin stays open for him meanwhile.
    agents: Vec<(String, String)>,
    /// The main thread's SendMessage calls awaiting their result (339):
    /// call id → (`to`, `message`).
    relays: HashMap<String, (String, String)>,
}

/// The chat's inbox, shared between its agent (which runs the turn) and the
/// window (which sends into it). Cheap to clone.
#[derive(Clone, Default)]
pub struct Inbox(Arc<Mutex<State>>);

impl std::fmt::Debug for Inbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Inbox")
    }
}

/// What a stdout line meant to the inbox.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    Taken(Taken),
    Relayed(Relayed),
    /// The turn's `result` — and whether the inbox closed the stdin on it.
    Result {
        closed: bool,
        /// Subagents still running at this reply's end (backlog 329).
        running: Vec<String>,
    },
}

impl Inbox {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The turn begins: its stdin writer's feed, and a fresh record.
    pub fn open(&self, tx: mpsc::UnboundedSender<String>) {
        let mut s = self.lock();
        *s = State {
            tx: Some(tx),
            seq: s.seq,
            ..State::default()
        };
    }

    /// Whether a turn takes messages now.
    pub fn is_open(&self) -> bool {
        self.lock().tx.is_some()
    }

    /// Write his message to the running turn. `id` is the window's uuid for
    /// it, which the CLI's lifecycle lines and a Take back name.
    pub fn send(&self, id: &str, text: &str) -> Result<(), SendError> {
        self.send_with(id, text, Vec::new(), Vec::new())
    }

    /// [`send`](Self::send) with files (backlog 339): the same content
    /// blocks as a turn's opening line.
    pub fn send_with(
        &self,
        id: &str,
        text: &str,
        images: Vec<ImageInput>,
        documents: Vec<DocumentInput>,
    ) -> Result<(), SendError> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err(SendError::BadId);
        }
        let mut s = self.lock();
        let Some(tx) = &s.tx else {
            return Err(SendError::NotRunning);
        };
        let w = Waiting {
            id: id.to_string(),
            text: text.to_string(),
            wire: id.to_string(),
            images,
            documents,
            now: false,
            promoting: false,
        };
        tx.send(user_line(&w, &s.agents))
            .map_err(|_| SendError::NotRunning)?;
        s.waiting.push(w);
        Ok(())
    }

    /// Send a waiting message now (backlog 339): cancel its queued line,
    /// then write it again under a fresh uuid with `priority: "now"`, which
    /// stops the running step and delivers it at once (measured).
    pub async fn send_now(&self, id: &str) -> SendNow {
        let rx = {
            let mut s = self.lock();
            if s.left.iter().any(|l| l == id) {
                return SendNow::NotRunning;
            }
            let Some(i) = s.waiting.iter().position(|w| w.id == id) else {
                return if s.back.iter().any(|b| b == id) {
                    SendNow::TakenBack
                } else {
                    SendNow::Delivered
                };
            };
            if s.waiting[i].now {
                return SendNow::Sent;
            }
            let Some(tx) = s.tx.clone() else {
                return SendNow::NotRunning;
            };
            s.waiting[i].promoting = true;
            let wire = s.waiting[i].wire.clone();
            s.seq += 1;
            let request_id = format!("nightloom-send-now-{}", s.seq);
            let (rtx, rrx) = oneshot::channel();
            s.replies.insert(request_id.clone(), rtx);
            let line = serde_json::json!({
                "type": "control_request",
                "request_id": request_id,
                "request": { "subtype": "cancel_async_message", "message_uuid": wire },
            });
            if tx.send(format!("{line}\n")).is_err() {
                s.replies.remove(&request_id);
                s.waiting[i].promoting = false;
                return SendNow::NotRunning;
            }
            rrx
        };
        let answer = tokio::time::timeout(TAKE_BACK_WAIT, rx).await;
        let mut s = self.lock();
        let Some(i) = s.waiting.iter().position(|w| w.id == id) else {
            // Taken, taken back, or the turn closed while the cancel was out.
            return if s.left.iter().any(|l| l == id) {
                SendNow::NotRunning
            } else if s.back.iter().any(|b| b == id) {
                SendNow::TakenBack
            } else {
                SendNow::Delivered
            };
        };
        s.waiting[i].promoting = false;
        if !matches!(answer, Ok(Ok(true))) {
            // Not cancelled: it is still queued (or about to be taken) at
            // the next step — nothing lost, it just was not hurried.
            return SendNow::NotHurried;
        }
        let Some(tx) = s.tx.clone() else {
            let w = s.waiting.remove(i);
            s.left.push(w.id);
            return SendNow::NotRunning;
        };
        s.waiting[i].wire = uuid::Uuid::new_v4().to_string();
        s.waiting[i].now = true;
        let line = user_line(&s.waiting[i], &s.agents);
        if tx.send(line).is_err() {
            let w = s.waiting.remove(i);
            s.left.push(w.id);
            return SendNow::NotRunning;
        }
        SendNow::Sent
    }

    /// Take a waiting message back. `Cancelled` also when the turn ended
    /// without taking it — either way it never reached the model.
    pub async fn take_back(&self, id: &str) -> TakeBack {
        let rx = {
            let mut s = self.lock();
            if s.left.iter().any(|l| l == id) {
                return TakeBack::Cancelled;
            }
            let Some(wire) = s
                .waiting
                .iter()
                .find(|w| w.id == id)
                .map(|w| w.wire.clone())
            else {
                return TakeBack::Delivered;
            };
            let Some(tx) = s.tx.clone() else {
                return TakeBack::Cancelled;
            };
            s.seq += 1;
            let request_id = format!("nightloom-take-back-{}", s.seq);
            let (rtx, rrx) = oneshot::channel();
            s.replies.insert(request_id.clone(), rtx);
            let line = serde_json::json!({
                "type": "control_request",
                "request_id": request_id,
                "request": { "subtype": "cancel_async_message", "message_uuid": wire },
            });
            if tx.send(format!("{line}\n")).is_err() {
                s.replies.remove(&request_id);
                return TakeBack::Cancelled;
            }
            rrx
        };
        let answer = tokio::time::timeout(TAKE_BACK_WAIT, rx).await;
        let mut s = self.lock();
        match answer {
            Ok(Ok(true)) => {
                s.waiting.retain(|w| w.id != id);
                s.back.push(id.to_string());
                // An idle process kept open only for this message ends now
                // — not while subagents run: their stdin carries Stop them
                // and the nested-spawn notes (329).
                if s.idle && s.waiting.is_empty() && s.agents.is_empty() {
                    s.tx = None;
                }
                TakeBack::Cancelled
            }
            // The turn closed under the request: still waiting then means
            // it went nowhere.
            Ok(Err(_)) if s.left.iter().any(|l| l == id) => TakeBack::Cancelled,
            _ => TakeBack::Delivered,
        }
    }

    /// One stdout line of the turn's process.
    pub fn on_line(&self, line: &str) -> Option<Effect> {
        // Cheap tests first: most lines are none of these.
        let kind = if line.contains(r#""type":"command_lifecycle""#) {
            0
        } else if line.contains(r#""type":"control_response""#) {
            1
        } else if line.starts_with(r#"{"type":"result""#) || line.contains(r#""type":"result""#) {
            2
        } else if line.contains(r#""subtype":"task_started""#)
            || line.contains(r#""subtype":"task_notification""#)
        {
            3
        } else if line.starts_with(r#"{"type":"assistant""#)
            && line.contains(r#""name":"SendMessage""#)
        {
            4
        } else if line.starts_with(r#"{"type":"user""#)
            && line.contains(r#""tool_result""#)
            && !self.lock().relays.is_empty()
        {
            5
        } else {
            return None;
        };
        let v: serde_json::Value = serde_json::from_str(line).ok()?;
        let mut s = self.lock();
        match kind {
            0 => {
                let id = v.get("command_uuid")?.as_str()?;
                let state = v.get("state")?.as_str()?;
                if state == "started" {
                    s.idle = false;
                }
                let i = s.waiting.iter().position(|w| w.wire == id)?;
                match state {
                    "started" => {
                        let w = s.waiting.remove(i);
                        s.taken.push(w.id.clone());
                        Some(Effect::Taken(Taken {
                            id: w.id,
                            text: w.text,
                            images: w.images,
                            documents: w.documents,
                            now: w.now,
                        }))
                    }
                    // A Send now's own cancel: the message is re-sent.
                    "cancelled" if s.waiting[i].promoting => None,
                    "cancelled" => {
                        let w = s.waiting.remove(i);
                        s.left.push(w.id);
                        None
                    }
                    _ => None,
                }
            }
            1 => {
                let r = v.get("response")?;
                let id = r.get("request_id")?.as_str()?;
                let tx = s.replies.remove(id)?;
                let cancelled = r
                    .get("response")
                    .and_then(|x| x.get("cancelled"))
                    .and_then(|c| c.as_bool())
                    .unwrap_or(false);
                let _ = tx.send(cancelled);
                None
            }
            3 => {
                let id = v.get("task_id")?.as_str()?.to_string();
                match v.get("subtype")?.as_str()? {
                    "task_started" => {
                        if v.get("task_type").and_then(|t| t.as_str()) == Some("local_agent") {
                            let what = v
                                .get("description")
                                .and_then(|d| d.as_str())
                                .unwrap_or("a subagent")
                                .to_string();
                            s.agents.push((id, what));
                        }
                    }
                    _ => {
                        s.agents.retain(|(a, _)| *a != id);
                        // The last one ended with nothing else holding the
                        // process: the EOF now (the CLI still wakes the main
                        // agent for it — measured with an early EOF).
                        if s.idle && s.agents.is_empty() && s.waiting.is_empty() {
                            s.tx = None;
                        }
                    }
                }
                None
            }
            4 => {
                // The main thread's own calls only: a subagent's line
                // carries its parent's call id.
                if !v.get("parent_tool_use_id").is_none_or(|p| p.is_null()) {
                    return None;
                }
                for b in v.pointer("/message/content")?.as_array()? {
                    if b.get("type").and_then(|t| t.as_str()) != Some("tool_use")
                        || b.get("name").and_then(|n| n.as_str()) != Some("SendMessage")
                    {
                        continue;
                    }
                    let (Some(call), Some(input)) =
                        (b.get("id").and_then(|i| i.as_str()), b.get("input"))
                    else {
                        continue;
                    };
                    let field = |k: &str| {
                        input
                            .get(k)
                            .and_then(|x| x.as_str())
                            .unwrap_or_default()
                            .to_string()
                    };
                    s.relays
                        .insert(call.to_string(), (field("to"), field("message")));
                }
                None
            }
            5 => {
                if !v.get("parent_tool_use_id").is_none_or(|p| p.is_null()) {
                    return None;
                }
                for b in v.pointer("/message/content")?.as_array()? {
                    let Some(call) = b.get("tool_use_id").and_then(|i| i.as_str()) else {
                        continue;
                    };
                    let Some((to, text)) = s.relays.remove(call) else {
                        continue;
                    };
                    let detail = match b.get("content") {
                        Some(serde_json::Value::String(t)) => t.clone(),
                        Some(serde_json::Value::Array(parts)) => parts
                            .iter()
                            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                            .collect::<Vec<_>>()
                            .join("\n"),
                        _ => String::new(),
                    };
                    let ok = b.get("is_error").and_then(|e| e.as_bool()) != Some(true)
                        && !detail.contains(r#""success":false"#);
                    let agent_id = s
                        .agents
                        .iter()
                        .find(|(a, d)| *a == to || *d == to)
                        .map(|(a, _)| a.clone())
                        .or_else(|| ok.then(|| to.clone()));
                    let detail: String = detail.chars().take(300).collect();
                    return Some(Effect::Relayed(Relayed {
                        to,
                        agent_id,
                        text,
                        ok,
                        detail,
                    }));
                }
                None
            }
            _ => {
                // Only the main thread's result: a line nested in a
                // subagent never is one, but say so.
                if v.get("type")?.as_str()? != "result" {
                    return None;
                }
                s.idle = true;
                // A call deferred to his answer (backlog 084) ends this
                // process; what waits goes back to him rather than run
                // ahead of the answer.
                if v.get("stop_reason").and_then(|r| r.as_str()) == Some("tool_deferred") {
                    drop(s);
                    self.stop();
                    return Some(Effect::Result {
                        closed: true,
                        running: Vec::new(),
                    });
                }
                let running: Vec<String> = s.agents.iter().map(|(_, d)| d.clone()).collect();
                let closed = s.waiting.is_empty() && running.is_empty();
                if closed {
                    s.tx = None;
                }
                Some(Effect::Result { closed, running })
            }
        }
    }

    /// The turn is over (or stopping): no more messages. Returns what was
    /// still waiting — sent nowhere, still in the window's queue.
    pub fn close(&self) -> Vec<Waiting> {
        let mut s = self.lock();
        s.tx = None;
        let left = std::mem::take(&mut s.waiting);
        s.left = left.iter().map(|w| w.id.clone()).collect();
        s.replies.clear();
        left
    }

    /// Cancel everything still waiting and close — the Stop. The cancels
    /// go out before the EOF, in order, on the same feed (measured run f:
    /// cancel, EOF, SIGINT → `cancelled: true` and the process exits).
    pub fn stop(&self) -> Vec<Waiting> {
        {
            let s = self.lock();
            if let Some(tx) = &s.tx {
                for (n, w) in s.waiting.iter().enumerate() {
                    let line = serde_json::json!({
                        "type": "control_request",
                        "request_id": format!("nightloom-stop-{n}"),
                        "request": { "subtype": "cancel_async_message", "message_uuid": w.wire },
                    });
                    let _ = tx.send(format!("{line}\n"));
                }
            }
        }
        self.close()
    }

    /// Stop every subagent still running (backlog 329, his "Stop them"):
    /// the CLI's `stop_task` control request for each — measured on
    /// 2.1.294: the agent is `stopped` at once and the main agent is woken
    /// to say so. How many were asked; 0 when no turn runs.
    pub fn stop_agents(&self) -> usize {
        let mut s = self.lock();
        let Some(tx) = s.tx.clone() else {
            return 0;
        };
        let ids: Vec<String> = s.agents.iter().map(|(id, _)| id.clone()).collect();
        for id in &ids {
            s.seq += 1;
            let line = serde_json::json!({
                "type": "control_request",
                "request_id": format!("nightloom-stop-task-{}", s.seq),
                "request": { "subtype": "stop_task", "task_id": id },
            });
            let _ = tx.send(format!("{line}\n"));
        }
        ids.len()
    }

    /// Nightloom's own note to an idle main thread whose subagents still
    /// run (backlog 329: a nested spawn reported "at its next step" when
    /// the main thread has no next tool call to carry it). Written as a
    /// user line with no uuid — not his, so not tracked as his and never
    /// recorded as his message; the CLI starts it as the next command, as
    /// it does any message that arrives while it is idle (measured run e).
    /// `false` when the main thread is not idle or no turn takes input.
    pub fn note_if_idle(&self, text: &str) -> bool {
        let mut s = self.lock();
        if !s.idle || s.agents.is_empty() {
            return false;
        }
        let Some(tx) = &s.tx else {
            return false;
        };
        let line = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": text }] },
            "parent_tool_use_id": serde_json::Value::Null,
        });
        if tx.send(format!("{line}\n")).is_err() {
            return false;
        }
        s.idle = false;
        true
    }

    /// Whether the main thread is idle while subagents still run.
    pub fn idle_with_agents(&self) -> bool {
        let s = self.lock();
        s.idle && !s.agents.is_empty() && s.tx.is_some()
    }

    /// Whether a message he sent is written to the feed and not yet taken.
    pub fn has_waiting(&self) -> bool {
        !self.lock().waiting.is_empty()
    }

    /// The ids the turn took since it began.
    pub fn taken(&self) -> Vec<String> {
        self.lock().taken.clone()
    }
}

/// His message as the CLI's stdin line: the opening line's shape
/// (`protocol::user_line`) with its files, the wire uuid the lifecycle
/// names, `priority: "now"` on a Send now (339), and — while subagents run
/// — the note that lets the main model pass it on ([`relay_note`]).
fn user_line(w: &Waiting, agents: &[(String, String)]) -> String {
    let mut text = w.text.clone();
    if let Some(note) = relay_note(agents) {
        text.push_str("\n\n");
        text.push_str(&note);
    }
    let input = crate::TurnInput {
        text,
        images: w.images.clone(),
        documents: w.documents.clone(),
    };
    let mut line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": super::protocol::user_content(&input.text, &input.images, &input.documents) },
        "parent_tool_use_id": serde_json::Value::Null,
        "uuid": w.wire,
    });
    if w.now {
        line["priority"] = serde_json::Value::from("now");
    }
    format!("{line}\n")
}

/// How [`relay_note`] begins, after the blank line [`user_line`] puts
/// before it — what `CliSession::locate` strips to match his words
/// (backlog 341).
pub const RELAY_NOTE_START: &str = "\n\n[Nightloom: sent while your subagents run — ";

/// Nightloom's note on a mid-turn message while subagents run (backlog
/// 339): who runs, by agent id, and how to pass his words on. Only on the
/// wire — the log and the window keep his words alone.
pub fn relay_note(agents: &[(String, String)]) -> Option<String> {
    if agents.is_empty() {
        return None;
    }
    let list = agents
        .iter()
        .map(|(id, what)| format!("`{id}` (\"{what}\")"))
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "{}{list}. If this message (or part of it) is for one of them, \
pass it on with SendMessage, `to` set to that agent id, in his words; it reaches the agent at its next tool call.]",
        RELAY_NOTE_START.trim_start()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "95578ec2-fd7c-49e0-b639-00e0298e2b87";

    fn lifecycle(state: &str) -> String {
        format!(
            r#"{{"type":"command_lifecycle","command_uuid":"{ID}","state":"{state}","uuid":"x","session_id":"s"}}"#
        )
    }
    const RESULT: &str = r#"{"type":"result","subtype":"success","is_error":false,"num_turns":5,"result":"DONE","session_id":"s"}"#;

    #[test]
    fn a_message_goes_on_the_feed_with_its_uuid_and_is_taken_on_started() {
        let inbox = Inbox::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        inbox.send(ID, "also echo PINEAPPLE").unwrap();
        let line = rx.try_recv().unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["uuid"], ID);
        assert_eq!(v["message"]["content"][0]["text"], "also echo PINEAPPLE");
        assert_eq!(inbox.on_line(&lifecycle("queued")), None);
        assert_eq!(
            inbox.on_line(&lifecycle("started")),
            Some(Effect::Taken(Taken {
                id: ID.into(),
                text: "also echo PINEAPPLE".into(),
                images: vec![],
                documents: vec![],
                now: false,
            }))
        );
        assert_eq!(inbox.taken(), vec![ID.to_string()]);
        // Nothing waits: the result closes the stdin.
        assert_eq!(
            inbox.on_line(RESULT),
            Some(Effect::Result {
                closed: true,
                running: vec![]
            })
        );
        assert!(!inbox.is_open());
    }

    #[test]
    fn a_result_with_a_message_still_waiting_keeps_the_stdin_open() {
        let inbox = Inbox::default();
        let (tx, _rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        inbox.send(ID, "late").unwrap();
        // Measured run e: the CLI runs it next, in the same process.
        assert_eq!(
            inbox.on_line(RESULT),
            Some(Effect::Result {
                closed: false,
                running: vec![]
            })
        );
        assert!(inbox.is_open());
        assert!(matches!(
            inbox.on_line(&lifecycle("started")),
            Some(Effect::Taken(_))
        ));
        assert_eq!(
            inbox.on_line(RESULT),
            Some(Effect::Result {
                closed: true,
                running: vec![]
            })
        );
    }

    #[test]
    fn nothing_running_refuses_and_a_bad_id_is_refused() {
        let inbox = Inbox::default();
        assert_eq!(inbox.send(ID, "x"), Err(SendError::NotRunning));
        let (tx, _rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        assert_eq!(inbox.send("not-a-uuid", "x"), Err(SendError::BadId));
    }

    #[test]
    fn a_note_goes_only_to_an_idle_main_thread_with_agents_running() {
        let inbox = Inbox::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        assert!(
            !inbox.note_if_idle("x"),
            "busy main thread: the hook carries it"
        );
        inbox.on_line(r#"{"type":"system","subtype":"task_started","task_id":"a1","description":"d","task_type":"local_agent"}"#);
        inbox.on_line(RESULT);
        assert!(inbox.idle_with_agents());
        assert!(inbox.note_if_idle("[Nightloom] your subagent started one"));
        let line = rx.try_recv().unwrap();
        assert!(
            line.contains("your subagent started one") && !line.contains("uuid"),
            "{line}"
        );
        // Not his: nothing waits, nothing is taken.
        assert!(inbox.taken().is_empty());
        assert!(!inbox.idle_with_agents(), "the note starts a command");
    }

    #[test]
    fn a_running_subagent_keeps_the_process_open_and_its_end_closes_it() {
        let inbox = Inbox::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        // Measured shapes (329-measurements, 2.1.294).
        inbox.on_line(r#"{"type":"system","subtype":"task_started","task_id":"a8bb","tool_use_id":"t","description":"Run delayed echo command","task_type":"local_agent"}"#);
        inbox.on_line(r#"{"type":"system","subtype":"task_started","task_id":"b5o5","description":"sleep","task_type":"local_bash"}"#);
        assert_eq!(
            inbox.on_line(RESULT),
            Some(Effect::Result {
                closed: false,
                running: vec!["Run delayed echo command".into()]
            })
        );
        assert!(inbox.is_open());
        assert_eq!(inbox.stop_agents(), 1);
        let line = rx.try_recv().unwrap();
        assert!(
            line.contains(r#""subtype":"stop_task""#) && line.contains("a8bb"),
            "{line}"
        );
        inbox.on_line(r#"{"type":"system","subtype":"task_notification","task_id":"a8bb","status":"stopped"}"#);
        assert!(!inbox.is_open());
    }

    #[tokio::test]
    async fn take_back_cancels_on_the_clis_yes_and_closes_an_idle_process() {
        let inbox = Inbox::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        inbox.send(ID, "x").unwrap();
        let _ = rx.try_recv();
        inbox.on_line(RESULT);
        let i2 = inbox.clone();
        let answer = tokio::spawn(async move { i2.take_back(ID).await });
        // The control request goes out on the feed…
        let req = loop {
            if let Ok(l) = rx.try_recv() {
                break l;
            }
            tokio::task::yield_now().await;
        };
        let v: serde_json::Value = serde_json::from_str(&req).unwrap();
        assert_eq!(v["request"]["subtype"], "cancel_async_message");
        assert_eq!(v["request"]["message_uuid"], ID);
        let rid = v["request_id"].as_str().unwrap().to_string();
        // …and the CLI's answer (measured run d's shape) settles it.
        inbox.on_line(&format!(
            r#"{{"type":"control_response","response":{{"subtype":"success","request_id":"{rid}","response":{{"cancelled":true}}}}}}"#
        ));
        assert_eq!(answer.await.unwrap(), TakeBack::Cancelled);
        assert!(!inbox.is_open(), "an idle process kept open for it ends");
    }

    /// Review of wave 4: a Take back while the main thread is idle with
    /// subagents running leaves the stdin open, so "Stop them" and the
    /// nested-spawn notes still reach the CLI.
    #[tokio::test]
    async fn take_back_while_subagents_run_keeps_the_stdin_open() {
        let inbox = Inbox::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        inbox.on_line(r#"{"type":"system","subtype":"task_started","task_id":"a1","description":"d","task_type":"local_agent"}"#);
        inbox.send(ID, "x").unwrap();
        let _ = rx.try_recv();
        inbox.on_line(RESULT);
        let i2 = inbox.clone();
        let answer = tokio::spawn(async move { i2.take_back(ID).await });
        let req = loop {
            if let Ok(l) = rx.try_recv() {
                break l;
            }
            tokio::task::yield_now().await;
        };
        let v: serde_json::Value = serde_json::from_str(&req).unwrap();
        let rid = v["request_id"].as_str().unwrap().to_string();
        inbox.on_line(&format!(
            r#"{{"type":"control_response","response":{{"subtype":"success","request_id":"{rid}","response":{{"cancelled":true}}}}}}"#
        ));
        assert_eq!(answer.await.unwrap(), TakeBack::Cancelled);
        assert!(inbox.is_open(), "a subagent still runs");
        assert_eq!(inbox.stop_agents(), 1);
    }

    #[tokio::test]
    async fn take_back_of_a_taken_message_says_delivered() {
        let inbox = Inbox::default();
        let (tx, _rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        inbox.send(ID, "x").unwrap();
        inbox.on_line(&lifecycle("started"));
        assert_eq!(inbox.take_back(ID).await, TakeBack::Delivered);
    }

    #[tokio::test]
    async fn stop_cancels_what_waits_and_take_back_then_says_cancelled() {
        let inbox = Inbox::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        inbox.send(ID, "x").unwrap();
        let _ = rx.try_recv();
        let left = inbox.stop();
        assert_eq!(left.len(), 1);
        let cancel = rx.try_recv().unwrap();
        assert!(cancel.contains("cancel_async_message"));
        // The feed is closed: the writer sees the end.
        assert!(rx.recv().await.is_none());
        assert_eq!(inbox.take_back(ID).await, TakeBack::Cancelled);
    }

    fn answer_cancel(inbox: &Inbox, req: &str, yes: bool) {
        let v: serde_json::Value = serde_json::from_str(req).unwrap();
        let rid = v["request_id"].as_str().unwrap().to_string();
        inbox.on_line(&format!(
            r#"{{"type":"control_response","response":{{"subtype":"success","request_id":"{rid}","response":{{"cancelled":{yes}}}}}}}"#
        ));
    }

    async fn next_line(rx: &mut mpsc::UnboundedReceiver<String>) -> String {
        loop {
            if let Ok(l) = rx.try_recv() {
                break l;
            }
            tokio::task::yield_now().await;
        }
    }

    /// Backlog 339, measured run promote2: Send now cancels the queued
    /// line, then re-sends it under a fresh uuid with `priority: "now"`;
    /// the CLI's `cancelled` line for the old uuid loses nothing, and the
    /// `started` line for the new one is the window's row, taken `now`.
    #[tokio::test]
    async fn send_now_cancels_and_resends_under_a_fresh_uuid_with_priority_now() {
        let inbox = Inbox::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        inbox.send(ID, "stop and do this").unwrap();
        let _ = rx.try_recv();
        let i2 = inbox.clone();
        let answer = tokio::spawn(async move { i2.send_now(ID).await });
        let req = next_line(&mut rx).await;
        let v: serde_json::Value = serde_json::from_str(&req).unwrap();
        assert_eq!(v["request"]["subtype"], "cancel_async_message");
        assert_eq!(v["request"]["message_uuid"], ID);
        // Measured order: the lifecycle `cancelled` comes before the answer.
        assert_eq!(inbox.on_line(&lifecycle("cancelled")), None);
        answer_cancel(&inbox, &req, true);
        assert_eq!(answer.await.unwrap(), SendNow::Sent);
        let line = rx.try_recv().unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["priority"], "now");
        assert_eq!(v["message"]["content"][0]["text"], "stop and do this");
        let wire = v["uuid"].as_str().unwrap().to_string();
        assert_ne!(wire, ID, "a reused uuid is dropped by the CLI");
        // The old uuid's lifecycle no longer names it…
        assert_eq!(inbox.on_line(&lifecycle("started")), None);
        // …the new one does, as the window's row.
        let started = format!(
            r#"{{"type":"command_lifecycle","command_uuid":"{wire}","state":"started","uuid":"x","session_id":"s"}}"#
        );
        match inbox.on_line(&started) {
            Some(Effect::Taken(t)) => {
                assert_eq!(t.id, ID);
                assert!(t.now);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(inbox.taken(), vec![ID.to_string()]);
        // A second Send now on it: already delivered.
        assert_eq!(inbox.send_now(ID).await, SendNow::Delivered);
    }

    /// A Send now the CLI did not cancel while the row still waits:
    /// not hurried (backlog 341 — it used to say "already reached the
    /// turn"), nothing re-sent, and it still goes at the next step.
    #[tokio::test]
    async fn send_now_the_cli_did_not_cancel_says_not_hurried_and_sends_nothing() {
        let inbox = Inbox::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        inbox.send(ID, "x").unwrap();
        let _ = rx.try_recv();
        let i2 = inbox.clone();
        let answer = tokio::spawn(async move { i2.send_now(ID).await });
        let req = next_line(&mut rx).await;
        answer_cancel(&inbox, &req, false);
        assert_eq!(answer.await.unwrap(), SendNow::NotHurried);
        assert!(rx.try_recv().is_err(), "no second line");
        // Still waiting: the lifecycle still takes it by its first uuid.
        assert!(matches!(
            inbox.on_line(&lifecycle("started")),
            Some(Effect::Taken(_))
        ));
    }

    /// Backlog 341: Take back's cancel wins the race against a Send now's —
    /// the Send now says it was taken back, not "already reached the turn".
    #[tokio::test]
    async fn send_now_that_loses_the_race_to_take_back_says_taken_back() {
        let inbox = Inbox::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        inbox.send(ID, "x").unwrap();
        let _ = rx.try_recv();
        let i2 = inbox.clone();
        let now = tokio::spawn(async move { i2.send_now(ID).await });
        let now_req = next_line(&mut rx).await;
        let i3 = inbox.clone();
        let back = tokio::spawn(async move { i3.take_back(ID).await });
        let back_req = next_line(&mut rx).await;
        answer_cancel(&inbox, &back_req, true);
        assert_eq!(back.await.unwrap(), TakeBack::Cancelled);
        answer_cancel(&inbox, &now_req, false);
        assert_eq!(now.await.unwrap(), SendNow::TakenBack);
        assert!(rx.try_recv().is_err(), "nothing re-sent");
        // And a Send now pressed after it says the same.
        assert_eq!(inbox.send_now(ID).await, SendNow::TakenBack);
    }

    /// Take back after a Send now cancels the new wire uuid.
    #[tokio::test]
    async fn take_back_after_send_now_names_the_new_uuid() {
        let inbox = Inbox::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        inbox.send(ID, "x").unwrap();
        let _ = rx.try_recv();
        let i2 = inbox.clone();
        let answer = tokio::spawn(async move { i2.send_now(ID).await });
        let req = next_line(&mut rx).await;
        answer_cancel(&inbox, &req, true);
        assert_eq!(answer.await.unwrap(), SendNow::Sent);
        let resent: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        let i3 = inbox.clone();
        let back = tokio::spawn(async move { i3.take_back(ID).await });
        let req = next_line(&mut rx).await;
        let v: serde_json::Value = serde_json::from_str(&req).unwrap();
        assert_eq!(v["request"]["message_uuid"], resent["uuid"]);
        answer_cancel(&inbox, &req, true);
        assert_eq!(back.await.unwrap(), TakeBack::Cancelled);
    }

    #[tokio::test]
    async fn send_now_with_nothing_running_says_so() {
        let inbox = Inbox::default();
        assert_eq!(inbox.send_now(ID).await, SendNow::Delivered);
        let (tx, mut rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        inbox.send(ID, "x").unwrap();
        let _ = rx.try_recv();
        inbox.stop();
        assert_eq!(inbox.send_now(ID).await, SendNow::NotRunning);
    }

    /// Backlog 339 (b): a mid-turn message carries its files, as the
    /// opening line's content blocks, and the taken message keeps them.
    #[test]
    fn a_message_with_files_carries_them_on_the_line_and_when_taken() {
        let inbox = Inbox::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        inbox
            .send_with(
                ID,
                "look at these",
                vec![ImageInput {
                    media_type: "image/png".into(),
                    data: "iVBORw0KGgo=".into(),
                }],
                vec![DocumentInput {
                    media_type: "application/pdf".into(),
                    name: "a.pdf".into(),
                    data: "JVBERi0=".into(),
                }],
            )
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        let c = v["message"]["content"].as_array().unwrap();
        assert_eq!(c.len(), 3);
        assert_eq!(c[0]["text"], "look at these");
        assert_eq!(c[1]["type"], "image");
        assert_eq!(c[2]["type"], "document");
        assert_eq!(c[2]["title"], "a.pdf");
        match inbox.on_line(&lifecycle("started")) {
            Some(Effect::Taken(t)) => {
                assert_eq!((t.images.len(), t.documents.len()), (1, 1));
            }
            other => panic!("{other:?}"),
        }
    }

    /// Backlog 339 (c): while a subagent runs, his message carries the
    /// note naming it by agent id — on the wire only, never in what is
    /// taken (the log keeps his words alone).
    #[test]
    fn a_message_while_a_subagent_runs_names_it_for_sendmessage() {
        let inbox = Inbox::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        inbox.on_line(r#"{"type":"system","subtype":"task_started","task_id":"a8bb","tool_use_id":"t","description":"Survey the logs","task_type":"local_agent"}"#);
        inbox
            .send(ID, "tell the survey agent to skip June")
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        let text = v["message"]["content"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("tell the survey agent to skip June\n\n[Nightloom:"));
        assert!(text.contains("`a8bb` (\"Survey the logs\")") && text.contains("SendMessage"));
        match inbox.on_line(&lifecycle("started")) {
            Some(Effect::Taken(t)) => assert_eq!(t.text, "tell the survey agent to skip June"),
            other => panic!("{other:?}"),
        }
        assert_eq!(relay_note(&[]), None);
    }

    /// Backlog 339 (c): the main thread's SendMessage call and its result
    /// come back as one `Relayed`, matched to the running agent; a failed
    /// send (the CLI's `success:false` text, measured 2026-10-04) is not ok;
    /// a subagent's own SendMessage is not the main model's relay.
    #[test]
    fn the_main_threads_sendmessage_comes_back_as_relayed() {
        let inbox = Inbox::default();
        let (tx, _rx) = mpsc::unbounded_channel();
        inbox.open(tx);
        inbox.on_line(r#"{"type":"system","subtype":"task_started","task_id":"a8bb","description":"Survey the logs","task_type":"local_agent"}"#);
        assert_eq!(
            inbox.on_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_s1","name":"SendMessage","input":{"to":"a8bb","message":"skip June"}}]},"parent_tool_use_id":null}"#),
            None
        );
        // A subagent's own call: ignored.
        inbox.on_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_x","name":"SendMessage","input":{"to":"main","message":"hi"}}]},"parent_tool_use_id":"toolu_t"}"#);
        assert_eq!(
            inbox.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_s1","content":[{"type":"text","text":"Message queued for delivery to a8bb at its next tool round."}]}]},"parent_tool_use_id":null}"#),
            Some(Effect::Relayed(Relayed {
                to: "a8bb".into(),
                agent_id: Some("a8bb".into()),
                text: "skip June".into(),
                ok: true,
                detail: "Message queued for delivery to a8bb at its next tool round.".into(),
            }))
        );
        inbox.on_line(r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_s2","name":"SendMessage","input":{"to":"sleeper","message":"x"}}]},"parent_tool_use_id":null}"#);
        match inbox.on_line(r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_s2","content":"{\"success\":false,\"message\":\"No agent named 'sleeper' is reachable.\"}"}]},"parent_tool_use_id":null}"#) {
            Some(Effect::Relayed(r)) => {
                assert!(!r.ok);
                assert_eq!(r.agent_id, None);
            }
            other => panic!("{other:?}"),
        }
    }

    /// The real CLI through the real turn (nightshift backlog 328): a
    /// message sent at the first call is delivered at the next step and
    /// answered in the same turn; one taken back never reaches the model.
    /// Haiku, two turns. `cargo test -p nightloom-service --lib
    /// measure_mid_turn -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn measure_mid_turn_messages_with_the_real_cli() {
        use crate::TurnEvent;
        use crate::agent::{AgentSpec, ClaudeCodeAgent};
        let dir = std::env::temp_dir().join(format!("nl-328-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut spec = AgentSpec::new(&dir);
        spec.binary = "claude".into();
        spec.model = Some("haiku".into());
        spec.no_session_persistence = true;
        spec.allowed_tools = vec!["Bash(sleep:*)".into(), "Bash(echo:*)".into()];
        let prompt = "Run these shell commands one at a time, each as its own separate Bash call, \
                      waiting for each before the next: `sleep 3 && echo one`, `sleep 3 && echo two`, \
                      `sleep 3 && echo three`. Then reply DONE.";
        for take_back in [false, true] {
            let agent = ClaudeCodeAgent::new(spec.clone());
            let inbox = agent.inbox();
            let id = uuid::Uuid::new_v4().to_string();
            let t0 = std::time::Instant::now();
            let (etx, mut erx) = mpsc::unbounded_channel::<(u128, TurnEvent)>();
            let cancel = tokio_util::sync::CancellationToken::new();
            let run = tokio::spawn(async move {
                let mut on = |e: TurnEvent| {
                    let _ = etx.send((t0.elapsed().as_millis(), e));
                };
                agent.run_turn(prompt, &cancel, &mut on).await
            });
            let mut sent = false;
            let mut log = Vec::new();
            while let Some((ms, e)) = erx.recv().await {
                match &e {
                    TurnEvent::ToolCall { name, input, .. } => {
                        log.push(format!("{ms:>6} call {name} {input}"));
                        if !sent {
                            sent = true;
                            inbox
                                .send(&id, "Also run `echo PINEAPPLE` as its own Bash call next.")
                                .unwrap();
                            log.push(format!("{ms:>6} sent"));
                            if take_back {
                                let r = inbox.take_back(&id).await;
                                log.push(format!(
                                    "{:>6} take back: {r:?}",
                                    t0.elapsed().as_millis()
                                ));
                            }
                        }
                    }
                    TurnEvent::ToolResult { content, .. } => {
                        log.push(format!("{ms:>6} result {}", content.trim()))
                    }
                    TurnEvent::MessageDelivered { after, .. } => {
                        log.push(format!("{ms:>6} DELIVERED {after}"))
                    }
                    _ => {}
                }
            }
            let out = run.await.unwrap().unwrap();
            log.push(format!(
                "{:>6} ended rounds={:?} text={:?}",
                t0.elapsed().as_millis(),
                out.rounds,
                out.text
            ));
            println!("--- take_back={take_back}\n{}", log.join("\n"));
        }
    }
}
