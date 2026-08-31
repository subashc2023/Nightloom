# Conventions

`AGENTS.md` carries the short form of the rules that change what you do. This
file is the long version, plus the findings behind them.

## Verification: `probe` vs `eval`

They answer different questions and both are cheap. An adapter can stream
flawlessly while the model never edits the right file.

Reach for **`eval`** when changing the turn engine, the tools, or their
descriptions — it is the only check that exercises a whole tool loop against a
real model, and it is what caught the round cap. Reach for **`probe`** when
adding or debugging an adapter: it is the verification loop for streaming
behaviour (thinking deltas present, usage adds up, stop reason set, stream
properly terminated).

### A prompt change is a hypothesis, and the suite is how you find out

Worth knowing before you have the idea again: **nothing in the preamble or in any
tool description tells the model that calls which do not depend on each other can
go out in one round, and adding a sentence that does has been measured to change
nothing.**

Three targets × seven tasks × three runs either side put `Trace::widest_round` at
1.0 on every task but `three-parallel` before **and** after — 54 attempts with no
call ever grouped — while pass rate moved 54/63 to 50/63, inside the noise of
three samples a cell.

`three-parallel` is the explanation: gpt-oss-120b fails it 0/3 with the task's
own instruction asking for one batch, and the models that pass it group nothing
anywhere else. Grouping is a post-training habit a task instruction can reach and
a preamble cannot.

The argument and the numbers are on `DEFAULT_IDENTITY`. Do not re-add it without
a measurement saying otherwise.

### The cache boundary is worth verifying rather than assuming

The accounting added in `pricing.rs` is what revealed that Anthropic caching had
never once engaged. If you change what is cached or where a breakpoint lands,
check `cache_read_tokens` on a session long enough to clear 1024 tokens — the
failure mode is silent, since Anthropic ignores an undersized breakpoint without
an error.

## Where things the model should know go

**The cache boundary is the design axis.** Stable for the life of a `Chat` goes
in a `SystemPrompt` segment; changes turn to turn goes in a `SidecarPart`. A
moving value in the preamble silently invalidates the cached prefix on every
turn — it costs full input price and full TTFT rather than failing loudly.

**About a *project*** goes in `<workspace>/.agents` and reaches the model as an
index, not as content — plain files the existing file tools already read and
write, so it needs no new tool and no retrieval layer. Resist adding either:
`write_file` already creates parent directories, and `grep`/`glob` find a note in
an ordinary walk because the docspace is **inside** the tree they are rooted at.

That containment is load-bearing rather than incidental. The docspace spent one
commit outside it, and the cost was immediately a second `Root` tree and a system
prompt that had to name notes by absolute path.

**About the *user*** goes in the vault, and the line between the two stores is
worth holding: *about the code in front of you* is the docspace, *what stays true
after this folder is closed* is the vault. Not a nicety — the prompt says it in
as many words, and without that sentence both indexes describe "shared notes"
indistinguishably and the model writes to whichever it read last, at which point
neither store is reliably about what it claims.

The same rule decides where a new *feature* belongs: the vault reuses
`project.rs`'s note functions and the existing file tools rather than growing a
storage layer or a `kb_read`, because a parallel file API is the retrieval layer
this section already tells you to resist. What the vault genuinely needed that
the docspace did not is a location and links — and those are the only two things
`knowledge.rs` has. A second task-list mechanism beside `todo_write` would
likewise leave two lists with no answer to which is current.

### Three bugs of one family: a note the model cannot get back

- **`SKIP_DIRS` blanketed `.nightloom`** and had to start skipping `sessions` /
  `probes` / `evals` by position instead.
- **`grep`/`glob` reported hits relative to the *search directory* rather than to
  the root**, so `path: "src"` answered `main.rs` for `src/main.rs` — a handle
  that resolves, passed straight to `read_file`, to a different file or none.
  Survivable while every search ran inside the workspace; a correctness bug the
  moment the docspace left it.
- **A pattern now matches the base-relative path *and* the reported one**, either
  counting as a hit (`hit()` in `search.rs`). The two spellings were only ever
  the same string when the search covered the whole workspace, so narrowing a
  vault search with the prefix the tool had *just printed* — `path: "@kb"` with
  `glob: "@kb/**/*.md"` — silently returned nothing where `**/*.md` returned six
  files. Measured live rather than reasoned about. Permissive rather than a
  switch to the reported path alone, since `path: "src"` with the pattern
  `main.rs` has to keep meaning what it reads as; the alternative trades one
  silent zero for another.

### An empty search result is a claim, and it has to say what it is a claim about

`grep`/`glob` search the workspace only unless given a `path`, which is
deliberate and stays. But `no matches for "checksum"` was indistinguishable from
an answer about everything the model can reach, and a vault question answered
from a workspace-only walk comes back as a confident wrong negative.

