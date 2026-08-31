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
the decision.

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

## `agent.rs` — the `--agent claude-code` REPL

It maps the flags the chat REPL already takes onto an `AgentSpec` (`--model`,
`--tools`, `--no-approval`, `--once`, and `--bare` as safe mode) and renders
through `chat::render` unchanged — which is the point: the terminal cannot tell
which engine produced a turn. `--agent-binary` and `--agent-budget` are its own.

Headless has no way to ask, so `--tools` maps to `--permission-mode dontAsk` and
`--no-approval` to `bypassPermissions`, and the startup lines say that
Nightloom's approval prompt does not apply here rather than letting the familiar
flag imply the familiar gate.

Turns chain by carrying Claude Code's session id into the next `--resume`, since
the history lives there and resuming is the only way to have a conversation at
all.
