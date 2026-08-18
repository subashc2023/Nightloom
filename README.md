# Nightloom

Model-agnostic LLM harness / desktop app. Current state: chat core —
canonical message model, event-sourced sessions, streaming provider adapters
for the big 4 plus OpenRouter, normalized tool use across all of them — with
two shells on top: a CLI REPL with an agentic tool loop and a Tauri desktop
app.

## Layout

- `nightloom-core` — conversation model, `Provider` trait, normalized
  `StreamEvent`, `Tool` trait + vendor-neutral `ToolDef`, append-only
  session event log (JSONL persistence).
- `nightloom-providers` — native adapters: Anthropic (Messages API), OpenAI
  (Responses API, streams reasoning summaries), Gemini
  (`streamGenerateContent`, streams thought summaries). One
  `chat/completions` adapter covers Groq and OpenRouter as flavors, plus
  legacy OpenAI and local servers (Ollama / llama.cpp / LM Studio / vLLM)
  via `--base-url`.
- `nightloom-service` — UI-agnostic turn engine: provider construction with
  retry, the streaming tool loop, cancellation, session discovery, built-in
  tools. Both shells drive conversations through it.
- `nightloom-evals` — the probe engine (streaming health checks).
- `nightloom-cli` — streaming REPL (`nightloom` binary).
- `apps/desktop` — Tauri 2 + Svelte 5 desktop app.

## Providers

| name          | API                     | env key                          | default model         |
| ------------- | ----------------------- | -------------------------------- | --------------------- |
| `anthropic`   | Messages                | `ANTHROPIC_API_KEY`              | claude-sonnet-5       |
| `openai`      | Responses (native)      | `OPENAI_API_KEY`                 | gpt-5-mini            |
| `openai-chat` | chat/completions        | `OPENAI_API_KEY` or `--base-url` | — (explicit)          |
| `gemini`      | streamGenerateContent   | `GEMINI_API_KEY`/`GOOGLE_API_KEY`| gemini-2.5-flash      |
| `groq`        | chat/completions flavor | `GROQ_API_KEY`                   | openai/gpt-oss-120b   |
| `openrouter`  | chat/completions flavor | `OPENROUTER_API_KEY`             | openrouter/auto       |

All adapters stream thinking when the model exposes it: Anthropic thinking
deltas, OpenAI reasoning summaries, Gemini thought summaries, Groq parsed
reasoning (`reasoning_format`), OpenRouter's unified `reasoning` field.

## Usage

```sh
# Anthropic (default)
cargo run -p nightloom-cli

# Any provider
cargo run -p nightloom-cli -- --provider gemini
cargo run -p nightloom-cli -- --provider groq --thinking effort=low
cargo run -p nightloom-cli -- --provider openrouter --model deepseek/deepseek-v4-flash

# Local server (no key needed)
cargo run -p nightloom-cli -- --provider openai-chat --base-url http://localhost:11434/v1 --model llama3.3

# One-shot (no REPL)
cargo run -p nightloom-cli -- --once "hello"

# Built-in tools (current_time, read_file, list_dir); the CLI runs the
# call → result → reply loop, up to 8 rounds per turn
cargo run -p nightloom-cli -- --tools

# Resume a session
cargo run -p nightloom-cli -- sessions            # list logs
cargo run -p nightloom-cli -- --continue          # most recent
cargo run -p nightloom-cli -- --resume 3f2a       # by id prefix
cargo run -p nightloom-cli -- sessions --delete 3f2a   # delete a log
```

REPL commands: `/new` (fresh session), `/compact` (replace earlier turns
with a model-written summary — the context sent to the provider restarts
from it, while the log keeps the full history), `/quit`.

## Tool use

Every adapter normalizes its vendor's tool-call dialect into one canonical
shape: complete `StreamEvent::ToolUse` events out, `ToolUse`/`ToolResult`
content blocks replayed back in (Anthropic `tool_use` blocks, OpenAI
Responses `function_call` items, Gemini `functionCall` parts, chat/completions
`tool_calls`). Tool results are session events; the provider-facing message
list is a projection. Anthropic thinking signatures (and `redacted_thinking`
blocks) are retained and replayed, so tools compose with explicit thinking;
unsigned thinking from other vendors is recorded for the log but dropped on
replay.

The REPL is interruption-safe: Ctrl-C mid-stream cancels the request and
records the partial reply (pending tool calls are discarded), and transient
provider failures (429/5xx/timeouts) retry with backoff before anything has
streamed.

## Desktop app

Tauri 2 shell with a Svelte 5 frontend: streaming chat with collapsible
thinking, tool-call chips with results, and a session sidebar (sessions are
JSONL logs in the OS app-data dir). A connection rail on the right holds
provider/model dropdowns plus the thinking/tools/system knobs — any change
reconnects immediately, and the app auto-connects to the last-used provider
on launch. The thinking control adapts to the selected target (Claude 5
adaptive effort vs Claude ≤4.5 budgets, OpenAI effort incl. minimal, Gemini
budgets vs Gemini 3 levels, OpenRouter either) with a note on how thinking
behaves there. A settings modal (provider list on the left, one pane at a time)
manages each provider: paste an API key (kept in the OS credential store —
Windows Credential Manager / macOS Keychain — and it wins over the env
var), fetch the provider's live model list from its API, and check which
models the rail's dropdown offers (plus custom ids); preferences persist
locally. Cancel mid-stream is the same interruption-safe path as the CLI's
Ctrl-C. Sessions can be deleted from the sidebar, and a Compact button
collapses earlier turns into a summary (shown as a divider in the
transcript) without losing the on-disk history.

```sh
npm install --prefix apps/desktop   # once
cargo tauri dev                     # run — works from the repo root
cargo tauri build                   # installer bundle
```

## Probe

Streaming health check across a (provider, model) matrix: TTFT, thinking/text
delta counts, usage accounting, stop reasons, an answer-correctness check,
and an optional two-leg tool round-trip (the model must call a fixture tool
and echo its result), with per-row diagnostics when something in the
pipeline breaks.

```sh
# Default matrix: 12 targets across all six providers
# (rows for providers whose API key isn't set are skipped)
cargo run -p nightloom-cli -- probe

# Custom targets, multiple runs
cargo run -p nightloom-cli -- probe --runs 3 \
  --target anthropic:claude-sonnet-5:effort=high \
  --target groq:openai/gpt-oss-120b:effort=low \
  --target openrouter:x-ai/grok-4.3:effort=low
```

Thinking specs: `budget=N` (Anthropic ≤4.5, Gemini, OpenRouter),
`effort=LEVEL` (Claude 5 adaptive, OpenAI, Groq, OpenRouter), `default`.
Append `:tools` to a target (or pass `--tools`) to run the tool round-trip;
the default matrix enables it on one row per native provider.
JSON reports land in `.nightloom/probes/`.

Sessions are appended as JSONL event logs under `.nightloom/sessions/` (opt
out with `--no-log`). The event log is the source of truth; provider requests
and UI rendering are projections of it.