Measured across four providers on a sealed vault: every one ran an unscoped
search, every one named the ambiguity unprompted when asked, and one caught
itself only by re-running the identical query scoped. So both tools now name the
directory they searched and, when a vault exists that the walk did not reach, say
so and name the alias (`vault_note()`; a nested vault *was* searched and is not
mentioned, since that would be its own small lie).

**It is not a cure.** Re-measured after the change, a model that had just been
told the vault was unsearched still answered from the empty result when the
expected answer was itself a negative, and took the advice and re-ran scoped when
the question demanded a value. Worth having for the second case; do not read it
as making an unscoped search safe.

## Adding a tool

**Classify its `Effect`.** The default is `Mutating`, so forgetting is safe but
silent, and a test pins the whole table. `Effect` decides two things rather than
one: whether a call needs approval, and whether it may run concurrently with its
neighbours. That raises the cost of talking a tool *down* to `ReadOnly` — the
same mistake it always was, but it now also buys a data race — and it is the
reverse risk the pinning test exists to catch.

**Answer the cancellation question.** `Tool::call` takes the turn's token, and
`_cancel` is the right answer for anything that finishes in microseconds. It is
worth a second thought for anything that spawns a process, opens a socket, or
walks a tree — the engine will wait for the call, so a tool that ignores the
token is a tool the user cannot interrupt.

**Shape its own output.** The 64 KiB `RESULT_LIMIT` in `run_tool` is only the
backstop under it. Truncating in the tool is what lets the message say *what* was
cut and how to ask for less; hitting the ceiling instead gets a blunt cut and a
generic notice.

### Two extensions to the effect rule

**A tool that runs a nested `Chat` classifies its `Effect` by what the nested
chat can reach**, not by what the tool itself does. `task` is `Mutating` because
a subagent runs whatever its tool set allows; `review` is `ReadOnly` because it
strips its own sub-chat to read-only tools before running it. The enforcement has
to live next to the classification — a `ReadOnly` that depends on a
shell-supplied factory behaving is the talked-down classification the effect
table's test exists to catch, one round of tool calls away from a data race and
an ungated write.

**A tool that leaves the machine classifies its `Effect` by egress**, not by
whether it changes anything locally. `web_fetch` mutates nothing and is
`Mutating`, because what makes a read safe here is a `Root` and there is no root
for a network — so the gate is the only thing that puts a URL in front of a
person. This composes with the nested-chat rule rather than competing with it:
`review` stays `ReadOnly` *and* its reviewer cannot fetch, because stripping the
sub-chat to read-only tools drops the web tools too.

## Structure

**Anything that supersedes conversation state is a marker, not a mutation.**
`Compaction`, `Rewind` and `Elide`/`Unelide` all leave the log append-only and
change only what the projection reads. A fourth follows the same three rules: the
log keeps the content, a UI can show what was hidden, and a `Rewind` that
supersedes the marker undoes it for free (compute the flags from `live_flags()`,
as `elide_flags()` does).

**Turn semantics live in two files** and usually change together:
`service/turn.rs` (`Chat`, the round loop, and its scripted-provider tests — by
far the largest module in the workspace) and `core/session.rs` (the event log and
every projection off it). A shell that seems to need its own loop logic is a sign
something belongs in `turn.rs`.

**Thinking spec strings** parse via `Thinking::FromStr`: `default`, `budget=N`,
`effort=LEVEL`. Adapters fail loudly on a mode their vendor does not support — no
silent fallbacks.

## Tests and CI

**Tests are inline** `#[cfg(test)] mod tests` at the bottom of the module they
cover. There is no `tests/` directory.

Adapter tests assert on the *request body JSON* the adapter builds
(`Anthropic::body(&req)`, wire-message mapping) rather than hitting the network.
Service tests drive `Chat` against scripted `Provider` impls in `turn.rs`'s test
module: `Scripted` replays a canned `Vec<StreamEvent>` per call, `Stall` never
terminates (for cancellation tests), `Erroring` dies mid-stream. Reach for those
shapes when adding coverage instead of introducing a new mocking layer.

**CI** (`.github/workflows/ci.yml`) runs fmt, clippy and the whole suite on push
and PR, on Linux and Windows both — `shell.rs` branches on OS and `root.rs`
resolves symlinks, so one platform tests half of each. `nightloom-desktop` is a
separate Windows-only job because `generate_context!` reads the gitignored
`apps/desktop/dist`, so the frontend must be built before the crate compiles at
all.

`probe` and `eval` are deliberately not in CI: both spend money against a real
model, and both answer a question a commit cannot regress on its own.

## Platform

Development happens on Windows. The `bash` tool spawns `cmd /C` here, not
PowerShell.
