# Nightloom

A model-agnostic LLM harness in Rust. One provider-neutral chat core, two
shells over it — a CLI REPL and a Tauri desktop app — and six provider
adapters that all normalize onto the same event stream.

The organizing idea: **the session log is the source of truth.** What a
provider receives, what the transcript renders, what the context gauge reads
are all projections of an append-only event log. Compaction, rewind and
elision are *markers*, never deletions — so a UI can show what was dropped,
and undo is always available.

## Quickstart

Needs Rust 1.85+ (edition 2024). Nothing else for the CLI.

```sh
cargo install --path crates/nightloom-cli   # installs the `nightloom` binary
nightloom keys set anthropic                # prompts; never taken from argv
nightloom                                   # REPL, Anthropic by default
```

Or without installing, and without an API key at all:

```sh
cargo run -p nightloom-cli -- --once "hello"
cargo run -p nightloom-cli -- --agent claude-code   # bills your Claude plan
```

Add `--tools` to let the model read, write and run things in the current
directory. Anything that can change the machine asks first.

## What makes it different

- **Six providers, one log.** Switch vendor mid-session and keep the
  conversation — reasoning replay tokens are separate types per vendor, so a
  handle issued by one can never reach another.
- **Or no provider at all.** `--agent claude-code` drives the signed-in Claude
  Code CLI, so turns bill to a Claude subscription instead of an API key.
- **Nothing is ever deleted.** Rewind to any user message, drop a 40k-token
  tool result out of the context, bring either back.
- **Approval by classification, not by name.** Every tool declares an
  `Effect`, and the default is `Mutating` — silence reads as "this can do
  anything".
- **Graded by the disk, not by a model.** The eval suite inspects the
  resulting directory, so a pass is a fact rather than an opinion.

## Providers

| name          | API                     | env key                           | default model       |
| ------------- | ----------------------- | --------------------------------- | ------------------- |
| `anthropic`   | Messages                | `ANTHROPIC_API_KEY`               | claude-sonnet-5     |
| `openai`      | Responses (native)      | `OPENAI_API_KEY`                  | gpt-5-mini          |
| `openai-chat` | chat/completions        | `OPENAI_API_KEY` or `--base-url`  | — (explicit)        |
| `gemini`      | streamGenerateContent   | `GEMINI_API_KEY`/`GOOGLE_API_KEY` | gemini-2.5-flash    |
| `groq`        | chat/completions flavor | `GROQ_API_KEY`                    | openai/gpt-oss-120b |
| `openrouter`  | chat/completions flavor | `OPENROUTER_API_KEY`              | openrouter/auto     |

Keys come from the OS credential store first, the environment second, and both
shells resolve them identically — a key set in the desktop settings pane works
in the CLI and vice versa.

```sh
nightloom keys                  # what has a key, and where from
nightloom keys set anthropic    # prompts, or reads a piped key on stdin
nightloom keys rm anthropic     # forgets the stored one; env is untouched
```

The same namespace covers search backends (`tavily`, `brave`, `exa`). On a
headless box with no keyring, every read falls through to the environment
rather than prompting, so nothing breaks over SSH or in CI.

Thinking specs are `default`, `budget=N` (Anthropic ≤4.5, Gemini 2.5,
OpenRouter) or `effort=LEVEL` (Claude 5 adaptive, OpenAI, Groq, OpenRouter).
Adapters fail loudly on a mode their vendor doesn't support — no silent
fallbacks.

## Claude Code as the engine

`--agent claude-code` swaps the *engine*, not the provider. Claude Code owns
the loop, the tools and the history; Nightloom renders what it streams. Turns
bill to your Claude plan rather than to an API key.

```sh
nightloom --agent claude-code
nightloom --agent claude-code --tools --model opus
nightloom --agent claude-code --once "what does this repo do?"
```

`ANTHROPIC_API_KEY` is removed from the child's environment, because the CLI
silently prefers a key over the subscription whenever one is set — and nothing
in the output would say so. `--bare` maps to `--safe-mode` (drops the host's
`CLAUDE.md`, hooks, plugins and MCP servers, and keeps auth working).

