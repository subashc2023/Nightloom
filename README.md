# Nightloom

A model-agnostic LLM harness in Rust: a provider-neutral chat core with two
shells over it — a CLI REPL and a Tauri desktop app. Both talk to the same
turn engine, both write the same session logs, and neither knows anything
about a vendor's wire format.

The organizing idea is that **the session log is the source of truth**.
Everything else — what a provider receives, what the transcript renders, what
a context gauge reads — is a projection of an append-only event log. Nothing
that supersedes conversation state deletes it: compaction, rewind and elision
are all markers, so a UI can show what was dropped and an undo is always
available.

## Layout

Six crates, strict dependency direction: `nightloom-core` ←
{`nightloom-providers`, `nightloom-mcp`} ← `nightloom-service` ←
`nightloom-evals` ← `nightloom-cli`; the desktop app sits on
`nightloom-service` only.

- `nightloom-core` — canonical types and nothing else: messages and content
  blocks, the `Provider` trait with its normalized `StreamEvent`, the `Tool`
  trait and vendor-neutral `ToolDef`, layered system prompts, the session
  event log and every projection off it. No HTTP, no vendors, no UI.
- `nightloom-providers` — one module per wire format, all SSE: Anthropic
  Messages, OpenAI Responses, Gemini `streamGenerateContent`, and one
  `chat/completions` adapter parameterized by flavor (Groq, OpenRouter,
  generic — which covers legacy OpenAI and local servers). Plus the model,
  context-limit and pricing tables, and a retry decorator.
- `nightloom-mcp` — an MCP client over stdio or Streamable HTTP; tools that
  live in another process, exposed as ordinary `Tool`s.
- `nightloom-service` — the shell-agnostic conversation engine: the streaming
  tool loop, cancellation, approval policy, subagents, compaction, the
  built-in tools, prompt assembly, session discovery, projects.
- `nightloom-evals` — two harnesses: a streaming health probe, and an agentic
  task suite that grades by inspecting the disk.
- `nightloom-cli` — the `nightloom` binary: REPL, probe, eval, session
  management.
- `apps/desktop` — Tauri 2 + Svelte 5.

## Providers

| name          | API                     | env key                           | default model       |
| ------------- | ----------------------- | --------------------------------- | ------------------- |
| `anthropic`   | Messages                | `ANTHROPIC_API_KEY`               | claude-sonnet-5     |
| `openai`      | Responses (native)      | `OPENAI_API_KEY`                  | gpt-5-mini          |
| `openai-chat` | chat/completions        | `OPENAI_API_KEY` or `--base-url`  | — (explicit)        |
| `gemini`      | streamGenerateContent   | `GEMINI_API_KEY`/`GOOGLE_API_KEY` | gemini-2.5-flash    |
| `groq`        | chat/completions flavor | `GROQ_API_KEY`                    | openai/gpt-oss-120b |
| `openrouter`  | chat/completions flavor | `OPENROUTER_API_KEY`              | openrouter/auto     |

Keys come from the OS credential store first and the environment second, and
both shells resolve them the same way — a key set in the desktop's settings
pane works in the CLI, and one set with `nightloom keys set` works in the app:

```sh
nightloom keys                       # what has a key, and where from
nightloom keys set anthropic         # prompts, or reads a piped key on stdin
nightloom keys rm anthropic          # forgets the stored one; env is untouched
```

The key is never taken as a command-line argument — that puts it in shell
history and in `ps`. A stored key wins over the environment, which is what
`keys` prints per row so a forgotten `ANTHROPIC_API_KEY` cannot quietly be
the one in use. There is no store on a headless box (no D-Bus session, no
unlocked keyring); every read falls through to the environment rather than
prompting, so nothing here breaks over SSH or in CI.

Every adapter streams thinking when the model exposes it, and every adapter
replays reasoning the way its own vendor requires — which is not uniform, and
where "drop it all" is wrong in three dialects out of four. Anthropic needs
signed thinking blocks back inside a tool loop; Gemini 3 hard-requires
`thoughtSignature` echoed on function calls, or round two of every tool loop
400s; OpenAI Responses wants its reasoning item replayed by id. The replay
tokens are separate types on purpose, so a handle issued by one vendor cannot
reach another — you can switch provider mid-session and keep the log.

## CLI

