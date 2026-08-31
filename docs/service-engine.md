# nightloom-service — the turn engine

`nightloom-service` is the shell-agnostic conversation engine. This file covers
`turn.rs` and the pieces that hang directly off `Chat`. See also
[service-prompt.md](service-prompt.md), [service-tools.md](service-tools.md),
[service-data.md](service-data.md), [service-agent.md](service-agent.md).

## `turn.rs`

`Chat` (provider + model + system / thinking / max_tokens / tools / max_rounds)
with `run_turn(session, input, cancel, on_event)` — the streaming tool loop.
It is by far the largest module in the workspace, and it owns every invariant a
shell must not reimplement.

`system` is a `SystemPrompt` and `sidecar` defaults to
`sidecar::default_parts()`. The sidecar is composed every round but only lands
on round one, since the projection declines a tool-result tail. After each
round's tool calls the engine drains `Tool::drain_events()` into the log, which
closes the task-list loop: the model writes it, the log keeps it, the next
turn's sidecar reads it back. `compact` runs deliberately bare — no preamble, no
sidecar.

`run_turn` takes `impl Into<TurnInput>`, so a `&str` call reads as it always did
and attachments are the case that has to say so.

### Events out

Progress streams through a serializable `TurnEvent` callback (`TextDelta` /
`ThinkingDelta` / `RedactedThinking` / `ToolCall` / `ToolResult` / `RoundLimit`
/ `Usage` / `Compacted`, `#[non_exhaustive]`).

`Usage` carries the **round's** accounting, not the turn total: the total counts
the cached prefix once per round, so a gauge fed from it races past the window
while the real context sits half empty.

### Invariants the engine owns

- stream-order block assembly (signed and empty thinking included);
- tool execution with results recorded even on the final round;
- cancellation and error paths recording partial replies with pending
  `tool_use` blocks stripped;
- the empty-text-block rule;
- a **cancellation check at the top of each round**. `tokio::select!` alone is
  not enough: both its branches are ready, and a fast stream can win every coin
  flip and carry a round — and any compaction it requested — to completion after
  the user interrupted.

Interruption arrives as a `tokio_util` `CancellationToken`.

### Consent is serial, execution overlaps adjacent reads

A round's calls are settled for consent **sequentially** and then executed with
*adjacent read-only calls overlapping* (`plan_round` / `execute` /
`drain_batch`). Consent stays serial because three approval prompts at once have
no sensible rendering, and the user should see the calls in the order the model
asked.

**Adjacency is the load-bearing half.** Hoisting every read to the front of the
round would be faster still and would let a read see a file as it was before a
write *in the same round* — turning a slow answer into a wrong one.

Mutating calls run alone because the two failures are not symmetric: two
`edit_file` calls racing on one file silently lose an edit, where run one after
the other the second fails loudly with an `old_string` that no longer matches,
which the model can act on.

Results are announced and recorded in **call order** regardless of what finished
first (Gemini pairs function responses by position). MCP tools are therefore
serial, being `Mutating` by classification — the honest cost of not adding a
second axis every future tool would have to answer.

Unit-tested against scripted mock providers, including a tool that records peak
concurrency.

### Approval

`Chat.approver: Option<Arc<dyn Approver>>` gates execution; `None` means allow
everything, deliberately, so the CLI, the probe and any embedder keep today's
behaviour.

Approval is asked on every round including the last. A denial emits
`TurnEvent::ToolDenied` *instead of* `ToolResult` on the wire — nothing ran, so
a result event would be a lie — while the log still records the result. Shells
with a live buffer must close the pending call on `ToolDenied`, or it renders as
stuck until the next transcript re-sync.

### Compaction on demand

`Chat::compact(session, cancel)` asks the model for a briefing-style summary (no
thinking, no tools) and records it as a `Compaction` event. Nothing is recorded
on cancel or error, and it refuses a session with no completed exchanges.

## `approval.rs`

