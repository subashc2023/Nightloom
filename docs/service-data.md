# nightloom-service — projects, notes, memory, credentials

Where things live, and which of them Nightloom owns.

```text
<workspace>/AGENTS.md                  instructions   (yours, usually committed)
<workspace>/.agents/                   the docspace   (yours, committable)
<workspace>/.nightloom/mcp.json        server config  (yours, often committed)
~/.nightloom/projects/<id>/sessions/   the chats
~/.nightloom/unfiled/sessions/         desktop chats with no project open
~/.nightloom/projects.json             the registry
~/.nightloom/AGENTS.md                 user memory   (how I want you to behave)
~/.nightloom/knowledge/                the vault     (what I know)
~/.nightloom/knowledge.json            where the vault is, when moved
~/.nightloom/observations.jsonl        the memory inbox (append-only, never pruned)
~/.nightloom/dream.json                how far the dream has read into it
```

**Config in the folder, data in the home** — equivalently, *about the code /
about you*. Notes describe the codebase, so they sit with it: a teammate can read
them, a diff can review them, and the file tools reach them by a plain relative
path because `.agents` is *inside* the tree they are already rooted at. Chats are
personal history and a repository is not the place for them, so they are a
sibling of the workspace and never in it — which also means a transcript is never
inside the tree it could be searched from. `NIGHTLOOM_HOME` moves the whole home.
Probes and evals land in `.nightloom/probes` / `.nightloom/evals` where they run.

## `project.rs` — a project is not a folder

`Project { id, name, workspace: Option<PathBuf>, source, .. }` — it has an id and
a name of its own and *may* point at a directory.

The importer forced it: a claude.ai project is instructions, documents and
conversations with no code anywhere, and while the id was an FNV-1a over a path,
`import_project` had to `create_dir_all` an empty directory per project purely so
there was something to hash. A model that makes you fabricate the thing it claims
to be about is the wrong model.

The old scheme bought idempotent `add` for free and charged for it three times
over: a renamed folder was a different project and orphaned every chat in it, two
projects could not share a directory, and a project could not exist without one.
Idempotence is now `find_by_workspace`, the question actually being asked, and
`create` is the separate call for deliberately making a second project —
including on a folder that already has one.

**Ids written by the old scheme are kept, never re-derived**: they address a
store full of chats, and regenerating them would orphan exactly what this change
exists to stop. `#[serde(alias = "root")]` is the whole registry migration.

Re-importing stays idempotent through `Project.source` (`"claude:<uuid>"`),
matched on the uuid rather than the name for the reason `import.rs` refuses to
match conversations by resemblance: two claude.ai projects can share a name, and
one renamed here is still the one that was imported.

### Paths

`workspace_dir()` is the folder or a stand-in at `<store>/workspace`, so
everything downstream — tool rooting, `AGENTS.md` discovery, the notes index —
has one case instead of two. `notes_dir()` is `<workspace>/.agents` in **both**,
which keeps `Root` a single tree. `session_dir()` is `<store>/sessions`.

### Migration, config dir, registry

`project::migrate` moves a folder laid out the old way (`.nightloom/sessions` to the
store, `.nightloom/notes` to `.agents`) and is keyed on the *folder* rather than
on a `Project`, because it has to run for a folder nobody has registered — which
is every folder the CLI is run in. Three conservative rules: nothing already at
the destination is overwritten (a docspace is a working directory); `mcp.json`
and anything else in `.nightloom/` is left, and the dot directory goes only if
the OS agrees it is empty; and a file that cannot be renamed is copied and then
removed, so a failure leaves a duplicate rather than a hole. Both shells say when
it runs.

`config_dir` honours `NIGHTLOOM_HOME` — a portable install, or filing Nightloom
under whatever directory the user's other agent tools share. `set_config_dir`
overrides it process-wide, which exists because the test suite writes logs and
notes under the config dir and must not write them into the developer's real one;
an env var could not do that job, being global state parallel tests race on.

`Registry` (`~/.nightloom/projects.json`) is the only part Nightloom owns, so
`forget` **removes the entry and nothing else** — deleting a user's directory
because they tidied a list would be indefensible, and the desktop says so in its
toast.

