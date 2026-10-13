use crate::message::Message;
use crate::prompt::SystemPrompt;
use futures::stream::BoxStream;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// Reasoning/thinking control. Vendors expose different knobs (Anthropic
/// budgets, OpenAI effort levels); adapters map what they support and fail
/// loudly on what they don't, so a mismatch is diagnosable instead of silent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Thinking {
    /// Provider default. Most models won't think; adaptive models may.
    Default,
    /// Token budget for thinking (Anthropic-style).
    Budget(u32),
    /// Effort level, e.g. "low" | "medium" | "high" (OpenAI-style).
    Effort(String),
}

impl FromStr for Thinking {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        if s == "default" {
            return Ok(Thinking::Default);
        }
        if let Some(n) = s.strip_prefix("budget=") {
            return n
                .parse()
                .map(Thinking::Budget)
                .map_err(|_| format!("invalid thinking budget: {n:?}"));
        }
        if let Some(e) = s.strip_prefix("effort=") {
            return Ok(Thinking::Effort(e.to_string()));
        }
        Err(format!(
            "invalid thinking spec {s:?} (expected default, budget=N, or effort=LEVEL)"
        ))
    }
}

impl fmt::Display for Thinking {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Thinking::Default => write!(f, "default"),
            Thinking::Budget(n) => write!(f, "budget={n}"),
            Thinking::Effort(e) => write!(f, "effort={e}"),
        }
    }
}

/// A tool the model may call, described vendor-neutrally. `input_schema` is
/// a JSON Schema object; adapters rename it to each API's field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    /// The cache-stable system prompt. Adapters render it to whatever shape
    /// their vendor takes; an empty prompt means the field is omitted.
    pub system: SystemPrompt,
    pub messages: Vec<Message>,
    pub max_tokens: u32,
    pub temperature: Option<f32>,
    pub thinking: Thinking,
    /// Tools the model may call this turn. Empty means tool use is off.
    pub tools: Vec<ToolDef>,
}

/// Token accounting for one request, normalized across vendors.
///
/// `input_tokens` is the **whole** prompt: every token the model read,
/// cached or not. That normalization is not free — Anthropic reports
/// `input_tokens` as the tokens that were *neither read from nor written to*
/// the cache, so its three counters have to be summed, while OpenAI and
/// Gemini already report an inclusive total that `cached_tokens` is a subset
/// of. Leaving each vendor's own convention in place would mean a context
/// gauge that reads near-empty on exactly the turns where caching is working,
/// which is the opposite of the truth.
///
/// The cache fields are a breakdown of that total, not additions to it, and
/// they are `Option` rather than `0` because "this host does not report
/// caching" and "nothing was cached" are different facts: the first must not
/// render as a 0% hit rate.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Reasoning tokens, when the provider reports them separately (OpenAI
    /// does; Anthropic counts thinking inside `output_tokens`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    /// Prompt tokens served from the cache, billed at a discount. A subset
    /// of `input_tokens`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    /// Prompt tokens written into the cache, billed at a premium. A subset
    /// of `input_tokens`. Only Anthropic bills this separately; the others
    /// fold cache writes into ordinary input, so this stays `None` there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    /// `cache_write_tokens` split by the lifetime the entry was written
    /// with — Anthropic's `usage.cache_creation.ephemeral_5m_input_tokens`
    /// and `ephemeral_1h_input_tokens` (2026-09-15). The split is what says
    /// *when the entry expires*, which the total cannot: a write is a write
    /// at either price, but one lasts five minutes and the other an hour.
    /// `None` where the host reports no breakdown, which is every host but
    /// Anthropic and every log written before the fields existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_5m_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_write_1h_tokens: Option<u64>,
}

/// How long a prompt-cache entry lives, measured from the *start* of the
/// request that wrote it — or last read it, since a read refreshes the
/// entry for its original lifetime (`external`, the Anthropic prompt-caching
/// reference). Two values because the API offers two.
///
/// Serialized as the API's own suffixes, `5m` and `1h`, so a log line reads
/// the way the usage block it was taken from does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CacheTtl {
    #[serde(rename = "5m")]
    FiveMinutes,
    #[serde(rename = "1h")]
    OneHour,
}

impl CacheTtl {
    pub fn duration(self) -> std::time::Duration {
        match self {
            CacheTtl::FiveMinutes => std::time::Duration::from_secs(5 * 60),
            CacheTtl::OneHour => std::time::Duration::from_secs(60 * 60),
        }
    }

    /// The API's suffix — `5m`, `1h` — which is also the serialized form.
    pub fn label(self) -> &'static str {
        match self {
            CacheTtl::FiveMinutes => "5m",
            CacheTtl::OneHour => "1h",
        }
    }
}

impl Usage {
    pub fn add(&mut self, other: Usage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        add_opt(&mut self.reasoning_tokens, other.reasoning_tokens);
        add_opt(&mut self.cache_read_tokens, other.cache_read_tokens);
        add_opt(&mut self.cache_write_tokens, other.cache_write_tokens);
        add_opt(&mut self.cache_write_5m_tokens, other.cache_write_5m_tokens);
        add_opt(&mut self.cache_write_1h_tokens, other.cache_write_1h_tokens);
    }

