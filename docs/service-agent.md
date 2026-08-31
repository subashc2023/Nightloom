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
