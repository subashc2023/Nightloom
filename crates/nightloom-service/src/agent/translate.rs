//! Claude Code's NDJSON, translated into [`TurnEvent`].
//!
//! `TurnEvent` is the seam both shells already render, so a faithful
//! translation here is the whole integration: the CLI's `render` and the
//! desktop's `turn-event` listener light up with no changes at all.
//!
//! The translator is a pure function of the byte stream — no process, no
//! clock, no network — which is what lets it be tested against verbatim
//! captured lines, the same shape as the adapter tests that assert on
//! request-body JSON.

use super::protocol::{
    ApiMessage, Block, Delta, Line, RateLimitInfo, ResultLine, StreamEv, SystemLine,
};
use crate::TurnEvent;
use nightloom_core::Usage;
use std::collections::HashMap;

/// What the turn produced beyond its rendered events.
#[derive(Debug, Default, Clone)]
pub struct AgentOutcome {
    /// The final assistant text, as the CLI itself summarized it.
    pub text: String,
    /// Claude Code's session id — the handle `--resume` takes.
    pub session_id: Option<String>,
    /// The model the CLI resolved to, from the `init` line.
    pub model: Option<String>,
    /// Summed across every round of the turn.
    pub usage: Usage,
    /// The CLI's own client-side estimate, and **not** a bill: under a
    /// subscription nothing here is charged per token. Carried so a shell
    /// can show what the same turn would have cost on the API, which is the
    /// only reading of this number that is true.
    pub cost_usd: Option<f64>,
    /// Assistant turns the CLI took internally, tool rounds included.
    pub rounds: Option<u32>,
    /// The plan window, when the run authenticated with OAuth.
    pub rate_limit: Option<RateLimitInfo>,
    /// Retries and other things worth saying out loud once.
    pub notices: Vec<String>,
    /// The CLI reported the turn itself as failed.
    pub is_error: bool,
}

/// Feeds lines in, gets [`TurnEvent`]s out, accumulates an [`AgentOutcome`].
#[derive(Debug, Default)]
pub struct Translator {
    /// `tool_use_id` → tool name. `TurnEvent::ToolResult` carries a name and
    /// Claude Code's `tool_result` block does not, so the pairing has to be
    /// remembered from the call that opened it.
    pending: HashMap<String, String>,
    outcome: AgentOutcome,
}

