# nightloom-service — the preamble and the sidecar

The cache boundary is the design axis for anything the model should know:
**stable for the life of a `Chat` goes in a `SystemPrompt` segment; changes turn
to turn goes in a `SidecarPart`.** A moving value in the preamble invalidates
the cached prefix every turn — it costs full input price and full TTFT rather
than failing loudly.

## `prompt.rs` — the static preamble

`assemble(&PromptConfig)` layers identity → environment → user memory → project
instructions → custom, anchoring a single cache breakpoint at the end.

### Environment

Time-invariant facts only: cwd, os/arch, shell, git root and branch read
straight from `.git/HEAD` rather than by spawning `git`. **A clock here would
cost a full cache miss every turn.**

`shell` names **the shell `bash` will spawn**, not the terminal the user
launched from. It read `PSModulePath` / `$SHELL` before, and a live session took
`shell: powershell` at its word, opened with `Get-ChildItem`, and spent two
rounds finding out it had been handed `cmd /C`. The segment describes the
model's environment, and describing somebody else's is worse than saying
nothing.

### Instructions: `AGENTS.md`

Project instructions are **every `AGENTS.md` between the filesystem root and
cwd**, emitted outermost-first so the most specific file wins. User memory is
`~/.nightloom/AGENTS.md`, first in the ladder and outside the walk because it is
about the *user* rather than a location on disk.

One filename, not a house-branded one beside it, for the reason `mcp.json` uses
the `mcpServers` key: a project that already wrote an `AGENTS.md` is picked up
without being asked to duplicate it.

The walk deliberately does **not** stop at the git root. That assumes the only
applicable instructions are ones committed to this project, which is wrong in
the two places people actually put them — a `~/dev/AGENTS.md` covering every
checkout under it, a machine-wide file at the top of the drive. Those are layers
someone wrote precisely so they would not have to repeat themselves per repo.
The cost is a `stat` per level on paths that usually do not exist. Each file is
capped at 32 KiB.

**This repository's own `AGENTS.md` is deliberately not `CLAUDE.md`.** The
long-form reference is far past the 32 KiB cap, so a `git mv` would hand the
model the first fraction of it cut mid-sentence, and even untruncated it is the
wrong size for the one place that has to stay small. `AGENTS.md` is a
purpose-written orientation — commands, the crate direction, the conventions
that change what an agent does — naming `docs/` as the read-on-demand reference
behind it.

### The docspace index (`PromptConfig.project`)

`project_notes_segment` emits **an index and never the contents** — names, sizes
and each note's first heading. Inlining them would put an unbounded pile of text
in the one place that has to stay small, and would make the facility worse the
more it was used; an index plus `read_file` costs one call for the note that
matters and nothing for the rest.

It is a `SystemPrompt` segment rather than a `SidecarPart` by the cache rule:
stable for the life of a `Chat`, so it is written to the cache once and read free
every turn after. The price, and it is the right trade, is that a note the model
writes mid-session is missing from the index until the next `Chat` — it just
wrote it, and `list_dir` answers if it forgets.

The segment is emitted for an **empty** docspace too: a facility the model was
never told about is one nobody uses, and the empty case is where saying what it
is for matters most.

It also tells the model **how to reach** a note, and that is the sentence that
rots. It said the docspace was outside the workspace and to give the absolute
path — true for the one commit the docspace spent at `~/.nightloom`, and it
survived thirteen commits past the move back to `<workspace>/.agents`. Nothing
failed over it, since the model does as it is told and an absolute path inside
the root resolves like any other, so the loss was silent: a model told the notes
are somewhere else has no reason to expect `grep` or `glob` to reach them, and
will not look — which is the entire affordance the move bought. It now names the
relative form (`.agents/<name>`), and the test resolves that path through a
`Root` rather than pinning the wording, since what has to be true is that the
file tools land on the note.

### The vault index (`PromptConfig.knowledge`)

`SegmentKind::Knowledge` — the same shape as the docspace layer and for the same
reasons (index never contents, a segment rather than a sidecar part, emitted
even when empty), with three differences that all follow from a vault being
meant to grow for years where a docspace is not.

**It is byte-budgeted** (`VAULT_INDEX_BUDGET`, 4 KiB of listing), because an
index that grew without limit would make the facility worse the more it was
used. Past the cap it **leads with the fact that it is a sample** — the exact
total, the words "not the whole vault", and the two searches that reach the rest
— all *above* the listing rather than as a footnote under seventy entries, which
is precisely where a reader who has stopped looking will not reach.

