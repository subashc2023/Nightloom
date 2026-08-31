# nightloom-core

Canonical types only; no HTTP, no vendors, no UI. `message.rs` holds `Message` /
`Role` / `ContentBlock` / `ImageInput`; each section below names its module.

## The `Provider` trait (`provider.rs`)

`stream_chat(ChatRequest) -> EventStream`. All streaming normalizes into
`StreamEvent` (`Start` / `TextDelta` / `ThinkingDelta` / `ThinkingSignature` /
`RedactedThinking` / `ReasoningRef` / `ToolUse` / `Usage` / `End`) — **vendor
delta shapes must never leak past the adapter boundary**.

`StreamEvent::ToolUse` carries a *complete* call: adapters buffer partial
argument fragments internally and emit one event per call. `ThinkingSignature`
marks the end of a signed thinking block, so consumers flush accumulated
`ThinkingDelta` text into one `ContentBlock::Thinking` with that signature. Only
Anthropic signs thinking.

## Tools (`tool.rs`)

`ToolDef` (name / description / JSON-Schema `input_schema`) declares tools
vendor-neutrally via `ChatRequest.tools`; the `Tool` trait is the execution
contract. `Err` becomes an `is_error` tool result fed back to the model, not an
abort. The optional `drain_events()` lets a tool whose output *is* conversation
state — the task list — append to the session log without being handed a `&mut
Session`.

`ContentBlock::ToolUse` lives in assistant messages, `ContentBlock::ToolResult`
in user messages; its `name` field exists because Gemini pairs results by
function name, not call id.

**`impl Tool for Arc<T>`** lets a connection be *shared* rather than duplicated.
A `Chat` owns `Box<dyn Tool>`, so without it the obvious way to build a
subagent's tool set would spawn a second copy of every MCP server.

### Effects

`Effect { ReadOnly, Session, Mutating }` is the axis an approval policy sorts
on, and `Tool::effect()` **defaults to `Mutating`**. The dangerous default is the
point: a tool that has not answered the question — one arriving over MCP, a
third-party impl compiled against an older trait — is something nobody vouched
for, and a `ReadOnly` default would let every future tool bypass the gate *by
omission*.

### Result size (`RESULT_LIMIT`, `run_tool`)

One tool result is capped at 64 KiB in the **funnel every call goes through**,
rather than per tool. It is a backstop, not a replacement for a tool truncating
its own output — a tool that knows what it cut can say something useful about it
(`grep` reports how many files matched and tells the model to narrow the
pattern), and every built-in does that at 16 KiB. The ceiling is for tools that
never considered the question: the same population `Tool::effect` defaults to
`Mutating` for, since a limit applied per tool is one every future tool escapes
by omission.

Four times the built-in cap deliberately — a ceiling low enough to pre-empt a
tool that *did* think about its size would replace a shaped truncation with a
blunt one. The notice is addressed to the model and names the full size: a result
that stops early without saying so reads as a file that ended there. Failures are
capped too, an `is_error` result being a block on the wire like any other.

### Cancellation (`Tool::call(input, cancel)`)

Every tool is handed the turn's `CancellationToken`, and **the engine never
abandons a call it started**. That is why the token is a parameter rather than a
race around the call: dropping the future leaves an assistant `tool_use` with no
`tool_result`, invalid on replay against every provider — the same damage
`orphan_marker` repairs after a crash, and a strange thing to manufacture on
purpose in answer to a Ctrl-C. An interrupted round still finishes and still
records a result for everything it started; what the token buys is results in
milliseconds instead of at the end of a ten-minute build.

Honouring it is per tool, and most correctly ignore it: `bash` kills what it
started, `web_fetch`/`web_search` drop the request in flight, `grep`/`glob` check
between files, MCP fails the in-flight call, and `task`/`review` need nothing
because the nested `Chat` already holds the token through the `TurnHandle`. One
string (`tools::INTERRUPTED`) says so — three phrasings for one event invite the
model to treat them as three problems.

## Reasoning and thinking replay

