//! Per-(provider, model) token prices, in USD per million tokens.
//!
//! The sibling of [`crate::limits`], and static for the same reasons: no
//! network, no cost, works offline. Where that module answers "how much room
//! is left", this one answers "what did that cost" — the question a
//! model-agnostic harness has to be able to answer, since switching provider
//! mid-session is a supported move here and a 15x price difference between
//! two models that both work is the interesting part of the comparison.
//!
//! # Refreshing these numbers
//!
//! Checked 2026-08-18, from two independent sources that agreed on every
//! first-party model:
//!
//! - **OpenRouter** `GET /api/v1/models` publishes `pricing.prompt` /
//!   `.completion` / `.input_cache_read` / `.input_cache_write` per token, for
//!   every model it proxies, and needs no API key.
//! - **models.dev** `api.json` publishes `cost.input` / `.output` /
//!   `.cache_read` / `.cache_write` per million tokens, for 191 providers.
//!
//! No vendor's own management endpoint carries prices — not Anthropic's
//! `/v1/models`, not Gemini's, not Groq's — which is why this table cannot be
//! refreshed the way `limits.rs` can.
//!
//! A model with no verified price is **absent**, and absent means `None` all
//! the way to the UI, which then shows tokens without a dollar figure. The
//! failure modes are not symmetric: no number reads as "we don't know", and a
//! guessed number reads as a bill.

use crate::registry::ProviderKind;
use nightloom_core::Usage;
use serde::{Deserialize, Serialize};

/// What a model charges, in USD per million tokens.
///
/// Cache rates are `Option` because "this vendor does not bill cache reads
/// separately" and "cache reads are free" are different claims, and only the
/// second is safe to compute with. A `None` read rate falls back to the full
/// input rate in [`Price::cost`], which overstates rather than understates.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    /// Discounted rate for prompt tokens served from cache.
    pub cache_read: Option<f64>,
    /// Premium rate for prompt tokens written into the cache. Only Anthropic
    /// bills this; elsewhere a cache write is priced as ordinary input.
    pub cache_write: Option<f64>,
}

const fn p(input: f64, output: f64) -> Price {
    Price {
        input,
        output,
        cache_read: None,
        cache_write: None,
    }
}

const fn pc(input: f64, output: f64, cache_read: f64) -> Price {
    Price {
        input,
        output,
        cache_read: Some(cache_read),
        cache_write: None,
    }
}

const fn pcw(input: f64, output: f64, cache_read: f64, cache_write: f64) -> Price {
    Price {
        input,
        output,
        cache_read: Some(cache_read),
        cache_write: Some(cache_write),
    }
}

const PER_MTOK: f64 = 1_000_000.0;

impl Price {
    /// What one request's [`Usage`] costs, in USD.
    ///
    /// Relies on the normalization `Usage` documents — `input_tokens` is the
    /// whole prompt and the cache counters are subsets of it — so the three
    /// input rates apply to three disjoint slices and cannot double-bill. An
    /// adapter that reported cache tokens *outside* `input_tokens` would show
    /// up here as an undercount, which is why the normalization is enforced at
    /// the adapter boundary rather than assumed here.
    pub fn cost(&self, usage: &Usage) -> f64 {
        let read = usage.cache_read_tokens.unwrap_or(0);
        let write = usage.cache_write_tokens.unwrap_or(0);
        let full = usage.uncached_input_tokens();
        let rate = |tokens: u64, rate: f64| tokens as f64 * rate / PER_MTOK;
        rate(full, self.input)
            + rate(read, self.cache_read.unwrap_or(self.input))
            + rate(write, self.cache_write.unwrap_or(self.input))
            + rate(usage.output_tokens, self.output)
    }
}

