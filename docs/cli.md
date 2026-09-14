# nightloom-cli

`chat.rs` is a terminal renderer over `nightloom-service`: it maps `TurnEvent`s
to stdout (dim thinking, tool chips) and wires Ctrl-C to the turn's
`CancellationToken`. **All loop and recording semantics live in the service** — a
shell that seems to need its own loop logic is a sign something belongs in
`turn.rs`.

## The REPL

Commands: `/new`, `/compact` (Ctrl-C cancellable), `/quit`, plus `/context`,
`/name` and `/rewind` below. `--resume` / `--continue` reopen a log.

The end-of-session line reports cache hit rate and cost, prefixed "at least" when
some exchange was unpriced.

### `/context`

Itemizes the next request largest-first. `/context drop <n>…` removes an item's
content and `/context keep <n>…` restores it — numbered by **event index**, the
opposite of `/rewind` and for the opposite reason: a checkpoint list is filtered,
so an index there would point at something the user never saw, while this list
*is* the context and the index is the handle `drop` needs. Several rows sharing
an index is the honest rendering, since an assistant turn that thought and then
called a tool is one event.

### `/rewind`

Lists the turns the session can be rewound to; `/rewind <n>` rewinds to one —
numbered in display order rather than by event index, since the index counts
assistant messages and tool results the user never sees.

### `/name`

Shows the session's name; `/name <text>` changes it. The escape hatch the
generated one needs: a name is written once from the first exchange, and a long
conversation that has moved on keeps describing where it started. Re-naming
automatically would mean paying a model call on a guess about when a chat has
drifted — a judgement the user can make and the engine cannot.

## Flags

- `--tools` enables the built-ins, rooted at cwd, so `.agents` there is the
  docspace.
- `--self-compact` additionally offers `compact_context`.
- `--bare` drops the preamble; `--no-sidecar` drops the per-turn status block.
- `--no-approval` (alias `--yolo`) runs mutating tools unattended.
- `--no-review` withholds the `review` tool. Which reviewers it offers is
  `tools::bench`'s decision, not the CLI's.
- `--no-web` withholds `web_fetch` / `web_search`. A startup line names the
  search backend that will answer, or the three env vars that would supply one —
  said out loud because the failure is otherwise invisible: a model with no
  `web_search` has no way to report that it has none, and simply guesses instead.
- `--no-knowledge` withholds the vault (the `@kb` tree and its index) and turns
  the memory system off whole, inbox included. A flag of its own rather than one
  riding on `--tools`, because turning tools on has always meant "may write
  inside this folder" and the vault is a second directory outside it. A startup
  line names it for two reasons the user cannot otherwise see: that the reach has
  widened, and that a *repointed* vault is invisible from here — a model quietly
  reading the wrong folder looks exactly like a model that has forgotten
  everything.
- `--no-mcp` opts out of MCP. Servers otherwise start at launch when `--tools` is
  on and a config exists, one line per server on stderr.

The `review` sub-chat is deliberately rooted at the workspace **without** the
vault: a reviewer runs on a second vendor, the vault is the user's personal
knowledge, and "no reason to read it" is the wrong guarantee when not handing it
over at all is available.

With approval on, a mutating call prompts `[y] allow [a] always allow <tool> [n]
deny`. Anything else typed becomes the denial reason handed to the model, and EOF
denies.

## Subcommands

**`sessions.rs`** prints `store::list` (by name, falling back to the opening
message), takes a positional query for `store::search` — which swaps the turns
column for a hit count and prints the matching excerpt under each row — and
handles `--delete <prefix>`. The REPL turns on titles and says so once; the
`--once` path deliberately does not, since a single answer to a single question
should not pay twice to label a log nobody is coming back to.

**`import.rs`** is the claude.ai export importer's shell. `--list` says what the
archive holds and writes nothing, worth having separately because the archive is
opaque, arrives by email and is usually enormous. Imported projects go into the
registry as a matter of course — the id is what decides where the chats were
written, so it cannot be optional — and `--no-register` therefore *removes* the
entries afterwards rather than skipping them, which leaves the chats on disk with
nothing listing them and says so. `--into` is optional and normally omitted;
without it the imported projects have no folder.

**`keys.rs`** is the credential store from the terminal — not a wrapper over a
desktop feature but the other half of sharing one, since a CLI-only user has no
way to *populate* the store otherwise. Providers and search backends share one
namespace on the command line because they share one from the user's point of
view. The key is read from stdin or a prompt and **never from argv**, which would
put it in shell history and in `ps`.

