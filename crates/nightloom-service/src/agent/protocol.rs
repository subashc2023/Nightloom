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
    /// A call the CLI refused because it would have prompted and nobody
    /// could answer — Manual mode, headless. Verbatim on 2.1.263
    /// (2026-09-16): `{"type":"system","subtype":"permission_denied",
    /// "tool_name":"Write","tool_use_id":"toolu_…","message":"Claude
    /// requested permissions to write to …, but you haven't granted it
    /// yet."}`. Under the Ask position this is what a turn with several
    /// calls at once comes to, since the CLI ignores `defer` for a batch.
    #[serde(rename = "permission_denied")]
    PermissionDenied {
        #[serde(default)]
        tool_name: String,
        #[serde(default)]
        tool_use_id: String,
        #[serde(default)]
        message: String,
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
    /// `end_turn` on the common path; `tool_deferred` when a hook parked
    /// a call (2026-09-16, nightshift backlog 084). Then `result` is the
    /// empty string, `is_error` false, and the call is in
    /// `deferred_tool_use`. Verbatim on 2.1.263: `"stop_reason":
    /// "tool_deferred","terminal_reason":"tool_deferred",…,"result":"",
    /// "deferred_tool_use":{"id":"toolu_…","name":"Write","input":{…}}`.
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub deferred_tool_use: Option<super::ask::DeferredCall>,
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
    /// Share of `window` used, 0–1. Measured on 2.1.263 (2026-09-16,
    /// nightshift backlog 073); the 2.1.237 fixture in `translate.rs`
    /// carries none, so absent on a build that does not send it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub utilization: Option<f64>,
    /// Both windows in one event, 2.1.263: the live percentages the top
    /// bar's plan chip prefers over any file, since they are this turn's.
    #[serde(
        default,
        rename = "unifiedWindows",
        skip_serializing_if = "Option::is_none"
    )]
    pub unified_windows: Option<UnifiedWindows>,
}

/// `rate_limit_info.unifiedWindows` (2.1.263): each window's share used
/// and reset time, whichever window the event itself was about.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct UnifiedWindows {
    #[serde(default)]
    pub five_hour: Option<WindowReading>,
    #[serde(default)]
    pub seven_day: Option<WindowReading>,
}

/// One window of [`UnifiedWindows`].
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct WindowReading {
    /// 0–1.
    #[serde(default)]
    pub utilization: Option<f64>,
    /// Unix seconds.
    #[serde(default, rename = "resetsAt")]
    pub resets_at: Option<i64>,
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
    /// The write split by lifetime (nightshift backlog 063). Where the CLI
    /// puts it depends on the line: at the top of `usage` on the
    /// `assistant` and `result` lines and on `message_start`, but on
    /// `message_delta` — the one line the translator reads usage from — it
    /// is *only* inside `usage.iterations[]`, one entry per server-side
    /// iteration of the round. Measured 2026-09-15 on 2.1.263, one turn:
    /// `{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":7619}`,
    /// the hour being what this engine writes with.
    #[serde(default)]
    cache_creation: Option<CacheCreation>,
    #[serde(default)]
    iterations: Vec<Iteration>,
}

#[derive(Debug, Default, Clone, Deserialize)]
struct OutputDetails {
    #[serde(default)]
    thinking_tokens: Option<u64>,
}

/// `usage.cache_creation`, the API's own field names.
#[derive(Debug, Default, Clone, Deserialize)]
struct CacheCreation {
    #[serde(default)]
    ephemeral_5m_input_tokens: Option<u64>,
    #[serde(default)]
    ephemeral_1h_input_tokens: Option<u64>,
}

/// One entry of `usage.iterations`; only the breakdown is wanted from it,
/// since the totals beside it are already summed at the top.
#[derive(Debug, Default, Clone, Deserialize)]
struct Iteration {
    #[serde(default)]
    cache_creation: Option<CacheCreation>,
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
        let (five, hour) = self.cache_split();
        Usage {
            input_tokens: self.input_tokens + read.unwrap_or(0) + write.unwrap_or(0),
            output_tokens: self.output_tokens,
            reasoning_tokens: self
                .output_tokens_details
                .as_ref()
                .and_then(|d| d.thinking_tokens),
            cache_read_tokens: read,
            cache_write_tokens: write,
            cache_write_5m_tokens: five,
            cache_write_1h_tokens: hour,
        }
    }

    /// The write split by lifetime, from the top-level object when the line
    /// carries one and otherwise summed over `iterations`; `None` on a line
    /// with neither, which is "not reported" rather than "nothing written".
    fn cache_split(&self) -> (Option<u64>, Option<u64>) {
        let split = |c: &CacheCreation| (c.ephemeral_5m_input_tokens, c.ephemeral_1h_input_tokens);
        if let Some(c) = &self.cache_creation {
            return split(c);
        }
        let mut five = None;
        let mut hour = None;
        for c in self
            .iterations
            .iter()
            .filter_map(|i| i.cache_creation.as_ref())
        {
            let (f, h) = split(c);
            if let Some(f) = f {
                *five.get_or_insert(0) += f;
            }
            if let Some(h) = h {
                *hour.get_or_insert(0) += h;
            }
        }
        (five, hour)
    }
}

/// The one line Nightloom writes *to* the CLI, when a turn has attachments.
///
/// Everything above reads the stream; this is the only shape that goes the
/// other way. With `--input-format stream-json` the CLI takes its user turn
/// on stdin as a `user` line carrying a Messages-API message, and that
/// message's `content` may be the block list rather than a string — which is
/// how an image or a PDF reaches the model at all, since argv carries text and
/// nothing else. The shape is the one the Agent SDK sends on its own behalf
/// (`external`, the SDK "Streaming Input" page shows exactly this `image`
/// block and lists image uploads as a streaming-mode-only capability), and
/// it was verified live on 2.1.263: a `document` block is accepted the same
/// way, and both survive a `--resume` of a session whose earlier turns went
/// on argv (`agent-attachments-report-2026-09-14.md` in the nightshift
/// repo).
///
/// Caption first, then images, then documents — the log's own order, and
/// the order the provider adapters build a user message in, so what the
/// agent saw and what the transcript replays are the same message. A caption
/// of nothing is still sent as a text block: the CLI has no "attachment
/// only" turn, and an empty string is what the composer sends for one.
///
/// `parent_tool_use_id` is `null` for a top-level turn. The SDK writes the
/// field on every user line it sends, so it is written here too rather than
/// left for the CLI to default — whether it would is not something that was
/// checked, and matching the SDK's shape exactly costs one key.
pub(super) fn user_line(input: &crate::TurnInput) -> String {
    let mut content = vec![serde_json::json!({ "type": "text", "text": input.text })];
    content.extend(input.images.iter().map(|img| {
        serde_json::json!({
            "type": "image",
            "source": { "type": "base64", "media_type": img.media_type, "data": img.data },
        })
    }));
    content.extend(input.documents.iter().map(|doc| {
        serde_json::json!({
            "type": "document",
            "source": { "type": "base64", "media_type": doc.media_type, "data": doc.data },
            "title": doc.name,
        })
    }));
    let line = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": content },
        "parent_tool_use_id": Value::Null,
    });
    // NDJSON: the newline is the frame, and the CLI waits for it.
    format!("{line}\n")
}