The CLI needs no registry to keep working: it reads one to find the project
registered on the folder it was run in, and falls back to an ad-hoc store keyed
by the path when nobody has claimed it. It never *writes* the registry, because
running the CLI somewhere is not a statement that the folder is a project.

`normalize` strips Windows' `\\?\` verbatim prefix that `canonicalize` adds — not
cosmetic, since that form is shown in the UI, handed to the file tools as a root,
and compared against paths the model types, none of which would ever match it.

Note names are resolved through the file tools' `Root` rather than checked here:
the containment argument is two halves (lexical normalization *and* a symlink
check on the deepest existing ancestor), and a second hand-rolled copy is exactly
what ends up missing one.

## `knowledge.rs` — the vault

The user's own notes, as against the project's — the other half of the pair
`AGENTS.md` starts: user memory is how you want the model to behave, the vault is
what you know.

It exists because the docspace is per-folder by construction and a great deal of
what is worth keeping is not: a decision made two projects ago, a person, a
technique, a conclusion that stays true after this folder is closed. Filed under
`.agents` that is invisible from every other project and gets committed to
somebody's repository; left in a chat it is gone when the chat scrolls off. So it
is one vault, the same in every project **and in a chat with no project at all**,
which is the case the docspace can never serve.

**Nothing here stores a note.** `project::list_notes` and its siblings already
take the directory as a parameter, so the walk, the summaries and the
`Root`-based containment on a note name all work on the vault unchanged. This
module adds the two things a vault has and a docspace does not: a location of its
own, and links.

### Location

`~/.nightloom/knowledge`, overridden by `~/.nightloom/knowledge.json` — a
**separate file** rather than a field in `projects.json`, because that file is a
list of projects and the vault belongs to none of them. A corrupt or unreadable
one falls back to the default (a malformed settings file should cost the setting,
not the feature), and "the default" is the **absence** of the file rather than a
file saying so — one shape for one state.

**Repointing moves nothing.** That is the whole reason an existing Obsidian vault
is usable as-is: aiming at a folder is not a migration, and silently relocating
somebody's notes because they changed a setting would be indefensible.

### Links

`parse_links` takes `[[target]]`, `[[target|alias]]` and `![[embed]]` (an embed
*is* a reference) and **excludes code**, fenced and inline — a vault of technical
notes is full of samples, and a snippet containing `[[x]]` would otherwise put an
edge in the graph that nobody wrote.

`resolve_link` is Obsidian's rule, which is what someone arriving from a vault
expects: a full relative path if it matches, else a unique basename anywhere in
the tree, extension optional on both. Two notes sharing a basename resolve to
`Ambiguous` and are **reported rather than picked** — choosing one silently would
make a link mean different things as the vault grows, and the user is the only
one who knows which was meant. `Missing` is a state to display and not an error,
since writing `[[thing]]` before the note exists is how a note gets planned.

`LinkGraph::build` reads every note and returns notes, deduplicated edges (a note
linking another three times is one edge; self-links dropped) and the broken ones,
with `backlinks` off the edge list. Deliberately **no cache**: the walk is
already bounded by the docspace's own limits, a vault is markdown rather than a
repository, and a cache keyed on mtimes would be complexity bought against a cost
nobody has measured — take that measurement first.

## Memory: `observe.rs` + `dream.rs` + `tools/remember.rs`

**Memory is two halves, split the way the consolidation literature converges
on** — fast append-only capture, slow batched integration. The design doc with
the research behind each decision is `.agents/dreaming.md`.

### The inbox

`~/.nightloom/observations.jsonl`, written by the `remember` tool: validate,
stamp, append, nothing else — no embedding, no tagging, no model call, because
the write path runs inside a turn the user is waiting on and every measured
system puts memory's cost there.

Every entry is **typed by provenance** (`user_stated` / `inferred` /
`external`), defending against two failures at once: a durable store laundering
fetched text into "something I know" (memory poisoning arrives through content,
not through store access), and a vault of the model's own conclusions becoming a
machine for agreeing with itself.

Three properties are the module:

