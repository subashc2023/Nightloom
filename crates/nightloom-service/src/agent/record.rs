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

use chrono::{DateTime, Utc};
use nightloom_core::{CacheTtl, ContentBlock, Role, Session, Usage};

use crate::TurnEvent;

/// What this engine's cache writes live for when the usage does not say.
///
/// Measured, not configured: one `claude -p` turn on 2.1.263 (2026-09-15)
/// reported `cache_creation: {ephemeral_1h_input_tokens: 7619,
/// ephemeral_5m_input_tokens: 0}`, and every turn since has said the same.
/// The CLI owns the request and the `ttl` in it, so this is a fact about
/// the CLI at that version and nothing here can change it; a turn whose
/// usage names a lifetime is believed over this constant
/// ([`Usage::cache_ttl`]).
pub const CLAUDE_CODE_CACHE_TTL: CacheTtl = CacheTtl::OneHour;

/// How much of one tool result is kept.
///
/// The agent has already shaped its own output — this is the backstop under
/// that, on `RESULT_LIMIT`'s argument and at the same size: what arrives is
/// whatever another process decided to return, and a log is not the place to
/// find out it decided on forty megabytes.
const RECORD_LIMIT: usize = 64 * 1024;

/// How much replayed conversation an ephemeral turn carries, in characters
/// of transcript, keeping the most recent. An ephemeral chat is short by
/// its nature — "I open it up, I do the thing, I close it" — and this is a
/// backstop under that, not a budget anyone should reach.
const CARRY_LIMIT: usize = 200 * 1024;

/// The prompt for one turn of an ephemeral chat on this engine: the
/// conversation so far, rendered back in front of the new message.
///
/// The recorder's inverse, and the reason it exists is a measurement: a
/// session run with `--no-session-persistence` cannot be `--resume`d
/// (2.1.263 answers "No conversation found"), and this module continues a
/// conversation *only* by resume. So a second turn would begin with a model
/// that had never seen the first. The log is in memory anyway — the
/// recorder wrote it there — and this renders what it holds as the chat's
/// earlier turns: what was said, by whom, in order, with the tool results
/// left out for the reason every other reader of a log leaves them out. It
/// is not a resume — the CLI's own tool calls are gone with the session,
/// and the prompt cache starts over each turn — and the block says so to
/// the model rather than pretending.
///
/// The turn just being sent is `text`; `session` holds everything before
/// it, so a caller renders this *before* recording the new user message.
/// With nothing before it (the first turn) the text goes out untouched.
pub fn carry_transcript(session: &Session, text: &str) -> String {
    let mut earlier = String::new();
    for m in session.messages() {
        let said = m.text();
        if said.trim().is_empty() {
            continue;
        }
        let who = match m.role {
            Role::User => "user",
            Role::Assistant => "assistant",
        };
        earlier.push_str(who);
        earlier.push_str(": ");
        earlier.push_str(said.trim());
        earlier.push_str("\n\n");
    }
    if earlier.is_empty() {
        return text.to_string();
    }
    let mut cut_note = "";
    if earlier.len() > CARRY_LIMIT {
        let mut from = earlier.len() - CARRY_LIMIT;
        while !earlier.is_char_boundary(from) {
            from += 1;
        }
        earlier = earlier[from..].to_string();
        cut_note = " The earliest turns were cut to fit.";
    }
    format!(
        "<earlier-turns>\n\
         This chat is ephemeral: nothing about it is kept, by Nightloom or by you, so its \
         earlier turns are replayed here rather than resumed. Tool results from those turns \
         are not included.{cut_note} Continue the conversation from the last message.\n\n\
         {}\
         </earlier-turns>\n\n{text}",
        earlier.trim_end_matches('\n').to_string() + "\n"
    )
}

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
    /// When the round being assembled was sent, as near as this side of the
    /// pipe can know it (nightshift backlog 063). The turn's first request
    /// goes out when the CLI is spawned, which is when this recorder is
    /// built; every later round is sent after the last tool result of the
    /// round before it, so the time that result arrived is the tightest
    /// lower bound the stream gives. A lower bound, never an upper one: the
    /// timer built on it may run short, and short is the direction that
    /// never claims a cache the API has already dropped.
    sent_at: DateTime<Utc>,
    /// Whether anything at all was recorded, so an empty turn writes no
    /// empty assistant message.
    wrote: bool,
    /// Each subagent's narrative so far, by the id of the call that
    /// spawned it, in the order the subagents first spoke (2026-09-16,
    /// nightshift backlog 075). Written out as one [`subagent_block`] per
    /// parent when the round's assistant message closes — see
    /// [`Recorder::flush_subagents`] for why then.
    subagents: Vec<(String, String)>,
}