`ContentBlock::ToolUse.signature` and `ContentBlock::ReasoningRef { id }` are
**opaque per-provider handles**, and the invariant is that an adapter may only
replay a token it issued itself. `signature` carries Gemini's `thoughtSignature`;
`ReasoningRef` carries an OpenAI Responses reasoning item's id.

They are separate fields on purpose: the desktop lets you switch provider
mid-session and keep the log, and an Anthropic signature replayed to OpenAI (or
the reverse) is a 400 on every later turn. A distinct variant falls into every
other adapter's `_ => None` arm, so cross-provider replay is structurally safe
rather than guarded by a prefix sniff.

`ContentBlock::Thinking` carries an optional signature and
`ContentBlock::RedactedThinking` an opaque payload; assistant blocks are recorded
**in stream order**, since thinking must precede the tool_use it led to. The
Anthropic adapter replays signed thinking and redacted blocks verbatim and drops
unsigned ones (Anthropic 400s on them); every other adapter drops thinking on
replay.

## Prompt layering (`prompt.rs`)

A system prompt is an ordered `Vec<Segment>` (`SystemPrompt`), not a string. Each
`Segment` carries a `SegmentKind` (Identity / Environment / ProjectInstructions /
ProjectNotes / Knowledge / UserMemory / Custom), a name, its text, and a
`cache_anchor` flag. `Knowledge` is the index of the user's knowledge vault —
about *them* rather than about this folder, which is what keeps it apart from
`ProjectNotes`; both reach the model as an index and never as content.

Two renderings, guaranteed byte-identical because `push` normalizes text on the
way in: `render_flat()` for vendors that take one system string, and per-segment
blocks for Anthropic, where `cache_anchors(max)` says which blocks get
`cache_control` — keeping the *last* `max`, since a late breakpoint covers the
longest prefix. The Anthropic adapter passes `SYSTEM_ANCHOR_BUDGET = 3`, not the
vendor's four: the fourth is reserved for the rolling conversation anchor. See
[providers.md](providers.md) for why.

**The prompt is assembled once per `Chat` and never mutated per turn** — caching
keys on an exact prefix match, so anything time-varying belongs in the sidecar.

## Token accounting (`Usage`)

`input_tokens` is the **whole** prompt, cached or not, with `cache_read_tokens` /
`cache_write_tokens` as subsets of it. That normalization costs something to
maintain: Anthropic reports `input_tokens` as the tokens *neither read from nor
written to* the cache, so its three counters are summed at the adapter boundary,
while OpenAI and Gemini already report an inclusive total.

Measured live: a 4,683-token cached prompt reports `input_tokens: 14`. Taking the
field at face value understates the context by 335x, so the gauge reads
near-empty on exactly the turns where caching is working.

Cache fields are `Option` because "this host does not report caching" and
"nothing was cached" are different facts, and only the first must not render as a
0% hit rate.

## The session log (`session.rs`)

Append-only event log (`SessionEvent`), persisted as JSONL. **The event log is
the source of truth**; the provider message list (`Session::messages()`) and any
UI rendering are projections of it.

Tool results are recorded as individual `SessionEvent::ToolResult` events; the
projection coalesces consecutive ones into the single user message providers
expect. `SessionEvent::Compaction { summary }` supersedes everything before it —
`messages()` restarts there, re-seeded with the summary as a user message, while
the log keeps the full history for UIs.

New capabilities are added as new `SessionEvent` variants. The enum is
`#[non_exhaustive]`, which protects downstream `match` arms and does **nothing
for serde**; forward compatibility comes from `SessionEvent::Unknown`
(`#[serde(other)]`).

`Session::with_log_as(dir, id, at)` is `with_log` with the id and creation time
supplied by the caller, which is what an import needs and the only way to get it:
a generated uuid would make a re-run a second copy of every chat rather than a
no-op, and `Utc::now()` would date a year-old conversation to this afternoon.