```sh
cargo run -p nightloom-cli                         # Anthropic, the default
cargo run -p nightloom-cli -- --provider gemini
cargo run -p nightloom-cli -- --provider groq --thinking effort=low
cargo run -p nightloom-cli -- --once "hello"       # one-shot, no REPL

# A local server needs no key
cargo run -p nightloom-cli -- --provider openai-chat \
  --base-url http://localhost:11434/v1 --model llama3.3

# Sessions
cargo run -p nightloom-cli -- sessions             # list logs, by name
cargo run -p nightloom-cli -- sessions borrow      # ones that mention it
cargo run -p nightloom-cli -- --continue           # resume the most recent
cargo run -p nightloom-cli -- --resume 3f2a        # resume by id prefix
cargo run -p nightloom-cli -- sessions --delete 3f2a
```

Thinking specs: `default`, `budget=N` (Anthropic ≤4.5, Gemini 2.5,
OpenRouter), `effort=LEVEL` (Claude 5 adaptive, OpenAI, Groq, OpenRouter).
Adapters fail loudly on a mode their vendor does not support rather than
silently falling back.

REPL commands: `/new`, `/compact`, `/quit`, `/rewind`, `/context`.

- `/rewind` lists the turns the session can be rewound to; `/rewind <n>` goes
  back to one. Every user message is a checkpoint, because you find out which
  turn you wanted back *after* the turn that spoiled it. Nothing is deleted —
  the log keeps it, and a later rewind can bring it back. Files a tool wrote
  are not reverted, and the CLI says so before doing it.
- `/context` itemizes what the next request actually carries, largest first:
  every system segment, every projected message, the sidecar, each with an
  estimated size and the log event behind it. `/context drop <n>…` removes an
  item's content and `/context keep <n>…` restores it. Removal is content-only
  — a tool result keeps its id and swaps only its payload — so it cannot
  produce a request a provider rejects.

Ctrl-C mid-stream cancels the turn and records the partial reply with pending
tool calls stripped. It also reaches a tool call already in flight: every tool
is handed the turn's token, so an interrupted `bash` kills what it started
rather than running to its timeout. The round still finishes and still records
a result for every call it made — a `tool_use` with no `tool_result` is
invalid on replay against every provider, so nothing is abandoned, only asked
to stop. Transient provider failures retry with backoff before anything has
streamed; mid-stream errors never retry.

## Tools

`--tools` turns on the built-ins: `read_file`, `write_file`, `edit_file`,
`list_dir`, `glob`, `grep`, `bash`, `current_time`, `todo_write`,
`web_fetch`, `web_search`, `task` (subagents) and
`review` (a second opinion from another vendor). `--self-compact` adds one
more, `compact_context` — separate because every other tool here acts on the
workspace and that one acts on the conversation, superseding everything
before it. Path-taking tools resolve their
argument against a workspace root and refuse anything outside it, checked both
lexically and by canonicalizing the deepest existing ancestor so a symlink
cannot point out. It is a guard rail, not a sandbox — `bash` is not confined
at all, only its working directory is set, and its description says so.

Every tool declares an `Effect` — `ReadOnly`, `Session` or `Mutating` — and
**the default is `Mutating`**. A tool that has not answered the question is
one nobody vouched for, so silence reads as "this can do anything".

Anything mutating asks first:

```
bash(command: "rm -rf build")
[y] allow  [a] always allow bash  [n] deny
```

Anything else typed becomes the denial reason, handed to the model verbatim —
a denial is a message, not an abort, so the model can try something else
instead of repeating the identical call. `--no-approval` (alias `--yolo`)
runs unattended.

`web_fetch` reads a URL: HTML comes back as text with headings, list markers
and links kept, so a link worth following appears as `[text](url)` and can be
fetched in turn. `web_search` needs one of `TAVILY_API_KEY`, `BRAVE_API_KEY`
or `EXA_API_KEY` and is not offered without one — nothing is substituted, and
a tool that fails every call would cost a round trip to discover that.

Both are **`Mutating`**, so both ask first. Reading a page reads like a read,
and every other read here is `ReadOnly` — but those are confined to the
workspace root, and there is no root for a network. The model composes the
URL out of whatever it has read, so the only containment available is a
person seeing it before it is sent. `--no-web` withholds them entirely.