/// The price of `model` on `kind`, or `None` when we have no verified figure.
///
/// Matching is by **longest matching prefix**, exactly as in
/// [`crate::limits::context_limit`], so dated snapshots (`claude-opus-5-2026…`)
/// and OpenRouter suffixes (`openai/gpt-5:batch`) resolve to their family and a
/// more specific row always beats a shorter one that prefixes it.
///
/// One caveat the prefix rule cannot see: an OpenRouter `:batch` suffix is
/// billed at half, and matching it to the base row overstates by 2x. That is
/// the safe direction, and the harness never sends batch requests.
pub fn price(kind: ProviderKind, model: &str) -> Option<Price> {
    let model = model.to_ascii_lowercase();
    let table = match kind {
        ProviderKind::Anthropic => ANTHROPIC,
        // As in `limits`: the generic chat/completions kind covers
        // api.openai.com's legacy endpoint and local servers alike. A local
        // model id matches nothing and stays `None`, which is the honest
        // answer — a self-hosted model has no per-token price.
        ProviderKind::Openai | ProviderKind::OpenaiChat => OPENAI,
        ProviderKind::Gemini => GEMINI,
        ProviderKind::Groq => GROQ,
        ProviderKind::Openrouter => OPENROUTER,
    };
    table
        .iter()
        .filter(|(id, _)| model.starts_with(id))
        .max_by_key(|(id, _)| id.len())
        .map(|(_, price)| *price)
}

// ---------------------------------------------------------------------------
// Provenance: read 2026-08-18 from openrouter.ai/api/v1/models and
// models.dev/api.json. USD per million tokens. Models present in `limits.rs`
// but absent here had no price in either source.
// ---------------------------------------------------------------------------

/// Anthropic Messages API. The cache-write column is the 5-minute TTL rate,
/// which is what this adapter's requests actually get: it sends
/// `cache_control: {type: ephemeral}` with no `ttl`, and 5 minutes is that
/// field's default.
const ANTHROPIC: &[(&str, Price)] = &[
    ("claude-fable-5", pcw(10.0, 50.0, 1.0, 12.5)),
    ("claude-opus-5", pcw(5.0, 25.0, 0.5, 6.25)),
    ("claude-sonnet-5", pcw(2.0, 10.0, 0.2, 2.5)),
    ("claude-opus-4-8", pcw(5.0, 25.0, 0.5, 6.25)),
    ("claude-opus-4-7", pcw(5.0, 25.0, 0.5, 6.25)),
    ("claude-opus-4-6", pcw(5.0, 25.0, 0.5, 6.25)),
    ("claude-sonnet-4-6", pcw(3.0, 15.0, 0.3, 3.75)),
    ("claude-opus-4-5", pcw(5.0, 25.0, 0.5, 6.25)),
    ("claude-sonnet-4-5", pcw(3.0, 15.0, 0.3, 3.75)),
    ("claude-haiku-4-5", pcw(1.0, 5.0, 0.1, 1.25)),
];

/// OpenAI. Every row stops at a read discount: cache writes are neither
/// charged nor reported, and the Responses adapter leaves
/// `cache_write_tokens` `None` to match.
const OPENAI: &[(&str, Price)] = &[
    ("gpt-5", pc(1.25, 10.0, 0.125)),
    ("gpt-5-mini", pc(0.25, 2.0, 0.025)),
    ("gpt-5-nano", pc(0.05, 0.4, 0.005)),
    ("gpt-5-pro", p(15.0, 120.0)),
    ("gpt-5.1", pc(1.25, 10.0, 0.125)),
    ("gpt-5.2", pc(1.75, 14.0, 0.175)),
    ("gpt-5.2-chat-latest", pc(1.75, 14.0, 0.175)),
    ("gpt-5.3-codex", pc(1.75, 14.0, 0.175)),
    ("gpt-5.3-chat-latest", pc(1.75, 14.0, 0.175)),
    ("gpt-5.4", pc(2.5, 15.0, 0.25)),
    ("gpt-5.4-mini", pc(0.75, 4.5, 0.075)),
    ("gpt-5.4-nano", pc(0.2, 1.25, 0.02)),
    ("gpt-5.4-pro", p(30.0, 180.0)),
    ("gpt-5.5", pc(5.0, 30.0, 0.5)),
    ("gpt-5.5-pro", p(30.0, 180.0)),
    ("gpt-5.6", pcw(5.0, 30.0, 0.5, 6.25)),
    ("gpt-5.6-luna", pcw(0.2, 1.2, 0.02, 0.25)),
    ("gpt-5.6-sol", pcw(5.0, 30.0, 0.5, 6.25)),
    ("gpt-5.6-terra", pcw(2.0, 12.0, 0.2, 2.5)),
    ("gpt-4.1", pc(2.0, 8.0, 0.5)),
    ("gpt-4o", pc(2.5, 10.0, 1.25)),
    ("gpt-4-turbo", p(10.0, 30.0)),
    ("o1", pc(15.0, 60.0, 7.5)),
    ("o3", pc(2.0, 8.0, 0.5)),
    ("o4-mini", pc(1.1, 4.4, 0.275)),
];