**`knowledge.rs`** is the vault's location from the terminal (`nightloom
knowledge`, `--set <dir>`, `--reset`), and exists on exactly `keys.rs`'s
argument: the desktop has a Settings pane for it and a terminal user has none, so
without the command the vault could only ever be the default for anyone who never
opens the app.

**`dream.rs`** is the consolidation pass from the terminal (`nightloom dream`,
`--dry-run` to print the pending batch and spend nothing): connect a provider,
wire Ctrl-C, render through `chat::render`, report. Everything that decides what
a dream may touch lives in `service::dream`, where the enforcement sits next to
the decision — including, since 2026-09-14, the split of the batch by project:
observations recorded in a registered project go to
`<workspace>/.agents/memory/`, the rest to the vault, one turn each. The report
line reads *consolidated 5 observations — 3 into Lanternfish, 2 into the vault*,
followed by one rollback line per folder (a workspace is committed only if it is
a repository, and only its `.agents/`). Since 2026-09-14 a turn may also
*propose* a replacement for the target's always-loaded file — the project's
`AGENTS.md`, or `~/.nightloom/AGENTS.md` for the vault — and the CLI then
prints *proposed a change to Lanternfish's instructions — review it under
Notes in the app* (`dream::proposed_line`, the same clause the desktop toast
uses). The file is never written by the pass: the proposal sits under the
store's `proposals/` and is applied only through the desktop editor, as a
draft the user saves (see [service-data.md](service-data.md), *Proposals*).

**`capture.rs`** is the pass that fills the inbox the dream drains (`nightloom
capture`, `--dry-run` to print the would-be observations and append nothing —
the provider is still called): it reads every session log since its watermark
(each registered project's chats and the unfiled ones), folds the new
conversation text — never a tool result — into excerpts, and asks the model
for observations one per line, `kind | text`. The same provider flags as
`dream`; the same thin shell — connect, Ctrl-C, render, report. The report
line reads *captured 4 observations from 3 chats (1 line skipped) — 3 from
Lanternfish, 1 unfiled*, then how many chats are waiting for more turns and
how many the turn cap left for the next run. Everything that decides what is
read and when a log's watermark moves lives in `service::capture`; the
mechanics are in [service-data.md](service-data.md) under *Capture*.
`--auto-dream` is unchanged and runs the dream alone.

A startup line names the pending observation count when there is one — the nudge
that makes dreaming periodic without making it automatic, since an unattended
pass spends real money. `--auto-dream` is the opt-in automation: a compaction
that lands (either path) runs `dream::consolidate` — the same function the
subcommand calls, so the two cannot drift — on `--dream-target
provider[:model]`, defaulting to the chat's own. The target is validated at
launch and named in a startup line, and a failed pass costs a stderr line, never
the REPL.

**`probe.rs`** is the matrix runner (`--target
provider:model:thinking-spec[:tools]`).

**`mcp_serve.rs`** is `nightloom mcp-serve [--project <id>]`: Nightloom's own
tools — `search_chats`, `read_chat`, `remember`, `fetch_page` — as an MCP server
on stdin and stdout, for `claude -p --mcp-config` on the Claude Code engine.
Hidden from `--help`, because nothing about it is for a person: run by hand it
prints nothing and waits for JSON-RPC. The config dir and the two streams are
all it supplies; the tools, the framing and the errors are
`nightloom_service::mcp_server` ([mcp.md](mcp.md), *The server*). The desktop
binary carries the same server as `--mcp-serve`, which is the one the app
actually launches, since the CLI is usually not on PATH.

## `agent.rs` — the `--agent claude-code` REPL

It maps the flags the chat REPL already takes onto an `AgentSpec` (`--model`,
`--tools`, `--no-approval`, `--once`, and `--bare` as safe mode) and renders
through `chat::render` unchanged — which is the point: the terminal cannot tell
which engine produced a turn. `--agent-binary` and `--agent-budget` are its own.

Headless has no way to ask, so `--tools` maps to `--permission-mode auto` (the
CLI's classifier decides; what it cannot approve is denied, never left waiting —
~~`dontAsk`~~ until 2026-09-14) and `--no-approval` to `bypassPermissions`, and the startup lines say that
Nightloom's approval prompt does not apply here rather than letting the familiar
flag imply the familiar gate.

Turns chain by carrying Claude Code's session id into the next `--resume`, since
the history lives there and resuming is the only way to have a conversation at
all.