impl<'a> Recorder<'a> {
    /// Build this immediately before spawning the turn: construction is
    /// what stamps the first request's start.
    pub fn new(session: &'a mut Session, model: impl Into<String>) -> Self {
        Self {
            session,
            model: model.into(),
            blocks: Vec::new(),
            text: String::new(),
            thinking: String::new(),
            open: Vec::new(),
            usage: Usage::default(),
            sent_at: Utc::now(),
            wrote: false,
            subagents: Vec::new(),
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
                // A result for a call this turn never opened is not this
                // turn's to record (the whole-project review of
                // 2026-09-16, F1): it is the refusal of a call a Stop left
                // pending, delivered by the next turn's process as its
                // first line (measured, `m084-9-deny-stale.jsonl`), and
                // the turn that was stopped already closed that call with
                // the orphan marker. A second result for one id is a log
                // no provider accepts on replay.
                if !self.open.iter().any(|(id, _)| id == tool_use_id) {
                    return;
                }
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
                // The next round cannot have been sent before this result
                // was in; the last result of the round is the bound kept.
                self.sent_at = Utc::now();
            }
            TurnEvent::Usage { usage } => self.usage.add(*usage),
            TurnEvent::Subagent {
                parent_tool_use_id,
                event,
            } => self.push_subagent(parent_tool_use_id, event),
            // Nothing else an agent emits reaches the log: a denial and a
            // round limit are the engine's own vocabulary, and a compaction
            // is the agent's business inside its own history.
            _ => {}
        }
    }

    /// A subagent's event goes into its narrative, not into the round's
    /// blocks (backlog 075). Its calls used to be recorded as the main
    /// thread's `tool_use` blocks under a `sub:` name — which named no
    /// parent and, carrying a colon, was a name no provider accepts on
    /// replay. Now the child's turn is kept as prose against the parent's
    /// id: each call one line, its result's first line under it, its
    /// words as they are. A log reader that knows the marker
    /// ([`SUBAGENT_OPEN`]) nests it under the parent's row; a provider
    /// replaying the log sees assistant text, which is valid.
    fn push_subagent(&mut self, parent: &str, event: &TurnEvent) {
        let line = match event {
            TurnEvent::TextDelta { text } => text.clone(),
            // Empty on Haiku (2.1.263 sends the block with no text); a
            // model that forwards its thinking gets a row per thought.
            TurnEvent::ThinkingDelta { text } if text.trim().is_empty() => return,
            TurnEvent::ThinkingDelta { text } => format!("✦ {}", first_line(text)),
            TurnEvent::RedactedThinking => "✦ (thinking withheld)".to_string(),
            TurnEvent::ToolCall { name, input, .. } => {
                format!("▸ {name} {}", first_line(&compact_input(input)))
            }
            TurnEvent::ToolResult {
                content, is_error, ..
            } => format!(
                "  ↳ {}{}",
                if *is_error { "error: " } else { "" },
                first_line(content)
            ),
            // A nested subagent's events arrive wrapped again, under its
            // own parent; anything else a child emits has no place here.
            _ => return,
        };
        let entry = match self.subagents.iter_mut().find(|(id, _)| id == parent) {
            Some(entry) => entry,
            None => {
                self.subagents.push((parent.to_string(), String::new()));
                self.subagents.last_mut().expect("just pushed")
            }
        };
        if !entry.1.is_empty() && !entry.1.ends_with('\n') {
            entry.1.push('\n');
        }
        entry.1.push_str(&line);
    }

    /// Every subagent narrative so far becomes a marked text block. Called
    /// as the round's assistant message closes, which is the one moment
    /// that works for both kinds of subagent: a foreground one has spoken
    /// before its parent's result arrives, so its block lands in the
    /// message holding the parent's call; a background one speaks after
    /// that result (the parent's result is "Async agent launched…" at
    /// once; measured `m075-1-forward.jsonl`) and its block lands in a
    /// later message of the same turn, still tagged with the parent's id.
    fn flush_subagents(&mut self) {
        for (parent, narrative) in std::mem::take(&mut self.subagents) {
            if narrative.trim().is_empty() {
                continue;
            }
            self.blocks.push(ContentBlock::Text {
                text: subagent_block(&parent, &clip(&narrative)),
            });
        }
    }

    /// A block of the caller's own, after whatever prose has streamed so
    /// far (nightshift backlog 149, 2026-09-17): the council's seat blocks
    /// and its record, appended to the chair's message before `finish` so
    /// they are blocks of that message and not text merged into its reply.
    /// The prose is closed first, so the order in the log is the order of
    /// events.
    pub fn push_block(&mut self, block: ContentBlock) {
        self.flush_prose();
        self.blocks.push(block);
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
        self.flush_subagents();
        if self.blocks.is_empty() {
            return;
        }
        let blocks = std::mem::take(&mut self.blocks);
        self.session.record_assistant_timed(
            self.model.clone(),
            blocks,
            stop_reason.map(String::from),
            std::mem::take(&mut self.usage),
            None,
            self.sent_at,
            Some(CLAUDE_CODE_CACHE_TTL),
        );
        self.wrote = true;
    }
}

