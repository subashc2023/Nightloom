//! Writing an agent's turn into a session log.
//!
//! An agent that owns its own loop owns its own history, so this log is a
//! **record** and never the thing replayed: `--resume` is what continues the
//! conversation, and the handle for it is written down as a
//! [`SessionEvent::AgentSession`]. That could argue for recording nothing at
//! all, and it is the wrong answer for a windowed shell — the sidebar, the
//! search, the transcript you reopen tomorrow are every one of them a
//! projection of this log, and a chat that appears in none of them is a chat
//! the app forgot the moment it scrolled off.
//!
//! So it is written, and written in the *same* shape a provider turn is,
//! which buys the property worth having: switching the rail back to a
//! provider mid-conversation replays what the agent did as ordinary history.
//! That only holds if the log is valid on the wire, and the one way it could
//! fail to be is the one `orphan_marker` already exists for — a `tool_use`
//! whose `tool_result` never arrived, which every provider 400s. The agent is
//! another process and can die mid-round, so pairing is *guaranteed here*
//! rather than assumed: [`Recorder::finish`] supplies a result for any call
//! still open, and says in the result that it is doing so.
//!
//! [`SessionEvent::AgentSession`]: nightloom_core::SessionEvent

use nightloom_core::{ContentBlock, Session, Usage};

use crate::TurnEvent;

/// How much of one tool result is kept.
///
/// The agent has already shaped its own output — this is the backstop under
/// that, on `RESULT_LIMIT`'s argument and at the same size: what arrives is
/// whatever another process decided to return, and a log is not the place to
/// find out it decided on forty megabytes.
const RECORD_LIMIT: usize = 64 * 1024;

/// Feed it the [`TurnEvent`]s of an agent turn; it writes the session log.
///
/// The two dialects differ in one structural way. Nightloom records an
/// assistant message and *then* the results of the calls in it, as separate
/// events; the agent streams text, then calls, then results, with no marker
/// between one round and the next. So a result is what closes a round: the
/// blocks accumulated so far become an `AssistantMessage`, and the results
/// follow it.
pub struct Recorder<'a> {
    session: &'a mut Session,
    model: String,
    /// Blocks of the round being assembled, in stream order — which is the
    /// order they must be replayed in, thinking before the call it led to.
    blocks: Vec<ContentBlock>,
    /// Text and thinking accumulate as deltas and become one block each.
    text: String,
    thinking: String,
    /// Calls opened this round and not yet answered.
    open: Vec<(String, String)>,
    /// Summed since the last assistant message, and written onto the one
    /// that closes the round it belongs to.
    usage: Usage,
    /// Whether anything at all was recorded, so an empty turn writes no
    /// empty assistant message.
    wrote: bool,
}

impl<'a> Recorder<'a> {
    pub fn new(session: &'a mut Session, model: impl Into<String>) -> Self {
        Self {
            session,
            model: model.into(),
            blocks: Vec::new(),
            text: String::new(),
            thinking: String::new(),
            open: Vec::new(),
            usage: Usage::default(),
            wrote: false,
        }
    }

    /// The model the CLI resolved to, once its `init` line has named it.
    ///
    /// Later than construction because an alias (`sonnet`) is all a shell has
    /// to offer until the agent answers with the id, and a log that records
    /// the alias is one whose cost and context figures cannot be looked up.
    pub fn set_model(&mut self, model: impl Into<String>) {
        let model = model.into();
        if !model.is_empty() {
            self.model = model;
        }
    }

