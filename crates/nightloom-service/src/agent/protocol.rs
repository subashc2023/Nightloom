//! Claude Code's `stream-json` wire format.
//!
//! One `Deserialize` per line shape, and deliberately partial: every struct
//! here ignores fields it does not name, and every tagged enum has an
//! `Unknown` arm. That is the same bet [`SessionEvent::Unknown`] makes and
//! for the same reason — this is another process's output, on its own
//! release cadence, and a new event type appearing in a `claude` update
//! must cost one ignored line rather than the rest of the turn.
//!
//! [`SessionEvent::Unknown`]: nightloom_core::SessionEvent
//!
//! Shapes captured from `claude -p --output-format stream-json --verbose
//! --include-partial-messages` on 2.1.237; the fixtures in
//! [`super::translate`] are verbatim lines from those runs.

use nightloom_core::Usage;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One line of the NDJSON stream.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub(super) enum Line {
    #[serde(rename = "system")]
    System(SystemLine),
    /// A passthrough of the underlying Anthropic SSE event. Present only
    /// with `--include-partial-messages`, which is why the supervisor always
    /// passes it: without these there are no deltas to stream and a turn
    /// arrives as one block at the end.
    #[serde(rename = "stream_event")]
    StreamEvent { event: StreamEv },
    #[serde(rename = "assistant")]
    Assistant(TurnLine),
    #[serde(rename = "user")]
    User(TurnLine),
    #[serde(rename = "result")]
    Result(ResultLine),
    /// Subscription budget, reported once per turn. Only ever emitted when
    /// the CLI authenticated with OAuth — an API-key run has no plan window
    /// to report — which makes its presence the one honest signal that this
    /// turn was billed to the plan and not to a key.
    #[serde(rename = "rate_limit_event")]
    RateLimitEvent { rate_limit_info: RateLimitInfo },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "subtype")]
pub(super) enum SystemLine {
    /// Session metadata, first line of the stream.
    #[serde(rename = "init")]
    Init {
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        tools: Vec<String>,
    },
    /// A retryable API failure, about to be retried. Reported rather than
    /// swallowed for the same reason `Retry` notifies the shell: a stall
    /// with no explanation reads as a hang.
    #[serde(rename = "api_retry")]
    ApiRetry {
        #[serde(default)]
        attempt: u32,
        #[serde(default)]
        max_retries: u32,
        #[serde(default)]
        error: Option<String>,
    },
    #[serde(other)]
    Other,
}

/// An `assistant` or `user` line: one API message, possibly a subagent's.
#[derive(Debug, Deserialize)]
pub(super) struct TurnLine {
    pub message: ApiMessage,
    /// The `task` call that spawned this, or `None` for the main thread.
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ApiMessage {
    /// Absent on some shapes, and a bare string on others — only the block
    /// array carries anything this translator acts on.
    #[serde(default)]
    pub content: Vec<Block>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub(super) enum Block {
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: Value,
        #[serde(default)]
        is_error: bool,
    },
    #[serde(rename = "redacted_thinking")]
    RedactedThinking,
    /// `text` and `thinking` land here and are deliberately dropped: the
    /// same content already arrived as deltas on `stream_event`, and
    /// emitting both would render every reply twice.
    #[serde(other)]
    Other,
}

/// The Anthropic SSE event carried inside a `stream_event` line.
#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub(super) enum StreamEv {
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta { delta: Delta },
    /// Carries the round's final usage. Emitted once per API call, which is
    /// what makes it the right feed for a context gauge — see
    /// [`TurnEvent::Usage`](crate::TurnEvent::Usage).
    #[serde(rename = "message_delta")]
    MessageDelta {
        #[serde(default)]
        usage: Option<RawUsage>,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub(super) enum Delta {
    #[serde(rename = "text_delta")]
    Text { text: String },
    #[serde(rename = "thinking_delta")]
    Thinking { thinking: String },
    /// `signature_delta` and `input_json_delta` land here. Neither is
    /// needed: signatures are Claude Code's to replay into its own session,
    /// and tool arguments arrive already assembled on the `assistant` line.
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
pub(super) struct ResultLine {
    #[serde(default)]
    pub subtype: Option<String>,
    #[serde(default)]
    pub is_error: bool,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub total_cost_usd: Option<f64>,
    #[serde(default)]
    pub num_turns: Option<u32>,
    #[serde(default)]
    pub usage: Option<RawUsage>,
}

/// The plan's rate-limit window, as the CLI reports it.
///
/// `Serialize` as well, because this is the one figure in a turn's outcome
/// that is about what the turn actually spent, and a windowed shell has to
/// get it across a command boundary to say so.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RateLimitInfo {
    /// `allowed`, or a throttled state.
    #[serde(default)]
    pub status: Option<String>,
    /// Which window this is — `five_hour`, `weekly`.
    #[serde(default, rename = "rateLimitType")]
    pub window: Option<String>,
    /// Unix seconds at which the window rolls over.
    #[serde(default, rename = "resetsAt")]
    pub resets_at: Option<i64>,
    #[serde(default, rename = "isUsingOverage")]
    pub using_overage: bool,
}

/// Anthropic's usage shape, passed through by the CLI unchanged.
#[derive(Debug, Default, Clone, Deserialize)]
pub(super) struct RawUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    cache_read_input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens_details: Option<OutputDetails>,
}

#[derive(Debug, Default, Clone, Deserialize)]
struct OutputDetails {
    #[serde(default)]
    thinking_tokens: Option<u64>,
}

impl RawUsage {
    /// Normalize to [`Usage`], where `input_tokens` is the **whole** prompt.
    ///
    /// This is the same summing [`Anthropic::read_input_usage`] does, and it
    /// has to be done here too rather than inherited: the CLI hands
    /// Anthropic's accounting through untouched, so `input_tokens` arrives
    /// as the tokens that were neither read from nor written to the cache.
    /// Taken at face value a cached prompt reads near-empty — which is
    /// exactly the turn where the gauge matters most.
    ///
    /// [`Anthropic::read_input_usage`]: nightloom_providers::Anthropic
    pub fn to_usage(&self) -> Usage {
        let read = self.cache_read_input_tokens;
        let write = self.cache_creation_input_tokens;
        Usage {
            input_tokens: self.input_tokens + read.unwrap_or(0) + write.unwrap_or(0),
            output_tokens: self.output_tokens,
            reasoning_tokens: self
                .output_tokens_details
                .as_ref()
                .and_then(|d| d.thinking_tokens),
            cache_read_tokens: read,
            cache_write_tokens: write,
        }
    }
}