**It is grouped by folder with an exact count beside each**, most-recently-edited
first *within* a folder. That shape is the one thing here that survives scale: an
entry is ~55 bytes, so 4 KiB lists ~75 notes, which against a vault of 2,000 is
4%. The obvious remedy does not work — adding a first-line snippet takes an entry
to ~130 bytes, so *four times* the budget would list 6% instead of 4%. Both fail;
what separates them is that a flat 4% still **reads** like a catalogue, so a model
that finds no hit concludes the vault is silent on the subject, where a folder
line with a count cannot mislead that way however hard it is cut. Grouping is
also *negative* cost, the repeated path prefix being factored out of every line
beneath it — paid for with one sentence saying a note's name is its folder plus
the line under it.

Budget is handed out **round-robin across folders**, so one late in the alphabet
is not starved by one early in it. Recency dropped to within-a-folder because it
is a good proxy for "what am I working on" and a poor one for "what does a
stranger need", and this index is read by a stranger at the start of every chat:
in a vault, unedited means *settled* rather than stale, so a decision that is
supposed to never change again would otherwise sort below a typo fix in an
archived note.

**Counts come from `project::note_counts`, not from the listing.** That is a
correctness fix: `list_notes` stops at its own cap **mid-walk in filesystem
order**, so its length is not the size of the vault and whole folders can be
absent from it. Measured, a 204-note vault reported 200 and dropped a folder
entirely — and the moment the index states a number, that becomes a fabricated
fact in a system prompt rather than a short answer. Counting is a `read_dir`
walk with none of the 512-byte summary probes, and its own ceiling renders as
"over N" rather than a bare number, so a folder past both limits still appears
truthfully as `zzz/ (3 notes, 0 shown)`.

Three sentences earn their tokens: that `@kb/<name>` is the path (the vault is
genuinely outside the workspace, so a model that does not know the alias cannot
open a note it can see), that `[[name]]` means `@kb/<name>.md`, and **what
belongs here versus the docspace**. That last one is load-bearing: without it the
two indexes describe "shared notes" in indistinguishable terms and the model
writes to whichever it read last, at which point neither store is about what it
claims.

**Deliberately no per-note link counts**, though the data exists — it would mean
reading every note in full at assembly time where listing costs a stat and a
512-byte probe. Re-examined against four models on a seeded vault and kept, with
a better argument than the original: asked to justify the field, a model instead
recovered the vault's entire link structure with **one `grep` mid-conversation**
— a per-turn cost paid by the one chat that needs it, against a per-chat prompt
cost paid by every chat that does not.

The same exercise produced the folder grouping, and it is worth recording that
the three weakest models in that panel all asked for content snippets in the
index while the two strongest both argued the opposite: an index is a router to
a read, and a snippet makes it look like a substitute for one. Not merely a
token argument — this vault records supersessions (an archived frame size, a
superseded config block, a section headed *what is not written down here*), and
a first paragraph would have surfaced the setup and hidden the correction on
exactly the notes where being wrong costs most.

### Both index layers are off in `nightloom-evals`

For the docspace that stopped being optional once the walk reached the root: one
file in a home directory would otherwise reach every eval workspace on that box.
For the vault the argument is stronger — it is not even per-workspace, so the
developer's own notes would reach every eval on that machine and none on any
other.

## `sidecar.rs` — per-turn context

`SidecarPart` implementations rendered fresh each turn onto the tail of the user
message and **never logged**. `default_parts()` is clock + context gauge
(estimated from the last assistant turn's usage, not the running total) + task
list. Returning `None` omits a part entirely, so an empty list costs zero tokens.

Past `COMPACT_ADVISORY_PCT` (75%) the gauge starts *recommending*
`compact_context` at the model's next natural stopping point. Proportional
rather than absolute because the two agree where it matters and diverge where it
counts: 150k on a 200k model, 750k on a 1M one, instead of an early compaction
throwing away most of a window the user is paying for.

It is advice, not a trigger. The engine knows how full the window is but not
whether this is a sensible place to stop, and firing automatically mid-task
discards exactly the detail the next step needed.

The advice appears only when `SidecarContext.can_self_compact` says the tool is
actually on the request — recommending a tool that was never advertised buys a
hallucinated call and an error result — and only when the limit is known, since
a warning needs a denominator.
