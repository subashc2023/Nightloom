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

use super::ask::DeferredCall;
use super::protocol::{
    ApiMessage, Block, Delta, DeniedCall, Line, RateLimitInfo, ResultLine, StreamEv, SystemLine,
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
    /// The call the CLI exited on, waiting for an answer (2026-09-16,
    /// nightshift backlog 084). `Some` exactly when the `result` line said
    /// `stop_reason: "tool_deferred"`; the process is gone, the session on
    /// disk still holds the call, and the turn is not over until a
    /// `--resume` runs it or refuses it — see [`super::ask`].
    pub deferred: Option<DeferredCall>,
    /// The calls the CLI refused on permission during the turn (nightshift
    /// backlog 143, pass 2): under Ask, a read outside the folders the
    /// chat may see is one — the prompt host denies it rather than pausing
    /// (see [`super::ask::PromptTool`]) and the model is told; this is how
    /// the shell learns which folder, so the rail can offer the grant. As
    /// the last `result` line listed them.
    pub denied: Vec<DeniedCall>,
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

    /// A translator for the resume of a deferred call: the `tool_result`
    /// that opens that stream belongs to a call this process never saw
    /// announced, so its pairing is seeded from the outcome that deferred
    /// it — or the result would render under the name `unknown`.
    pub fn resuming(call: &DeferredCall) -> Self {
        let mut t = Self::default();
        t.pending.insert(call.id.clone(), call.name.clone());
        t
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
            Line::Assistant(t) => self.blocks(t.message, t.parent_tool_use_id),
            Line::User(t) => self.blocks(t.message, t.parent_tool_use_id),
            Line::System(s) => self.system(s),
            Line::Result(r) => self.result(r),
            Line::RateLimitEvent { rate_limit_info } => {
                self.outcome.rate_limit = Some(rate_limit_info);
                Vec::new()
            }
            Line::PromptSuggestion { suggestion } => {
                let text = suggestion.trim().to_string();
                if text.is_empty() {
                    Vec::new()
                } else {
                    vec![TurnEvent::PromptSuggestion { text }]
                }
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
    /// its own `Agent` tool, carrying the spawning call's id.
    ///
    /// Its calls are rendered rather than hidden, because watching a
    /// subagent work is most of what a subagent's progress *is*. But they
    /// are marked, because a nested `Read` shown as a bare `Read` claims the
    /// main thread did it — and the two have different reasons to worry you.
    /// ~~Marked by a `sub:` prefix on the name~~ — since 2026-09-16
    /// (nightshift backlog 075) marked by wrapping: every event of a nested
    /// line goes out as [`TurnEvent::Subagent`] with the parent's id, the
    /// inner event exactly what the main thread's would be. The prefix
    /// named no parent, so two subagents at once were one stream; and a
    /// name with a colon in it was recorded into the log as a `tool_use`
    /// name, which no provider accepts on replay. The child's text and
    /// thinking are emitted here too — a nested line is their only copy
    /// (`protocol::Block::Text`); a top-level line's are still dropped.
    fn blocks(&mut self, message: ApiMessage, nested: Option<String>) -> Vec<TurnEvent> {
        let mut out = Vec::new();
        for block in message.content {
            let event = match block {
                Block::ToolUse { id, name, input } => {
                    self.pending.insert(id.clone(), name.clone());
                    TurnEvent::ToolCall { id, name, input }
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
                    TurnEvent::ToolResult {
                        tool_use_id,
                        name,
                        content: flatten(&content),
                        is_error,
                    }
                }
                Block::RedactedThinking => TurnEvent::RedactedThinking,
                Block::Text { text } if nested.is_some() && !text.is_empty() => {
                    TurnEvent::TextDelta { text }
                }
                Block::Thinking { thinking } if nested.is_some() && !thinking.is_empty() => {
                    TurnEvent::ThinkingDelta { text: thinking }
                }
                Block::Text { .. } | Block::Thinking { .. } | Block::Other => continue,
            };
            out.push(match &nested {
                Some(parent) => TurnEvent::Subagent {
                    parent_tool_use_id: parent.clone(),
                    event: Box::new(event),
                },
                None => event,
            });
        }
        out
    }

    fn system(&mut self, line: SystemLine) -> Vec<TurnEvent> {
        match line {
            SystemLine::Init {
                session_id,
                model,
                tools,
                mcp_servers,
                slash_commands,
                skills,
                agents,
                claude_code_version,
                permission_mode,
            } => {
                self.outcome.session_id = session_id.clone();
                self.outcome.model = model.clone();
                // The rest of the line goes out as one event (nightshift
                // backlog 077): what this session has, for the Context
                // page's *This session* pane.
                return vec![TurnEvent::AgentInit {
                    session_id,
                    model,
                    version: claude_code_version,
                    permission_mode,
                    tools,
                    mcp_servers: mcp_servers
                        .into_iter()
                        .map(|s| crate::turn::McpServer {
                            name: s.name,
                            status: s.status,
                            error: s.error,
                        })
                        .collect(),
                    slash_commands,
                    skills,
                    agents,
                }];
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
            // The engine's own vocabulary for a refusal, so the transcript
            // marks the call denied where it stands instead of leaving it
            // in flight until the CLI's error result lands — and says why
            // in the one line the CLI gives. The `user` line's error result
            // still follows and pairs the call in the log, as it does for a
            // provider-engine denial.
            SystemLine::PermissionDenied {
                tool_name,
                tool_use_id,
                message,
            } => {
                return vec![TurnEvent::ToolDenied {
                    tool_use_id,
                    name: tool_name,
                    reason: message,
                }];
            }
            SystemLine::Other => {}
        }
        Vec::new()
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
        // A deferred call is the turn pausing, not ending: the CLI reports
        // `subtype: "success"` and an empty `result` for it, so nothing
        // above says so, and this is the one field that does. Assigned,
        // not merged: a session resumed with a new prompt while a call was
        // still pending prints *two* result lines in one process — the
        // pending call deferred again, then the prompt's own end — and the
        // later line is the one that says how the turn ended (measured
        // 2026-09-16, `m084-8-stale.jsonl`).
        self.outcome.deferred = if r.stop_reason.as_deref() == Some("tool_deferred") {
            r.deferred_tool_use
        } else {
            None
        };
        // The same rule for the refusals: the last result line's list is
        // the turn's, and a deferral's line (empty on the measured shape)
        // is followed by the resume's, which carries the whole turn's.
        self.outcome.denied = r.permission_denials;
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
    use nightloom_core::CacheTtl;

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

    /// The init line goes out whole as one event (nightshift backlog 077):
    /// a verbatim 2.1.263 line, trimmed to the lists' first entries.
    #[test]
    fn the_init_line_is_one_event_with_what_the_session_has() {
        const FULL: &str = r#"{"type":"system","subtype":"init","cwd":"/tmp/x","session_id":"3dc6cb69-b57a-4617-b43d-6c9b9992b643","tools":["Task","Bash","mcp__claude_ai_Google_Drive__search_files"],"mcp_servers":[{"name":"openalex","status":"pending"},{"name":"claude.ai Gmail","status":"needs-auth"}],"model":"claude-haiku-4-5-20251001","permissionMode":"default","slash_commands":["design","clear"],"terminal_slash_commands":["doctor"],"apiKeySource":"none","claude_code_version":"2.1.263","output_style":"default","agents":["Explore","Plan"],"skills":["design"],"plugins":[],"capabilities":["msg_lifecycle_v1"],"uuid":"54c8ef44-b001-4c04-b4f4-6043092b9529","memory_paths":{"auto":"/Users/x/.claude/projects/-tmp-x/memory/"}}"#;
        let (events, outcome) = drive(&[FULL]);
        assert_eq!(events.len(), 1);
        match &events[0] {
            TurnEvent::AgentInit {
                session_id,
                model,
                version,
                permission_mode,
                tools,
                mcp_servers,
                slash_commands,
                skills,
                agents,
            } => {
                assert_eq!(
                    session_id.as_deref(),
                    Some("3dc6cb69-b57a-4617-b43d-6c9b9992b643")
                );
                assert_eq!(model.as_deref(), Some("claude-haiku-4-5-20251001"));
                assert_eq!(version.as_deref(), Some("2.1.263"));
                assert_eq!(permission_mode.as_deref(), Some("default"));
                assert_eq!(tools.len(), 3);
                assert_eq!(mcp_servers[0].name, "openalex");
                assert_eq!(mcp_servers[0].status, "pending");
                assert!(mcp_servers[0].error.is_none());
                assert_eq!(mcp_servers[1].status, "needs-auth");
                assert_eq!(slash_commands, &["design", "clear"]);
                assert_eq!(skills, &["design"]);
                assert_eq!(agents, &["Explore", "Plan"]);
            }
            other => panic!("expected AgentInit, got {other:?}"),
        }
        // And the outcome still learns the id and model from it.
        assert_eq!(outcome.model.as_deref(), Some("claude-haiku-4-5-20251001"));
        // The older, shorter line (no lists) still parses, with empty lists.
        let (events, _) = drive(&[INIT]);
        assert!(
            matches!(&events[0], TurnEvent::AgentInit { skills, version, .. }
            if skills.is_empty() && version.is_none())
        );
    }

    /// The suggestion line (backlog 083): verbatim from 2.1.263, one event.
    #[test]
    fn a_prompt_suggestion_line_is_one_event() {
        const LINE: &str = r#"{"type":"prompt_suggestion","suggestion":"Write the code","uuid":"967e0cd2-5115-4642-ad23-c4e38a6c28d5","session_id":"2279a73e-2a14-4b5d-a9af-2cce68531f10"}"#;
        let (events, _) = drive(&[LINE]);
        assert!(
            matches!(&events[0], TurnEvent::PromptSuggestion { text } if text == "Write the code")
        );
        let (none, _) = drive(&[r#"{"type":"prompt_suggestion","suggestion":"  "}"#]);
        assert!(none.is_empty());
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

    /// A subagent's calls render, and say whose they are: wrapped with the
    /// parent's id, the inner call bare. Shown as the main thread's they
    /// would claim it opened the file; named `sub:Read` (the old marking)
    /// they named no parent and could not be replayed. Its text is the
    /// nested line's only copy, so it is emitted; its empty thinking (what
    /// Haiku sent on 2.1.263, `m075-1-forward.jsonl`) is not.
    #[test]
    fn subagent_calls_are_marked() {
        const NESTED: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_9","name":"Read","input":{}}]},"parent_tool_use_id":"toolu_parent"}"#;
        const NESTED_RESULT: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok","tool_use_id":"toolu_9"}]},"parent_tool_use_id":"toolu_parent"}"#;
        const NESTED_TEXT: &str = r###"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"","signature":"x"},{"type":"text","text":"## Project Summary\n\nTiny."}]},"parent_tool_use_id":"toolu_parent"}"###;
        let (events, _) = drive(&[NESTED, NESTED_RESULT, NESTED_TEXT]);
        assert_eq!(events.len(), 3, "{events:?}");
        match &events[0] {
            TurnEvent::Subagent {
                parent_tool_use_id,
                event,
            } => {
                assert_eq!(parent_tool_use_id, "toolu_parent");
                assert!(
                    matches!(&**event, TurnEvent::ToolCall { name, id, .. } if name == "Read" && id == "toolu_9")
                );
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(&events[1], TurnEvent::Subagent { event, .. }
            if matches!(&**event, TurnEvent::ToolResult { name, content, .. } if name == "Read" && content == "ok")));
        assert!(matches!(&events[2], TurnEvent::Subagent { event, .. }
            if matches!(&**event, TurnEvent::TextDelta { text } if text == "## Project Summary\n\nTiny.")));
        // The main thread's calls keep their plain, unwrapped names, and
        // its text blocks are still left to the deltas.
        const TOP_TEXT: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello"}]},"parent_tool_use_id":null}"#;
        let (top, _) = drive(&[TOOL_USE, TOP_TEXT]);
        assert_eq!(top.len(), 1, "{top:?}");
        assert!(matches!(&top[0], TurnEvent::ToolCall { name, .. } if name == "Read"));
        // The wire shape the window reads.
        let json = serde_json::to_string(&events[2]).unwrap();
        assert!(json.contains(r#""type":"subagent""#), "{json}");
        assert!(
            json.contains(r#""parent_tool_use_id":"toolu_parent""#),
            "{json}"
        );
        assert!(json.contains(r#""event":{"type":"text_delta""#), "{json}");
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

    /// Verbatim from one `claude -p` turn on 2.1.263 (2026-09-15, nightshift
    /// backlog 063), trimmed of fields nothing here reads. On `message_delta`
    /// the lifetime split is only inside `iterations`; on `result` it is at
    /// the top of `usage` as well.
    const MSG_DELTA_263: &str = r#"{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":10,"cache_creation_input_tokens":7619,"cache_read_input_tokens":12144,"output_tokens":42,"output_tokens_details":{"thinking_tokens":35},"iterations":[{"input_tokens":10,"output_tokens":42,"cache_read_input_tokens":12144,"cache_creation_input_tokens":7619,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":7619},"type":"message"}]},"context_management":{"applied_edits":[]}},"session_id":"1e5bca8c","parent_tool_use_id":null}"#;
    const RESULT_263: &str = r#"{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"hi","session_id":"1e5bca8c","total_cost_usd":0.0022,"usage":{"input_tokens":10,"cache_creation_input_tokens":7619,"cache_read_input_tokens":12144,"output_tokens":42,"output_tokens_details":{"thinking_tokens":35},"cache_creation":{"ephemeral_1h_input_tokens":7619,"ephemeral_5m_input_tokens":0}}}"#;

    /// The Claude Code engine writes its cache with the one-hour lifetime,
    /// and the translator finds the split wherever the CLI put it.
    #[test]
    fn the_cache_write_lifetime_is_read_from_wherever_the_cli_puts_it() {
        let (events, _) = drive(&[MSG_DELTA_263]);
        let TurnEvent::Usage { usage } = &events[0] else {
            panic!("expected Usage, got {:?}", events[0]);
        };
        assert_eq!(usage.cache_write_tokens, Some(7619));
        assert_eq!(usage.cache_write_1h_tokens, Some(7619));
        assert_eq!(usage.cache_write_5m_tokens, Some(0));
        assert_eq!(usage.cache_write_ttl(), Some(CacheTtl::OneHour));

        let (_, outcome) = drive(&[RESULT_263]);
        assert_eq!(outcome.usage.cache_write_1h_tokens, Some(7619));
        assert_eq!(outcome.usage.cache_write_ttl(), Some(CacheTtl::OneHour));

        // The older shape has no split: unknown, not zero.
        let (events, _) = drive(&[MSG_DELTA]);
        let TurnEvent::Usage { usage } = &events[0] else {
            panic!("expected Usage, got {:?}", events[0]);
        };
        assert_eq!(usage.cache_write_1h_tokens, None);
        assert_eq!(usage.cache_write_ttl(), None);
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

    /// Verbatim from the 2026-09-16 defer measurement on 2.1.263
    /// (nightshift `082-five-measurements-2026-09-16.md`, 4(b)), usage
    /// fields trimmed: the CLI's `subtype` is still `success` and its
    /// `result` empty, so the deferred call is the only thing that says
    /// the turn paused.
    const TOOL_USE_WRITE: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_0183kRSEVfCJqZ7Xkb2qtMU8","name":"Write","input":{"file_path":"/tmp/b.txt","content":"hello"}}]},"parent_tool_use_id":null}"#;
    const RESULT_DEFERRED: &str = r#"{"type":"result","subtype":"success","stop_reason":"tool_deferred","terminal_reason":"tool_deferred","is_error":false,"num_turns":1,"result":"","permission_denials":[],"session_id":"37d58676-f0f2-489b-8d59-f73106054e94","deferred_tool_use":{"id":"toolu_0183kRSEVfCJqZ7Xkb2qtMU8","name":"Write","input":{"file_path":"/tmp/b.txt","content":"hello"}}}"#;
    /// The resume's opening line, same measurement (4(c)): the result for
    /// the deferred call arrives before any `init`.
    const RESUME_RESULT_LINE: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"File created successfully at: /tmp/b.txt","is_error":false,"tool_use_id":"toolu_0183kRSEVfCJqZ7Xkb2qtMU8"}]},"parent_tool_use_id":null}"#;
    /// A headless Manual-mode refusal, verbatim (4(a)'s first run).
    const PERMISSION_DENIED: &str = r#"{"type":"system","subtype":"permission_denied","tool_name":"Write","tool_use_id":"toolu_01ARqRycp8phHpqzvrPHQTZ1","message":"Claude requested permissions to write to /tmp/a.txt, but you haven't granted it yet.","uuid":"12a21463","session_id":"c222b9af"}"#;

    /// A deferred result carries the call out on the outcome, not as an
    /// error and not as an ended turn: the call was already announced on
    /// the `assistant` line and renders there, and `deferred` is what the
    /// shell reads to know the turn is waiting.
    #[test]
    fn a_deferred_result_carries_the_pending_call() {
        let (events, outcome) = drive(&[INIT, TOOL_USE_WRITE, RESULT_DEFERRED]);
        assert_eq!(
            events.len(),
            2,
            "the init line's event and the call itself, nothing for the result line"
        );
        assert!(matches!(&events[0], TurnEvent::AgentInit { .. }));
        assert!(matches!(&events[1], TurnEvent::ToolCall { id, name, .. }
            if id == "toolu_0183kRSEVfCJqZ7Xkb2qtMU8" && name == "Write"));
        let call = outcome.deferred.expect("deferred call");
        assert_eq!(call.id, "toolu_0183kRSEVfCJqZ7Xkb2qtMU8");
        assert_eq!(call.name, "Write");
        assert_eq!(call.input["content"], "hello");
        assert!(!outcome.is_error);
        assert!(outcome.notices.is_empty(), "{:?}", outcome.notices);
        assert_eq!(
            outcome.session_id.as_deref(),
            Some("37d58676-f0f2-489b-8d59-f73106054e94")
        );
        // An ordinary end is not a deferral, and a later end clears an
        // earlier deferral in the same stream.
        let (_, plain) = drive(&[RESULT]);
        assert!(plain.deferred.is_none());
        let (_, two) = drive(&[RESULT_DEFERRED, RESULT]);
        assert!(two.deferred.is_none(), "the last result line wins");
        assert_eq!(two.text, "hello");
    }

    /// Verbatim from the 2026-09-17 measurement with a denying prompt
    /// host (nightshift `remainders-report-2026-09-17.md`, m143-3), the
    /// usage trimmed: a read outside the working directories under Ask
    /// ends the turn normally and names the refused call here.
    const RESULT_DENIED: &str = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":4489,"num_turns":3,"result":"denied by the test host","stop_reason":"end_turn","session_id":"622c001b-584c-4eae-ac58-9ec6b07a1cc7","total_cost_usd":0.0071,"permission_denials":[{"tool_name":"Read","tool_use_id":"toolu_01Lm3HWyuxzs8mJZDetcpE5H","tool_input":{"file_path":"/elsewhere/hello.txt"}}]}"#;

    /// The refused calls ride out on the outcome (backlog 143, pass 2),
    /// and a plain result carries none.
    #[test]
    fn a_result_carries_the_calls_the_permission_check_refused() {
        let (_, outcome) = drive(&[INIT, RESULT_DENIED]);
        assert_eq!(outcome.denied.len(), 1);
        assert_eq!(outcome.denied[0].tool_name, "Read");
        assert_eq!(
            outcome.denied[0].tool_use_id,
            "toolu_01Lm3HWyuxzs8mJZDetcpE5H"
        );
        assert_eq!(
            outcome.denied[0].tool_input["file_path"],
            "/elsewhere/hello.txt"
        );
        assert!(!outcome.is_error);
        let (_, plain) = drive(&[RESULT]);
        assert!(plain.denied.is_empty());
    }

    /// The resume stream opens with the result of a call this translator
    /// never saw; seeded, it pairs by name as if it had.
    #[test]
    fn a_resuming_translator_names_the_deferred_calls_result() {
        let call = DeferredCall {
            id: "toolu_0183kRSEVfCJqZ7Xkb2qtMU8".into(),
            name: "Write".into(),
            input: serde_json::json!({}),
        };
        let mut t = Translator::resuming(&call);
        let events = t.push(RESUME_RESULT_LINE);
        assert!(
            matches!(&events[0], TurnEvent::ToolResult { name, is_error, .. }
            if name == "Write" && !is_error)
        );
        // Unseeded, the same line is an orphan.
        let (events, _) = drive(&[RESUME_RESULT_LINE]);
        assert!(matches!(&events[0], TurnEvent::ToolResult { name, .. } if name == "unknown"));
    }

    /// A headless refusal renders as the engine's own denial, so the call
    /// is marked where it stands with the CLI's one line of why.
    #[test]
    fn a_permission_denied_line_is_a_tool_denied_event() {
        let (events, _) = drive(&[PERMISSION_DENIED]);
        match &events[0] {
            TurnEvent::ToolDenied {
                tool_use_id,
                name,
                reason,
            } => {
                assert_eq!(tool_use_id, "toolu_01ARqRycp8phHpqzvrPHQTZ1");
                assert_eq!(name, "Write");
                assert!(
                    reason.starts_with("Claude requested permissions"),
                    "{reason}"
                );
            }
            other => panic!("expected ToolDenied, got {other:?}"),
        }
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

    /// Verbatim from `env -u ANTHROPIC_API_KEY claude -p "Say exactly: hello"
    /// --tools "" --output-format stream-json --verbose --model haiku` on
    /// 2.1.263, 2026-09-16 (nightshift backlog 073): the event now carries
    /// the window's share used and both windows under `unifiedWindows`,
    /// which the 2.1.237 line above does not. Both spellings parse; the
    /// older one reads as no figure, never as zero.
    const RATE_LIMIT_263: &str = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1789552800,"rateLimitType":"seven_day","utilization":0.86,"isUsingOverage":false,"surpassedThreshold":0.75,"unifiedWindows":{"five_hour":{"utilization":0.85,"resetsAt":1789551600},"seven_day":{"utilization":0.86,"resetsAt":1789552800}}},"uuid":"c2d83942-97f4-4c02-b0a2-0d08d4ed4c8e","session_id":"1767de8a-1fcd-4dda-af8d-219cd2c14c5e"}"#;

    #[test]
    fn rate_limit_event_carries_both_windows_on_263_and_none_on_237() {
        let (_, outcome) = drive(&[RATE_LIMIT_263, RESULT]);
        let plan = outcome.rate_limit.expect("plan window");
        assert_eq!(plan.window.as_deref(), Some("seven_day"));
        assert_eq!(plan.status.as_deref(), Some("allowed_warning"));
        assert_eq!(plan.utilization, Some(0.86));
        let w = plan.unified_windows.expect("unifiedWindows on 2.1.263");
        assert_eq!(w.five_hour.as_ref().and_then(|x| x.utilization), Some(0.85));
        assert_eq!(
            w.five_hour.as_ref().and_then(|x| x.resets_at),
            Some(1789551600)
        );
        assert_eq!(w.seven_day.as_ref().and_then(|x| x.utilization), Some(0.86));

        let (_, outcome) = drive(&[RATE_LIMIT, RESULT]);
        let plan = outcome.rate_limit.expect("plan window");
        assert_eq!(plan.utilization, None);
        assert!(plan.unified_windows.is_none());
    }
}
