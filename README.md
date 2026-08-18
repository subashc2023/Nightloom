# Nightloom

Model-agnostic LLM harness / desktop app. Current state: chat core —
canonical message model, event-sourced sessions, streaming provider adapters
for the big 4 plus OpenRouter, normalized tool use across all of them, and a
CLI REPL with an agentic tool loop.

## Crates

- `nightloom-core` — conversation model, `Provider` trait, normalized
  `StreamEvent`, `Tool` trait + vendor-neutral `ToolDef`, append-only
  session event log (JSONL persistence).
- `nightloom-providers` — native adapters: Anthropic (Messages API), OpenAI
  (Responses API, streams reasoning summaries), Gemini
  (`streamGenerateContent`, streams thought summaries). One
  `chat/completions` adapter covers Groq and OpenRouter as flavors, plus
  legacy OpenAI and local servers (Ollama / llama.cpp / LM Studio / vLLM)
  via `--base-url`.
- `nightloom-evals` — the probe engine (streaming health checks).
- `nightloom-cli` — streaming REPL (`nightloom` binary).

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
```

REPL commands: `/new` (fresh session), `/quit`.

## Tool use

Every adapter normalizes its vendor's tool-call dialect into one canonical
shape: complete `StreamEvent::ToolUse` events out, `ToolUse`/`ToolResult`
content blocks replayed back in (Anthropic `tool_use` blocks, OpenAI
Responses `function_call` items, Gemini `functionCall` parts, chat/completions
`tool_calls`). Tool results are session events; the provider-facing message
list is a projection. Known limitation: assistant thinking blocks are not
replayed (signatures aren't retained yet), so combine tools with explicit
thinking at your own risk on Anthropic.

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