Because that engine runs its own tools, Nightloom's approval gate does not
apply: `--tools` maps to the CLI's `dontAsk` and `--no-approval` to
`bypassPermissions`, and the startup lines say so. `--thinking`,
`--self-compact`, `/context` and `/rewind` don't apply either. Use
`--agent-binary` for a version manager or a checkout, `--agent-budget` to stop
a turn once it has spent that much USD.

## CLI

```sh
nightloom --provider gemini
nightloom --provider groq --thinking effort=low
nightloom --provider openai-chat --base-url http://localhost:11434/v1 --model llama3.3

nightloom sessions              # list logs, by name
nightloom sessions borrow       # ones whose conversation mentions it
nightloom --continue            # resume the most recent
nightloom --resume 3f2a         # resume by id prefix
nightloom sessions --delete 3f2a
```

| flag | |
| --- | --- |
| `--provider` `--model` `--base-url` | which endpoint |
| `--thinking` `--max-tokens` | reasoning control (default 8192 tokens) |
| `--tools` | built-ins: files, shell, search, web, subagents |
| `--no-approval` (`--yolo`) | run tool calls without asking |
| `--self-compact` | also offer `compact_context` |
| `--no-web` `--no-review` `--no-mcp` | withhold a tool group |
| `--no-knowledge` | withhold the vault — the `@kb` tree and its index |
| `--bare` `--no-sidecar` `--system` | preamble and per-turn status block |
| `--once` | one prompt, print the reply, exit |
| `--resume` `--continue` `--log-dir` `--no-log` | session logs |
| `--agent` `--agent-binary` `--agent-budget` | the Claude Code engine |

REPL: `/new`, `/compact`, `/quit`, `/name [text]`, `/rewind [n]`,
`/context [drop|keep <n>…]`.

- **`/rewind`** — every user message is a checkpoint, because you find out
  which turn you wanted back *after* the turn that spoiled it. Nothing is
  deleted. Files a tool wrote are not reverted, and the CLI says so first.
- **`/context`** itemizes what the next request carries, largest first, with a
  size and the log event behind each item. `drop` removes an item's *content*
  only, so it can't produce a request a provider rejects.
- **`/name`** renames the session. Names are written once, by a model, from
  the first exchange alone.

Ctrl-C cancels the turn and reaches a tool already in flight — an interrupted
`bash` kills what it started. The round still finishes and still records a
result for every call it made, since a `tool_use` with no `tool_result` is
invalid on replay against every provider.

## Tools

`--tools` enables `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`,
`grep`, `bash`, `current_time`, `todo_write`, `remember`, `web_fetch`,
`web_search`, `task` (subagents) and `review` (a second opinion from another
vendor). `--self-compact` adds `compact_context`.

Every tool declares an `Effect` — `ReadOnly`, `Session` or `Mutating` — and
**the default is `Mutating`**. Anything mutating asks first:

```
bash(command: "rm -rf build")
[y] allow  [a] always allow bash  [n] deny
```

Anything else you type becomes the denial reason, handed to the model
verbatim — a denial is a message, not an abort, so the model can try something
else instead of repeating the identical call.

Path-taking tools resolve against a workspace root and refuse anything outside
it, checked lexically *and* by canonicalizing the deepest existing ancestor so
a symlink can't point out. It's a guard rail, not a sandbox: `bash` isn't
confined at all, only its working directory is set.

**The web tools are `Mutating` too.** Every other read here is confined by a
workspace root, and there is no root for a network — so a person seeing the
URL before it is sent is the only containment available. `web_search` needs
one of `TAVILY_API_KEY`, `BRAVE_API_KEY` or `EXA_API_KEY` and isn't offered
without one.

**Subagents** (`task`) run a focused instruction in a nested chat and return
only their final message. The point isn't parallelism, it's *forgetting* — a
question costing twenty file reads and one sentence to answer shouldn't spend
the parent's window on the nineteen intermediate results. Subagents inherit
the parent's cancellation token and approval policy, so they can't be a door
beside the gate.

## MCP

Servers go in `.nightloom/mcp.json` or `~/.nightloom/mcp.json`, using the same
`mcpServers` shape other hosts use — so an existing config copies across
unchanged. They start with `--tools`; `--no-mcp` opts out.

```json
{
  "mcpServers": {
    "files":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/some/dir"] },
    "remote": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${SOME_TOKEN}" } }
  }
}
```

