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
```

Providers are constructed from env keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`); probe rows for unset providers are skipped. Local servers (Ollama, etc.) use `--provider openai-chat --base-url ... --model ...` with no key.

## Architecture

Four crates with a strict dependency direction: `nightloom-core` ← `nightloom-providers` ← `nightloom-evals` ← `nightloom-cli`.

**nightloom-core** — canonical types only; knows nothing about HTTP, vendors, or UI.
- `Provider` trait (`provider.rs`): `stream_chat(ChatRequest) -> EventStream`. All streaming is normalized into `StreamEvent` (`Start` / `TextDelta` / `ThinkingDelta` / `Usage` / `End`) — vendor delta shapes must never leak past the adapter boundary.
- `Thinking` enum: `Default` | `Budget(u32)` (Anthropic-style) | `Effort(String)` (OpenAI-style). Adapters map what their vendor supports and **fail loudly** on what they don't — no silent fallbacks.
- `Session` (`session.rs`): append-only event log (`SessionEvent`), persisted as JSONL under `.nightloom/sessions/`. The event log is the source of truth; the provider message list (`Session::messages()`) and any UI rendering are projections of it. New capabilities (tool calls, checkpoints, compaction) are added as new `SessionEvent` variants — the enum is `#[non_exhaustive]`.

**nightloom-providers** — one module per wire format, all SSE-based via `eventsource-stream` + `async-stream`.
- Native adapters: `anthropic.rs` (Messages API), `openai_responses.rs` (Responses API, streams reasoning summaries), `gemini.rs` (`streamGenerateContent`, thought parts).
- `openai_compat.rs` is a single `chat/completions` adapter parameterized by `Flavor` (Generic / Groq / OpenRouter) — the wire formats are nearly shared, but reasoning knobs and usage accounting differ per host (Groq: `reasoning_format`/`x_groq.usage`; OpenRouter: unified `reasoning` object, usage via `usage: {include: true}`). Add new chat/completions hosts as flavors here, not as new adapter modules.
- `registry.rs`: `ProviderKind` is the single place that maps provider name → env keys → default model → adapter constructor. New providers register here.
- Shared error helpers (`transport`, `parse`, `api_error`) live in `lib.rs`.

**nightloom-evals** — `probe.rs` runs a spec against any `Provider` and produces a `ProbeReport`: TTFT (measured from before the request, so it includes connection time), thinking/text delta counts, usage accounting, stop reason, answer-substring check, and diagnostics. Diagnostic entries prefixed `note:` are informational; anything else fails the probe. JSON reports land in `.nightloom/probes/`.

**nightloom-cli** — `chat.rs` (REPL: `/new`, `/quit`) and `probe.rs` (matrix runner, `--target provider:model:thinking-spec`).

## Conventions

- When adding or debugging an adapter, run `probe` against it — that's the project's verification loop for streaming behavior (thinking deltas present, usage adds up, stop reason set, stream properly terminated).
- Thinking spec strings parse via `Thinking::FromStr`: `default`, `budget=N`, `effort=LEVEL`.
