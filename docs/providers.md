# nightloom-providers

One module per wire format, all SSE-based via `eventsource-stream` +
`async-stream`.

- **Native adapters**: `anthropic.rs` (Messages API), `openai_responses.rs`
  (Responses API, streams reasoning summaries), `gemini.rs`
  (`streamGenerateContent`, thought parts).
- **`openai_compat.rs`** is a single `chat/completions` adapter parameterized by
  `Flavor` (Generic / Groq / OpenRouter). The wire formats are nearly shared,
  but reasoning knobs and usage accounting differ per host (Groq:
  `reasoning_format` / `x_groq.usage`; OpenRouter: unified `reasoning` object,
  usage via `usage: {include: true}`). Add new chat/completions hosts as flavors
  here, not as new adapter modules.
- Shared error helpers (`transport`, `parse`, `api_error`) live in `lib.rs`.
  `retry.rs` is a `Provider` decorator that retries *opening* a stream on
  transient errors (transport, 408/429/5xx/529) with exponential backoff;
  mid-stream errors are never retried. The CLI wraps its provider in it; the
  probe deliberately doesn't, since retries would distort TTFT.

## Reasoning replay is not uniform

"Drop it all" is wrong in three of four dialects.

- **Anthropic** *requires* signed thinking blocks back inside a tool loop and
  recommends them across turns. Unsigned ones are dropped — the API rejects what
  it cannot verify.
- **Gemini 3** *hard-requires* `thoughtSignature` echoed on `functionCall` parts
  of the current turn: omit it and round two of every tool loop 400s. Only the
  first `functionCall` part of each step is signed, and part order must survive
  replay (`FC1+sig, FC2, FR1, FR2` — never interleaved pairs), which the
  projection gets for free by coalescing a round's results into one user message.
  Gemini 2.5 never validates any of this.
- **OpenAI Responses** wants the reasoning *item* replayed by id, in stream
  order, immediately before the item it produced. Its streamed summaries are not
  the replayable artifact.
- **chat/completions** hosts require nothing.

Anthropic `display` is sent as `summarized` on adaptive thinking. Its default is
`omitted` on Claude 5, which makes the server skip streaming thinking entirely —
you get a signature and no text, and a thinking UI renders nothing on the
default model.

## Registry and management plane

- **`registry.rs`**: `ProviderKind` is the single place mapping provider name →
  env keys → default model → adapter constructor. New providers register here.
  `build(api_key, base_url)` lets a shell pass an explicit key (wins over env);
  `from_env` is the env-only shorthand.
- **`models.rs`**: `list_models(kind, api_key, base_url)` queries each vendor's
  models endpoint and returns plain ids (Gemini filtered to
  `generateContent`-capable, OpenAI stripped of non-chat ids). A
  management-plane helper for settings UIs, deliberately outside the `Provider`
  trait. Manual smoke: `cargo run -p nightloom-providers --example list_models`.

## Limits and pricing

Both resolve by **longest matching prefix**, so dated snapshots and OpenRouter
`vendor/model:suffix` ids fall back to their family, and both return `None` for
an unknown model rather than a guess.

- **`limits.rs`**: `context_limit(kind, model)` → the model's context window. A
  `None` degrades the gauge to a raw token count; a wrong denominator would
  promise the model headroom it does not have. Static by design (offline, zero
  cost); the module doc records where each number came from and which live
  endpoints can refresh it — Anthropic `/v1/models` and Groq both expose limits,
  OpenAI's does not.
- **`pricing.rs`**: `price(kind, model)` → USD per million tokens, with
  `Price::cost(&Usage)` applying three rates to three **disjoint** input slices
  (fresh / cache read / cache write), which only holds because `Usage` is
  normalized inclusively at the adapter boundary. `None` reaches the UI as no
  dollar figure at all: the errors are not symmetric, since no number reads as
  "we don't know" and a guessed one reads as a bill.

  No vendor management endpoint carries prices (not Anthropic's, Gemini's, or
  Groq's), so unlike `limits.rs` this table cannot be refreshed from the vendor;
  the numbers come from OpenRouter's `/api/v1/models` and models.dev, which
  agreed on every first-party model. Two traps recorded in the module: a Gemini
  "cache write" price is explicit-cache **storage** quoted per MTok-*hour* and
  belongs nowhere near a per-token column, and an OpenRouter row is what
  OpenRouter bills, so disagreeing with the native table for the same model is
  expected rather than a transcription error.

## Anthropic caching is two breakpoints, not one

The system anchors (capped at `SYSTEM_ANCHOR_BUDGET = 3`) plus a rolling one
that `mark_conversation_prefix` puts at the end of the conversation *minus its
last message*. The reservation comes out of the four-per-request limit rather
than on top of it, because a fifth is a 400.

The last message is excluded deliberately: on round one it carries the sidecar,
whose clock moves every turn, so marking it would move the cached bytes and turn
every read into a miss.

Before this, the only cacheable prefix was a ~300-token preamble — below
Anthropic's 1024-token minimum and therefore **silently ignored**. A measured
four-turn session reported `cache_read_input_tokens: 0` on every turn, meaning
the preamble/sidecar split was protecting a cache that never existed. With it,
turn 4 of a measured session read back 1032 tokens and wrote only the 548-token
delta, costing $0.002502 against $0.004086 uncached.

## Tool-call wire dialects, for adapter work

- **Anthropic** buffers `input_json_delta` fragments per block index.
- **OpenAI Responses** reads complete items off `response.output_item.done`.
- **Gemini** gets whole `functionCall` parts (ids synthesized `call-N` when
  absent).
- **chat/completions** accumulates `delta.tool_calls` fragments by index and
  flushes at `[DONE]`.
