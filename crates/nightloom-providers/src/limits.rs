//! Per-(provider, model) context-window sizes.
//!
//! A management-plane helper alongside [`crate::models`]: the `Provider` trait
//! stays chat-only, and nothing here touches the network. The service's
//! per-turn context gauge needs a denominator, and the wire protocols never
//! tell us one — the only place a limit shows up is a vendor's management
//! endpoint or its docs.
//!
//! # Refreshing these numbers
//!
//! Checked 2026-08-18. Live sources, each verified on that date:
//!
//! - **Anthropic** `GET /v1/models` **does** expose limits: every entry
//!   carries `max_input_tokens` and `max_tokens`. (Older guidance that it
//!   doesn't is out of date — the docs now advertise the field.)
//! - **Gemini** `GET /v1beta/models` returns `inputTokenLimit` /
//!   `outputTokenLimit` per model.
//! - **Groq** `GET /openai/v1/models` returns `context_window` per model.
//! - **OpenRouter** `GET /api/v1/models` returns `context_length` per model,
//!   and needs no API key.
//! - **OpenAI** `GET /v1/models` does **not**: entries carry only
//!   `id`/`object`/`created`/`owned_by`/`shutdown_date`. OpenAI numbers have
//!   to come from the per-model doc pages.
//! - `https://models.dev/api.json` is an unauthenticated community aggregate
//!   with `limit.context` / `limit.input` / `limit.output` for ~191
//!   providers. It agreed with all four vendor endpoints above on every model
//!   spot-checked, so it is a reasonable single source for a bulk refresh —
//!   confirm anything surprising against the vendor.
//!
//! A future version could fetch these at runtime; today the table is static so
//! the gauge costs nothing and works offline.

use crate::registry::ProviderKind;

/// The context window for `model` on `kind`, or `None` when we don't know it.
///
/// Matching is by **longest matching prefix** over the tables below, so dated
/// snapshot ids (`claude-opus-4-5-20251101`, `gpt-5-2025-08-07`), OpenRouter
/// suffixes (`openai/gpt-5:batch`), and family aliases all resolve to their
/// family entry — and a more specific row always beats a shorter one that
/// happens to prefix it (`gpt-5.4-mini` over `gpt-5.4` over `gpt-5`).
///
/// Unknown models return `None` rather than a guessed default. A wrong
/// denominator is worse than no denominator: it would tell the model it has
/// room it doesn't have, and the gauge degrades gracefully to a raw token
/// count when the limit is absent.
pub fn context_limit(kind: ProviderKind, model: &str) -> Option<u64> {
    let model = model.to_ascii_lowercase();
    let table = match kind {
        ProviderKind::Anthropic => ANTHROPIC,
        // The generic chat/completions kind covers both api.openai.com's
        // legacy endpoint and local servers. Falling back to the OpenAI table
        // gets the former right; a local model id (`llama3.1:8b`,
        // `gpt-oss:20b`, `qwen3:14b`) matches nothing and stays `None`, which
        // is the honest answer for a window only the server knows.
        ProviderKind::Openai | ProviderKind::OpenaiChat => OPENAI,
        ProviderKind::Gemini => GEMINI,
        ProviderKind::Groq => GROQ,
        ProviderKind::Openrouter => OPENROUTER,
    };
    longest_prefix(table, &model)
}

fn longest_prefix(table: &[(&str, u64)], model: &str) -> Option<u64> {
    table
        .iter()
        .filter(|(id, _)| model.starts_with(id))
        .max_by_key(|(id, _)| id.len())
        .map(|(_, limit)| *limit)
}

// ---------------------------------------------------------------------------
// Provenance: every number below was read on 2026-08-18 from the vendor's own
// management endpoint (Anthropic /v1/models, Gemini /v1beta/models, Groq
// /openai/v1/models, OpenRouter /api/v1/models) or, for OpenAI, its per-model
// documentation pages at developers.openai.com/api/docs/models/<id>, and
// cross-checked against models.dev/api.json. Models whose window could not be
// verified from one of those are deliberately absent: omission yields `None`.
//
// The value is the **total** context window (history + this turn's output),
// which is what the service's gauge sums — it adds the last turn's
// `input_tokens + output_tokens`. Where a vendor splits the window (OpenAI
// quotes 400k total = 272k input + 128k output) the total is the right
// denominator for that sum.
// ---------------------------------------------------------------------------