    /// The lifetime this request's cache write was made with, read off the
    /// breakdown: an hour if any tokens went in at an hour, else five
    /// minutes if any went in at five. `None` when nothing was written —
    /// which includes a host that reports no breakdown at all.
    ///
    /// An hour outranks five minutes because a request that used both
    /// breakpoints put the hour one first (the API requires the longer
    /// lifetime earlier in the prompt), so the hour is what the shared
    /// prefix lives for.
    pub fn cache_write_ttl(&self) -> Option<CacheTtl> {
        if self.cache_write_1h_tokens.unwrap_or(0) > 0 {
            Some(CacheTtl::OneHour)
        } else if self.cache_write_5m_tokens.unwrap_or(0) > 0 {
            Some(CacheTtl::FiveMinutes)
        } else {
            None
        }
    }

    /// The lifetime of the cache entry this request left behind, for a
    /// timer: the write's own lifetime when the breakdown says it; else
    /// `default` — the lifetime the engine writes with when it does not
    /// say — when the request touched the cache at all, since a read
    /// refreshes the entry it hit for that same lifetime and a write
    /// without a breakdown is a write at the engine's usual one; `None`
    /// when it did neither, because then there is no entry to time. A host
    /// that reports no caching at all lands on `None` by the same test
    /// rather than by a special case.
    pub fn cache_ttl(&self, default: Option<CacheTtl>) -> Option<CacheTtl> {
        self.cache_write_ttl().or_else(|| {
            let touched =
                self.cache_read_tokens.unwrap_or(0) + self.cache_write_tokens.unwrap_or(0);
            (touched > 0).then_some(default).flatten()
        })
    }

    /// Prompt tokens that were neither read from nor written to the cache —
    /// what the provider charges at the full input rate.
    pub fn uncached_input_tokens(&self) -> u64 {
        self.input_tokens
            .saturating_sub(self.cache_read_tokens.unwrap_or(0))
            .saturating_sub(self.cache_write_tokens.unwrap_or(0))
    }

    /// Share of the prompt served from cache, `None` on a host that does not
    /// report caching at all. An empty prompt is `None` rather than 0%: a
    /// rate needs a denominator, and this is the same rule the context gauge
    /// follows for an unknown window.
    pub fn cache_hit_rate(&self) -> Option<f64> {
        let read = self.cache_read_tokens?;
        (self.input_tokens > 0).then(|| read as f64 / self.input_tokens as f64)
    }
}

fn add_opt(slot: &mut Option<u64>, other: Option<u64>) {
    if let Some(v) = other {
        *slot.get_or_insert(0) += v;
    }
}

/// Normalized streaming event. Every provider's SSE dialect is translated
/// into this enum at the adapter boundary; nothing downstream ever sees a
/// vendor-specific delta shape.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum StreamEvent {
    Start,
    TextDelta(String),
    ThinkingDelta(String),
    /// A complete tool call. Adapters buffer partial-argument deltas and
    /// emit one event per call once its input parses — argument fragments
    /// are too vendor-shaped to normalize incrementally.
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
        /// Opaque replay token the provider attached to this call, to be
        /// recorded and handed back verbatim (Gemini's `thoughtSignature`).
        /// `None` from every vendor that doesn't sign tool calls.
        signature: Option<String>,
    },
    /// A handle to a reasoning artifact the provider kept server-side
    /// (OpenAI Responses `reasoning` items). Emitted in stream order — after
    /// the thinking deltas it summarizes, before the tool call it led to —
    /// so consumers can record it in the position the vendor expects it
    /// replayed in. `id` is opaque and only meaningful to its issuer.
    ReasoningRef {
        id: String,
    },
    /// End of a signed thinking block: the provider's integrity signature
    /// for every `ThinkingDelta` since the last boundary. Consumers should
    /// flush accumulated thinking into a signed block on receipt. Only
    /// vendors that sign thinking (Anthropic) emit this.
    ThinkingSignature(String),
    /// A thinking block the provider encrypted instead of streaming
    /// (Anthropic `redacted_thinking`); `data` is opaque and only
    /// meaningful replayed back to the same vendor.
    RedactedThinking {
        data: String,
    },
    Usage(Usage),
    End {
        stop_reason: Option<String>,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("configuration error: {0}")]
    Config(String),
    #[error("transport error: {0}")]
    Transport(String),
    #[error("api error (status {status}): {message}")]
    Api { status: u16, message: String },
    #[error("failed to parse provider response: {0}")]
    Parse(String),
}

pub type EventStream = BoxStream<'static, Result<StreamEvent, ProviderError>>;

#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;

    /// Open a streaming chat completion. The returned stream yields
    /// normalized events and ends after `StreamEvent::End` (or an error).
    async fn stream_chat(&self, request: ChatRequest) -> Result<EventStream, ProviderError>;

    /// The lifetime this adapter's requests cache their prompt for when the
    /// response does not say (see [`Usage::cache_ttl`]). The adapter is the
    /// one thing that knows, since it is what asked for the cache and with
    /// what `ttl`; `None` — the default — for a host whose cache has no
    /// clock this crate can vouch for, which leaves the timer off rather
    /// than guessing one.
    fn cache_ttl(&self) -> Option<CacheTtl> {
        None
    }
}