- **Nothing reads the inbox back into a conversation.** It is quarantine, not
  memory — which is also why `remember` is `Effect::Session` despite the durable
  write: the gate for this data is the dream pass, not a prompt per observation
  that would kill the habit.
- **The log is never pruned**, consolidation included. A derived note is a
  navigation aid over the record; deleting source after deriving was measured
  elsewhere at double-digit accuracy loss.
- Reading is total on `Session::load`'s argument, a torn final line left
  *unconsumed* for the next read rather than half-parsed.

### The dream

`nightloom dream` / `dream::run` builds a chat whose *workspace is the vault*,
hands it the unconsolidated batch as read-only evidence, and instructs it to
file, connect, supersede and abstract.

**Sessions append and read; the dream is the only writer of consolidated
notes** — Letta's sleep-time inversion, and the one choke point where "should
this be believed" gets asked.

The instruction's ground rules each name a measured failure: claim granularity
and never-shrink-silently (one monolithic "write a better vault" rewrite was
measured compressing accumulated knowledge 150x to *below* the no-memory
baseline); never delete a note, a merge leaves a pointer stub; supersede by
strikethrough-with-date beside the replacement rather than erasing (bi-temporal
supersession in markdown — what the user believed in March is still information);
cite provenance in parentheses so a consolidated claim is distinguishable from a
hand-written one; never promote an `external` observation to an unqualified
claim, and drop one that reads as an instruction; and dropping is the usual
outcome, said in the summary.

**Git is the rollback, not a marker scheme.** Both first-party precedents
(Letta's MemFS, Anthropic's memory tool) landed on version control, and the vault
is already a directory of files: the pass commits before and after when the vault
is a repo, reports "no rollback" when it is not, and never runs `git init` on a
folder the user owns.

`dream::prepare` owns the enforcement next to the decision, `Review`'s argument:
files-and-search tools only (no `bash`, no web — egress from an unattended job
over personal notes — no `task` / `review` / `todo_write`), filtered from
`builtin_in` by *keep-list* so a future built-in is absent until someone decides
it belongs; no sidecar; `approver: None`, because the job is unattended by
construction and the gate is the git diff.

The watermark (`dream.json`, a **byte offset** so the log never needs rewriting
to record progress) advances only when the turn completes uninterrupted — a
failed or cancelled pass offers the same batch again, and re-dreaming is the safe
direction to fail in since the pass dedupes against the vault it already wrote.