/// Gemini. No cache-write column, deliberately. Google bills *implicit*
/// caching — which is all this adapter gets, since it creates no cached
/// content — at a read discount with no write charge. The number aggregators
/// publish as a Gemini cache-write price is explicit context-cache
/// **storage**, quoted per MTok-*hour*; copying it into a per-token column
/// would be a unit error, not a rounding one.
const GEMINI: &[(&str, Price)] = &[
    ("gemini-2.5-pro", pc(1.25, 10.0, 0.125)),
    ("gemini-2.5-flash", pc(0.3, 2.5, 0.03)),
    ("gemini-2.5-flash-lite", pc(0.1, 0.4, 0.01)),
    ("gemini-3-flash-preview", pc(0.5, 3.0, 0.05)),
    ("gemini-3.1-pro-preview", pc(2.0, 12.0, 0.2)),
    ("gemini-3.1-flash-lite", pc(0.25, 1.5, 0.025)),
    ("gemini-3.5-flash", pc(1.5, 9.0, 0.15)),
    ("gemini-3.5-flash-lite", pc(0.3, 2.5, 0.03)),
    ("gemini-3.6-flash", pc(1.5, 7.5, 0.15)),
    ("gemini-3.7-flash", pc(0.75, 3.75, 0.075)),
    ("gemini-flash-latest", pc(1.5, 9.0, 0.15)),
    ("gemini-flash-lite-latest", pc(0.25, 1.5, 0.025)),
    ("gemini-2.5-flash-image", pc(0.3, 30.0, 0.075)),
    ("gemini-2.5-flash-preview-tts", p(0.5, 10.0)),
    ("gemini-2.5-pro-preview-tts", p(1.0, 20.0)),
    ("gemini-3.1-flash-image", p(0.5, 60.0)),
    ("gemini-3.1-flash-lite-image", p(0.25, 30.0)),
    ("gemini-3.1-flash-tts-preview", p(1.0, 20.0)),
];

/// Groq. Its `/openai/v1/models` reports `context_window` but no pricing, so
/// unlike the limits table these could not come from the vendor endpoint.
const GROQ: &[(&str, Price)] = &[
    ("openai/gpt-oss-120b", pc(0.15, 0.6, 0.075)),
    ("openai/gpt-oss-20b", pc(0.075, 0.3, 0.0375)),
    ("openai/gpt-oss-safeguard-20b", p(0.075, 0.3)),
    ("qwen/qwen3.6-27b", pc(0.6, 3.0, 0.3)),
    ("llama-3.3-70b-versatile", p(0.59, 0.79)),
    ("llama-3.1-8b-instant", p(0.05, 0.08)),
    ("allam-2-7b", p(0.0, 0.0)),
];