`messages_with_sidecar(Option<&str>)` is the same projection with per-turn
context appended as an extra text block on the trailing user message; composed at
projection time and **never recorded**, so replaying an old log can't resurrect
last week's clock. It attaches only when the projection ends in a user message
carrying **no tool result** (round one of a turn) — after a tool round the tail is
a tool-result message, where an extra text block is a wire hazard. The test is the
*absence of a `ToolResult`*, not the presence of only `Text`: a turn where the
user attached an image is still round one, and an "all blocks are text" rule
silently dropped the clock, gauge and task list for exactly the turns carrying an
image.

### Crash consistency (`Session::load`, `LoadReport`, `orphan_marker`)

**Opening a log is total** — every line becomes exactly one event, and a line
this build cannot parse becomes `Unknown` rather than an error. A log is not a
document that is either valid or worthless; it is the only copy of a
conversation, and the failure it has to survive is the process dying mid-write,
which is exactly when refusing to open costs the most.

Three failures were live before this, each the quiet kind:

- a **torn final line** made the whole session unloadable (`?` on one
  `from_str`);
- an **unknown event tag** did the same to any log written by a newer build;
- an **orphaned `tool_use`** — the process dying between recording a round's
  calls and recording their results, a window as long as a `bash` timeout or a
  subagent turn — replayed as a `tool_use` with no `tool_result`, which every
  provider 400s. The worst shape available: the session lists, opens, renders its
  full history, then fails on every turn forever with nothing saying which event
  is at fault.

The placeholder holds its **position**, which is load-bearing: `Rewind` and
`Elide` address events by index, so skipping an unreadable line would renumber
the log and silently re-aim every marker at a different turn — an inconvenience
traded for a corruption.

The orphan is answered in the **projection**, not by repairing the log: no tool
result happened, so the block is supplied where the wire needs one
(`BlockSource::Repair`, so a reader can see it is Nightloom talking and not a
tool) and history keeps saying what it said. A partly-recorded round is the
ordinary case — three calls with two results is what a crash between them looks
like — so the check is per call id.

`load` **writes nothing**: a torn tail is noted and put right on the first
append, so viewing a session never modifies it and a log on read-only media still
opens. What tolerance costs is stated rather than hidden — an unreadable event
that was itself a `Rewind` or `Elide` is not being honoured, so content the user
hid is back on the wire, and `LoadReport::summary()` is the one sentence both
shells say about it.

## Markers over mutations

Everything that supersedes conversation state leaves the log append-only and
changes only what the projection reads.

### Rewind (`SessionEvent::Rewind { to }`, `Session::rewind`, `checkpoints()`, `live_events()`)

A **marker, not a truncation** — events `to..` stop counting while the log keeps
them. Two things fall out that a destructive rewind could not do: a UI can show
what was undone (greyed out, so a rewind is distinguishable from a delete), and a
rewind can supersede a `Compaction` event itself and bring the full history back.

`to` must be a live `UserMessage`, and that restriction is load-bearing: cutting
anywhere else can land inside a tool round and leave an assistant `tool_use`
whose `tool_result` was superseded, which every provider rejects on replay.
Chained and overlapping rewinds need no special case — each clears its own range
and the union is what remains.

**Every user message is a checkpoint**, not only ones planted in advance: you
find out which turn you wanted back after the turn that spoiled it. `messages()`,
`todos()` and the desktop's gauge respect it; `cost()` and `total_usage()`
deliberately do **not**, because the tokens were spent and a bill that shrank on
rewind would be fiction. Files written by tools are not reverted, and both shells
say so at the moment of rewinding.

### Elision (`SessionEvent::Elide` / `Unelide`, `Session::elide`, `is_elidable`, `elide_flags()`)

**Content removal, never structural removal**, and that distinction is the whole
safety argument. Dropping an event outright is unusable — an assistant `tool_use`
whose `tool_result` vanished is a 400 on every provider.

An elided event still projects a block of the same kind in the same position: a
tool result keeps its `tool_use_id` and swaps only its content, and an elided
assistant turn keeps every `ToolUse` and `ReasoningRef` **verbatim** (a Gemini
`thoughtSignature` is not content, and round two of a tool loop hard-requires it)
while its text and thinking become one marker. So an elision cannot produce an
invalid request by construction, rather than by a check somebody has to remember
to run. Dropping thinking is safe between turns and would not be inside one —
Anthropic wants the final assistant turn's thinking back while a tool loop is
open and ignores it on earlier turns.