impl Translator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Translate one line. Unparseable lines yield nothing rather than
    /// failing the turn — the log is another process's and a build of it
    /// newer than this one is expected, not exceptional.
    pub fn push(&mut self, line: &str) -> Vec<TurnEvent> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        let Ok(parsed) = serde_json::from_str::<Line>(line) else {
            return Vec::new();
        };
        match parsed {
            Line::StreamEvent { event } => self.stream_event(event),
            Line::Assistant(t) => self.blocks(t.message, t.parent_tool_use_id.is_some()),
            Line::User(t) => self.blocks(t.message, t.parent_tool_use_id.is_some()),
            Line::System(s) => {
                self.system(s);
                Vec::new()
            }
            Line::Result(r) => self.result(r),
            Line::RateLimitEvent { rate_limit_info } => {
                self.outcome.rate_limit = Some(rate_limit_info);
                Vec::new()
            }
            Line::Unknown => Vec::new(),
        }
    }

    /// The accumulated outcome. Call after the stream ends.
    pub fn finish(self) -> AgentOutcome {
        self.outcome
    }

    fn stream_event(&mut self, event: StreamEv) -> Vec<TurnEvent> {
        match event {
            StreamEv::ContentBlockDelta { delta } => match delta {
                Delta::Text { text } => vec![TurnEvent::TextDelta { text }],
                Delta::Thinking { thinking } => vec![TurnEvent::ThinkingDelta { text: thinking }],
                Delta::Other => Vec::new(),
            },
            // One per API call, so this is the round's accounting rather
            // than a running total — which is exactly what a context gauge
            // wants and what `TurnEvent::Usage` documents itself as.
            StreamEv::MessageDelta { usage: Some(raw) } => {
                let usage = raw.to_usage();
                self.outcome.usage.add(usage);
                vec![TurnEvent::Usage { usage }]
            }
            StreamEv::MessageDelta { usage: None } | StreamEv::Other => Vec::new(),
        }
    }

    /// `nested` is a message from a subagent — one Claude Code spawned via
    /// its own `Task` tool, carrying the spawning call's id.
    ///
    /// Its calls are rendered rather than hidden, because watching a
    /// subagent work is most of what a subagent's progress *is*. But they
    /// are marked, because a nested `Read` shown as a bare `Read` claims the
    /// main thread did it — and the two have different reasons to worry you.
    fn blocks(&mut self, message: ApiMessage, nested: bool) -> Vec<TurnEvent> {
        let mut out = Vec::new();
        for block in message.content {
            match block {
                Block::ToolUse { id, name, input } => {
                    self.pending.insert(id.clone(), name.clone());
                    out.push(TurnEvent::ToolCall {
                        id,
                        name: label(&name, nested),
                        input,
                    });
                }
                Block::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => {
                    let name = self
                        .pending
                        .remove(&tool_use_id)
                        .unwrap_or_else(|| "unknown".to_string());
                    out.push(TurnEvent::ToolResult {
                        tool_use_id,
                        name: label(&name, nested),
                        content: flatten(&content),
                        is_error,
                    });
                }
                Block::RedactedThinking => out.push(TurnEvent::RedactedThinking),
                Block::Other => {}
            }
        }
        out
    }

    fn system(&mut self, line: SystemLine) {
        match line {
            SystemLine::Init {
                session_id,
                model,
                tools,
            } => {
                self.outcome.session_id = session_id;
                self.outcome.model = model;
                let _ = tools;
            }
            SystemLine::ApiRetry {
                attempt,
                max_retries,
                error,
            } => {
                let what = error.unwrap_or_else(|| "transient failure".into());
                self.outcome
                    .notices
                    .push(format!("retrying after {what} ({attempt}/{max_retries})"));
            }
            SystemLine::Other => {}
        }
    }

    fn result(&mut self, r: ResultLine) -> Vec<TurnEvent> {
        if let Some(text) = r.result {
            self.outcome.text = text;
        }
        if let Some(id) = r.session_id {
            self.outcome.session_id = Some(id);
        }
        self.outcome.cost_usd = r.total_cost_usd;
        self.outcome.rounds = r.num_turns;
        self.outcome.is_error = r.is_error;
        if let Some(sub) = r.subtype.filter(|s| s != "success") {
            self.outcome.notices.push(format!("ended: {sub}"));
        }
        // The `result` line repeats the turn's totals, which `message_delta`
        // has already been reporting per round. Adding them again would
        // double every figure in the gauge, so it is read only when no
        // round ever reported — a turn that failed before it streamed.
        if self.outcome.usage == Usage::default()
            && let Some(raw) = r.usage
        {
            self.outcome.usage = raw.to_usage();
        }
        Vec::new()
    }
}

/// A tool's name as the transcript should show it. ASCII, because this
/// lands in a terminal chip and in the desktop's tool list alike.
fn label(name: &str, nested: bool) -> String {
    if nested {
        format!("sub:{name}")
    } else {
        name.to_string()
    }
}