/// The marker a subagent's narrative is recorded under, as a text block:
/// `<subagent parent="<tool_use_id>">\n…\n</subagent>` (backlog 075). A
/// renderer that knows it nests the block under the parent's call; one
/// that does not shows a readable transcript with the parent named.
pub const SUBAGENT_OPEN: &str = "<subagent parent=\"";
pub const SUBAGENT_CLOSE: &str = "</subagent>";

/// One subagent's narrative as the log records it.
pub fn subagent_block(parent: &str, narrative: &str) -> String {
    format!(
        "{SUBAGENT_OPEN}{parent}\">\n{}\n{SUBAGENT_CLOSE}",
        narrative.trim_end_matches('\n')
    )
}

/// The first line of a result or a thought, cut to a row's width: the
/// child's narrative is a summary, and the full content is in the CLI's
/// own session.
fn first_line(text: &str) -> String {
    const WIDTH: usize = 160;
    let line = text.lines().next().unwrap_or("").trim();
    if line.chars().count() <= WIDTH {
        return line.to_string();
    }
    let cut: String = line.chars().take(WIDTH).collect();
    format!("{cut}…")
}

/// A call's input on one line: the values of its fields, in order, the
/// way a transcript row shows them (`file_path` first when it has one).
fn compact_input(input: &serde_json::Value) -> String {
    match input {
        serde_json::Value::Object(map) => {
            let mut parts: Vec<String> = Vec::new();
            for key in [
                "file_path",
                "command",
                "pattern",
                "path",
                "prompt",
                "description",
            ] {
                if let Some(v) = map.get(key) {
                    parts.push(scalar(v));
                }
            }
            if parts.is_empty() {
                parts.extend(map.values().map(scalar));
            }
            parts.join(" · ")
        }
        other => scalar(other),
    }
}

