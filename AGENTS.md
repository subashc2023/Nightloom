# AGENTS.md

Nightloom is a model-agnostic LLM harness in Rust: a provider-neutral chat core
with two shells over it — a CLI REPL and a Tauri desktop app. Cargo workspace,
edition 2024.

`docs/` is the long-form reference: every non-obvious decision in the codebase
with the argument that produced it, one file per area (`core`, `providers`,
`service-engine`, `service-prompt`, `service-tools`, `service-data`,
`service-agent`, `mcp`, `evals`, `cli`, `desktop`, `desktop-ui`, `commands`,
`conventions`). It is far too large to load and deliberately **not** in your
context — this file is. Read the one you need with `read_file` when you want the
*why* behind something, and prefer it over inferring intent from the code,
because most of what looks arbitrary here was measured. `CLAUDE.md` is the index
over it.

## Commands

```sh
cargo build                      # build workspace
cargo test                       # all tests (538 at last count)
cargo test -p nightloom-core     # one crate
cargo clippy --workspace         # must be clean
cargo fmt

cargo run -p nightloom-cli -- --tools           # the REPL, built-in tools on
cargo run -p nightloom-cli -- --once "hello"    # one-shot, no REPL
cargo run -p nightloom-cli -- sessions          # list logs
cargo run -p nightloom-cli -- probe             # streaming health, per provider
cargo run -p nightloom-cli -- eval              # agentic task suite

npm install --prefix apps/desktop        # once
cargo tauri dev                          # desktop, from the repo root
npm run check --prefix apps/desktop      # svelte-check
```

`probe` and `eval` both spend real money against real models and are not in CI.
They answer different questions: `probe` asks whether a stream is healthy,
`eval` asks whether a model can finish a job with these tools. Reach for `eval`
when you change the turn engine, the tools, or their descriptions — it is the
only check that exercises a whole tool loop.

## Architecture

Six crates plus the desktop app, with a strict dependency direction:

```
nightloom-core <- {nightloom-providers, nightloom-mcp} <- nightloom-service
                  <- nightloom-evals <- nightloom-cli
apps/desktop/src-tauri (nightloom-desktop) -> nightloom-service only
```

- **core** — canonical types only. No HTTP, no vendors, no UI. `Provider`,
  `Message`/`ContentBlock`, `Tool`/`ToolDef`/`Effect`, `Session` (the
  append-only event log), `SystemPrompt`.
- **providers** — one module per wire format, all SSE. Vendor delta shapes must
  never leak past the adapter boundary; everything normalizes to `StreamEvent`.
- **mcp** — an MCP client; tools that live in another process.
- **service** — the shell-agnostic conversation engine. `turn.rs` owns the
  streaming tool loop and every invariant a shell must not reimplement.
  `agent/` is a *second* engine that drives the signed-in `claude` CLI.
- **evals** — two harnesses that fail independently: the agentic suite and the
  streaming probe.
- **cli** / **desktop** — renderers. They map `TurnEvent` to a screen and never
  talk to providers directly.

The event log is the source of truth. The provider message list
(`Session::messages()`) and anything a UI draws are *projections* of it.

## Conventions that change what you do

- **Tests are inline** `#[cfg(test)] mod tests` at the bottom of the module they
  cover. There is no `tests/` directory. Adapter tests assert on the request
  body JSON rather than hitting the network; service tests drive `Chat` against
  the scripted `Provider` impls in `turn.rs`'s test module. Reach for those
  shapes instead of adding a mocking layer.
- **Tool descriptions and error strings are prompt text, not documentation.**
  A description is the only instruction the model gets about when to reach for a
  tool; an `Err` comes back to it as an `is_error` result it must act on. Write
  both as instructions that say what to do next.
- **Adding a tool means classifying its `Effect`.** The default is `Mutating`,
  so forgetting is safe but silent, and a test pins the whole table. `Effect`
  decides two things: whether a call needs approval, and whether it may run
  concurrently with its neighbours. Talking a tool down to `ReadOnly` now buys a
  data race as well as an ungated write.