A `command` means stdio, a `url` means Streamable HTTP. An **unset** `${VAR}`
fails that server with one line rather than sending an empty token. A server
that fails to start costs one line and takes nothing else down. MCP tools are
always `Mutating` — a server wanting past the gate would only have to name its
tool `read_something`.

## Projects and the docspace

A **project is not a folder.** It has an id and a name of its own and *may*
point at a working directory. So renaming or moving a folder stops orphaning a
year of chats, two projects can share one folder, and a project can have no
folder at all.

```text
<workspace>/AGENTS.md                  instructions  (yours, usually committed)
<workspace>/.agents/                   the docspace  (yours, committable)
~/.nightloom/knowledge/                the vault     (yours, repointable)
~/.nightloom/projects/<id>/sessions/   the chats
```

Config in the folder, data in the home — about the code / about you. Notes
describe the codebase so they sit with it, reachable by a plain relative path
because `.agents` is inside the tree the file tools are already rooted at.
Chats are personal history, and a repository is not the place for them.

So shared knowledge between chats needs no database and no retrieval layer,
just a directory the model can read and write. Notes reach it as an **index**
— names, sizes, first headings — never as content.

`NIGHTLOOM_HOME` moves the home. The CLI reads the registry to find the
project registered on the folder it was run in, so `nightloom --continue`
resumes the conversation the desktop app was having there.

### The knowledge vault

The docspace is about the code in front of you. The **vault** is about you —
what stays true after this folder is closed: a decision made two projects
ago, a person, a technique. One vault, the same in every project *and in a
chat with no project at all*, which is the case the docspace can never serve.

It is a plain folder of markdown, reached by the same file tools as
everything else under the alias `@kb/<name>` — no database, no retrieval
layer, no new tool. `[[wikilinks]]` resolve by Obsidian's rule (path, else
unique basename; ambiguity reported, never guessed), so pointing it at an
existing Obsidian vault works as-is:

```sh
nightloom knowledge                          # where it is
nightloom knowledge --set ~/Documents/Vault  # e.g. an Obsidian vault
nightloom knowledge --reset                  # back to ~/.nightloom/knowledge
```

Repointing writes a path and moves nothing. The model gets an **index** —
grouped by folder with exact counts, never contents — and a bare `grep`
still searches the workspace only, so reaching into the vault is always
explicit. The desktop lists both stores in the Notes panel, renders links
and backlinks, and draws the link graph; the CLI names the vault at startup
and `--no-knowledge` withholds it for one run.

### Remembering and dreaming

During any chat the model can `remember` — one observation, appended to
`~/.nightloom/observations.jsonl` with a timestamp and a provenance type
(the user said it / the model inferred it / it came from fetched content).
Nothing reads that inbox back into a conversation; it is evidence, not
memory.

```sh
nightloom dream --dry-run   # what's pending; spends nothing
nightloom dream             # consolidate the inbox into the vault

# or let a compaction trigger it — the moment a conversation's detail is
# already being traded for a summary
nightloom --auto-dream --dream-target openrouter:deepseek/deepseek-v4-flash
```

The dream is the only writer of consolidated notes: it files each durable
observation into the note it belongs in, supersedes contradicted claims
(struck through with a date — never erased), links what relates, and steps
back for conclusions no single observation states. If the vault is a git
repository it commits before and after, so `git log -p` is the audit trail
and revert is free. The raw log is never pruned, a failed pass consumes
nothing, and fetched content is never promoted past attribution — that is
the poisoning defense. An unattended pass spends real money, so nothing
fires by default — the CLI names the backlog at startup and the desktop
badges its Dream button. Opting in (`--auto-dream`, or Settings → Knowledge
in the app) runs a pass after each compaction, and a dream-model override
lets a cheap model do it: in a six-model bench, DeepSeek v4 flash held
every consolidation rule at about $0.002 a pass.

### Importing from claude.ai

Settings → Privacy → Export Data gets you a zip. It's the only way in — there
is no Projects API.

```sh
nightloom import claude-export.zip --list     # what it holds; writes nothing
nightloom import claude-export.zip
nightloom import claude-export.zip --only thesis --unfiled
nightloom import claude-export.zip --into ~/claude   # also give them folders
```

