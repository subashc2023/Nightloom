//! Provider adapters. Each module translates the canonical `nightloom-core`
//! types to one vendor wire format and normalizes its streaming dialect into
//! `StreamEvent` — vendor shapes never leak past this crate.
//!
//! Native adapters: Anthropic (Messages), OpenAI (Responses), Gemini
//! (streamGenerateContent). The `chat/completions` adapter covers Groq,
//! OpenRouter, legacy OpenAI, and local servers as flavors of one dialect.

mod anthropic;
mod gemini;
pub mod limits;
pub mod models;
mod openai_compat;
mod openai_responses;
pub mod pricing;
mod registry;
pub mod retry;

pub use anthropic::Anthropic;
pub use gemini::Gemini;
pub use limits::context_limit;
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

/// How much of an error body to keep. Enough for any real message, and a
/// bound on a gateway that answers a failed request with a page of HTML —
/// which reaches a user as an error line and a model as a tool result.
const ERROR_BODY_LIMIT: usize = 4096;

/// Read the response body of a non-2xx reply into an `Api` error.
pub(crate) async fn api_error(resp: reqwest::Response) -> ProviderError {
    let status = resp.status().as_u16();
    let mut message = resp
        .text()
        .await
        .unwrap_or_else(|e| format!("<failed to read error body: {e}>"));
    if message.len() > ERROR_BODY_LIMIT {
        let cut = (0..=ERROR_BODY_LIMIT)
            .rev()
            .find(|i| message.is_char_boundary(*i))
            .unwrap_or(0);
        message.truncate(cut);
        message.push_str("… (error body truncated)");
    }
    ProviderError::Api { status, message }
}

/// An id for a tool call whose dialect did not give it one.
///
/// Gemini omits ids, and so do several `chat/completions` servers. Numbering
/// them per response made every round's first call `call-0`, which is unique
/// where the vendor needs it — inside one request — and duplicated everywhere
/// else: a session log holding several `tool_use` blocks with one id, and an
/// approval table that keys the prompt a user is answering by exactly that id.
/// Counting across the process instead costs nothing and makes the id mean one
/// call. The clock seeds it so that ids issued before a restart and after it
/// do not overlap either.
pub(crate) fn synthetic_call_id() -> String {
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: OnceLock<AtomicU64> = OnceLock::new();
    let counter = NEXT.get_or_init(|| {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_micros() as u64);
        AtomicU64::new(seed)
    });
    format!("call-{:x}", counter.fetch_add(1, Ordering::Relaxed))
}

/// A stream that stopped without saying it had finished.
///
/// The [`nightloom_core::Provider`] contract has every stream end in
/// `StreamEvent::End` or an error, and this is the error. A connection dropped
/// mid-response otherwise ends the stream in silence, which from above is
/// indistinguishable from a model that finished — so a truncated reply gets
/// recorded as a complete one, and any tool call still being buffered when the
/// bytes stopped is simply lost. Failing here makes it the ordinary
/// interrupted-turn shape instead, which the engine already knows how to
/// record.
pub(crate) fn truncated(vendor: &str) -> ProviderError {
    ProviderError::Transport(format!(
        "{vendor}: the response stream ended before the model finished — the \
         reply is incomplete"
    ))
}
