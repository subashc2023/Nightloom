# Commands

The short list lives in `AGENTS.md`. This is the whole surface.

## Build and test

```sh
cargo build                      # build workspace
cargo test                       # all tests
cargo test -p nightloom-core     # one crate
cargo test -p nightloom-core round_trips_through_jsonl   # one test by name
cargo clippy --workspace
cargo fmt
```

## The REPL

```sh
# Defaults to anthropic / claude-sonnet-5
cargo run -p nightloom-cli -- --provider gemini
cargo run -p nightloom-cli -- --once "hello"     # one-shot, no REPL
cargo run -p nightloom-cli -- --continue         # resume the most recent session
cargo run -p nightloom-cli -- --resume 3f2a      # resume by session-id prefix
cargo run -p nightloom-cli -- sessions           # list logs (--delete <prefix>)
```

## The Claude Code engine

Drive the signed-in Claude Code CLI instead of a provider API, so turns are
billed to your Claude subscription rather than an API key. Claude Code owns the
loop, the tools and the history; Nightloom renders what it streams.

```sh
cargo run -p nightloom-cli -- --agent claude-code
cargo run -p nightloom-cli -- --agent claude-code --tools --model opus
cargo run -p nightloom-cli -- --agent claude-code --once "what does this repo do?"
```

## API keys

The OS credential store, shared with the desktop app.

```sh
cargo run -p nightloom-cli -- keys                 # what has a key, and where from
cargo run -p nightloom-cli -- keys set anthropic   # stdin or prompt, never argv
cargo run -p nightloom-cli -- keys rm anthropic
```

## The knowledge vault

Yours, across every project, reached as `@kb/<name>`.

```sh
cargo run -p nightloom-cli -- knowledge                    # where it is
cargo run -p nightloom-cli -- knowledge --set ~/Documents/Vault   # e.g. an Obsidian vault
cargo run -p nightloom-cli -- knowledge --reset            # back to ~/.nightloom/knowledge
cargo run -p nightloom-cli -- --tools --no-knowledge       # withhold it for one run
```

## Dreaming

Consolidate the memory inbox into the vault. Design and model bench:
`.agents/dreaming.md`.

```sh
cargo run -p nightloom-cli -- dream --dry-run              # what's pending; spends nothing
cargo run -p nightloom-cli -- dream

# ...or automatically after each compaction, on a cheap model
cargo run -p nightloom-cli -- --auto-dream --dream-target openrouter:deepseek/deepseek-v4-flash
```

## Importing from claude.ai

Settings → Privacy → Export Data.

```sh
cargo run -p nightloom-cli -- import claude-export.zip --list
cargo run -p nightloom-cli -- import claude-export.zip
cargo run -p nightloom-cli -- import claude-export.zip --only thesis --unfiled
cargo run -p nightloom-cli -- import claude-export.zip --into ~/claude  # also make folders
```

## Evals and probes

Both spend real money against real models, and neither is in CI.

```sh
# Agentic task suite: can a model finish a job with these tools?
cargo run -p nightloom-cli -- eval
cargo run -p nightloom-cli -- eval --target groq:openai/gpt-oss-120b --task rename-across-files --runs 5

# Streaming health probe across the (provider, model) matrix
cargo run -p nightloom-cli -- probe
cargo run -p nightloom-cli -- probe --runs 3 --target anthropic:claude-sonnet-5:effort=high
```

## The desktop app

Tauri 2 + Svelte 5.

```sh
npm install --prefix apps/desktop   # once
cargo install tauri-cli --version "^2"   # once — the tauri CLI is not a workspace member
cargo tauri dev                     # works from the repo root (tauri CLI finds apps/desktop)
npm run check --prefix apps/desktop # svelte-check
cargo tauri build                   # installer bundle
```

## Manual smoke tests

Each spends real turns or real requests, hence an example rather than a test.

```sh
# The desktop runs the same Claude Code engine: the rail's Provider / Claude Code
# switch. Exercises the path that records an agent turn into a session log.
cargo run -p nightloom-service --example agent_record

# Search chain: a dead key ahead of a live one should retire the head on the
# first query and not pay for it on the second. Two real searches.
TAVILY_API_KEY=tvly-not-a-real-key cargo run -p nightloom-service --example search_chain

# Each vendor's models endpoint.
cargo run -p nightloom-providers --example list_models
```