Subagents (`task`) run a focused instruction in a nested chat with its own
session and return only their final message. The point is not parallelism, it
is *forgetting*: a question costing twenty file reads and one sentence to
answer should not spend the parent's window on the nineteen intermediate
results. A subagent inherits the parent's cancellation token and its approval
policy — including any "always allow" already granted — so it cannot be a door
beside the gate.

## MCP

Servers are configured in `.nightloom/mcp.json` (or `~/.nightloom/mcp.json`)
using the same `mcpServers` shape other hosts use, so an existing config can
be copied across unchanged. They start with `--tools`; `--no-mcp` opts out.

```json
{
  "mcpServers": {
    "files":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/some/dir"] },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${SOME_TOKEN}" } }
  }
}
```

A `command` means stdio, a `url` means Streamable HTTP. `${VAR}` is read from
the environment, and an **unset** one fails that server with one line rather
than sending an empty token — the alternative to writing `${GITHUB_TOKEN}` in
a config file is writing the token. A server that fails to start costs one
line and takes nothing else down. MCP tools land beside the built-ins and are
subject to the same approval gate; they are always classified `Mutating`,
since a server wanting past the gate would only have to name its tool
`read_something`.

## Projects and the docspace

A **project is not a folder.** It has an id and a name of its own, and *may*
point at a working directory. The importer forced the distinction: a claude.ai
project is instructions, documents and conversations with no code anywhere, and
while identity was a hash of a path the import had to invent an empty directory
per project purely so there was something to hash.

```text
<workspace>/AGENTS.md                  instructions  (yours, usually committed)
<workspace>/.agents/                   the docspace  (yours, committable)
~/.nightloom/projects/<id>/sessions/   the chats
```

The split is about the code / about you. Notes describe the codebase, so they
sit with it — a teammate can read them, a diff can review them, and the file
tools reach them by a plain relative path because `.agents` is inside the tree
they are already rooted at. Chats are personal history, and a repository is not
the place for them. A project with no folder gets a stand-in one inside its
store, so the rule holds either way: instructions and notes in the workspace,
chats a sibling of it and never in it.

Shared knowledge between chats therefore needs no database and no retrieval
layer — it needs a directory the model can read and write, and a system-prompt
layer telling it what is in there. The notes reach the model as an **index**
(names, sizes, first headings), not as content: inlining them would put an
unbounded pile of text in the one place that has to stay small.

Three things fall out that were previously impossible: renaming or moving a
folder stops orphaning a year of chats, two projects can share one folder, and
a project can have no folder at all. `NIGHTLOOM_HOME` moves the home. The CLI
needs no registry — it reads one to find the project registered on the folder
it was run in, and falls back to a store keyed by the path when nobody has
claimed it, so `nightloom --continue` in a project directory resumes the
conversation the desktop app was having there. Opening a folder laid out the
old way migrates it: `.nightloom/sessions` to the store, `.nightloom/notes` to
`.agents`, nothing overwritten, `mcp.json` left alone, and both shells say what
moved.

## Context

The system prompt is an ordered list of segments, not a string, and the cache
boundary is the design axis: anything stable for the life of a chat goes in a
segment, and anything that changes turn to turn goes in the per-turn
**sidecar** — clock, context gauge, task list — which is composed at
projection time and never logged. Putting a moving value in the preamble
invalidates the cached prefix every turn; it costs full input price and full
TTFT rather than failing loudly.

`--bare` drops the preamble, `--no-sidecar` drops the status block.

Past 75% of the window the gauge starts *recommending* `compact_context` at
the model's next natural stopping point — and only where the tool is actually
on the request, since recommending one that was never advertised buys a
hallucinated call. It is advice, not a trigger: the engine knows how full the
window is but not whether this is a sensible place to stop, and firing
automatically mid-task discards exactly the detail the next step needed. With
`--self-compact` off nobody compacts but you, from `/compact`.

Cost is recorded per exchange rather than re-derived, because a model id alone
does not name a provider and yesterday's price is not today's. An unpriced
model contributes no dollar figure at all rather than `$0.00`, and a session
containing one renders its total with a `≥`.

A session's **name** is recorded the same way and for the same reason: it
comes out of a model call already paid for, so re-deriving it would mean
paying again on every listing. It is written once, at the end of the first
turn, from that turn alone — two clipped excerpts and an instruction, never
the conversation so far. Deriving a name without a model is what both shells
did before, and it is the part that stops working: forty chats all beginning
"can you help me" are a list you open one by one.