Projects become projects, `prompt_template` becomes `AGENTS.md`, docs become
the docspace, conversations become session logs. Re-importing adds the chats
you've had since rather than a second copy of everything, and nothing already
on disk is overwritten. A conversation is linked to a project by id or not at
all — matching by name similarity would file a chat under the wrong project,
whose notes then land in its system prompt.

## Desktop app

```sh
npm install --prefix apps/desktop        # once (Node 20+)
cargo install tauri-cli --version "^2"   # once
cargo tauri dev                          # works from the repo root
cargo tauri build                        # installer bundle
```

Streaming chat with collapsible thinking, tool chips, inline approval prompts,
math rendering (all four TeX delimiters, guarded so `$5` stays money), and
image or PDF attachments by paste or drop. Projects on the left with a
Chats/Notes tab strip; a right-hand rail holds the connection knobs, the
model's task list, and a context panel that itemizes the wire with a
remove/restore button per block. Settings manages per-provider keys, live
model lists, and a prompt library. The rail's Provider / Claude Code switch
runs the same agent engine the CLI does.

Unfiled chats go to `~/.nightloom/unfiled/` — the quickest useful thing the
app does is answer a question that has nothing to do with any directory.

## Probe and eval

Different questions, both cheap. An adapter can stream flawlessly while the
model never edits the right file.

**Probe** — a streaming health check across a (provider, model) matrix: TTFT,
thinking/text delta counts, usage accounting, stop reasons, an answer check
and an optional two-leg tool round-trip. Reach for it when adding or debugging
an adapter.

```sh
nightloom probe
nightloom probe --runs 3 --target anthropic:claude-sonnet-5:effort=high
```

**Eval** — gives a model a throwaway workspace, the built-in tools and an
instruction, then inspects the disk. Every agentic task carries a trap: a
decommissioned file with the same phrase, a config that must survive an
in-place edit, a symbol that must *not* be renamed, a file that doesn't exist
and must not be invented. Three further tasks grade the recorded call *trace*
instead — three files read in one batch and three read one after another leave
a workspace identical in every byte.

```sh
nightloom eval
nightloom eval --target groq:openai/gpt-oss-120b --task rename-across-files --runs 5
```

Tasks: `find-fact`, `fix-value`, `rename-across-files`, `absent-file`,
`one-call`, `three-sequential`, `three-parallel`. `runs` defaults to 3 — these
are sampled systems, and the interesting number is a pass rate.

Reach for `eval` when changing the turn engine, the tools or their
descriptions. It's the only check that exercises a whole tool loop against a
real model, and it's what caught a round cap that had been silently truncating
ordinary work.

## Layout

Strict dependency direction: `nightloom-core` ← {`nightloom-providers`,
`nightloom-mcp`} ← `nightloom-service` ← `nightloom-evals` ←
`nightloom-cli`. The desktop app sits on `nightloom-service` only.

| crate | |
| --- | --- |
| `nightloom-core` | canonical types only — messages, the `Provider` and `Tool` traits, layered prompts, the session log and its projections. No HTTP, no vendors, no UI. |
| `nightloom-providers` | one module per wire format, all SSE; plus the model, context-limit and pricing tables and a retry decorator. |
| `nightloom-mcp` | an MCP client over stdio or Streamable HTTP. |
| `nightloom-service` | the shell-agnostic engine: streaming tool loop, cancellation, approval, subagents, compaction, built-in tools, projects. |
| `nightloom-evals` | the probe and the agentic task suite. |
| `nightloom-cli` | the `nightloom` binary. |
| `apps/desktop` | Tauri 2 + Svelte 5. |

## Development

```sh
cargo test --workspace          # ~535 tests, no network
cargo clippy --workspace
cargo fmt
npm run check --prefix apps/desktop
```

Tests are inline `#[cfg(test)] mod tests` at the bottom of the module they
cover; there is no `tests/` directory. Nothing talks to a provider — adapter
tests assert on the request body the adapter builds, and engine tests drive
the turn loop against scripted providers. CI runs the same commands on Linux
and Windows. `probe` and `eval` are deliberately not in CI: both spend money
against a real model.

`docs/` is the long-form architecture reference — why each boundary is
where it is, and what went wrong before it moved there — one file per area,
indexed by `CLAUDE.md`. `AGENTS.md` is the short orientation over both.

## License

MIT.
