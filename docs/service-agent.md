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

~~and none is supplied~~ — since 2026-09-14 one is: with tools on, the desktop
passes `--mcp-config` with an inline JSON naming its own binary
(`current_exe() --mcp-serve --project <id>`, `AgentSpec::mcp_config`), so the
engine gets Nightloom's `search_chats`, `read_chat`, `remember` and
`fetch_page` as `mcp__nightloom__*` (nightshift backlog 046; the server is
`mcp_server.rs`, documented in mcp.md). ~~Under safe mode `--strict-mcp-config`
now means *this server and no other*, which is what safe mode wants.~~ —
**Wrong, measured 2026-09-14 (nightshift 046 pass 2, blocker 058):** CLI
2.1.263's `--safe-mode` discards `--mcp-config` servers as well as the host's,
so its `system/init` reports `mcp_servers: []` and a safe-mode chat has
**none** of Nightloom's tools; without `--safe-mode` the same command lists
`nightloom: connected`. `--strict-mcp-config` still rides along, harmless.
~~Until blocker 058 is answered, safe mode means "nothing of the host's and
nothing of Nightloom's beyond the preamble", and the Safe mode hint says so.~~
**Answered the same evening:** "what is the point of safe mode if it drops
Nightloom's stuff?" So safe mode is now spelled **`--setting-sources ""
--strict-mcp-config --disable-slash-commands`** and never `--safe-mode`.
Measured (the table is on `AgentSpec::safe_mode`): no setting sources drops
the user `CLAUDE.md`, both hook layers and the allowlist exactly as
`--safe-mode` did, and keeps the one server named by `--mcp-config`; both
spellings still load the *folder's* `CLAUDE.md`, whatever `--safe-mode`'s
help says, and under Nightloom that file is the project's own. Without the
allowlist the `auto` classifier judges each Nightloom call, as it did
before.
The engine note tells the model when to reach for each, by their full
`mcp__nightloom__` names (the CLI's `ToolSearch` resolves nothing shorter). The CLI's permission
system judges the calls like any other MCP tool; the allowlist line for
`~/.claude/settings.json` is `"mcp__nightloom__*"` under `permissions.allow`
(`search_chats` and `read_chat` are read-only, `remember` appends one inbox
line, `fetch_page` leaves the machine).

**Usage is re-normalized.** The CLI passes Anthropic's accounting through
untouched, so `input_tokens` arrives exclusive of cache traffic and has to be
summed the way `anthropic.rs` sums it, or a cached prompt reads near-empty on
exactly the turn the gauge matters. The `result` line repeats the turn's totals
that `message_delta` already reported per round, so reading both doubles every
figure.

**The cache lifetime is measured, and the split moves between lines**
(2026-09-15, nightshift backlog 063). One `claude -p` turn on 2.1.263 reported
`cache_creation: {ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens:
7619}` — **this engine writes its prompt cache with the one-hour lifetime**
(`record::CLAUDE_CODE_CACHE_TTL`; the API adapter's own requests get five
minutes, see [core.md](core.md) "Token accounting"). The CLI owns the request
and the `ttl` in it, so this is a fact about the CLI at that version and
nothing here can change it; a turn whose usage names a lifetime is believed
over the constant. Where the CLI puts the split depends on the line: at the
top of `usage` on the `assistant` and `result` lines and on `message_start`,
but on `message_delta` — the one line the translator reads usage from — it is
*only* inside `usage.iterations[]`, one entry per server-side iteration of the
round. `RawUsage` reads the top-level object when present and otherwise sums
the iterations; a line with neither is "not reported", not "nothing written".

Each round's `AssistantMessage` records when its request was sent and the
lifetime of the cache it left (`sent_at`, `cache_ttl`). The send time is as
near as this side of the pipe can know it: the turn's first request goes out
when the CLI is spawned, which is when the `Recorder` is built — build it
immediately before `run_turn` — and every later round is sent after the last
tool result of the round before it, so the time that result arrived is the
bound the recorder keeps. A lower bound, never an upper one: the desktop's
timer may run short, and short is the direction that never claims a cache the
API has already dropped.

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

## Incognito and ephemeral chats on this engine (2026-09-15)

A chat started as incognito or ephemeral (nightshift backlog 059; `ChatMode`
in [core.md](core.md)) writes nothing, and on this engine the CLI runs its own
tools, so the confinement is on the command line (`AgentSpec::apply_mode`):

- **`--tools Read Glob Grep WebFetch WebSearch`** (`READ_ONLY_TOOLS`) — a
  positive list, never `--disallowedTools`. Both were measured on 2.1.263 with
  one Haiku turn each, reading the `system/init` event's `tools`:
  `--disallowedTools Write Edit NotebookEdit Bash` did remove those four, and
  left `EnterWorktree`, `CronCreate`, `CronDelete` and `Task` in the list — a
  worktree and a cron job both write, and the next release can add more; the
  `--tools` spelling left exactly the five named. A deny-list drifts open; a
  positive list is default-closed, and `--tools` is already how the rail's
  "tools off" is spelled. The web stays: incognito is about *his* data, a
  fetch writes nothing on this machine, and egress keeps its own switch.
  `--tools` does not touch MCP tools, which is right — see the next point.
- **Nightloom's server is started with `--no-remember`** (`mcp_server::ServeArgs`),
  so `search_chats`, `read_chat` and `fetch_page` reach the model and
  `remember` does not; the `initialize` instructions drop the sentence about
  it. An incognito chat may read the other chats; it is the other chats that
  may not read it, and the two readers refuse such a chat on their own
  ([service-tools.md](service-tools.md) "Other chats").
- **Ephemeral adds `--no-session-persistence`** (`AgentSpec::no_session_persistence`).
  Measured: a turn without it wrote a 116 KB session file under
  `~/.claude/projects/<cwd>/` for one word of reply; with it, nothing; and
  `--resume` of that session id then failed — "No conversation found with
  session ID". So the CLI keeps nothing, **and cannot continue the
  conversation either**, since this module continues one only by `--resume`.
  The desktop therefore carries the conversation itself: `send_agent` renders
  the in-memory log's earlier turns (`agent::carry_transcript`, the recorder's
  inverse — what was said, by whom, in order, tool results left out) into an
  `<earlier-turns>` block in front of each message from the second turn on,
  and the block tells the model it is a replay, not a resume. What that costs:
  no prompt cache across turns, the CLI's own tool calls from earlier turns
  gone, the prompt growing with the chat (capped at the most recent ~200 KB).
  An ephemeral chat is short by its nature, and the alternative — one
  long-lived `--input-format stream-json` process per chat — changes
  `run_turn`'s lifecycle and is a nightshift blocker rather than a guess.
- `--add-dir` for the vault is still passed: `Read` is in the list, and the
  grant only makes vault paths readable without a classifier prompt.

The log is written as usual for incognito (marked on line 1) and not at all
for ephemeral ([service-data.md](service-data.md)); the `Recorder` writes into
whichever `Session` it is given and does not know the difference.

## Editing the CLI's history, by copy (`agent/cli_session.rs`, 2026-09-15)

His question (nightshift backlog 062): "Can't you just edit the history and
then start a new Claude Code session instead of resume whenever the chat
history is edited?" Yes, and that is what this module does. The CLI keeps a
conversation as `~/.claude/projects/<cwd with every non-alphanumeric byte as
'-'>/<session id>.jsonl` — one JSON object per line; `user` / `assistant` /
`attachment` **nodes** chained by `uuid` → `parentUuid`, an assistant reply
being several nodes (one per content block) sharing a `message.id`; and
bookkeeping lines with no uuid (`queue-operation`, `file-history-snapshot`,
`atis-latch`, `last-prompt` naming the leaf, `mode`). `--resume <id>`
continues from the tree's leaf. `CliSession::parse` reads it; `rewrite`,
`remove` and `truncate` return an edited copy; `write_copy` writes the copy
**beside the original under a fresh uuid**, every `sessionId` swapped, with
`create_new`, and returns the id the desktop records as the chat's
`AgentSession` and `set_resume`s. **The original is never opened for
writing and never deleted**; the persisted tool outputs it names by absolute
path stay readable from the copy. Lines the edit does not touch go out as
they came in, bar the id; touched lines are re-serialized.

**Measured, CLI 2.1.263, all on his account (`inferred`; the full table is in
the nightshift repo's `edit-messages-report-2026-09-15.md`).** A Haiku
session of two turns (PELICAN, then OTTER), copied three ways and each copy
resumed with "list every message so far":

| copy | resumed? | cache read / write | the model's history |
|---|---|---|---|
| **truncate** before the second user node (it and every descendant dropped, with the `last-prompt` / `file-history-snapshot` naming them and the `queue-operation` pair before it) | yes | 7017 / 247 | first turn only — this is **rewind** and **edit-and-send** |
| **drop outright** (the node alone gone, its child re-parented) | yes | 7017 / 334 | the orphaned "OK" merged as a second assistant message |
| **placeholder** (the node's text replaced) | yes | 7017 / 341 | the placeholder in place of the turn |

So the CLI accepts all three, and the prompt cache reads the unchanged
prefix in every case. Then, with the **built module** doing the rewrite:
a one-turn session on `opus` and one on `sonnet` (PELICAN), each copied
with the user node's text changed to WALRUS and resumed with "what is the
code word?" — **both answered WALRUS**, no error, cache read 3126 / write
976 on Opus and 8480 / 1075 on Sonnet. Fable was not run: the item records
that on Fable 5.1 the API checks edited history against preserved thinking
blocks and returns 400 for accounts created on or after 2026-08-31 (his is
older); if a model refuses, the turn's error is what the UI shows, and
nothing in the log is lost.

What each edit does to the copy, and why:

- **Edit and save** (`rewrite`): the target's text replaced. A user prompt
  keeps its attachment blocks; an assistant reply keeps its thinking nodes
  (signed as they are — measured to resume under a changed user turn; an
  edited *assistant* turn's thinking was not measured separately) and its
  first text node takes the text, any further text node going.
- **Remove** (`remove`): a user prompt, or an assistant reply that calls no
  tool, is **dropped outright** with its children re-parented — the spec
  asked which of the two measured shapes to prefer, and dropping is the one
  taken, since a placeholder is a turn the model still reads. A reply
  *with* a tool call cannot be dropped (its results would answer nothing),
  so it keeps its `tool_use` nodes, loses its thinking, and says the same
  marker sentence the API engine's elision projects (`REMOVED_MARKER`).
- **Rewind** and **edit and send** (`truncate`): the copy cut before the
  user prompt, as measured. A cut that leaves no turn at all — at the
  oldest prompt, or before the CLI session began — writes no copy: the
  desktop starts the next turn with no `--resume` instead, and the chat
  records the id that turn opens.

- **Restore** (`restore`, 2026-09-15, nightshift backlog 064 — the Restore
  this engine lacked when 062 landed, nightshift blocker 067): the turn's
  nodes put back into the *current* file from the **original** the
  removal copied from, which is still on disk since nothing here deletes.
  The target is located in the original, by the address the removal used,
  so the text check runs against the file that has the text. A node still
  present (the marked text node of a reply with a tool call) takes its
  original line again; one that was dropped (a prompt, a text reply, a
  thinking node) is inserted after its parent's line, a prompt's
  `file-history-snapshot` with it; then every node the copy shares with
  the original hangs from the parent it had there, where that parent is
  present — undoing the re-parenting and leaving alone an edge some other
  removal moved. Written as a third copy under a new id, recorded and
  resumed (`restore_message` in the desktop). Not a plain return to the
  original id, which the undo of a *rewind* can afford: anything done to
  the copy since would go with it. Which file is the original: the latest
  `AgentSession` live before the `Elide` marker that hid the turn.
- **Unrewind** (no file work): the rewind resumed a truncated copy; lifting
  it resumes the file the copy was cut from, recorded as a fresh
  `AgentSession` line since the copy's own line is later and still live.

**Addressing a turn.** Nightloom's log and the CLI's file share their
*tail*, not their head — a chat may hold turns from before it came to this
engine, and the CLI holds only the turns since — so a target is counted
**from the newest user prompt** (`Target::User { from_last, text }`) and
checked by text before anything is changed; an assistant reply is found
within its turn by its text. A mismatch is a refusal that changes nothing
("that turn reads differently in Claude Code's history than in this chat's
log"), and a turn the CLI never saw says so. Subagent transcripts live in
`<session id>/subagents/` and are not in the file; the main chain is the
leaf's ancestry, which is what makes the count stable across branches.

**The version pin.** The format is undocumented and the CLI's to change, so
`MEASURED_VERSION = "2.1.263"` is written down and a file whose first node
carries another *major* version — or lacks `uuid` / `parentUuid` / `type`,
or has a line that is not JSON — is refused with the sentence the UI shows
whole: "this Claude Code version keeps sessions in a shape Nightloom does
not know; the edit was not applied". A minor step is not a refusal. When
the CLI moves the shape, the fixture in the module's tests (synthesised
from the node types and fields — never a copy of a real file, which carries
the user's instructions files, e-mail and system prompt in its `attachment`
nodes) is where the new shape gets measured.

**What this is not.** Not the ephemeral chat's `<earlier-turns>` replay,
which flattens the CLI's tool calls to text: an edited copy keeps the real
assistant turns and tool calls, which is why it caches. And nothing here
touches auth — the line below still binds.

## What `--append-system-prompt` carries

Three parts, in this order, joined by blank lines (`prompt::agent_prompt`
builds them as segments; `agent_preamble` is that prompt rendered flat, and
nothing else, so what the Context popover itemizes and what the flag carries
cannot differ by a byte — 2026-09-14):

1. **Nightloom's preamble**, minus identity and environment. The same layers
   `assemble` builds for the API engine — the user's `~/.nightloom/AGENTS.md`,
   every `AGENTS.md` on the walk to the workspace, the project's notes index,
   the vault's index — but never `DEFAULT_IDENTITY` or the `<environment>`
   block: Claude Code has an identity of its own and knows its cwd, and a
   second copy of either would contradict the first rather than refine it.
   Before this the engine got none of it, so a chat there started knowing
   nothing a chat on the other engine knows.
2. **An engine note** (`SegmentKind::EngineNote`). Those segments name Nightloom's tools (`read_file`,
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
engines; the CLI (`nightloom-cli/src/agent.rs`) still sends only `--system`. A
chat's own switched-off layers (`SessionEvent::PromptLayers`,
[service-prompt.md](service-prompt.md) "Layers off per chat") apply here as on
the other engine, plus the engine note, which is a layer on this engine alone;
so does the chat's own text for a layer (`PromptLayers.edits`, 2026-09-15),
which rides the same `PromptConfig` into the same flag.
No segment carries a cache anchor: the CLI does its own caching.

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
`--system-prompt-snapshot`; see the report for the option. The same rule
governs a layer switched off mid-chat: a new chat drops it at once, a resumed
one on 2.1.265 or later keeps the recorded prompt until its next compaction, and
the Context popover says so on this engine rather than pretend.

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

## How attachments reach the engine

Argv carries text and nothing else, so a turn with an image or a PDF cannot go
on `-p <prompt>`. It goes on **stdin** instead: `run_turn` takes `impl
Into<TurnInput>` (a `&str` converts, so text-only callers read as they did), and
when the input has attachments it swaps `-p <prompt>` for `-p --input-format
stream-json`, pipes one NDJSON user line (`protocol::user_line`) and closes the
pipe. Everything after the first two arguments is identical in both shapes, which
is the property that keeps the resume path and every flag test valid without a
second copy of each. A text-only turn is untouched — `-p`, `Stdio::null()`, as
before.

The line is the Agent SDK's own user message: `{"type":"user","message":{"role":
"user","content":[…]},"parent_tool_use_id":null}` with `content` as the block
list — caption as a `text` block, then `image` blocks, then `document` blocks,
every source `{"type":"base64","media_type","data"}` and a document carrying its
`title`. That is the log's order too, so what the agent saw and what the
transcript replays are the same message. The SDK documents this for images and
lists image uploads as a streaming-input-only capability (`external`, the SDK
"Streaming Input" page); `document` blocks were not in the doc and were **verified
live** on 2.1.263 alongside the image case, a `--resume` of a session whose
earlier turns went on argv, and a 12 MB line (the headless page's "piped stdin is
capped at 10MB" does not bind this input). The stdin write runs on its own task:
a PDF near the cap is tens of megabytes past what a pipe buffers, and a write
awaited in front of the stdout loop could sit against a child blocked on a line
nobody is reading yet.

**Needs a CLI with `--input-format stream-json`** — present on 2.1.263 and in
the SDK's contract, so any version the module already runs on. What was
*measured* and is worth knowing: a `document` over ~23 MiB encoded is **silently
dropped** somewhere between the CLI and the model — exit 0, no error line,
`input_tokens: 10`, a reply asking which document you meant, while
`--replay-user-messages` shows the CLI received the whole block. 22.7 MiB reached
the model; 24.0 MiB did not. The composer therefore caps documents at 20 MiB
encoded on this engine (the API path keeps its 32 MiB) so the failure is a named
refusal at attach time. Images near their own 10 MiB cap went through. The record
is `agent-attachments-report-2026-09-14.md` in the nightshift repo.

The desktop's `send_agent` records the turn with its attachments through
`record_user_with_attachments`, exactly as `send` does, so a chat that started
on this engine projects onto a provider request with its attachments intact if
the rail is switched.

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