    pub fn push(&mut self, event: &TurnEvent) {
        match event {
            TurnEvent::TextDelta { text } => self.text.push_str(text),
            TurnEvent::ThinkingDelta { text } => self.thinking.push_str(text),
            TurnEvent::RedactedThinking => {
                self.flush_prose();
                // Kept for the transcript's sake and deliberately empty: the
                // payload is the agent's to replay into its own session, and
                // an adapter here may only replay a token it issued itself.
                self.blocks.push(ContentBlock::RedactedThinking {
                    data: String::new(),
                });
            }
            TurnEvent::ToolCall { id, name, input } => {
                self.flush_prose();
                self.open.push((id.clone(), name.clone()));
                self.blocks.push(ContentBlock::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                    signature: None,
                });
            }
            TurnEvent::ToolResult {
                tool_use_id,
                name,
                content,
                is_error,
            } => {
                // The first result of a round is what says the assistant
                // message before it is complete.
                self.flush_assistant(Some("tool_use"));
                self.open.retain(|(id, _)| id != tool_use_id);
                self.session.record_tool_result(&ContentBlock::ToolResult {
                    tool_use_id: tool_use_id.clone(),
                    name: name.clone(),
                    content: clip(content),
                    is_error: *is_error,
                });
                self.wrote = true;
            }
            TurnEvent::Usage { usage } => self.usage.add(*usage),
            // Nothing else an agent emits reaches the log: a denial and a
            // round limit are the engine's own vocabulary, and a compaction
            // is the agent's business inside its own history.
            _ => {}
        }
    }

    /// Close the turn: the final assistant message, plus a result for any
    /// call left open.
    ///
    /// Returns whether anything was recorded, so a caller can tell a turn
    /// that failed before it said anything from one that merely said little.
    pub fn finish(mut self, stop_reason: Option<&str>) -> bool {
        self.flush_prose();
        let orphans: Vec<(String, String)> = std::mem::take(&mut self.open);
        let reason = if orphans.is_empty() {
            stop_reason
        } else {
            Some("tool_use")
        };
        self.flush_assistant(reason);
        for (id, name) in orphans {
            self.session.record_tool_result(&ContentBlock::ToolResult {
                tool_use_id: id,
                name,
                content: ORPHAN.to_string(),
                is_error: true,
            });
            self.wrote = true;
        }
        self.wrote
    }

    /// Accumulated deltas become blocks, in the order they streamed.
    fn flush_prose(&mut self) {
        if !self.thinking.is_empty() {
            self.blocks.push(ContentBlock::Thinking {
                text: std::mem::take(&mut self.thinking),
                // Unsigned, which needs no rule of its own: an adapter
                // replays only a signature it issued, so this renders in the
                // transcript and can never be forged onto a wire.
                signature: None,
            });
        }
        if !self.text.is_empty() {
            self.blocks.push(ContentBlock::Text {
                text: std::mem::take(&mut self.text),
            });
        }
    }

    /// Write the round's assistant message, if it has anything in it.
    fn flush_assistant(&mut self, stop_reason: Option<&str>) {
        self.flush_prose();
        if self.blocks.is_empty() {
            return;
        }
        let blocks = std::mem::take(&mut self.blocks);
        self.session.record_assistant(
            self.model.clone(),
            blocks,
            stop_reason.map(String::from),
            std::mem::take(&mut self.usage),
        );
        self.wrote = true;
    }
}

/// What stands in for a result the agent never delivered.
///
/// Addressed to a model, like every other tool string here, because that is
/// who reads it if this conversation is later carried on by a provider.
const ORPHAN: &str =
    "[no result recorded: the agent ended before this call returned. Do not assume it ran.]";