The log keeps the content, `unelide` restores it, and a rewind that supersedes
the marker restores it too (`elide_flags` counts only *live* markers, which is
how that composes for free).

What it does **not** do is refund the cache: changing bytes mid-conversation
invalidates every cached prefix past that point, so the next turn pays full price
for the remainder. Usually a good trade against a 40k-token tool result, but a
cost, and both shells say so at the moment of removing.

## Recorded, never re-derived

### Cost (`SessionEvent::AssistantMessage.cost`, `Session::cost()`)

Cost is the one figure a projection cannot reconstruct — it needs the provider (a
model id alone does not name one: the same model is billed differently direct and
through OpenRouter) and the price *as it was that day*, so re-pricing an old log
from today's table would restate history every time a vendor moves a rate.

`SessionCost.unpriced_exchanges` is not a rounding detail: a session run entirely
on an unpriced model sums to `0.0`, and rendering that as "$0.00" would claim it
was free rather than unknown.

### Session titles (`SessionEvent::Title`, `Session::title()`)

Latest wins. Recorded rather than derived on cost — the name comes out of a model
call already paid for, so re-deriving it would mean paying again on every listing
and every repaint. Deriving one *without* a model (the opening message, clipped)
is what both shells did before, and forty chats whose names all begin "can you
help me" are a list you open one by one.

A `Compaction` does **not** clear it, which is where it parts company with the
task list — a summary supersedes the plan that produced it, but does not make the
conversation a different conversation. A `Rewind` does supersede it: a rewind to
the opening message is the one edit that leaves the old name describing a turn
that no longer counts.

A rename is an ordinary append — the old name stays in the log and the projection
takes the latest — which is what makes both shells' rename five lines rather than
a mutation path of its own.

## Attachments

### Images (`ContentBlock::Image { media_type, data }`, `ImageInput`)

Base64 inline, never a path or a URL: the log is the source of truth and has to
replay standalone, and a path stops meaning anything once the file moves or the
log is opened on another machine.

**User messages only** — no model emits one, so an adapter meeting an image in an
assistant message drops it. `SessionEvent::UserMessage` carries them in an
`images` array that is absent when empty, so pre-image logs load unchanged. The
projection puts images before the caption and omits the caption entirely when it
is empty, since an empty text block is rejected on the wire and an uncaptioned
attachment is a real turn.

Wire formats differ per vendor — Anthropic `source.base64`, Gemini `inlineData`,
OpenAI Responses `input_image` with a data URL, chat/completions `image_url` —
and the last has to switch `content` from a string to an array of parts, which it
does **only** when an image is present so imageless bodies stay byte-identical
for hosts that accept only the string form.

### Documents (`ContentBlock::Document`, `DocumentInput`)

A PDF, inline base64 like an image and in **user** messages only, carrying a
`name` as well as a media type. The name is on the wire for two of the four
dialects (OpenAI Responses' `input_file` and chat/completions' `file` part both
require a `filename`) and earns its place regardless, being what the model and
the user call the thing ("clause 4 of contract.pdf") when a turn carries three.

PDF is the only type offered: the only one every vendor that takes documents
agrees on, and the only one a user cannot simply paste — a `.md` or `.csv` is
text, and `read_file` already exists.

Wire forms: Anthropic a `document` block with the name as `title`; Gemini the
same `inlineData` shape an image uses (a blob part has no field for a filename,
so it is the one dialect that loses it); OpenAI Responses `input_file` with a
data URL; OpenRouter a `file` part.

**A host that cannot carry a document gets a notice, not the bytes and not
silence** (`undeliverable_document`). Groq and the generic `chat/completions`
flavor have no file part, and the flavor cannot tell OpenAI's own endpoint from a
local llama.cpp behind the same `--base-url`. The three options are not equally
bad: sending the part anyway 400s the request against every local server, and
dropping the block silently leaves a caption asking about a document the model
then answers as though it had read. So the block is *substituted* by prompt text
naming the file and saying it could not be delivered — the same device
`elision_marker` and `orphan_marker` use.