`Approver` / `PendingCall` / `Decision { Allow, AllowAlways, Deny(reason) }`,
plus `AutoApprove` — the policy every shell should reuse rather than re-derive.
It answers `ReadOnly` and `Session` calls itself, delegates only `Mutating`
ones, and remembers `AllowAlways` per tool name.

**The instance must outlive a re-connect**: the desktop rail re-connects on
every knob change, and rebuilding the policy there silently forgets every grant
the user made.

A denial is **a message to the model, not an abort** — recorded as an `is_error`
`ToolResult` (a `tool_use` with no matching result is invalid on replay) and the
turn continues, so a typed reason is what lets the model try something else
instead of repeating the identical call. Denial strings are prompt text, like
tool descriptions.

## Model-initiated compaction (`tools/compact.rs`)

`Chat::enable_self_compaction()` hands the model a `compact_context` tool and
honours what it asks for.

The tool cannot do the work itself: summarizing is a provider call, and
recursing into the model from inside an open turn would interleave two streams
over one session and rewrite the history the current turn is still reading. So
it only raises a `CompactSignal`, and `run_turn` acts on it at the **turn
boundary**, after the reply is complete.

The request is taken (cleared) whether or not it fires, so a compaction asked
for during a turn that then failed cannot go off at the end of the *next* one. A
failed summarization leaves the session untouched and does not fail the turn —
the model is advised again next turn, and losing the reply over it would not be
self-correcting.

Enabling it is one call rather than a tool a shell can push on its own, because
the tool and the engine each hold half of it: a `CompactContext` whose signal
nothing reads would accept every request and perform none.

**Opt-in in both shells** (`--self-compact`, the rail's sixth switch) rather than
part of the tool set, which is where it started. Every other built-in acts on
the workspace and this one acts on the conversation; a compaction supersedes
everything before it, and the model's judgement about when the context is worth
trading for a summary is not the same judgement as whether it may edit a file.
Both shells still compact on demand (`/compact`, the button above the
transcript), which is what makes off a usable default rather than a corner the
user has to climb out of.

## Session titles

`Chat::title(session, cancel)` names a session and records a `Title` event;
`Chat::enable_titles()` makes `run_turn` do it at the turn boundary, next to
where a requested compaction settles, for any session with a completed exchange
and no name.

It names from the **first exchange only** — two clipped excerpts and the
instruction, never the conversation so far. A title answers "which chat was
that", a question already settled once the model has replied once; titling from
the full history would cost more every turn it fired and would make the name
depend on when it ran rather than on what the conversation is.

Opt-in for the same reason `enable_self_compaction` is: the caller pays, and
switching it on for everybody would put a second provider call at the end of
every eval workspace and every probe. It is called on the shell's own chat
rather than inside a `build_chat`, since a subagent's session is in-memory and
will never appear in anyone's list.

Failures are silent — the session stays nameless and is tried again next turn,
which also means a log written before any of this existed gets a name the first
time it is picked up.

## Smaller pieces

- **`Chat::context_view(&session)`** builds a `WireView` from the same three
  pieces `run_turn` assembles — the preamble, the projection, and a freshly
  rendered sidecar — rather than from a description of them. A view that
  reimplemented the assembly would be a second thing to keep in step with the
  engine, and it would drift in exactly the places worth looking at, since those
  are the places the engine is doing something non-obvious.
- **`Chat.price`** is the pricing-table sibling of `context_limit`: set it and
  every recorded exchange carries its cost; leave it `None` and cost goes
  unrecorded rather than recorded as zero. `run_turn` costs each **round** on
  that round's usage, matching how a tool loop is actually billed.
- **`mcp`** re-exports `nightloom-mcp` rather than wrapping it: a shell needs the
  config type to discover servers and the report type to say which failed, and
  nothing in between that this crate could usefully add. MCP tools land in
  `chat.tools` beside the built-ins and are subject to the same approval gate —
  verified live, a denied MCP call came back with the user's typed reason and the
  model picked a different argument.