/// Cut an oversized result down, saying so and naming the full size — a
/// result that stops early without saying it reads as output that ended
/// there.
fn clip(text: &str) -> String {
    if text.len() <= RECORD_LIMIT {
        return text.to_string();
    }
    let mut cut = RECORD_LIMIT;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!(
        "{}\n\n[truncated: {} bytes of output, {} kept]",
        &text[..cut],
        text.len(),
        cut
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::SessionEvent;
    use serde_json::json;

    fn call(id: &str) -> TurnEvent {
        TurnEvent::ToolCall {
            id: id.into(),
            name: "Read".into(),
            input: json!({"file_path": "a.txt"}),
        }
    }

    fn result(id: &str) -> TurnEvent {
        TurnEvent::ToolResult {
            tool_use_id: id.into(),
            name: "Read".into(),
            content: "contents".into(),
            is_error: false,
        }
    }

    /// The shape a tool round has to land in: assistant (thinking, text,
    /// tool_use) then the result as its own event, then the final reply.
    #[test]
    fn a_tool_round_records_as_a_provider_turn_would() {
        let mut s = Session::new();
        s.record_user("read a.txt");
        let mut r = Recorder::new(&mut s, "claude-sonnet-5");
        r.push(&TurnEvent::ThinkingDelta {
            text: "let me look".into(),
        });
        r.push(&TurnEvent::TextDelta {
            text: "Reading it.".into(),
        });
        r.push(&call("c1"));
        r.push(&result("c1"));
        r.push(&TurnEvent::TextDelta {
            text: "It says contents.".into(),
        });
        assert!(r.finish(Some("end_turn")));

        let events = s.events();
        assert!(matches!(events[1], SessionEvent::UserMessage { .. }));
        let SessionEvent::AssistantMessage { blocks, .. } = &events[2] else {
            panic!("expected an assistant message, got {:?}", events[2]);
        };
        // Stream order, thinking before the call it led to.
        assert!(matches!(blocks[0], ContentBlock::Thinking { .. }));
        assert!(matches!(blocks[1], ContentBlock::Text { .. }));
        assert!(matches!(blocks[2], ContentBlock::ToolUse { .. }));
        assert!(matches!(events[3], SessionEvent::ToolResult { .. }));
        assert!(matches!(events[4], SessionEvent::AssistantMessage { .. }));

        // And it is a valid request: every call has its result.
        assert_eq!(s.messages().len(), 4);
    }

    #[test]
    fn a_call_the_agent_never_answered_still_gets_a_result() {
        let mut s = Session::new();
        s.record_user("go");
        let mut r = Recorder::new(&mut s, "m");
        r.push(&call("c1"));
        r.push(&call("c2"));
        r.push(&result("c1"));
        // c2 never came back — the agent died, or was killed mid-round.
        r.finish(None);

        let ids: Vec<&str> = s
            .events()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::ToolResult { tool_use_id, .. } => Some(tool_use_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(ids, ["c1", "c2"]);
        let SessionEvent::ToolResult {
            content, is_error, ..
        } = &s.events()[4]
        else {
            panic!("expected the supplied result");
        };
        assert!(*is_error);
        assert!(content.contains("Do not assume it ran"));
    }

    #[test]
    fn an_empty_turn_records_nothing() {
        let mut s = Session::new();
        s.record_user("go");
        let before = s.events().len();
        let r = Recorder::new(&mut s, "m");
        assert!(!r.finish(Some("end_turn")));
        assert_eq!(s.events().len(), before);
    }

    #[test]
    fn usage_lands_on_the_message_that_closes_each_round() {
        let mut s = Session::new();
        s.record_user("go");
        let mut r = Recorder::new(&mut s, "m");
        r.push(&TurnEvent::Usage {
            usage: Usage {
                input_tokens: 10,
                output_tokens: 1,
                ..Usage::default()
            },
        });
        r.push(&call("c1"));
        r.push(&result("c1"));
        r.push(&TurnEvent::Usage {
            usage: Usage {
                input_tokens: 20,
                output_tokens: 2,
                ..Usage::default()
            },
        });
        r.push(&TurnEvent::TextDelta {
            text: "done".into(),
        });
        r.finish(Some("end_turn"));

        let totals: Vec<u64> = s
            .events()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::AssistantMessage { usage, .. } => Some(usage.input_tokens),
                _ => None,
            })
            .collect();
        // The message that opened the tool call carries what had been
        // reported by then; the closing one carries the rest — which is what
        // makes the trailing message the live reading a gauge wants.
        assert_eq!(totals, [10, 20]);
    }

    #[test]
    fn an_oversized_result_is_cut_and_says_so() {
        let mut s = Session::new();
        let mut r = Recorder::new(&mut s, "m");
        r.push(&call("c1"));
        r.push(&TurnEvent::ToolResult {
            tool_use_id: "c1".into(),
            name: "Bash".into(),
            content: "x".repeat(RECORD_LIMIT + 500),
            is_error: false,
        });
        r.finish(None);
        let SessionEvent::ToolResult { content, .. } = &s.events()[2] else {
            panic!("expected a tool result");
        };
        assert!(content.len() < RECORD_LIMIT + 200);
        assert!(content.contains(&format!("{} bytes", RECORD_LIMIT + 500)));
    }
}