fn scalar(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
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

    /// The refusal of a call a Stop left pending arrives as the first
    /// line of the next turn (review F1, 2026-09-16); the stopped turn
    /// already closed that call, so the result has no open call here and
    /// is not recorded — one result per call, whatever the stream says.
    #[test]
    fn a_result_for_a_call_this_turn_never_opened_is_dropped() {
        let mut s = Session::new();
        s.record_user("go");
        let mut r = Recorder::new(&mut s, "m");
        r.push(&TurnEvent::ToolResult {
            tool_use_id: "stale".into(),
            name: "Edit".into(),
            content: "the turn was stopped before this was approved".into(),
            is_error: true,
        });
        r.push(&call("c1"));
        r.push(&result("c1"));
        r.push(&TurnEvent::TextDelta {
            text: "done".into(),
        });
        assert!(r.finish(Some("end_turn")));

        let ids: Vec<&str> = s
            .events()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::ToolResult { tool_use_id, .. } => Some(tool_use_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(ids, ["c1"]);
        // And nothing else of the stray result: no empty assistant
        // message was flushed ahead of the round it did not belong to.
        assert!(matches!(
            s.events()[2],
            SessionEvent::AssistantMessage { .. }
        ));
        assert!(matches!(s.events()[3], SessionEvent::ToolResult { .. }));
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

    /// Each round's message carries when its request went out and the
    /// lifetime of the cache it left (nightshift backlog 063): the split's
    /// own when the usage names one, this engine's measured hour when the
    /// round only read, nothing when it touched no cache.
    #[test]
    fn each_round_records_its_send_time_and_cache_lifetime() {
        let mut s = Session::new();
        let built = Utc::now();
        let mut r = Recorder::new(&mut s, "m");
        r.push(&TurnEvent::TextDelta { text: "a".into() });
        r.push(&call("t1"));
        r.push(&TurnEvent::Usage {
            usage: Usage {
                input_tokens: 10,
                cache_write_tokens: Some(10),
                cache_write_1h_tokens: Some(10),
                cache_write_5m_tokens: Some(0),
                ..Usage::default()
            },
        });
        r.push(&result("t1"));
        let after_result = Utc::now();
        r.push(&TurnEvent::TextDelta { text: "b".into() });
        r.push(&TurnEvent::Usage {
            usage: Usage {
                input_tokens: 20,
                cache_read_tokens: Some(20),
                cache_write_tokens: Some(0),
                ..Usage::default()
            },
        });
        r.finish(Some("end_turn"));

        let rounds: Vec<(DateTime<Utc>, Option<CacheTtl>)> = s
            .events()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::AssistantMessage {
                    sent_at, cache_ttl, ..
                } => Some((sent_at.unwrap(), *cache_ttl)),
                _ => None,
            })
            .collect();
        assert_eq!(rounds.len(), 2);
        // The first request was sent when the recorder was built, before
        // the first result; the second no earlier than that result.
        assert!(rounds[0].0 >= built && rounds[0].0 <= after_result);
        assert!(rounds[1].0 >= rounds[0].0 && rounds[1].0 <= Utc::now());
        assert_eq!(rounds[0].1, Some(CacheTtl::OneHour));
        assert_eq!(rounds[1].1, Some(CLAUDE_CODE_CACHE_TTL));

        // A round that neither read nor wrote leaves nothing to time.
        let mut s = Session::new();
        let mut r = Recorder::new(&mut s, "m");
        r.push(&TurnEvent::TextDelta { text: "a".into() });
        r.push(&TurnEvent::Usage {
            usage: Usage {
                input_tokens: 10,
                ..Usage::default()
            },
        });
        r.finish(Some("end_turn"));
        assert!(matches!(
            s.events().last().unwrap(),
            SessionEvent::AssistantMessage {
                sent_at: Some(_),
                cache_ttl: None,
                ..
            }
        ));
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

    /// The first turn goes out as typed; a later one carries what was said
    /// before it, in order, with the speakers named, the tool result left
    /// out, and the new message last and untouched.
    #[test]
    fn an_ephemeral_turn_carries_the_earlier_conversation_and_never_a_tool_result() {
        let mut s = Session::ephemeral();
        assert_eq!(carry_transcript(&s, "first question"), "first question");

        s.record_user("first question");
        let mut r = Recorder::new(&mut s, "m");
        r.push(&TurnEvent::TextDelta {
            text: "let me read".into(),
        });
        r.push(&call("c1"));
        r.push(&TurnEvent::ToolResult {
            tool_use_id: "c1".into(),
            name: "Read".into(),
            content: "SECRET-FILE-CONTENTS".into(),
            is_error: false,
        });
        r.push(&TurnEvent::TextDelta {
            text: "the file says hello".into(),
        });
        r.finish(Some("end_turn"));

        let out = carry_transcript(&s, "second question");
        assert!(out.starts_with("<earlier-turns>\n"), "{out}");
        assert!(
            out.ends_with("</earlier-turns>\n\nsecond question"),
            "{out}"
        );
        assert!(
            out.contains("user: first question\n\nassistant: let me read"),
            "{out}"
        );
        assert!(out.contains("assistant: the file says hello"), "{out}");
        assert!(!out.contains("SECRET-FILE-CONTENTS"), "{out}");
        assert!(out.contains("replayed here rather than resumed"), "{out}");
        assert!(!out.contains("were cut"), "{out}");
    }

    /// Past the limit the oldest turns go and the block says so.
    #[test]
    fn an_oversized_carry_keeps_the_most_recent_turns() {
        let mut s = Session::ephemeral();
        for i in 0..40 {
            s.record_user(format!("turn {i} {}", "x".repeat(8 * 1024)));
            s.record_assistant(
                "m",
                vec![ContentBlock::Text {
                    text: format!("reply {i}"),
                }],
                None,
                Usage::default(),
            );
        }
        let out = carry_transcript(&s, "now");
        assert!(out.len() < CARRY_LIMIT + 2048, "{}", out.len());
        assert!(out.contains("were cut to fit"));
        assert!(out.contains("reply 39"));
        assert!(!out.contains("reply 0\n"));
    }

    fn sub(parent: &str, event: TurnEvent) -> TurnEvent {
        TurnEvent::Subagent {
            parent_tool_use_id: parent.into(),
            event: Box::new(event),
        }
    }

    fn assistant_blocks(s: &Session) -> Vec<Vec<ContentBlock>> {
        s.events()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::AssistantMessage { blocks, .. } => Some(blocks.clone()),
                _ => None,
            })
            .collect()
    }

    /// A foreground subagent (backlog 075): its calls and words become one
    /// marked text block in the message that holds the parent's call — no
    /// `sub:` tool_use blocks of its own, so the message replays — and the
    /// parent's real result is recorded as it was.
    #[test]
    fn a_subagents_turn_is_recorded_as_a_marked_block_against_its_parent() {
        let mut s = Session::new();
        s.record_user("explore");
        let mut r = Recorder::new(&mut s, "m");
        r.push(&TurnEvent::ToolCall {
            id: "p1".into(),
            name: "Agent".into(),
            input: json!({"prompt": "read everything", "subagent_type": "Explore"}),
        });
        r.push(&sub(
            "p1",
            TurnEvent::ThinkingDelta {
                text: String::new(),
            },
        ));
        r.push(&sub("p1", call("c1")));
        r.push(&sub(
            "p1",
            TurnEvent::ToolResult {
                tool_use_id: "c1".into(),
                name: "Read".into(),
                content: "1\tdef add(a, b):\n2\t    return a + b\n".into(),
                is_error: false,
            },
        ));
        r.push(&sub(
            "p1",
            TurnEvent::TextDelta {
                text: "## Summary\n\nAdds numbers.".into(),
            },
        ));
        r.push(&TurnEvent::ToolResult {
            tool_use_id: "p1".into(),
            name: "Agent".into(),
            content: "Adds numbers.".into(),
            is_error: false,
        });
        r.push(&TurnEvent::TextDelta {
            text: "Done.".into(),
        });
        assert!(r.finish(Some("end_turn")));
        let msgs = assistant_blocks(&s);
        assert_eq!(msgs.len(), 2, "{msgs:?}");
        let first = &msgs[0];
        assert!(matches!(&first[0], ContentBlock::ToolUse { name, .. } if name == "Agent"));
        let text = match &first[1] {
            ContentBlock::Text { text } => text.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(
            text,
            "<subagent parent=\"p1\">\n\u{25b8} Read a.txt\n  \u{21b3} 1\tdef add(a, b):\n## Summary\n\nAdds numbers.\n</subagent>"
        );
        assert_eq!(first.len(), 2, "no sub: tool_use blocks: {first:?}");
        assert!(
            !s.events().iter().any(|e| matches!(e,
                SessionEvent::ToolResult { tool_use_id, .. } if tool_use_id == "c1")),
            "the child's result is in the narrative, not a result event"
        );
        assert!(s.events().iter().any(|e| matches!(e,
            SessionEvent::ToolResult { tool_use_id, content, .. } if tool_use_id == "p1" && content == "Adds numbers.")));
        assert!(matches!(&msgs[1][0], ContentBlock::Text { text } if text == "Done."));
    }

    /// A background subagent speaks after its parent's result: the block
    /// lands in the next message of the turn, still tagged with the
    /// parent's id, and a turn that ends while the child is mid-sentence
    /// still writes what it had.
    #[test]
    fn a_background_subagents_words_land_in_a_later_message_of_the_turn() {
        let mut s = Session::new();
        s.record_user("explore in the background");
        let mut r = Recorder::new(&mut s, "m");
        r.push(&TurnEvent::ToolCall {
            id: "p2".into(),
            name: "Agent".into(),
            input: json!({"prompt": "x"}),
        });
        r.push(&TurnEvent::ToolResult {
            tool_use_id: "p2".into(),
            name: "Agent".into(),
            content: "Async agent launched successfully.".into(),
            is_error: false,
        });
        r.push(&TurnEvent::TextDelta {
            text: "Waiting.".into(),
        });
        r.push(&sub("p2", call("c2")));
        r.push(&sub(
            "p2",
            TurnEvent::TextDelta {
                text: "Found it.".into(),
            },
        ));
        r.finish(Some("end_turn"));
        let msgs = assistant_blocks(&s);
        assert_eq!(msgs.len(), 2, "{msgs:?}");
        assert!(matches!(&msgs[1][0], ContentBlock::Text { text } if text == "Waiting."));
        assert!(matches!(&msgs[1][1], ContentBlock::Text { text }
            if text.starts_with("<subagent parent=\"p2\">\n") && text.contains("\u{25b8} Read a.txt\nFound it.\n</subagent>")));
        assert_eq!(
            subagent_block("p", "a\n"),
            "<subagent parent=\"p\">\na\n</subagent>"
        );
    }
}
