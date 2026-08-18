//! Provider adapters. Each module translates the canonical `nightloom-core`
//! types to one vendor wire format and normalizes its streaming dialect into
//! `StreamEvent` — vendor shapes never leak past this crate.
//!
//! Native adapters: Anthropic (Messages), OpenAI (Responses), Gemini
//! (streamGenerateContent). The `chat/completions` adapter covers Groq,
//! OpenRouter, legacy OpenAI, and local servers as flavors of one dialect.

mod anthropic;
mod gemini;
mod openai_compat;
mod openai_responses;
mod registry;
pub mod retry;

pub use anthropic::Anthropic;
pub use gemini::Gemini;
pub use openai_compat::OpenAiCompat;
pub use openai_responses::OpenAiResponses;
pub use registry::ProviderKind;

use nightloom_core::ProviderError;

pub(crate) fn transport(e: impl std::fmt::Display) -> ProviderError {
    ProviderError::Transport(e.to_string())
}

pub(crate) fn parse(e: impl std::fmt::Display) -> ProviderError {
    ProviderError::Parse(e.to_string())
}

/// Read the response body of a non-2xx reply into an `Api` error.
pub(crate) async fn api_error(resp: reqwest::Response) -> ProviderError {
    let status = resp.status().as_u16();
    let message = resp
        .text()
        .await
        .unwrap_or_else(|e| format!("<failed to read error body: {e}>"));
    ProviderError::Api { status, message }
}
