# nightloom-service — driving a signed-in CLI instead of an API (`agent/`)

`ClaudeCodeAgent` runs `claude -p --output-format stream-json` and translates its
NDJSON into `TurnEvent`, so a turn is billed to a Claude subscription rather than
an API key.

## Why it is not a `Provider`

Deliberately **not** a `Provider`, and that is the whole design rather than a
limitation worked around.

`Provider` is a stateless request for a completion whose `StreamEvent::ToolUse`
is an *unexecuted* call the engine then runs through the approval gate and
`Effect` scheduling. Claude Code is the other half of that contract already — it
owns the loop, runs its own tools, keeps its own history, and never emits a call
for anyone else to run.

Wrapping it as an adapter leaves two options and no middle: advertise no tools at
all, or re-expose Nightloom's over `--mcp-config` and let its loop replace
`run_turn`, at which point the gate, the sidecar and `max_rounds` are all still
being assembled and none of them are running.

So the seam is one level up. `TurnEvent` is what both shells already render, and
the dialects map almost one-to-one — `stream_event` deltas to `TextDelta` /
`ThinkingDelta`, `assistant` `tool_use` blocks to `ToolCall`, `user`
`tool_result` blocks to `ToolResult`. That makes this a **second engine behind
the same event stream** rather than a sixth adapter under the first one. What it
buys is both renderers unchanged; what it costs is `turn.rs`, since Claude Code
has its own version of everything in it.

## Four load-bearing details, each measured

**`ANTHROPIC_API_KEY` is removed from the child's environment**
(`use_subscription`, on by default). The CLI silently prefers a key over the
subscription whenever one is set, so an inherited environment bills the API for
every turn and nothing in the output says so — the exact cost the module exists
to avoid.

**`--safe-mode`, never `--bare`.** They read as the same flag and are opposites
here: bare mode "never reads OAuth credentials or the system keychain" and forces
the run back onto a key, where safe mode drops only the host's `CLAUDE.md`,
hooks, plugins and MCP servers and leaves auth working.

Safe mode additionally emits **`--strict-mcp-config`**, which reads as redundant
against its own help text and is belt-and-braces on purpose. Reported on macOS,
safe mode dropped the local MCP servers and left the account-level claude.ai
connectors on the request, so a child asked to read a workspace file called
`mcp__claude_ai_Google_Drive__search_files` and then said it had no `Read` tool —
not a missing capability but a *substituted* one, which fails looking like a
stupid model rather than a wrong tool set. `--strict-mcp-config` is "only servers
from `--mcp-config`", and none is supplied, so it is the documented spelling of
what safe mode already promised. Verified accepted and non-regressive; the
failure itself does not reproduce on Windows, where safe mode alone already
reports `mcp_servers: []` on a machine carrying both a user-level `mcpServers`
entry and `claudeAiMcpEverConnected`.

**Usage is re-normalized.** The CLI passes Anthropic's accounting through
untouched, so `input_tokens` arrives exclusive of cache traffic and has to be
summed the way `anthropic.rs` sums it, or a cached prompt reads near-empty on
exactly the turn the gauge matters. The `result` line repeats the turn's totals
that `message_delta` already reported per round, so reading both doubles every
figure.

A `rate_limit_event` appears only on an OAuth run, which makes its presence the
one honest signal that a turn was billed to the plan. The dollar total is the
CLI's own estimate of what the same turn *would* have cost on the API and is
rendered saying so, never as a bill.

**Finding the binary is not `Command::new` alone** (`resolve_binary`,
`searched_locations`). A GUI process on macOS is started by launchd with a
minimal `PATH` and never sources a login shell, and Claude Code's own installer
puts the binary in `~/.local/bin` — so the desktop's default `claude` resolved
for no macOS user who installed it the documented way, while the identical
default worked from a terminal.

`PATH` still wins whenever it resolves, and that ordering is load-bearing rather
than tidiness: a version manager's `PATH` entry is the correct one and may sit
beside a stale `~/.local/bin` install, so preferring the candidate list would
silently run the wrong binary — a worse failure than the one being fixed, because
it succeeds.

Resolving through a **login shell** is the general answer and is deliberately
refused: it covers version managers this list cannot, and it runs the user's whole
startup configuration on the connect path, where it can be slow and can hang on a
broken rc file — trading a reliable connect for a case that already has a working
answer in `AgentSpec::binary` taking an absolute path. The fallback is
`#[cfg(unix)]` because that is where the bug is: a Windows GUI process inherits
the machine and user `PATH` from the registry, so probing Unix directories there
would be theatre, and `Command`'s own `PATHEXT` resolution is left exactly as it
was.

A "not found" names every place it looked, and the desktop reports the
**resolved** path in `AgentInfo.binary` so the rail shows which binary answered
rather than the name it was asked for — the two differ exactly when the fallback
did something.

## What `--append-system-prompt` carries

