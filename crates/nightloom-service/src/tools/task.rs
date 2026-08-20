//! Subagents: a tool that runs a focused task in its own context window.
//!
//! The point is not parallelism, it is *forgetting*. A question like "which
//! module owns retry policy" can cost twenty file reads to answer and one
//! sentence to state. Answering it inline spends the parent's window on
//! nineteen intermediate results it will never need again; answering it in a
//! subagent spends a fresh window and returns the sentence.
//!
//! So the sub-session is deliberately in-memory and never logged, and the
//! only thing that crosses back is the final message. The parent cannot see
//! the subagent's steps, which is the trade: use it when the intermediate
//! work is genuinely disposable, and don't when you need to watch it.
//!
//! Two things are lent from the spawning turn rather than rebuilt, and both
//! are load-bearing — see [`TurnHandle`].

use crate::approval::Approver;
use crate::turn::Chat;
use nightloom_core::tool::{Effect, Tool};
use nightloom_core::{Session, ToolDef};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

const TASK_DESC: &str = "Run a focused sub-task in a separate agent that has its own context \
     window. Give it one complete, self-contained instruction: it cannot see this conversation, \
     and all you get back is its final message. Reach for it when answering something would cost \
     a lot of exploration you do not need to keep — searching a large tree, reading many files to \
     settle one question. Do not use it for work that is one or two tool calls, and do not use it \
     when you need to see the intermediate results yourself, because you will not.";

/// What a subagent borrows from the turn that spawned it.
///
/// Both fields are refreshed by the engine at the top of every round, which
/// is what makes the ordering of `Chat` setup irrelevant — a shell can set
/// `approver` before or after `enable_subagents` and get the same behaviour.
///
/// **The approver is the security-relevant half.** A subagent runs the same
/// mutating tools as its parent, so one that did not inherit the approval
/// policy would be a way to run `bash` without ever being asked — the gate
/// would still be there, and the model would simply have a door beside it.
/// Inheriting the *instance* also carries the user's "always allow" grants,
/// so approving `write_file` once does not start over inside every subagent.
#[derive(Default)]
pub struct TurnHandle {
    cancel: Mutex<Option<CancellationToken>>,
    approver: Mutex<Option<Arc<dyn Approver>>>,
}

impl TurnHandle {
    /// Called by the engine each round; see the type docs for why it is a
    /// refresh rather than a one-time capture.
    pub(crate) fn lend(&self, cancel: &CancellationToken, approver: Option<Arc<dyn Approver>>) {
        *self.cancel.lock().unwrap() = Some(cancel.clone());
        *self.approver.lock().unwrap() = approver;
    }

    pub(crate) fn cancel(&self) -> CancellationToken {
        self.cancel.lock().unwrap().clone().unwrap_or_default()
    }

    pub(crate) fn approver(&self) -> Option<Arc<dyn Approver>> {
        self.approver.lock().unwrap().clone()
    }
}

/// The `task` tool. Build it through [`Chat::enable_subagents`], which wires
/// the handle — the factory alone is not enough.
pub struct Subagent {
    factory: Arc<dyn Fn() -> Result<Chat, String> + Send + Sync>,
    handle: Arc<TurnHandle>,
}

impl Subagent {
    pub fn new(
        factory: Arc<dyn Fn() -> Result<Chat, String> + Send + Sync>,
        handle: Arc<TurnHandle>,
    ) -> Self {
        Self { factory, handle }
    }
}

#[async_trait::async_trait]
impl Tool for Subagent {
    /// A subagent runs whatever its own tool set allows, which includes the
    /// mutating ones. Classifying it any lower would let the model reach them
    /// without the approval its own calls get — though each of the
    /// subagent's calls is separately gated too, since it inherits the
    /// policy.
    fn effect(&self) -> Effect {
        Effect::Mutating
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "task".into(),
            description: TASK_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "The complete instruction for the subagent. It has no \
                                        other context, so say everything it needs."
                    }
                },
                "required": ["prompt"]
            }),
        }
    }

    async fn call(&self, input: Value) -> Result<String, String> {
        let prompt = input["prompt"]
            .as_str()
            .filter(|p| !p.trim().is_empty())
            .ok_or_else(|| {
                "missing required argument: prompt (the subagent's full instruction)".to_string()
            })?;

        // A build failure comes back as a tool error the model can react
        // to — the alternative, panicking inside a tool, takes the process
        // down over a recoverable condition.
        let mut chat = (self.factory)().map_err(|e| format!("cannot start a subagent: {e}"))?;
        chat.approver = self.handle.approver();
        // Structural stop against a subagent spawning subagents: the factory
        // is a shell-supplied closure and nothing else prevents it handing
        // out the same tool set it was built from, which recurses until
        // something runs out. Depth one is also the useful depth — a
        // subagent that delegates has defeated the point of a fresh window.
        chat.tools.retain(|t| t.def().name != "task");

        // Its own session, in memory: the parent's log stays a record of the
        // parent's conversation, and the subagent's twenty file reads never
        // touch it.
        let mut session = Session::new();
        let cancel = self.handle.cancel();
        let outcome = chat
            .run_turn(&mut session, prompt, &cancel, &mut |_| {})
            .await
            .map_err(|e| format!("the subagent failed: {e}"))?;
        if outcome.interrupted {
            return Err("the subagent was interrupted before it finished".into());
        }

        let answer = session
            .messages()
            .iter()
            .rev()
            .find(|m| m.role == nightloom_core::Role::Assistant)
            .map(|m| m.text().trim().to_string())
            .unwrap_or_default();
        if answer.is_empty() {
            // Almost always means it burned every round on tool calls. Say so
            // rather than returning "", which reads as a successful nothing.
            return Err(
                "the subagent finished without producing an answer; it may have run out \
                        of tool rounds. Try a narrower instruction."
                    .into(),
            );
        }
        Ok(answer)
    }
}