/// OpenRouter, from its own `/api/v1/models` — the rate it actually bills.
/// For several models that is genuinely not the upstream vendor's list price
/// (`google/gemini-3.6-flash` and `openai/gpt-5.6-sol` were both half the
/// native rate when read), so a row here disagreeing with the native table
/// above is the expected outcome and not a transcription error.
const OPENROUTER: &[(&str, Price)] = &[
    ("anthropic/claude-fable-5", pcw(10.0, 50.0, 1.0, 12.5)),
    ("anthropic/claude-opus-5", pcw(5.0, 25.0, 0.5, 6.25)),
    ("anthropic/claude-sonnet-5", pcw(2.0, 10.0, 0.2, 2.5)),
    ("anthropic/claude-opus-4.8", pcw(5.0, 25.0, 0.5, 6.25)),
    ("anthropic/claude-opus-4.7", pcw(5.0, 25.0, 0.5, 6.25)),
    ("anthropic/claude-opus-4.6", pcw(5.0, 25.0, 0.5, 6.25)),
    ("anthropic/claude-sonnet-4.6", pcw(3.0, 15.0, 0.3, 3.75)),
    ("anthropic/claude-sonnet-4.5", pcw(3.0, 15.0, 0.3, 3.75)),
    ("anthropic/claude-opus-4.5", pcw(5.0, 25.0, 0.5, 6.25)),
    ("anthropic/claude-haiku-4.5", pcw(1.0, 5.0, 0.1, 1.25)),
    ("openai/gpt-5", pc(1.25, 10.0, 0.125)),
    ("openai/gpt-5-mini", pc(0.25, 2.0, 0.025)),
    ("openai/gpt-5-nano", pc(0.05, 0.4, 0.005)),
    ("openai/gpt-5-pro", p(15.0, 120.0)),
    ("openai/gpt-5.1", pc(1.25, 10.0, 0.125)),
    ("openai/gpt-5.2", pc(1.75, 14.0, 0.175)),
    ("openai/gpt-5.2-chat", pc(1.75, 14.0, 0.175)),
    ("openai/gpt-5.3-codex", pc(1.75, 14.0, 0.175)),
    ("openai/gpt-5.4", pc(2.5, 15.0, 0.25)),
    ("openai/gpt-5.4-mini", pc(0.75, 4.5, 0.075)),
    ("openai/gpt-5.4-nano", pc(0.2, 1.25, 0.02)),
    ("openai/gpt-5.5", pc(5.0, 30.0, 0.5)),
    ("openai/gpt-5.6-luna", pcw(0.2, 1.2, 0.02, 0.25)),
    ("openai/gpt-5.6-sol", pcw(2.5, 15.0, 0.25, 3.125)),
    ("openai/gpt-5.6-terra", pcw(2.0, 12.0, 0.2, 2.5)),
    ("google/gemini-2.5-pro", pc(1.25, 10.0, 0.125)),
    ("google/gemini-2.5-flash", pc(0.3, 2.5, 0.03)),
    ("google/gemini-2.5-flash-lite", pc(0.1, 0.4, 0.01)),
    ("google/gemini-2.5-flash-image", pc(0.3, 2.5, 0.03)),
    ("google/gemini-3-flash-preview", pc(0.5, 3.0, 0.05)),
    ("google/gemini-3.1-pro-preview", pc(2.0, 12.0, 0.2)),
    ("google/gemini-3.5-flash", pc(1.5, 9.0, 0.15)),
    ("google/gemini-3.6-flash", pc(0.75, 3.75, 0.075)),
    ("google/gemini-3.7-flash", pc(0.375, 1.875, 0.0375)),
    ("deepseek/deepseek-v4-flash", pc(0.0798, 0.1596, 0.016)),
    ("deepseek/deepseek-v4-pro", pc(0.66, 1.98, 0.022)),
    ("x-ai/grok-4.3", pc(1.25, 2.5, 0.2)),
    ("x-ai/grok-4.5", pc(2.0, 6.0, 0.3)),
    ("x-ai/grok-4.6", pc(2.0, 6.0, 0.5)),
    ("x-ai/grok-4.20", pc(1.25, 2.5, 0.2)),
    ("moonshotai/kimi-k2.6", pc(0.5605, 2.36, 0.0944)),
    ("moonshotai/kimi-k2.7-code", pc(0.71, 3.5, 0.15)),
    ("moonshotai/kimi-k3", pc(3.0, 15.0, 0.3)),
    ("qwen/qwen3.6-27b", p(0.289, 2.4)),
    (
        "qwen/qwen3.6-plus",
        Price {
            input: 0.325,
            output: 1.95,
            cache_read: None,
            cache_write: Some(0.4062),
        },
    ),
    ("meta-llama/llama-4-maverick", p(0.2, 0.8)),
    ("meta-llama/llama-4-scout", p(0.1, 0.3)),
];

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(input: u64, output: u64, read: Option<u64>, write: Option<u64>) -> Usage {
        Usage {
            input_tokens: input,
            output_tokens: output,
            reasoning_tokens: None,
            cache_read_tokens: read,
            cache_write_tokens: write,
        }
    }

    #[test]
    fn exact_id_hits() {
        let p = price(ProviderKind::Anthropic, "claude-sonnet-5").unwrap();
        assert_eq!((p.input, p.output), (2.0, 10.0));
        assert_eq!(p.cache_read, Some(0.2));
        assert_eq!(price(ProviderKind::Openai, "gpt-5.4").unwrap().input, 2.5);
    }

    #[test]
    fn dated_snapshot_resolves_to_its_family() {
        assert_eq!(
            price(ProviderKind::Anthropic, "claude-haiku-4-5-20251001"),
            price(ProviderKind::Anthropic, "claude-haiku-4-5")
        );
        assert_eq!(
            price(ProviderKind::Openrouter, "openai/gpt-5:batch"),
            price(ProviderKind::Openrouter, "openai/gpt-5")
        );
    }

    #[test]
    fn a_longer_row_beats_a_shorter_one_that_prefixes_it() {
        // `gpt-5.4-mini` also starts with `gpt-5`, and billing it as the
        // flagship would overstate by more than 3x.
        assert_eq!(
            price(ProviderKind::Openai, "gpt-5.4-mini").unwrap().input,
            0.75
        );
        assert_eq!(
            price(ProviderKind::Openai, "gpt-5-nano").unwrap().input,
            0.05
        );
    }

    #[test]
    fn unknown_model_is_none_not_a_guess() {
        assert_eq!(price(ProviderKind::Anthropic, "claude-9"), None);
        // A local server's model has no per-token price at all.
        assert_eq!(price(ProviderKind::OpenaiChat, "llama3.1:8b"), None);
        // Present in `limits.rs`, but neither source published a price, so it
        // is absent here rather than borrowed from a sibling model.
        assert_eq!(price(ProviderKind::Groq, "groq/compound"), None);
    }

    #[test]
    fn the_three_input_rates_apply_to_disjoint_slices() {
        // 10k prompt = 1k fresh + 7k cache reads + 2k cache writes, which is
        // how Anthropic's usage arrives once the adapter has summed it.
        let p = pcw(3.0, 15.0, 0.3, 3.75);
        let cost = p.cost(&usage(10_000, 1_000, Some(7_000), Some(2_000)));
        let expected = (1_000.0 * 3.0 + 7_000.0 * 0.3 + 2_000.0 * 3.75 + 1_000.0 * 15.0) / 1e6;
        assert!((cost - expected).abs() < 1e-12, "{cost} vs {expected}");
        // Billing the whole prompt at the input rate would be this instead,
        // and the gap is the entire point of the cache.
        assert!(cost < (10_000.0 * 3.0 + 1_000.0 * 15.0) / 1e6);
    }

    #[test]
    fn an_unpriced_cache_read_bills_at_the_full_input_rate() {
        // Overstating is the safe direction: a host that reports cache reads
        // without publishing a discount should not be assumed to be generous.
        let p = p(1.0, 2.0);
        let cost = p.cost(&usage(1_000, 0, Some(900), None));
        assert!((cost - 1_000.0 / 1e6).abs() < 1e-12, "{cost}");
    }

    #[test]
    fn a_gemini_row_carries_no_cache_write_rate() {
        // The published figure is per MTok-hour of explicit cache storage,
        // and this adapter creates no explicit caches.
        let p = price(ProviderKind::Gemini, "gemini-3.1-pro-preview").unwrap();
        assert_eq!(p.cache_write, None);
        assert_eq!(p.cache_read, Some(0.2));
    }

    #[test]
    fn every_priced_model_costs_something_and_nothing_is_negative() {
        for table in [ANTHROPIC, OPENAI, GEMINI, GROQ, OPENROUTER] {
            for (id, p) in table {
                assert!(p.input >= 0.0 && p.output >= 0.0, "{id}");
                if let Some(r) = p.cache_read {
                    // A read discount above the input rate is a transcription
                    // error, not a pricing model anyone offers.
                    assert!(r >= 0.0 && r <= p.input, "{id}: cache_read {r} > input");
                }
                if let Some(w) = p.cache_write {
                    assert!(w >= p.input, "{id}: cache_write {w} < input");
                }
            }
        }
    }
}