Three parts, in this order, joined by blank lines (`prompt::agent_preamble`,
2026-09-14):

1. **Nightloom's preamble**, minus identity and environment. The same layers
   `assemble` builds for the API engine — the user's `~/.nightloom/AGENTS.md`,
   every `AGENTS.md` on the walk to the workspace, the project's notes index,
   the vault's index — but never `DEFAULT_IDENTITY` or the `<environment>`
   block: Claude Code has an identity of its own and knows its cwd, and a
   second copy of either would contradict the first rather than refine it.
   Before this the engine got none of it, so a chat there started knowing
   nothing a chat on the other engine knows.
2. **An engine note.** Those segments name Nightloom's tools (`read_file`,
   `write_file`, `edit_file`) and the vault by its `@kb/` alias, and neither
   exists here. Rather than a second wording of every segment per engine, one
   short `<engine-note>` follows them: the file tools are `Read`, `Write` and
   `Edit`, and `@kb` stands for the vault's real directory, so `@kb/<name>` is
   `<vault>/<name>` and `[[name]]` is `@kb/<name>.md`. Emitted only when there
   is a preamble to gloss, and names the vault only when there is one. When it
   does, the note also asks for the dream's discipline — amend, strike through
   with a date, never rewrite a note whole — because a chat is not given the
   dream's instruction and the vault is git-snapshotted only by dreams.

   Naming the vault is not enough to make it readable: the CLI routes a path
   outside its working directories to approval, and headless that is the
   classifier, whose refusal simply does not run. So the same vault directory
   goes on the command line as `--add-dir` (`AgentSpec::add_dirs`), which the
   permissions reference says makes its files "readable without prompts" with
   edits following the permission mode (`external`, fetched 2026-09-14). The
   grant rides the knowledge switch with the index: off, and neither the index
   nor the directory is sent.
3. **The library prompt** (the rail's system-prompt dropdown), last, so it wins
   by position the way the `custom` layer does on the API engine's ladder.

The flag is omitted altogether when all three are empty. The desktop's rail
gates the first two on its Preamble switch, on by default and now shown on both
engines; the CLI (`nightloom-cli/src/agent.rs`) still sends only `--system`.

**A changed preamble does not necessarily reach a resumed session.** The docs
say (`external`, code.claude.com/docs/en/cli-reference, "System prompt flags in
resumed conversations", 2026-09-14) that Claude Code "builds the system prompt
once, on a conversation's first request ... and records it in the session", that
"every later request uses that recorded prompt, including after you return to
the conversation with `--resume`", and that different flag text "takes effect
once the conversation is compacted or when you start a new conversation" —
unless `--system-prompt-snapshot off` is passed. They add that before v2.1.265
"passing any of the system prompt flags also turned recording off". Measured on
CLI 2.1.263: a resumed session asked what its system prompt said answered with
the *new* text (recording off, as the docs say for that version), and the same
experiment with `--system-prompt-snapshot on` on both launches answered with the
*first* text. So on the CLI this was built against, a note written mid-chat is
in the index of the next turn; on 2.1.265 or later it is in the index of the
next *conversation*, which is the same rule the API engine already lives by
(the index is assembled once per `Chat`). Nothing here passes
`--system-prompt-snapshot`; see the report for the option.

## Translation

A pure function of the byte stream, tested against verbatim captured lines — the
same shape as the adapter tests that assert on request bodies. Two invisible
traps are covered: the reply arrives twice (as deltas, then as a whole `assistant`
block) and rendering both prints every answer twice, and a `tool_result` carries
no tool name, so the pairing has to be remembered from the call that opened it.

A line this build cannot parse costs that line and nothing else, on
`SessionEvent::Unknown`'s argument: it is another process's output on its own
release cadence.

Subagent messages carry `parent_tool_use_id` and their calls render marked
(`sub:Read`) rather than hidden or bare — watching a subagent work is most of what
its progress is, but a nested `Read` shown plainly claims the main thread did it.

## `agent/record.rs`

Both shells drive the agent and need different things from it: a REPL runs turns
one after another, a window switches between chats. So `follow_on` (move forward)
is joined by `set_resume` (point somewhere, or nowhere) and by a `Recorder` that
writes an agent turn into a `Session` — see **External agents** in
[core.md](core.md) for why a log that is never replayed is still worth keeping.

`resolved_model()` is the snapshot the CLI last resolved an alias to, kept
**beside** the spec rather than written into it: the spec holds what to *ask* for
next turn, and pinning yesterday's snapshot into the request would quietly stop
following the alias the user chose.

## The line this must never cross

**Nothing here may ever be extended into replaying the CLI's OAuth token onto a
request of our own.** Anthropic's terms scope OAuth to "ordinary use of Claude
Code and other native Anthropic applications" and say developers "should use API
key authentication", so driving the signed-in binary is the supported shape and
lifting its credential is the prohibited one.