- **Adding a tool means answering cancellation.** `Tool::call` takes the turn's
  token; `_cancel` is right for anything finishing in microseconds, and worth a
  second thought for anything that spawns a process, opens a socket, or walks a
  tree. The engine waits for the call, so a tool that ignores the token is one
  the user cannot interrupt.
- **The cache boundary is the design axis for anything the model should know.**
  Stable for the life of a `Chat` goes in a `SystemPrompt` segment; changes turn
  to turn goes in a `SidecarPart`. A moving value in the preamble invalidates
  the cached prefix every turn — it costs full input price and full TTFT rather
  than failing loudly. **Never put a clock, a date, or git status in
  `prompt.rs`.**
- **Anything that supersedes conversation state is a marker, not a mutation.**
  `Compaction`, `Rewind`, `Elide`/`Unelide` all leave the log append-only and
  change only what the projection reads. A fourth follows the same three rules:
  the log keeps the content, a UI can show what was hidden, and a `Rewind` that
  supersedes the marker undoes it for free.
- **Two note stores, and the line between them matters.** *Project notes* live
  in `<workspace>/.agents` — about the code, committable, inside the tree the
  file tools are rooted at, so `grep`/`glob` find one in an ordinary walk. The
  *knowledge vault* lives in `~/.nightloom/knowledge` (repointable) — about the
  **user**, the same one in every project and in a chat with no project at all,
  reached as `@kb/<name>` through `Root`'s one named second tree. Both reach
  the model as an index, never as content. Don't add a retrieval layer, a
  `kb_read`, or a second task-list mechanism beside `todo_write`: the vault
  reuses `project.rs`'s note functions and the existing file tools, and the
  only two things `knowledge.rs` adds are a location and `[[wikilinks]]`.
  The vault index is **a map, not a catalogue**: grouped by folder with an
  exact count on each, budget shared round-robin, and past the cap it leads
  with "this is a sample" rather than footnoting it. Counts come from
  `project::note_counts`, never from `list_notes` — that stops mid-walk at its
  own cap, so its length is not the size of the vault. Don't add per-note
  snippets or link counts to it; both were measured and refused.
- **An empty search result names its scope.** `grep`/`glob` walk the workspace
  only unless given a `path`, so a bare `no matches` was indistinguishable from
  an answer about everything reachable — measured wrong on four providers over
  a vault question. Both tools now name the directory searched and say when a
  vault was not reached. A glob pattern matches the base-relative path *or* the
  reported one, because feeding back the `@kb/` prefix the tool had just
  printed used to return zero, silently.
- **Memory is an inbox plus a dream, and only the dream writes the vault's
  consolidated notes.** Sessions capture through the `remember` tool — an
  append to `~/.nightloom/observations.jsonl`, typed by provenance
  (`user_stated`/`inferred`/`external`), no model call on the write path —
  and `nightloom dream` is the batch pass that files, supersedes and
  abstracts into the vault, under git when the vault is a repo. The inbox is
  never read back into a conversation and never pruned; the watermark
  (`dream.json`) is a byte offset that advances only on an uninterrupted
  pass. Don't add a consolidation step to the write path, don't let the
  dream delete notes (supersession is strikethrough-with-date), and don't
  schedule it behind the user's back — it spends money unattended, so the
  one automation is opt-in and compaction-triggered (`--auto-dream`, or the
  desktop's Settings → Knowledge toggle), never a wall clock. The design,
  the research, and the dream-model bench: `.agents/dreaming.md`.
- **Turn semantics live in two files** and usually change together:
  `service/turn.rs` and `core/session.rs`. A shell that seems to need its own
  loop logic is a sign something belongs in `turn.rs`.
- Thinking spec strings parse via `Thinking::FromStr`: `default`, `budget=N`,
  `effort=LEVEL`. Adapters **fail loudly** on a mode their vendor doesn't
  support — no silent fallbacks.

## Platform

Development happens on Windows. `shell.rs` branches on OS and `root.rs` resolves
symlinks, so one platform tests half of each — CI runs the suite on Linux and
Windows both. The `bash` tool spawns `cmd /C` here, not PowerShell.