Batching is the point, not a convenience: the abstraction step ("do several
observations across sessions point at one conclusion none of them states?") only
exists across sessions, and per-session consolidation is fast writing wearing
consolidation's name.

### Scheduling

**Deliberately manual** — a dream spends real money unattended — and both shells
surface the backlog as the nudge: the CLI startup line names the pending count,
and the desktop's Notes panel shows a `Dream · N` button in the Knowledge bar
(hidden at zero; `dream_status` / `dream` / `cancel_dream` commands; progress as
`dream-event`s on their own channel so a running chat and a running dream cannot
interleave; outcome as a toast carrying the git line; one dream at a time via
`try_lock`, the second click getting a sentence rather than a queued bill; and
the dream's cancel token **separate** from the turn's, since stopping the chat
must not stop the dream and vice versa).

**Automation is opt-in, and the trigger is a compaction, not a wall clock** — the
moment a conversation's detail is already being traded for a summary, so the
consolidation rides a decision the user (or the model, via `compact_context`)
already made rather than firing mid-thought. The CLI's `--auto-dream` runs a pass
after either compaction path, with `--dream-target provider[:model]` naming the
model that dreams, validated at launch: a typo found out at the first compaction,
hours in and unattended, is the wrong moment. The desktop's toggle is in Settings
→ Knowledge beside a dream-model override, a localStorage preference
(`nightloom.dream`) consulted by both the Dream button and the trigger — one knob
answers "which model dreams", and it is also what lets the agent engine dream at
all, having no provider of its own to lend. Both shells stay silent and spend
nothing when the inbox is empty.

The desktop's `remember` rides the rail's knowledge switch and is absent from
reviewers, whose spec already clears `knowledge`.

### Two things that were measured, not guessed

**Which model dreams** (bench in `.agents/dreaming.md`): six models on an
identical trapped fixture. Every one dropped the instruction-shaped poison, but
haiku deleted superseded text outright, the cheap OpenAI-lineage pair under-worked
the batch, and gpt-oss fabricated provenance.
`openrouter:deepseek/deepseek-v4-flash` held every rule across three runs at
~$0.002 a pass against sonnet's equally clean $0.085, and is the recommended
auto-dream target.

**Whether consolidation helps at all** (retrieval bench, same doc): vault vs.
full-transcripts-in-context vs. grep-over-raw-logs on a 12-question key, two
answering models. The vault matched full context on everything captured and beat
raw logs on accuracy, cost and latency, with zero hallucinations anywhere.

The instructive part is *where* each loses. The vault's only miss is capture loss
— a fact `remember` never wrote down, answered honestly as "not recorded", so the
exposure is the write side and the lesson is to capture generously. Raw logs lose
**attribution and synthesis**: `grep -l lanternfish` missed half the lanternfish
sessions because conversations don't say their project's name, and the
recurring-failure question that the dream's incident table answers in one read is
stated in no single greppable line. Full context wins outright only at a corpus
size that fits in a window, which months of history do not. **The vault's
measured value is organization, not compression.**

## `credentials.rs`

API keys, from the OS credential store (`keyring`, service "nightloom") or the
environment, **stored winning over env**.

It is here rather than in either shell because both need the *same* answer. It
began in the desktop's `main.rs` next to the settings pane that writes it, which
left the CLI env-or-nothing and made the two shells disagree — a key entered in
the app was invisible to `nightloom`, and the only symptom was a 401 in one shell
and a working session in the other. So the order is one function (`provider_key`
/ `search_key`) rather than two that agree today. Both shells pass the result to
`connect` as an explicit `api_key`, so the registry's own env fallback only ever
runs for a caller that has not asked.

Not in `nightloom-providers`, because that crate is wire formats and a keychain
is not one; not in a crate of its own, because `tools::env_search_key` — the
environment half of the same question — is already here.

**Every read is `Option`-shaped and never blocks.** The CLI runs over SSH, in
containers and in CI where there is no D-Bus session and no unlocked keyring, and
a lookup that popped a GUI unlock dialog on a headless box would be worse than no
store. An absent, locked or broken store reads as "no stored key" and falls
through to the environment, which stays a first-class path rather than a
deprecated one. Only *writes* report failure.

Search keys are namespaced `search:<name>`, since providers and backends share
one keyring service and a future provider called "brave" would otherwise read a
search key as its API key; a test pins that. The `keyring` feature is default-on
and removable — reads then return `None` and writes
`CredentialError::Unsupported` — which is also what lets a build skip the Linux
D-Bus headers CI now installs.

## `import.rs` — the claude.ai export

A claude.ai account export becomes projects, and it is a *mapping* rather than a
translation because the two systems name the same four things: a project is a
project, its `prompt_template` is `AGENTS.md`, its `docs` are the docspace, its
conversations are session logs. Nothing new is stored to make that work.

It takes the `Registry` rather than leaving registration to the caller: a
project's id decides where its store is, so nothing can be written until the
project exists. `ImportOptions.into` is **optional and normally omitted** — an
imported project has no folder, because a claude.ai project has no code. Pass one
when the user means to keep code alongside them.

The account-wide privacy export is the **only** way in — there is no Projects API
and no per-project export — so the reader takes the emailed zip directly, "unzip
it first" being a step that goes wrong on a 400 MB archive and buys nothing.

### The archive is undocumented and has already moved

Projects used to be one `projects.json` holding an array; current exports ship a
`projects/` directory with one file per project, each holding the object that used
to be one element of it. Both are read, the array preferred and the directory
walked *only* when it is absent — an archive carrying both would otherwise import
every project twice.

Knowing only the array is how this shipped, and the failure has no symptom to
notice: no project parses, so no instructions and no documents are written, and
every conversation falls through to the unfiled path. Nothing errors; it reads as
an account whose projects were all deleted.

Restoring the projects cannot restore the **filing** — measured on a real
1,823-conversation export, `project_uuid` occurs zero times in the whole file, so
the link is simply not in the archive. An import that finds projects and files
nothing under them therefore says so in words, at the *head* of the warning list
rather than appended to it: every other line there is one record that could not be
read, both shells clip the list, and this one is about the import as a whole.

### Two decisions carry the module

**A conversation is linked to a project by id or not at all.** `project_uuid` is
on some accounts' conversations and absent on others, and the fallback every
other tool in this space uses — matching a chat to a project by keyword
similarity on its *name* — is refused here, because the projection reads the
docspace of whatever project a chat lands in, so a mis-filed conversation comes
back with another project's notes in its system prompt. An unlinked chat is
reported as unfiled and imported only on `--unfiled`: a gap the user can see
rather than a mistake they cannot.

**claude.ai's tool calls are flattened to text and never replayed as tool
blocks** — the safety-critical half. A `tool_use` in an export names artifacts,
web search or the analysis sandbox, none of which are on a Nightloom request, so
recorded as a `ContentBlock::ToolUse` it would be either an orphan (the exact 400
`orphan_marker` exists for) or a call to a tool that was never advertised. An
artifact keeps its content whole, being usually what the conversation was *for*,
while a machine-generated result is capped like any other tool output.

Thinking is kept and kept **unsigned**, which needed no new rule: an adapter
replays only a reasoning token it issued itself, so imported reasoning renders in
the transcript and can never be forged onto a wire.

### Shape, order, idempotency

A conversation is a **tree** — editing a message branches it — so the live path is
walked back from `current_leaf_message_uuid` and off-path messages are counted
rather than written, since importing every branch in index order reads as the same
question asked twice with two different answers.

Order is otherwise the file's own, and `created_at` is deliberately *not* a
tiebreak: its granularity ties on a fast exchange, and a stable sort on a tied key
silently reorders the pair — which turned `user, assistant, user` into `user,
user, assistant` on the first fixture with two messages in the same second.

Idempotency is the filename rather than a check somebody remembers to run: the
conversation's uuid is the session id and the log is created with `create_new`, so
a second run counts what it already has. (`Session::with_log_as` is the
constructor that exists for this, and it validates the id, an export being a zip
that arrived by email.)

The written log is stamped with the conversation's own mtime, which is not
cosmetic: `store` sorts on it and `--continue` opens the newest, so leaving it
would flatten a year of history into one afternoon *and* hijack `--continue` in
the imported project.

Re-importing is the ordinary way to pick up chats you have had since the last
export, so **nothing already on disk is overwritten**: a note or an `AGENTS.md`
that has been edited is left alone and said out loud, one that is byte-identical
is not mentioned at all, and a conversation already present is counted rather than
rewritten. An import that could undo a week of notes would be a worse feature than
no import.

### Reading is total, inside a record too

One unparseable record costs a line in the report, not the other nine hundred.
That applies **inside** a record through `null_as_default`: `#[serde(default)]`
answers a field that is *absent*, not one that is present and null, and the export
does not observe the distinction. A real archive writes `"file_name": null` on an
attachment whose name claude.ai no longer has, and one of those failed the whole
conversation it appeared in — six chats out of 1,817, each otherwise perfectly
readable, dropped over a field nothing downstream reads on an attachment
carrying its `extracted_content` regardless.

Every non-`Option` field in the exported shapes therefore reads a null as its
default. `Option` fields are left alone, null being already what they are for, and
`ExportedConversation::uuid` keeps no default at all, since a conversation with no
id has no session filename and no idempotency key and genuinely cannot be
imported.

## `store.rs` — session-log discovery

`list` → `SessionSummary`, `find_by_prefix`, `latest`, plus `search` and `delete`
(by id or prefix). `SessionSummary::label` is title-or-opening-message, so two
shells listing the same directory cannot disagree about what a chat is called.

`search` is case-insensitive substring over **the conversation only** — user
messages, assistant text and the title, never tool results. A tool result is
whatever a file happened to contain, so including them returns every session that
ever read a file mentioning the word, which is close to all of them and never the
one being looked for. Superseded turns are searched like any other, since a chat
you rewound is still the chat you are trying to find. A hit in the *name* is the
last-resort excerpt rather than the first, the name being already the row's label.

`find_fold` walks the original string rather than lowercasing it and calling
`find`, because lowercasing can change a string's length and the returned offset
then points somewhere else in the string the caller is about to slice.
`excerpt_around` clips around the hit rather than from the start, since a match
3,000 characters in would not appear in a leading excerpt and a result that does
not show why it matched reads as a false positive.

### Listing is a cache, not an index

`list` used to read every byte of every log: on a corpus of 1,800 imported
chats (106 MB) a warm listing took **237 ms**, and it ran on every rail
refresh, because `ProjectInfo` reached for `list(dir).len()` to fill in a
chat count. It now takes **3.8 ms**. Four changes, in the order they matter:

- **`count`, not `list().len()`.** A project row wants a number `read_dir`
  already knows. Nothing else in that call ever needed a log opened.
- **`log_files` takes size and mtime off the `DirEntry`.** On Windows the
  directory scan already carries both, so `entry.metadata()` is free where
  `fs::metadata(&path)` re-opens the file — measured at 34 ms of the 40 ms
  that remained once the reads were gone, and more than everything else in
  `list` put together. `latest` got the same win for nothing.
- **`Peek`, a three-variant mirror of `SessionEvent`,** and `LISTED`, which
  matches the raw line before any parsing. Deserializing an internally-tagged
  enum buffers the whole object even to throw it away, so without the
  prefilter a 60 KB tool result costs 60 KB of parse to learn it is not a
  title. This is the only part coupled to the writer — it needs compact JSON —
  and `a_listing_reads_the_tags_the_writer_actually_emits` pins it against
  `Session`'s own output rather than against a literal.
- **`Listing`, a `.listing.json` beside the logs.**

The last is a **cache and deliberately not an index**, and the distinction is
the whole design:

- The logs stay the only source of truth. Every entry is re-validated against
  its file's size and mtime on each listing, and *anything* unexpected —
  missing file, wrong version, unparseable JSON, a size that shrank, a clock
  that went backwards — falls through to reading the log. The worst a stale or
  corrupt cache can do is cost one rescan.
- An index that writers maintained could instead be **wrong**, and the way it
  would show is a session that exists not appearing in the picker. That is the
  worst available bug in a resume picker, and it does not self-heal.
- It would also have more than one writer, one of them a different process:
  `Session::record` appends, but the importer writes its logs directly and
  backdates them with `stamp`, never touching `Session` — and the CLI and the
  desktop write the same directories at once. That means a lock and a
  crash-consistency story between the log append and the index update, which
  is exactly the complexity `record` was simplified away from.

It is cheap because logs only ever grow: `id` and `first_user` fix at their
first occurrence, `user_turns` counts upward, `title` is latest-wins. So an
entry carries a **byte offset** and a log that gained a turn costs the bytes it
gained. The offset stops at the last newline, so a log being appended to right
now is not half-counted and the torn line is re-read next time — the same rule
as the dream's watermark, for the same reason. Writes go through a
process-named temp file and a rename, so two shells listing at once lose an
update rather than a file, and a directory that cannot be written to still
lists.

**One bad row costs the row, not the listing.** A picker that shows nothing is
worse than one that shows all but one chat, and both readers used to fail
whole over a single file: a log deleted between the directory scan and the
open — one window deleting a chat while another lists — took the listing down
with it, and so did a *directory* named `something.jsonl`, which fails to open
with a different error on every platform (`IsADirectory` on Linux, access
denied on Windows). `skip_deleted` now drops a row whose file is `NotFound`,
`log_files` skips directories, and `log_paths` makes the same not-a-directory
test from the entry type so `count` cannot disagree with the `list` it labels.
Every *other* error still propagates: quietly returning a short list is the
silent-truncation bug, not the fix for it.

`search` is not cached and not cacheable this way: it needs the text a summary
throws away. What would help it is a full-text index, which is a much larger
thing — and search is something a user asks for, where listing happens on its
own. Both now read bytes rather than `read_to_string`, so one byte that is not
UTF-8 costs that line instead of returning an empty picker.

## `lib.rs::connect`

Builds a provider (explicit `api_key` wins over env), resolves the model, wraps
in `Retry`, and re-exports `list_models`.
