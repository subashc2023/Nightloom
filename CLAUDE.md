# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Nightloom is a model-agnostic LLM harness (eventual desktop app; currently a chat core + CLI REPL) written in Rust. Cargo workspace, edition 2024.

## Commands

```sh
cargo build                      # build workspace
cargo test                       # all tests
cargo test -p nightloom-core     # one crate
cargo test -p nightloom-core round_trips_through_jsonl   # one test by name
cargo clippy --workspace
cargo fmt

# Run the REPL (defaults to anthropic / claude-sonnet-5)
cargo run -p nightloom-cli -- --provider gemini
cargo run -p nightloom-cli -- --once "hello"     # one-shot, no REPL

# Streaming health probe across the (provider, model) matrix
cargo run -p nightloom-cli -- probe
cargo run -p nightloom-cli -- probe --runs 3 --target anthropic:claude-sonnet-5:effort=high

# Desktop app (Tauri 2 + Svelte 5)
npm install --prefix apps/desktop   # once
cargo tauri dev                     # works from the repo root (tauri CLI finds apps/desktop)
npm run check --prefix apps/desktop # svelte-check
```

Providers are constructed from env keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`); probe rows for unset providers are skipped. Local servers (Ollama, etc.) use `--provider openai-chat --base-url ... --model ...` with no key.

## Architecture

Five crates plus the desktop app, with a strict dependency direction: `nightloom-core` ← `nightloom-providers` ← {`nightloom-service`, `nightloom-evals`} ← `nightloom-cli`; `apps/desktop/src-tauri` (crate `nightloom-desktop`) sits on `nightloom-service` only. Core knows no HTTP or UI; shells (CLI, desktop) render but never talk to providers directly — they drive `nightloom-service`.

**nightloom-core** — canonical types only; knows nothing about HTTP, vendors, or UI.
- `Provider` trait (`provider.rs`): `stream_chat(ChatRequest) -> EventStream`. All streaming is normalized into `StreamEvent` (`Start` / `TextDelta` / `ThinkingDelta` / `ThinkingSignature` / `RedactedThinking` / `ToolUse` / `Usage` / `End`) — vendor delta shapes must never leak past the adapter boundary. `StreamEvent::ToolUse` carries a *complete* call: adapters buffer partial-argument fragments internally and emit one event per call. `ThinkingSignature` marks the end of a signed thinking block (consumers flush accumulated `ThinkingDelta` text into one `ContentBlock::Thinking` with that signature); only Anthropic signs thinking.
- Tool use (`tool.rs`): `ToolDef` (name/description/JSON-Schema `input_schema`) declares tools vendor-neutrally via `ChatRequest.tools`; the `Tool` trait is the execution contract (`Err` becomes an `is_error` tool result fed back to the model, not an abort). `ContentBlock::ToolUse` lives in assistant messages, `ContentBlock::ToolResult` in user messages — its `name` field exists because Gemini pairs results by function name, not call id.
- Thinking replay: `ContentBlock::Thinking` carries an optional signature and `ContentBlock::RedactedThinking` an opaque payload; assistant blocks are recorded **in stream order** (thinking must precede the tool_use it led to). The Anthropic adapter replays signed thinking and redacted blocks verbatim and drops unsigned ones (Anthropic 400s on them); every other adapter drops thinking on replay.
- `Thinking` enum: `Default` | `Budget(u32)` (Anthropic-style) | `Effort(String)` (OpenAI-style). Adapters map what their vendor supports and **fail loudly** on what they don't — no silent fallbacks.
- `Session` (`session.rs`): append-only event log (`SessionEvent`), persisted as JSONL under `.nightloom/sessions/`. The event log is the source of truth; the provider message list (`Session::messages()`) and any UI rendering are projections of it. Tool results are recorded as individual `SessionEvent::ToolResult` events; the projection coalesces consecutive ones into the single user message providers expect. New capabilities (checkpoints, compaction) are added as new `SessionEvent` variants — the enum is `#[non_exhaustive]`.

**nightloom-providers** — one module per wire format, all SSE-based via `eventsource-stream` + `async-stream`.
- Native adapters: `anthropic.rs` (Messages API), `openai_responses.rs` (Responses API, streams reasoning summaries), `gemini.rs` (`streamGenerateContent`, thought parts).
- `openai_compat.rs` is a single `chat/completions` adapter parameterized by `Flavor` (Generic / Groq / OpenRouter) — the wire formats are nearly shared, but reasoning knobs and usage accounting differ per host (Groq: `reasoning_format`/`x_groq.usage`; OpenRouter: unified `reasoning` object, usage via `usage: {include: true}`). Add new chat/completions hosts as flavors here, not as new adapter modules.
- `registry.rs`: `ProviderKind` is the single place that maps provider name → env keys → default model → adapter constructor. New providers register here. `build(api_key, base_url)` lets a shell pass an explicit key (wins over env); `from_env` is the env-only shorthand.
- `models.rs`: `list_models(kind, api_key, base_url)` queries each vendor's models endpoint and returns plain ids (Gemini filtered to `generateContent`-capable, OpenAI stripped of non-chat ids). Management-plane helper for settings UIs — deliberately outside the `Provider` trait. Manual smoke: `cargo run -p nightloom-providers --example list_models`.
- Shared error helpers (`transport`, `parse`, `api_error`) live in `lib.rs`. `retry.rs` is a `Provider` decorator that retries *opening* a stream on transient errors (transport, 408/429/5xx/529) with exponential backoff; mid-stream errors are never retried. The CLI wraps its provider in it; the probe deliberately doesn't (retries would distort TTFT).