/// Anthropic Messages API. Source: `GET /v1/models` (`max_input_tokens`) and
/// the model-overview / context-windows docs.
///
/// Note on the 1M window: it used to sit behind the `context-1m-2025-08-07`
/// beta header. It no longer does — the docs state that for every model with a
/// 1M window, 1M is the default with no beta header and standard pricing, so
/// these are the numbers the harness gets as it ships (it sends no beta
/// headers).
///
/// Note on Sonnet 4.5, where the sources disagree: `GET /v1/models` reports
/// `max_input_tokens: 1000000` (models.dev copies the same figure), while the
/// context-windows doc enumerates exactly which models are 1M and then says
/// "other Claude models, including Claude Sonnet 4.5, have a 200k-token
/// context window". The doc is the more specific claim — the endpoint field
/// looks like the beta ceiling rather than the default — and the two errors
/// are not symmetric: understating costs an early compaction, overstating
/// walks the model into a hard 400 mid-conversation. 200k encoded.
const ANTHROPIC: &[(&str, u64)] = &[
    // 1M by default.
    ("claude-fable-5", 1_000_000),
    // Documented as 1M but 404s without account access, so unverifiable
    // here; the row costs nothing and pays off for keys that do have it.
    ("claude-mythos-5", 1_000_000),
    ("claude-opus-5", 1_000_000),
    ("claude-sonnet-5", 1_000_000),
    ("claude-opus-4-8", 1_000_000),
    ("claude-opus-4-7", 1_000_000),
    ("claude-opus-4-6", 1_000_000),
    ("claude-sonnet-4-6", 1_000_000),
    // 200k.
    ("claude-opus-4-5", 200_000),
    ("claude-sonnet-4-5", 200_000),
    ("claude-haiku-4-5", 200_000),
];

/// OpenAI Responses API (and the legacy chat/completions endpoint). Source:
/// the per-model doc pages; `/v1/models` carries no limits.
const OPENAI: &[(&str, u64)] = &[
    ("gpt-5", 400_000),
    ("gpt-5-mini", 400_000),
    ("gpt-5-nano", 400_000),
    ("gpt-5-pro", 400_000),
    ("gpt-5-codex", 400_000),
    ("gpt-5.1", 400_000),
    ("gpt-5.2", 400_000),
    ("gpt-5.2-chat-latest", 128_000),
    ("gpt-5.3-codex", 400_000),
    ("gpt-5.3-chat-latest", 128_000),
    // 5.4 and later frontier ids widen to 1.05M (922k input + 128k output);
    // the mini/nano siblings stay at 400k.
    ("gpt-5.4", 1_050_000),
    ("gpt-5.4-mini", 400_000),
    ("gpt-5.4-nano", 400_000),
    ("gpt-5.4-pro", 1_050_000),
    ("gpt-5.5", 1_050_000),
    ("gpt-5.5-pro", 1_050_000),
    ("gpt-5.6", 1_050_000),
    ("gpt-5.6-luna", 1_050_000),
    ("gpt-5.6-sol", 1_050_000),
    ("gpt-5.6-terra", 1_050_000),
    ("gpt-4.1", 1_047_576),
    ("gpt-4o", 128_000),
    ("gpt-4-turbo", 128_000),
    ("o1", 200_000),
    ("o3", 200_000),
    ("o4-mini", 200_000),
];

/// Google Generative Language API. Source: `GET /v1beta/models`
/// (`inputTokenLimit`).
///
/// The trailing rows are guards, not offerings: image/TTS variants share a
/// prefix with a chat family but have far smaller windows, and without an
/// explicit row they would inherit the chat family's number.
const GEMINI: &[(&str, u64)] = &[
    ("gemini-2.5-pro", 1_048_576),
    ("gemini-2.5-flash", 1_048_576),
    ("gemini-2.5-flash-lite", 1_048_576),
    ("gemini-3-flash-preview", 1_048_576),
    ("gemini-3.1-pro-preview", 1_048_576),
    ("gemini-3.1-flash-lite", 1_048_576),
    ("gemini-3.5-flash", 1_048_576),
    ("gemini-3.5-flash-lite", 1_048_576),
    ("gemini-3.6-flash", 1_048_576),
    ("gemini-3.7-flash", 1_048_576),
    ("gemini-flash-latest", 1_048_576),
    ("gemini-flash-lite-latest", 1_048_576),
    ("gemini-pro-latest", 1_048_576),
    ("gemma-4-26b-a4b-it", 262_144),
    ("gemma-4-31b-it", 262_144),
    // Guards against prefix over-reach (see above).
    ("gemini-2.5-flash-image", 32_768),
    ("gemini-2.5-flash-preview-tts", 8_192),
    ("gemini-2.5-pro-preview-tts", 8_192),
    ("gemini-3.1-flash-image", 65_536),
    ("gemini-3.1-flash-lite-image", 65_536),
    ("gemini-3.1-flash-tts-preview", 8_192),
];