/// A `tool_result`'s content, which is a bare string on the common path and
/// a block array when the tool returned something structured.
fn flatten(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .map(|b| match b.get("text").and_then(|t| t.as_str()) {
                Some(t) => t.to_string(),
                // Naming what cannot be carried rather than dropping it, on
                // `McpTool`'s argument: an empty result reads as a call that
                // did nothing and invites a retry.
                None => match b.get("type").and_then(|t| t.as_str()) {
                    Some(kind) => format!("[{kind}]"),
                    None => String::new(),
                },
            })
            .collect::<Vec<_>>()
            .join("\n"),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim lines from `claude -p "Say exactly: hello" --tools ""
    /// --output-format stream-json --include-partial-messages --verbose`
    /// on 2.1.237, trimmed of fields nothing here reads.
    const INIT: &str = r#"{"type":"system","subtype":"init","cwd":"C:\\tmp","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5-20251001","permissionMode":"default","session_id":"e111a725-ecb4-40e9-8ccf-033e6b658866"}"#;
    const THINK: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"The user is","estimated_tokens":null}}}"#;
    const SIG: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EpwDCq8BCBAYAipA"}}}"#;
    const TEXT: &str = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello"}}}"#;
    const MSG_DELTA: &str = r#"{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":3546,"cache_creation_input_tokens":10,"cache_read_input_tokens":100,"output_tokens":43,"output_tokens_details":{"thinking_tokens":36}}}}"#;
    const ASSISTANT_TEXT: &str = r#"{"type":"assistant","message":{"model":"claude-haiku-4-5","role":"assistant","content":[{"type":"text","text":"hello"}]},"parent_tool_use_id":null,"session_id":"e1"}"#;
    const TOOL_USE: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_012V","name":"Read","input":{"file_path":"C:\\tmp\\data.txt"},"caller":{"type":"direct"}}]},"parent_tool_use_id":null}"#;
    const TOOL_RESULT_ERR: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"File does not exist.","is_error":true,"tool_use_id":"toolu_012V"}]},"parent_tool_use_id":null}"#;
    const RATE_LIMIT: &str = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1787269200,"rateLimitType":"five_hour","overageStatus":"allowed","isUsingOverage":false}}"#;
    const RESULT: &str = r#"{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"hello","session_id":"e111a725","total_cost_usd":0.003761,"usage":{"input_tokens":3546,"output_tokens":43}}"#;

    fn drive(lines: &[&str]) -> (Vec<TurnEvent>, AgentOutcome) {
        let mut t = Translator::new();
        let events = lines.iter().flat_map(|l| t.push(l)).collect();
        (events, t.finish())
    }

    #[test]
    fn text_and_thinking_stream_as_deltas() {
        let (events, _) = drive(&[THINK, TEXT]);
        assert!(matches!(&events[0], TurnEvent::ThinkingDelta { text } if text == "The user is"));
        assert!(matches!(&events[1], TurnEvent::TextDelta { text } if text == "hello"));
        assert_eq!(events.len(), 2);
    }

    /// The same reply arrives twice — as deltas, then as a whole block on
    /// the `assistant` line. Emitting both renders every answer twice.
    #[test]
    fn assistant_text_block_does_not_duplicate_the_deltas() {
        let (events, _) = drive(&[TEXT, ASSISTANT_TEXT]);
        assert_eq!(events.len(), 1, "assistant text block must be dropped");
    }

    /// Signature and input-json deltas are not content and must not render.
    #[test]
    fn opaque_deltas_are_dropped() {
        let (events, _) = drive(&[SIG]);
        assert!(events.is_empty());
    }

    /// `tool_result` carries no name; the pairing comes from the call.
    #[test]
    fn tool_result_takes_its_name_from_the_call() {
        let (events, _) = drive(&[TOOL_USE, TOOL_RESULT_ERR]);
        assert!(matches!(&events[0], TurnEvent::ToolCall { name, id, .. }
            if name == "Read" && id == "toolu_012V"));
        match &events[1] {
            TurnEvent::ToolResult {
                name,
                is_error,
                content,
                tool_use_id,
            } => {
                assert_eq!(name, "Read");
                assert_eq!(tool_use_id, "toolu_012V");
                assert!(is_error);
                assert_eq!(content, "File does not exist.");
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    /// A subagent's calls render, and say that is what they are. Shown bare
    /// they would claim the main thread opened the file.
    #[test]
    fn subagent_calls_are_marked() {
        const NESTED: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_9","name":"Read","input":{}}]},"parent_tool_use_id":"toolu_parent"}"#;
        const NESTED_RESULT: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok","tool_use_id":"toolu_9"}]},"parent_tool_use_id":"toolu_parent"}"#;
        let (events, _) = drive(&[NESTED, NESTED_RESULT]);
        assert!(matches!(&events[0], TurnEvent::ToolCall { name, .. } if name == "sub:Read"));
        assert!(matches!(&events[1], TurnEvent::ToolResult { name, .. } if name == "sub:Read"));
        // The main thread's calls keep their plain names.
        let (top, _) = drive(&[TOOL_USE]);
        assert!(matches!(&top[0], TurnEvent::ToolCall { name, .. } if name == "Read"));
    }

    /// A result whose call was never seen still renders, rather than being
    /// dropped: a missing chip is harder to diagnose than a vague one.
    #[test]
    fn orphan_tool_result_still_renders() {
        let (events, _) = drive(&[TOOL_RESULT_ERR]);
        assert!(matches!(&events[0], TurnEvent::ToolResult { name, .. } if name == "unknown"));
    }

    /// Anthropic reports `input_tokens` exclusive of cache traffic. Summed
    /// here or the gauge reads 3546 against a real prompt of 3656.
    #[test]
    fn usage_input_is_the_whole_prompt() {
        let (events, outcome) = drive(&[MSG_DELTA]);
        let TurnEvent::Usage { usage } = &events[0] else {
            panic!("expected Usage, got {:?}", events[0]);
        };
        assert_eq!(usage.input_tokens, 3546 + 10 + 100);
        assert_eq!(usage.cache_read_tokens, Some(100));
        assert_eq!(usage.cache_write_tokens, Some(10));
        assert_eq!(usage.reasoning_tokens, Some(36));
        assert_eq!(outcome.usage.input_tokens, 3656);
    }

    /// The `result` line repeats the turn total. Added on top of the
    /// per-round figures it would double every number in the gauge.
    #[test]
    fn result_usage_does_not_double_count_rounds() {
        let (_, outcome) = drive(&[MSG_DELTA, RESULT]);
        assert_eq!(outcome.usage.input_tokens, 3656);
        assert_eq!(outcome.usage.output_tokens, 43);
    }

    /// A turn that died before streaming has no round to read, so the
    /// totals on `result` are the only accounting there is.
    #[test]
    fn result_usage_is_read_when_no_round_reported() {
        let (_, outcome) = drive(&[RESULT]);
        assert_eq!(outcome.usage.input_tokens, 3546);
    }

    #[test]
    fn outcome_carries_session_model_and_plan_window() {
        let (_, outcome) = drive(&[INIT, RATE_LIMIT, RESULT]);
        assert_eq!(outcome.session_id.as_deref(), Some("e111a725"));
        assert_eq!(outcome.model.as_deref(), Some("claude-haiku-4-5-20251001"));
        assert_eq!(outcome.text, "hello");
        assert_eq!(outcome.rounds, Some(2));
        assert_eq!(outcome.cost_usd, Some(0.003761));
        let plan = outcome.rate_limit.expect("plan window");
        assert_eq!(plan.window.as_deref(), Some("five_hour"));
        assert_eq!(plan.status.as_deref(), Some("allowed"));
        assert!(!plan.using_overage);
    }

    /// A line this build cannot read costs that line and nothing else —
    /// `claude` ships on its own cadence and will add event types.
    #[test]
    fn unknown_and_torn_lines_are_survivable() {
        let (events, outcome) = drive(&[
            r#"{"type":"some_future_event","payload":{}}"#,
            r#"{"type":"stream_event","event":{"type":"content_bl"#,
            "",
            "   ",
            TEXT,
        ]);
        assert_eq!(events.len(), 1, "the good line still translates");
        assert!(!outcome.is_error);
    }

    /// A structured tool result flattens to text, naming what it cannot
    /// carry rather than yielding an empty string.
    #[test]
    fn structured_tool_result_flattens() {
        let blocks = serde_json::json!([
            {"type": "text", "text": "line one"},
            {"type": "image", "source": {}},
        ]);
        assert_eq!(flatten(&blocks), "line one\n[image]");
        assert_eq!(flatten(&serde_json::Value::Null), "");
    }
}