**nightloom-service** — the shell-agnostic conversation engine.
- `turn.rs`: `Chat` (provider + model + system/thinking/max_tokens/tools/max_rounds) with `run_turn(session, input, cancel, on_event)` — the streaming tool loop. Progress streams out through a serializable `TurnEvent` callback (`TextDelta` / `ThinkingDelta` / `RedactedThinking` / `ToolCall` / `ToolResult` / `RoundLimit`, `#[non_exhaustive]`); interruption comes in via a `tokio_util` `CancellationToken`. The engine owns the invariants shells must not reimplement: stream-order block assembly (signed/empty thinking included), tool execution with results recorded even on the final round, cancellation/error paths recording partial replies with pending `tool_use` blocks stripped, the empty-text-block rule. Unit-tested against scripted mock providers.
- `store.rs`: session-log discovery (`list` → `SessionSummary`, `find_by_prefix`, `latest`); `lib.rs::connect` builds a provider (explicit api_key wins over env) + resolves the model + wraps in `Retry`, and re-exports `list_models`; `tools.rs` hosts the built-in tools (current_time, read_file, list_dir) shared by all shells.

**nightloom-evals** — `probe.rs` runs a spec against any `Provider` and produces a `ProbeReport`: TTFT (measured from before the request, so it includes connection time), thinking/text delta counts, usage accounting, stop reason, answer-substring check, and diagnostics. Diagnostic entries prefixed `note:` are informational; anything else fails the probe. JSON reports land in `.nightloom/probes/`.

**nightloom-cli** — `chat.rs` is a terminal renderer over `nightloom-service`: it maps `TurnEvent`s to stdout (dim thinking, tool chips) and wires Ctrl-C to the turn's `CancellationToken`; all loop/recording semantics live in the service. REPL commands `/new`, `/quit`; `--resume`/`--continue`; `--tools` enables the built-ins. `sessions.rs` prints `store::list`; `probe.rs` is the matrix runner (`--target provider:model:thinking-spec[:tools]`).

**apps/desktop** (`nightloom-desktop`) — Tauri 2 shell + Svelte 5 frontend. `src-tauri/src/main.rs` exposes commands `providers` / `set_api_key` / `clear_api_key` / `list_models` / `connect` / `list_sessions` / `new_session` / `open_session` / `transcript` / `send` / `cancel` over managed state (`Chat` + active `Session` in tokio mutexes, a swap-per-turn `CancellationToken`); `send` forwards `TurnEvent`s as `turn-event` window events, retry stalls as `turn-notice`. Sessions are created lazily by `send` (never by `connect`), so provider switching and launch auto-connect leave no empty logs; session logs live in the OS app-data dir, not `.nightloom/`. Connection UX: a right-hand rail (`ProviderRail.svelte`) with provider/model dropdowns and thinking/tools/system knobs re-connects on every change and auto-connects at launch to the last-used draft; `SettingsModal.svelte` is a sidebar-nav modal (provider list left, one pane at a time) managing per-provider API keys, rail visibility, and model checklists (curated ∪ custom ∪ live-fetched via `list_models`). API keys entered in-app live in the OS credential store (`keyring` crate, service "nightloom", user = provider label; `openai-chat` falls back to `openai`'s stored key) and win over env vars; the UI only ever sees `key_source` ("stored"/"env"/null), never the key. The curated model list, visibility prefs, and last connection live in `src/lib/catalog.ts` + localStorage (`nightloom.catalog-prefs`, `nightloom.last-connection`). The frontend (`src/lib/types.ts`) mirrors the serde shapes of `TurnEvent`, `SessionEvent`, and `ContentBlock` — changing those enums means updating that file; unknown tags are ignored on both sides, so additive variants are safe. The transcript is a projection of `SessionEvent[]`; after each turn the UI re-syncs via `transcript` rather than trusting its live buffer.

Tool-call wire dialects, for adapter work: Anthropic buffers `input_json_delta` fragments per block index; OpenAI Responses reads complete items off `response.output_item.done`; Gemini gets whole `functionCall` parts (ids synthesized `call-N` when absent); chat/completions accumulates `delta.tool_calls` fragments by index and flushes at `[DONE]`. The probe's tool check (`ProbeSpec.tool_check`) is a two-leg fixture: the model must call `lookup_codeword` and the second leg's answer must contain the fabricated codeword.

## Conventions

- When adding or debugging an adapter, run `probe` against it — that's the project's verification loop for streaming behavior (thinking deltas present, usage adds up, stop reason set, stream properly terminated).
- Thinking spec strings parse via `Thinking::FromStr`: `default`, `budget=N`, `effort=LEVEL`.