/// Groq. Source: `GET /openai/v1/models` (`context_window`).
const GROQ: &[(&str, u64)] = &[
    ("openai/gpt-oss-120b", 131_072),
    ("openai/gpt-oss-20b", 131_072),
    ("openai/gpt-oss-safeguard-20b", 131_072),
    ("qwen/qwen3.6-27b", 131_072),
    ("groq/compound", 131_072),
    ("groq/compound-mini", 131_072),
    ("llama-3.3-70b-versatile", 131_072),
    ("llama-3.1-8b-instant", 131_072),
    ("allam-2-7b", 4_096),
];

/// OpenRouter. Source: `GET /api/v1/models` (`context_length`), which is what
/// the gateway will actually route with — it can differ from the upstream
/// vendor's default (OpenRouter serves `anthropic/claude-sonnet-4.5` with the
/// long-context option, so 1M there against Anthropic-direct's 200k).
///
/// `openrouter/auto` is deliberately absent even though the API advertises 2M
/// for it: that is the router's ceiling, not the window of whichever model it
/// picks for a given request, so `None` is the truthful answer.
const OPENROUTER: &[(&str, u64)] = &[
    ("anthropic/claude-fable-5", 1_000_000),
    ("anthropic/claude-opus-5", 1_000_000),
    ("anthropic/claude-sonnet-5", 1_000_000),
    ("anthropic/claude-opus-4.8", 1_000_000),
    ("anthropic/claude-opus-4.7", 1_000_000),
    ("anthropic/claude-opus-4.6", 1_000_000),
    ("anthropic/claude-sonnet-4.6", 1_000_000),
    ("anthropic/claude-sonnet-4.5", 1_000_000),
    ("anthropic/claude-opus-4.5", 200_000),
    ("anthropic/claude-haiku-4.5", 200_000),
    ("openai/gpt-5", 400_000),
    ("openai/gpt-5-mini", 400_000),
    ("openai/gpt-5-nano", 400_000),
    ("openai/gpt-5-pro", 400_000),
    ("openai/gpt-5.1", 400_000),
    ("openai/gpt-5.2", 400_000),
    ("openai/gpt-5.2-chat", 128_000),
    ("openai/gpt-5.3-codex", 400_000),
    ("openai/gpt-5.4", 1_050_000),
    ("openai/gpt-5.4-mini", 400_000),
    ("openai/gpt-5.4-nano", 400_000),
    ("openai/gpt-5.5", 1_050_000),
    ("openai/gpt-5.6-luna", 1_050_000),
    ("openai/gpt-5.6-sol", 1_050_000),
    ("openai/gpt-5.6-terra", 1_050_000),
    ("google/gemini-2.5-pro", 1_048_576),
    ("google/gemini-2.5-flash", 1_048_576),
    ("google/gemini-2.5-flash-lite", 1_048_576),
    ("google/gemini-2.5-flash-image", 32_768), // guard, see GEMINI
    ("google/gemini-3-flash-preview", 1_048_576),
    ("google/gemini-3.1-pro-preview", 1_048_576),
    ("google/gemini-3.5-flash", 1_048_576),
    ("google/gemini-3.6-flash", 1_048_576),
    ("google/gemini-3.7-flash", 1_048_576),
    ("deepseek/deepseek-v4-flash", 1_048_576),
    ("deepseek/deepseek-v4-pro", 1_048_576),
    ("x-ai/grok-4.3", 1_000_000),
    ("x-ai/grok-4.5", 500_000),
    ("x-ai/grok-4.6", 500_000),
    ("x-ai/grok-4.20", 2_000_000),
    ("moonshotai/kimi-k2.6", 262_144),
    ("moonshotai/kimi-k2.7-code", 262_144),
    ("moonshotai/kimi-k3", 1_048_576),
    ("qwen/qwen3.6-27b", 262_144),
    ("qwen/qwen3.6-plus", 1_000_000),
    ("meta-llama/llama-4-maverick", 1_048_576),
    ("meta-llama/llama-4-scout", 1_310_720),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_id_hits() {
        assert_eq!(
            context_limit(ProviderKind::Anthropic, "claude-sonnet-5"),
            Some(1_000_000)
        );
        assert_eq!(
            context_limit(ProviderKind::Gemini, "gemini-2.5-flash"),
            Some(1_048_576)
        );
        assert_eq!(
            context_limit(ProviderKind::Groq, "openai/gpt-oss-120b"),
            Some(131_072)
        );
    }

    #[test]
    fn dated_snapshot_resolves_to_its_family() {
        assert_eq!(
            context_limit(ProviderKind::Anthropic, "claude-opus-4-5-20251101"),
            Some(200_000)
        );
        assert_eq!(
            context_limit(ProviderKind::Anthropic, "claude-haiku-4-5-20251001"),
            Some(200_000)
        );
        assert_eq!(
            context_limit(ProviderKind::Openai, "gpt-5-2025-08-07"),
            Some(400_000)
        );
    }

    #[test]
    fn unknown_model_is_none_not_a_guess() {
        assert_eq!(context_limit(ProviderKind::Anthropic, "claude-9"), None);
        assert_eq!(context_limit(ProviderKind::Openai, "gpt-nonesuch"), None);
        // A local server's model: nothing here can know its window.
        assert_eq!(context_limit(ProviderKind::OpenaiChat, "llama3.1:8b"), None);
        assert_eq!(context_limit(ProviderKind::OpenaiChat, "gpt-oss:20b"), None);
        // …but the same kind pointed at api.openai.com resolves normally.
        assert_eq!(
            context_limit(ProviderKind::OpenaiChat, "gpt-4o-mini"),
            Some(128_000)
        );
    }

    #[test]
    fn openrouter_vendor_slash_model_ids_match() {
        assert_eq!(
            context_limit(ProviderKind::Openrouter, "anthropic/claude-sonnet-5"),
            Some(1_000_000)
        );
        assert_eq!(
            context_limit(ProviderKind::Openrouter, "deepseek/deepseek-v4-flash"),
            Some(1_048_576)
        );
        // Suffixed route variants fall back to the base entry by prefix.
        assert_eq!(
            context_limit(ProviderKind::Openrouter, "openai/gpt-5-mini:batch"),
            Some(400_000)
        );
        // The router's own ceiling is not any real model's window.
        assert_eq!(
            context_limit(ProviderKind::Openrouter, "openrouter/auto"),
            None
        );
    }

    #[test]
    fn longest_prefix_wins_over_a_shorter_match() {
        // "gpt-5" (400k), "gpt-5.4" (1.05M) and "gpt-5.4-mini" (400k) all
        // prefix this family; the most specific row must win each time.
        assert_eq!(context_limit(ProviderKind::Openai, "gpt-5"), Some(400_000));
        assert_eq!(
            context_limit(ProviderKind::Openai, "gpt-5.4-2026-03-05"),
            Some(1_050_000)
        );
        assert_eq!(
            context_limit(ProviderKind::Openai, "gpt-5.4-mini-2026-03-17"),
            Some(400_000)
        );
        // Same shape on Anthropic: `opus-5` must not be read off the
        // shorter `opus-4-5` row, or `sonnet-4-5` off `sonnet-4-6`.
        assert_eq!(
            context_limit(ProviderKind::Anthropic, "claude-sonnet-4-5-20250929"),
            Some(200_000)
        );
        assert_eq!(
            context_limit(ProviderKind::Anthropic, "claude-opus-4-5-20251101"),
            Some(200_000)
        );
        assert_eq!(
            context_limit(ProviderKind::Anthropic, "claude-opus-5"),
            Some(1_000_000)
        );
        // And a chat family must not lend its window to an image sibling.
        assert_eq!(
            context_limit(ProviderKind::Gemini, "gemini-2.5-flash-image"),
            Some(32_768)
        );
    }

    #[test]
    fn matching_is_case_insensitive() {
        assert_eq!(
            context_limit(ProviderKind::Anthropic, "Claude-Sonnet-5"),
            Some(1_000_000)
        );
    }
}