Refusing to build the request at all, which is what this project does for an
unsupported *thinking* mode, is wrong here because **content is not a knob**: the
desktop lets you switch provider mid-session and keep the log, and a hard failure
would make every later turn impossible on that host rather than one attachment
unreadable. The log is untouched either way, so the same turn replays whole on
the next provider that can read it.

The notice stays in the *string* `content` form on `chat/completions` rather than
forcing the parts array — a notice is text, and stepping into the array to
deliver it would break the string-only servers on exactly the request it exists
to keep working.

## Smaller pieces

- **Task list** (`todo.rs`, `SessionEvent::TodoState`): `TodoItem { content,
  status }`, a whole-list snapshot per write, latest wins, cleared by a
  `Compaction`. Not part of the message projection — it reaches the model through
  the sidecar, so the model sees one current list rather than a trail of stale
  copies.
- **`Thinking` enum**: `Default` | `Budget(u32)` (Anthropic-style) |
  `Effort(String)` (OpenAI-style). Adapters map what their vendor supports and
  **fail loudly** on what they don't — no silent fallbacks.

## Context view (`context.rs`, `WireView::assemble`, `Session::messages_sourced`)

The itemization of **what is actually on the wire** — system segments, every
projected message, and the sidecar, each with a size and the log event that
produced it. It exists because the transcript is not the request: tool results
coalesce, a compaction replaces everything before it, an image is base64 rather
than a thumbnail, and the sidecar is composed at projection time and never
logged.

`messages_sourced` **is** the projection and `messages_with_sidecar` is it with
the tags dropped — one implementation rather than two, since a view that itemized
a different list from the one the engine sends would be worse than no view.

Sizes are **estimates and say so**: there is no tokenizer here (every vendor
tokenizes differently, and only one offers a counting endpoint), so `Size.tokens`
is an `Option` and an image is `None` rather than a guess.
`ContextTotals.unestimated` is the same device as
`SessionCost.unpriced_exchanges` — a view of nothing but images totals zero
tokens, and rendering that as "0" would claim the context is empty rather than
unmeasured, so a non-zero count means the total is a floor and renders with `≥`.

## External agents (`SessionEvent::AgentSession`, `service::agent::Recorder`)

A turn run by an agent that owns its own loop is recorded in **exactly the shape
a provider turn is**, plus one marker naming the agent session it mirrors.

Recording at all is not obvious — the agent keeps the history and `--resume` is
what continues it, so this log is a *record* and never the thing replayed. The
argument for it is a windowed shell: the sidebar, the search and the transcript
you reopen tomorrow are each a projection of this log, and a chat that appears in
none of them is one the app forgot the moment it scrolled off. Recording it in
the *same* shape buys what makes an engine switch worth having: turn the rail
back to a provider mid-conversation and what the agent did replays as ordinary
history.

That only holds if the log is valid on the wire, and there is exactly one way it
could fail to be — the orphaned `tool_use`. The agent is another process and can
die mid-round, so pairing is **guaranteed by the recorder**: `finish` supplies an
`is_error` result for every call still open, saying so in words addressed to the
model.

`AgentSession` is latest-wins metadata like a `Title` and is **not part of the
message projection**, since it says where the conversation is kept rather than
being a turn in it. Without it, reopening the chat shows every turn and then
starts a fresh one with no memory of any of it — a transcript that lies about
being continuous, which is worse than a chat that plainly did not persist. It
carries the agent's *name* as well as the id, so a second agent later cannot have
its handles read as the first one's.

One wart is recorded rather than hidden: the CLI names the snapshot it resolved
`sonnet` to on a line that arrives before any event, so the opening messages of
the first turn after a connect carry the alias, which is in no limits or pricing
table. Both shells seed from the last recorded exchange and from
`ClaudeCodeAgent::resolved_model`, which shrinks it to that one turn; buffering a
whole turn to stamp it would close the gap and would trade a cosmetic id for
losing a turn on a crash.