Renaming is an ordinary append, so the old name stays in the log and the
latest wins — `/name <text>` in the REPL, a pencil or a double-click in the
sidebar. It exists because a name is written once and a long conversation
that has moved on keeps describing where it started; deciding automatically
when a chat has drifted is not a judgement the engine is in a position to
make, and the person looking at both the name and the conversation is.

Search covers **the conversation and not tool output**. A tool result is
whatever a file happened to contain, so searching it would return every
session that ever read a file mentioning the word — close to all of them, and
never the one being looked for. Excerpts are clipped around the hit rather
than from the start of the message, because a result that does not show why it
matched reads as a false positive.

## Desktop app

```sh
npm install --prefix apps/desktop        # once
cargo install tauri-cli --version "^2"   # once
cargo tauri dev                          # works from the repo root
cargo tauri build                        # installer bundle
```

Streaming chat with collapsible thinking, tool chips, inline approval prompts,
and image or PDF attachments by paste or drop. Projects live on the left with a
Chats/Notes tab strip; the right-hand rail holds the connection knobs, the
model's task list, and a context panel that itemizes the wire with a
remove/restore button per block. A settings modal manages per-provider API
keys (kept in the OS credential store, and winning over env vars), live model
lists, and which models the dropdowns offer. Named system prompts live in a
prompt library; applying one copies its text onto the draft, so editing a
library entry cannot silently change a chat already connected with it.

Chats filed under a project go to that project's store; unfiled chats go to
`~/.nightloom/unfiled/`, because the quickest useful thing this app does is
answer a question that has nothing to do with any directory — and they sit
beside the projects so everything Nightloom has written is under one directory
you can open.

## Probe and eval

They answer different questions and both are cheap. An adapter can stream
flawlessly while the model never edits the right file.

**Probe** is a streaming health check across a (provider, model) matrix: TTFT,
thinking/text delta counts, usage accounting, stop reasons, an
answer-correctness check, and an optional two-leg tool round-trip. Reach for
it when adding or debugging an adapter.

```sh
cargo run -p nightloom-cli -- probe
cargo run -p nightloom-cli -- probe --runs 3 \
  --target anthropic:claude-sonnet-5:effort=high \
  --target groq:openai/gpt-oss-120b:effort=low
```

**Eval** gives a model a throwaway workspace, the built-in tools and an
instruction, then **inspects the disk**. No model grades another: a check is a
plain function over the resulting directory, so a pass is a fact rather than
an opinion. Every agentic task carries a trap — a decommissioned file with the
same phrase, a config that must survive an in-place edit, a symbol that must
*not* be renamed, a file that does not exist and must not be invented. Three
further tasks ask a different question — not *can it finish the job* but *can
it make this shape of tool call* — and are graded on the recorded call trace,
since three files read in one batch and three read one after another leave a
workspace identical in every byte.

```sh
cargo run -p nightloom-cli -- eval
cargo run -p nightloom-cli -- eval --target groq:openai/gpt-oss-120b \
  --task rename-across-files --runs 5
```

Tasks: `find-fact`, `fix-value`, `rename-across-files`, `absent-file`,
`one-call`, `three-sequential`, `three-parallel`. `runs` defaults to 3 —
these are sampled systems, and the interesting number is a pass rate.

Reach for `eval` when changing the turn engine, the tools, or their
descriptions. It is the only check that exercises a whole tool loop against a
real model, and it is what caught a round cap that had been silently
truncating ordinary work.

## Development

```sh
cargo test --workspace          # ~380 tests, no network
cargo clippy --workspace
cargo fmt
npm run check --prefix apps/desktop
```

Tests are inline `#[cfg(test)] mod tests` at the bottom of the module they
cover; there is no `tests/` directory. Nothing here talks to a provider:
adapter tests assert on the request body the adapter builds, and engine tests
drive the turn loop against scripted providers. CI runs the same commands on
Linux and Windows.

Session logs live under `~/.nightloom` and notes in `<workspace>/.agents` (see
**Projects and the docspace**); `NIGHTLOOM_HOME` moves the former. What else
lands in the folder is `.nightloom/mcp.json`, written by hand, and `probes/`
and `evals/` where those commands are run.

`CLAUDE.md` is the long-form architecture document — why each boundary is
where it is, and what went wrong before it moved there.
