use crate::message::Message;
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

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<Message>,
    pub max_tokens: u32,
    pub temperature: Option<f32>,
    pub thinking: Thinking,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Reasoning tokens, when the provider reports them separately (OpenAI
    /// does; Anthropic counts thinking inside `output_tokens`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
}

impl Usage {
    pub fn add(&mut self, other: Usage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        if let Some(r) = other.reasoning_tokens {
            *self.reasoning_tokens.get_or_insert(0) += r;
        }
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
    Usage(Usage),
    End { stop_reason: Option<String> },
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
}
