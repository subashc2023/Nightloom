# apps/desktop — the Svelte frontend

Svelte 5 over the Tauri backend in [desktop.md](desktop.md).

## The types seam

`src/lib/types.ts` mirrors the serde shapes of `TurnEvent`, `SessionEvent` and
`ContentBlock` — changing those enums means updating that file.

Unknown tags are ignored on both sides (the TS unions skip what they do not
match, and the Rust side has `SessionEvent::Unknown`), so additive variants are
safe. `BlockSource` has a third arm, `repair`, for a block the projection
supplied rather than an event produced; the panel offers no remove button for it,
since there is no log event behind it to act on.

**The weakest seam is field *names***: renaming a field on `ImageInput` would
silently yield `undefined` in a `data:` URL rather than a type error, so both
sides stay snake_case (`media_type`, matching `context_limit` / `key_source`).

The transcript is a projection of `SessionEvent[]`; after each turn the UI
re-syncs via `transcript` rather than trusting its live buffer.
Between send and the first streamed event the live buffer is empty, and an
empty buffer used to render as nothing; now it renders as a waiting row — the
moon icon rolling a short way and back, three still dots under
`prefers-reduced-motion` — that the first delta, tool call or error replaces
(nightshift backlog 049). It carries no text, because the UI cannot see
whether anything is progressing, only that nothing has arrived.

## The window frame

**No system frame on Windows and Linux; the title bar is ours. macOS keeps its
frame and gets a menu bar instead** (`build_window` / `mac_menu` in `main.rs`,
`TitleBar.svelte`, `platform.ts`).

A dark app wearing a light-grey system caption strip is the one place a Tauri app
announces that it is a webview, and the frame is also the only part of the window
the theme could never reach.

The window is built in `setup` rather than declared in `tauri.conf.json`, because
what it should be **differs per platform and the config file has no way to say
so**: Windows and Linux get `decorations(false)`. Declaring `decorations: false`
in the config and undoing it for macOS at runtime is worse in both directions —
there is no runtime setter for the macOS title-bar style, so that platform would
get a system caption bar *above* ours, and the platform this exists for would
show a system frame for however many frames the setup hook takes.

`build_window` runs **last** in `setup`, after `app.manage`: the webview starts
loading the moment the window exists, and its first paint calls straight into
`providers` and `list_sessions`, which resolve `State<AppState>` and panic if
nothing has managed it yet.

The bar spans the **whole** width above the three columns rather than sitting
inside the centre one, because it is the window's chrome and not a toolbar — with
no system frame there has to be somewhere to grab at the top of the screen
wherever the pointer is, including over the sidebar and the rail. The wordmark
that used to head the sidebar moved into it, so the app is no taller in chrome
than it was with a system caption bar, and the settings gear moved up out of
`TopBar.svelte` for the matching reason: that bar describes the *conversation*
(which model, how full its window is, what it has cost) and settings are about
the app.

Dragging and double-click-to-maximize come from `data-tauri-drag-region="deep"`,
whose injected handler treats clickable elements as blockers on their own, so the
four buttons need no opt-out — `isClickableElement` sees the `BUTTON` before it
sees the region and returns false, which is why the gear can sit inside the drag
region at all.

Three things the system used to keep are now state to track:

- **the maximize glyph** — a restore icon on a windowed window is the one wrong
  thing a caption bar can do and still look plausible. `onResized` reports it,
  since dragging a window to the top edge maximizes it without the button being
  touched, coalesced because that event fires every frame of a resize drag.
- **focus** — the bar dims like every native one, which is most of what makes a
  background window read as background.
- **the OS title**, set to the chat's name: five alt-tab entries all reading
  "Nightloom" say less than the names the sidebar is already showing.

`platform.ts` reads the OS from a global that `build_window` plants with an
initialization script rather than from a command, because the bar needs it
*before the first paint* and a bar that laid itself out twice would flicker on
every launch.

**Resizing needs nothing from this end on either platform**, which was found
rather than assumed: an undecorated window's edges are hit-tested by
`tauri-runtime-wry`'s `undecorated_resizing` — a `TAURI_DRAG_RESIZE_BORDERS`
child window on Windows and a GTK button-press handler on the webview for Linux,
both over a five-pixel inset, both checking resizable-and-not-maximized. This
shipped with eight `startResizeDragging` grips for Linux written against the
assumption that GTK left an undecorated window no grab; they duplicated the
handler already under them at the same inset, and are gone, along with the
`allow-start-resize-dragging` permission they needed. The Windows child window is
visible in the running app's child-HWND list, which is how the pair turned up.

What is *not* reimplemented is Windows 11's Snap Layouts flyout, which needs
`WM_NCHITTEST` to answer `HTMAXBUTTON` and so a `windows-sys` dependency and a
window subclass — the maximize button works, hovering it just does not open the
layout picker.

Every one of these is an IPC call now, so `capabilities/default.json` carries
them explicitly: `core:window:default` grants only the questions and
`allow-internal-toggle-maximize`, not dragging, the three caption buttons or the
title.

### macOS is the platform this is *not* done to

Arrived at rather than assumed. The obvious move there is what every modern Mac
app makes — hide the title and overlay the traffic lights on our own bar
(`TitleBarStyle::Overlay` + `hidden_title`). It shipped that way for one commit
and was reverted: a window zoomed with it on leaves a strip of the desktop
showing along the top, the frame's height coming out of the window with nothing
filling it. A sliver of somebody's wallpaper above the content is a worse failure
than a system title bar, which is at least what the platform looks like.

So macOS gets its frame whole, `TitleBar.svelte` renders **nothing** there (a bar
of ours under the system's is two title bars), and what would have gone in it
goes in the **menu bar** — the native answer anyway, and the one piece of chrome
that already melds with the notch.

Three consequences. The **wordmark is absent on macOS**, because the menu bar is
already showing the app's name two millimetres above and a window that says it
again is a port announcing itself. The **OS title is the bare chat name** there
rather than `<chat> — Nightloom`, for the same reason.

And **`mac_menu` is not decoration**: Tauri installs a default menu on macOS when
an app sets none, and replacing it is where the trap is — a webview on that
platform takes ⌘C and ⌘V *from the menu*, so a custom menu without an Edit
submenu silently breaks copy and paste in every text box the app has. The
custom items (four at first — Settings ⌘,, New Chat ⌘N, Open Folder as Project…
⌘O, Import from claude.ai… — and, since the 2026-09-13 chat-surface redesign, View → ~~Model, Tasks
& Context ⌘M~~ Model & Tasks ⌘M and Context ⌘⇧C (the Context tab left the popover
for its own button under the top bar's gauge, review round 1 the same evening),
Command Palette… ⌘K, Switch Project… ⌘P, Switch Engine ⌘E, and a
Model menu with Sonnet ⌘⇧S, Opus ⌘⇧O, Fable ⌘⇧F, Haiku ⌘⇧H — **the Claude
Code engine's aliases only, since 2026-09-14**) are **forwarded to
the webview** as a `menu` event carrying the item's id, and `runMenuCommand` in
`state.svelte.ts` acts on it: each one is a frontend flow — a modal, a file
dialog, a re-connect — and the backend has no way to run half of one. Nothing is
reachable *only* from the menu, so no other platform is missing a capability: on
Windows and Linux `App.svelte` binds the same chords itself (guarded off on macOS
so nothing fires twice). ~~A model key switches the picker to the first id carrying
the alias; a provider with no such id gets a toast and no change.~~ **2026-09-14,
his second look — "anthropic shouldn't be special":** on the API engine the
picker's models are **⌘⇧1…9** in the popover's order, every provider alike
(`pickerModels` / `switchModelAt`, bound in `App.svelte` on every platform), and
the four letters decline there with a toast; on Claude Code the letters set the
CLI's alias as before. Shift means model on both engines. ~~⌘⇧1…9~~
⌘1…9 (bare ⌘ since his second look: "anthropic shouldn't be special") is the
n-th provider pill, bound in `App.svelte` on every platform — it is not a menu
item (the pills are dynamic), so macOS cannot double-fire it; matched on
`e.code` so a layout cannot move it. It works from anywhere in the window, the
popover open or not. ⇧ in a key cap is Shift, never caps lock (⇪); the cap's
tooltip spells the chord out.

The menu is registered `#[cfg(target_os = "macos")]` and only there, because on
Windows and Linux a menu is drawn *inside* the window under a caption bar this
app no longer has, which would put a grey strip across the top of a themed window
— the exact thing the borderless frame exists to be rid of.

The macOS path cannot be compiled from this repo's usual CI
(`objc2-exception-helper` needs a real Objective-C toolchain, so `cargo check
--target aarch64-apple-darwin` fails on any non-Apple box). It was verified by
temporarily flipping those `cfg`s on and building the same code on Windows, which
is the check to repeat when touching it.

## The right-hand rail

`RightRail.svelte` with ~~three~~ two tabs (Context moved out, review round 1
2026-09-13 — see below):

- **`ProviderRail.svelte`** — the engine as two radio cards (who is billed, who
  runs the loop), provider pills, a model radio list (each id's ⌘⇧ key and
  context window), thinking as a segmented control, and seven switches each with
  a `?` carrying its explanation: tools, ask-before-writing, web access and
  self-compaction (the last three shown only with tools on), knowledge, preamble,
  and per-turn status. It re-connects on every change and auto-connects at
  launch to the last-used draft. (Redesigned 2026-09-13; the dropdowns it
  replaced were the same knobs.) The preamble switch shows on both engines
  since 2026-09-14, with an engine-aware hint: on Claude Code it gates what
  `connect_agent` appends to the CLI's own prompt.
  On Claude Code the model is a row of alias pills (default · fable · opus ·
  sonnet · haiku, each with its key) plus *other…* for a typed id, and the
  Binary field sits at the foot under **CLI** — set once, read never. The
  *Providers, keys & models…* button closes the popover as Settings opens, and
  the system-prompt pencil closes it, opens the library, and reopens it
  scrolled to the dropdown when the library closes (`app.promptsFrom`,
  `app.railScrollTo`). The library's edit lives in `app.promptDraft`, so no
  way out of the modal loses typed text.
- **`TaskPanel.svelte`** — the model's task list, badged with the open count.
- ~~**`ContextPanel.svelte`** — the `WireView`; see [desktop.md](desktop.md).~~
  **`ContextPanel.svelte`** is ~~its own popover now~~ **a centre modal since
  2026-09-15 (nightshift backlog 056)**, opened from the top bar's
  context gauge (which reads *Context* before any usage) or ⌘⇧C. ~~On Claude Code
  it explains rather than vanishes: the panel itemises the request Nightloom
  is about to send, and that engine's CLI assembles its own — Nightloom appends
  its preamble to it (2026-09-14), but the request is the CLI's and there is
  nothing to take apart.~~ **Superseded later on 2026-09-14 (nightshift backlog
  048):** the panel shows on both engines. Its System section is the whole
  prompt: one row per layer in ladder order (identity, environment, user
  memory, model instructions, project instructions — one sub-row per
  `AGENTS.md` on the walk — notes index, vault index, and on Claude Code the
  engine note), each row unfolding to the segment's **full text**
  (`WireSegment.text`), and *Show as sent* rendering the exact string the
  backend sends (`WireView.system_text`) with a Copy button. The library prompt
  is listed last without a switch — it has the rail's dropdown. On Claude Code
  `context_view` returns the bridged segments with no messages, and the
  Conversation section says the CLI holds the history; the *gauge* still
  counts, from the usage the CLI reports per turn.

  **Redrawn 2026-09-15 (nightshift backlog 056)** after he could not find
  the unfold or *Show as sent* in the popover: the page is a modal on the
  same overlay as Settings (`App.svelte`, `settings-overlay`; the TopBar
  chip and ⌘⇧C still toggle `app.showContext`), because a 32 KB `AGENTS.md`
  at reading size does not fit a 340 px column. **Each layer is a card** in
  the Settings idiom — the rail's switch, the name, a one-line gloss in plain
  words, the layer's size, and a **Read** button with a chevron that opens the
  full text in place in the transcript's face and size (`--transcript-font`,
  `--transcript-size`) in a box that scrolls past 22 rem, with Copy per file.
  An off layer is struck through with "off for this chat" beside it in words;
  a layer with nothing on disk says "nothing to send". **Layers · As sent** is
  a segmented control in the page head; *As sent* is one card with the string,
  its length and Copy. The Conversation section comes second, its gauge in
  its heading row and the bar under it; the Claude Code caveat is one dim
  line under the cards.

  **Each layer row has a switch** that turns the layer off *for this chat*:
  the row is struck through while off, so a blind test is visible while it
  runs, and the layer is absent from *as sent*. A flip records
  `SessionEvent::PromptLayers` in the chat's log (`set_prompt_layers`, which
  creates the log if the first send has not) and reconnects the way a rail knob
  does, so `connect` / `connect_agent` read the set back; the switches
  themselves project the log (`promptLayersOff` in `state.svelte.ts`, a copy of
  `Session::prompt_layers_off` on the same terms as the todos). Reopening the
  chat keeps them, and opening a different chat reconnects if its set differs
  from the one the engine was built with (`syncPromptLayers`, run from an effect
  in `App.svelte`; `prompt_layers` returns both sets). Identity and environment
  have no row on Claude Code — they are the CLI's own — and that engine's rows
  carry the caveat that a resumed chat on CLI ≥ 2.1.265 keeps its recorded
  prompt until the next compaction. With the rail's Preamble switch off the
  per-chat switches are disabled: nothing is left to remove. ~~**Deliberately not
  built:** rewriting a layer's text for one chat — the store editors and the
  library prompt are where text is edited; see
  [service-prompt.md](service-prompt.md).~~ **Superseded 2026-09-15 (nightshift
  backlog 057), his call — "changing the actual information per chat just in
  practice means changing what the flag is attached to".** The Memory, Model
  instructions and Project instructions cards carry **Edit for this chat**: the
  body opens as a textarea at reading size, seeded from the chat's own text or
  else from the file (`prompt_layer_file`, the same read the prompt makes), and
  *Save for this chat* records it as `SessionEvent::PromptLayers.edits`
  (`set_prompt_layer_text`) and reconnects the way a switch does. The card then
  says **edited for this chat** and *as sent* carries the wrapped override;
  **Revert to the file** drops it; **Make this the file** closes the page and
  opens the store editor (Notes → Memory / Instructions, or the model's file)
  with the override in the buffer as a draft through `noteDrafts` — the ● marker,
  Revert and Save all apply, and nothing is written until Save is pressed there
  (`promoteLayerText`). Overrides project off the log like the off set
  (`promptLayerEdits`), survive reopen, are compared on reconnect
  (`syncPromptLayers` reads `edits` / `built_edits`), are undone by a rewind
  past them, and are not offered for the indexes, identity, environment or the
  engine note. The fork the old paragraph worried about is now visible — the
  card says so and the dream still proposes against the file. One popover is
  open at a time (`app.showRail` / `app.showContext`).

The thinking dropdown is capability-aware via `catalog.ts::thinkingSupport(kind,
model)` — Claude 5 → adaptive effort, Claude ≤4.5 → budget, OpenAI → effort incl.
minimal, Gemini 2.5 → budget vs Gemini 3 → level low|high, Groq/openai-chat →
effort, OpenRouter → both — with a per-target note. `sanitizeThinking` coerces
invalid saved modes to `default` before connect. Adapters still fail loudly: the
UI table is a projection, so keep the two in sync.

The knowledge switch is on screen rather than implied by the tools switch because
it is a change in *reach* — tools alone has always meant "may write inside this
folder" — and the rail names the directory under it.

## Settings

`SettingsModal.svelte` is a sidebar-nav modal (provider list left, one pane at a
time) managing per-provider API keys, rail visibility, the model picker, web
search keys, the vault's folder, the projects folder (since 2026-09-14, the
*Projects folder* row), the usage ledger (the *Usage* row, the same day —
below), and — since 2026-09-14 — the per-model
instruction files (the *Model instructions* row; the files themselves are
described under Notes below). That pane lists every file, has *+ Add for
`<current model>`* for the one the rail is on, and — later the same day,
nightshift backlog 053 — an *Any model* picker under it: a provider (every
one the app knows, plus the Claude Code engine) and a model from that
provider's known list, or a typed id, with a dot for whether its file exists
and one button, *Open* or *Create*.

API keys entered in-app live in the OS credential store (`keyring` crate, service
"nightloom", user = provider label; `openai-chat` falls back to `openai`'s stored
key) and win over env vars; the UI only ever sees `key_source`
("stored"/"env"/null), never the key.

The curated model list, visibility prefs, last connection and saved system
prompts live in `src/lib/catalog.ts` + localStorage (`nightloom.catalog-prefs`,
`nightloom.last-connection`, `nightloom.prompts`).

### The vault's folder

A pane beside Providers and Web search: the path, a native folder picker, and
Reset to default. Repointing writes a path and **moves nothing**, which the pane
says out loud — it is what makes an existing Obsidian vault usable as-is, and
what stops a changed setting from relocating somebody's notes.

`useKnowledgeDir` re-connects afterwards, because the vault is part of what
`connect` roots the tools at and indexes into the preamble; leaving it would have
the sidebar showing one folder and the model reading another.

Reviewers are built from the window's `ChatSpec` with `knowledge` cleared, on the
CLI's argument about a second vendor. `connect_agent` reports it as `null`, since
Claude Code owns its own file access and a chip naming a folder that engine never
reads would be worse than no chip.

### The projects folder

A row *Projects folder* beside the vault's, in the same shape: the path, a
native folder picker, Reset to default, and the sentence that repointing
**moves nothing** — the projects already made are registered by their own paths
and stay where they are; this only decides where *New project…* puts the next
one. Recorded in `~/.nightloom/projects-folder.json` (one `dir` key, absent
means the default; `projects.json` is the registry, so the vault's
`<thing>.json` convention could not be followed literally).

The default is worked out from the registry rather than hard-coded
(`project::default_projects_folder`): the parent of the most recently
*created* project whose workspace sits in a folder literally named `projects`
— where a claude.ai import put its projects, and where the user has been
keeping them since — else `~/Documents/Nightloom/projects`. A project
registered from somewhere else (a repository checked out beside the projects
folder, created later) is skipped rather than allowed to move the default: its
parent says nothing about where new ones go. Most recently *created* rather
than opened, because where the user last made a project is where they are
keeping them now.

### Usage

A row *Usage* under its own heading, since 2026-09-14 (nightshift backlog
045; blocker 060 chose a Settings pane over anything in the transcript, on
the dashboard's own reasoning that text in a message is stored and replayed
forever). The nav row carries a dot for whether a ledger exists and the
seven-day figure; the pane, in order:

1. **Spend** — a table of models down and three windows across (today, the
   last 7 days, the last 30 days; UTC days, inclusive), dedup basis, with a
   total row. A model's `main` and `subagent` scopes are added together; a
   fast-mode request is its own row suffixed `#fast`. A model the rates
   table does not price is listed under the table as counted-but-unpriced
   rather than shown as $0.
2. **Surfaces** — the newest snapshot's split of the weekly limit by surface
   (Claude Code / chat / cowork / other) and the weekly-cap line: the
   all-models cap's fill and the per-model scoped cap's, with the window
   start and the snapshot time in UTC.
3. **Ledger** — the directory, the first and last dates on record, when the
   CSV was last written (its mtime, relative and absolute), and the one-line
   note that the collector is `~/.claude/usage-ledger.py` on a six-hourly
   LaunchAgent and that Nightloom writes none of it.

The pane's opening paragraph carries the stance: these are the API's own
usage fields priced by `usage-rates.json`, so turns run on a subscription
are shown as what they *would* have cost, not as a bill — the same sentence
`docs/service-agent.md` gives for the Claude Code engine's dollar figure.
The numbers come from one Tauri command, `usage_ledger`, which returns
`available: false` and a reason (never an error) on a machine where the
collector has not run, so Settings opens either way; the modal reads it once
on open, for the nav row, and again whenever the pane is shown. The reader
and the formula are `crates/nightloom-service/src/usage.rs`, documented in
`docs/usage-ledger.md`.

### The model picker

Candidates are curated ∪ custom ∪ live-fetched (via `list_models`), in that
order — curated, then fetched, then custom — and **that order is load-bearing**:
`customModels` is *also* the storage for "this id is on", so an id from the API
joins it the moment it is switched on. Read before the fetched list, turning one
chip on moved its whole family (which sorts by its first member's index) to the
top of the list under the user's cursor.

~~It is **cartouches, not a checkbox column**~~ — **since 2026-09-13 it is rows**
(checkbox · id · `default` pill · "n dated releases" · context window) under a
strip of every id that is on, in `modelsFor`'s order, which is the popover's own
(Swaraag's pick, nightshift blocker 033). Two shaping passes
(`catalog.ts::groupModels`) are what make a fetched list readable either way: a
vendor's `/v1/models` is a few hundred ids in its own order, and most of that
length is the same handful of models wearing different release dates.

**Folding** collapses `-20250219` / `-2025-02-19` / `-latest` / `-001` variants
onto one row, whose id is always a string the vendor actually listed — untagged
if there is one, else `-latest`, else the newest snapshot — since a synthesized
base is a 404 the user finds out about a turn later. A "n dated releases" toggle
(the `+n` badge before the redesign) opens the group to pin a specific snapshot,
and one already pinned stays visible unasked, or it would be a model in the
popover's list with no switch anywhere to turn it back off.

**Grouping** is a trie over `-`-separated tokens (a vendor path being one token),
which finds real families where a character-wise common prefix would not — `gpt-5`
and `gpt-oss` share four characters and nothing else. It splits a group at its
first branching token only when the group exceeds `FLAT_MAX`, and recurses, so
depth follows how crowded a branch is: OpenRouter's list splits by vendor and
again inside whichever vendor is large, while a six-model provider stays one
unheaded list.

Both passes are pure presentation — nothing here rewrites a preference or invents
an id.

### The prompt library

`PromptLibrary.svelte`: named system prompts the rail picks from a dropdown,
edited in a modal with a full-height editor.

Applying one **copies** its text onto the draft rather than referencing it
(`ConnectionDraft.promptId` records which entry it came from, by id so a rename
does not orphan it), so editing a library entry cannot silently change the prompt
a chat is already connected with. Saving an edit to the *active* entry
re-connects, which is the one case where it should.

They are app-wide rather than per-project because a system prompt is about how
you want the model to behave, not about a folder, and the quickest thing this app
does is an unfiled chat with no folder to read one out of. Anything that *is*
about the project belongs in the docspace the preamble already indexes.

## Notes: two stores in one panel

Notes are a **first-class surface, not a hidden folder**. `NotesPanel.svelte`
shows *Project* (`<workspace>/.agents`) and *Knowledge* (the vault) as sections,
and `NoteView.svelte` edits either in the centre pane, replacing the transcript
rather than floating over it, because reading and writing a note is work and not
a dialog.

Two sections rather than a third sidebar tab, because "where did I write that
down" has two answers and the user should see both without choosing first. The
Knowledge section renders **with no project open**, which is the headline rather
than a detail: the quickest thing this app does is a chat with no folder, and
until the vault existed that chat had no notes of any kind.

The four note commands take a `scope` (`project` | `knowledge`) instead of
gaining four siblings, since the operations are identical and only the directory
differs.

**Since 2026-09-14 the scope also names the two always-loaded files:**
`instructions` is `<workspace>/AGENTS.md` and `memory` is
`~/.nightloom/AGENTS.md` — the halves of each store that the preamble reads
*whole* rather than indexing (see [service-prompt.md](service-prompt.md)).
They had no editor: the project menu said where `AGENTS.md` lived and the
user memory file was reachable from nowhere in the app. Each section of the
Notes panel now leads with a pinned row (*Instructions* over the project
notes, *Memory* over the vault) that opens the same `NoteView`. The scopes
are one fixed file each: `list_notes` refuses them, `read_note` answers an
absent file with empty text rather than an error (the editor opens on it so
the first line can be written), and `delete_note` refuses them — emptying the
text is the reversible form, per the never-lose-work rule. Saving either
re-connects the live connection (`saveNote` → `applyDraft`), the rule the
prompt library already follows for its active entry, because the preamble is
assembled once at connect and an edit would otherwise sit unread until the
next chat. The editor's footer says so and says *whole*, where the notes'
footer says *name and first line*.

**Drafts (same day, his review):** typing into a note, leaving it and coming
back found the edit gone — the editor reloaded the file. Unsaved text now
lives in `app.noteDrafts`, keyed `scope:name`, for the life of the app (the
never-lose-work rule); reopening a note with a draft shows the draft over the
saved baseline, marked *● draft*, with **Revert** (back to the last saved
text) beside **Save**. The mirror into `noteDrafts` is keyed to the note
*whose text is in the buffer* (`bufferKey`, set by `load` after the read),
not to the selection: the selection changes a tick before the buffer does,
and the first version wrote the previous note's unsaved text as a draft under
the next note's name. An unrecognized value is an error rather than a default, because a typo
that quietly wrote a personal note into somebody's repository is exactly the
failure the split exists to prevent.

**A fifth scope, `models` (2026-09-14, nightshift backlog 044):**
`~/.nightloom/models/`, one file per model id, read whole into the preamble of
a chat on that model and no other (see [service-prompt.md](service-prompt.md)).
A folder like the two stores — it lists and deletes — but its names are ids:
`<id>.md`, with a `/` in the id written `__` (`modelInstructionFile` in
`catalog.ts`, the same rule as the backend's). `read_note` answers a missing
file with empty text, as for the fixed files, so the editor opens on a model
that has none yet; saving re-connects like `instructions` and `memory`, and an
empty file is treated as absent. It is not in the Notes panel. It is reached
from two places: the **Model instructions** row in Settings (under Knowledge),
which lists every file with its id and size and has *+ Add for `<current
model>`* — the rail's model, or on the Claude Code engine its alias — and the
pencil under the model list in the popover. Both close the surface they are on
and open `NoteView`; Save and the back button bring it back (`closeNote` reads
`app.noteFrom`; the popover scrolls to its model list, Settings reopens on the
row), the round trip the prompt library makes for the popover.

The Settings row also reaches a model the chat is *not* on (backlog 053,
2026-09-14): the *Any model* card below the list is a provider select — every
provider plus the Claude Code engine — and a model select filled the way the
provider's own pane is (curated, the API's list where a key exists, custom,
the provider's default; on the engine the four aliases), with an *Other —
type an id…* row for anything unlisted. A dot and a line say whether
`modelInstructionFile(id)` is in the folder; *Open* opens it in `NoteView` by
the same path as *+ Add for*, and *Create* first writes it through
`save_note("models", …)` with one header line naming the pair
(`<!-- model instructions · <provider> / <id> -->`, `instructionFileFor` in
`catalog.ts`), then opens it. The provider is in that line only: the file is
keyed on the id exactly as the preamble keys it, so nothing about which file a
chat reads changed. A file created and left with only its header is non-empty
and so is sent — one comment line — until it is emptied or filled.

**The Dream button (Knowledge bar, `Dream · N`, hidden at zero)** runs the
consolidation pass over the observation inbox (the mechanics are in
[service-data.md](service-data.md) under *Scheduling*). Since 2026-09-14 the
pass files per project — an observation recorded in a registered project lands
in that project's `.agents/memory/`, the rest in the vault — and the button's
shape is unchanged; only the toast shows the split: *dream: consolidated 5
observations — 3 into Lanternfish, 2 into the vault — Lanternfish's .agents
committed (a1b2c3d); vault unchanged*. `DreamReport.filed` carries the split in
turn order, projects first and the vault last, and `git` is one clause per
folder. The Project section's listing picks the new memory notes up on the
same `refreshNotes` as everything else.

**The Capture button (Knowledge bar, `Capture · N`, always visible)** runs the
pass that fills the inbox the Dream button drains: it reads every chat log
since its watermark — each project's and the unfiled ones — and extracts
observations on the dream's connection (the Settings model, else the rail's;
`passTarget` in `state.svelte.ts` is the one place both buttons ask). N is the
number of logs with something new (`capture_status`, a directory scan after
every turn), not the inbox count, which is why the button does not hide at
zero the way Dream's does: the chat open right now is always one of them. It
shares the dream's one-at-a-time lock and its Stop, and the toast reads
*capture: captured 4 observations from 3 chats — 3 from Lanternfish, 1
unfiled; 2 waiting for more turns*. With the Settings toggle on, the
after-compaction trigger runs a capture first and then the dream. The
mechanics are in [service-data.md](service-data.md) under *Capture*.

**Proposed changes to the two fixed files (2026-09-14, memory-writer 6c).**
The dream may *propose* a replacement for `Instructions` or `Memory` — never
write either; the mechanics and the guarantee are in
[service-data.md](service-data.md) under *Proposals*. Its toast ends *— and
proposed a change to Lanternfish's instructions — review it under Notes*, and
the pinned row grows a `1 proposed` badge (`app.proposals`, re-listed with the
notes after every turn and every dream; `list_proposals` / `read_proposal` /
`dismiss_proposal` / `mark_applied`, scope `instructions` or `memory`). The
badge — and a ⌘K row, *Review proposed instructions*, while any exist — opens
`NoteView` on the file in **proposal mode** (`app.proposalReview`): the
model's *why* above a side-by-side diff of the saved text against the
proposal (`unifiedDiff` in `diff.ts`, a small line LCS rendered through the
same `DiffView` the Nightshift screens use; no dependency), and three ways
out. *Load into editor* makes the proposed text the buffer — a **draft**, by
the same `noteDrafts` rule as typed text (`mirrorDraft`, the effect's body
extracted so the rule is testable): `● draft` shows, Revert restores the
saved text and forgets the proposal (`unstageProposal`), Save writes the file
through the ordinary `saveNote` and only afterwards records the proposal as
applied with a hash of what was saved (`app.stagedProposal` → `mark_applied`).
*Dismiss* confirms first (`ConfirmDialog` — the badge goes with it, and the
never-lose-work rule says a click must not lose something unread), then moves
the file under `proposals/dismissed/`. *Keep for later* closes; the badge
stays. Nothing in any of it writes `AGENTS.md` except the user's Save.

`app.openNote` carries its scope for the same reason — the two stores can each
hold a `plan.md`, and a bare name would make saving depend on which sidebar tab
happened to be showing. The load effect is guarded on that pair changing rather
than running on any state change: the textarea is bound to the same `text`, so an
unguarded effect would discard what the user was typing on their own keystroke.

`refreshNotes` reads **both** stores after every turn, which is the visible half
of shared knowledge — the note the model just left appears in the sidebar without
a reload. A new note gets `.md` appended when the name has no extension, since
both stores are markdown by convention and an extensionless file is one nobody's
editor knows what to do with.

## Wikilinks, backlinks and the graph

The vault's own surface.

`links.ts` recognizes `[[name]]` in marked's *tokenizer* rather than as a pass
over rendered HTML — `math.ts`'s argument, that by then the delimiters may have
survived and the thing between them has not — and gets inline-code exclusion for
free, since marked consumes the source left to right and a `` `[[x]]` `` is
claimed whole by the built-in codespan tokenizer before this extension is asked
about the brackets inside it.

`tilde.ts` replaces marked's `del` tokenizer on both instances so strikethrough
needs `~~two~~` tildes: GFM lets a single pair strike, and a research reply
that says "~70%" and "(~10-20%" in one paragraph had everything between the
two struck, silently (2026-09-14, seen live). A lone `~` is a character.

It renders to an `<a href="#kb:…">`: **a fragment, not a custom scheme**, because
DOMPurify strips every scheme outside its allow-list and a `nlnote:` href would
arrive as a dead anchor indistinguishable from a real one. It uses its own
`Marked` instance rather than `marked.use`, so the transcript keeps rendering
assistant text exactly as it did — a model that happens to write `[[x]]` in a
reply should not have it turn into a link to a file the reader cannot click.

Its `resolveNote` **mirrors** `knowledge::resolve_link` and is one of the
projections that has to stay in step with the backend. It exists rather than
calling the backend because the editor renders text that has not been saved yet,
so there is no file to ask about.

A link to a note that does not exist **creates** it on click — writing
`[[thing]]` first is how a note gets planned — and is styled dashed rather than
red for the same reason.

Backlinks come from the backend's graph, since computing them needs the contents
of every note and the frontend holds none; the fetch is guarded on the note still
being open, or clicking through two links quickly leaves the first note's
backlinks under the second.

`GraphView.svelte` is a centre-pane view like `NoteView`, drawing the graph on a
canvas with a force simulation written here rather than pulled in — the
hand-rolled-FNV-1a principle, a few hundred nodes being a hundred lines of
physics against a transitive tree for one view.

Nodes are seeded **on a circle**, not at random: a random cloud looks broken while
it untangles where a ring resolves in about a second, and the seed is
deterministic so re-opening gives the same picture. The loop stops when the layout
settles and restarts on hover or resize, because a canvas repainting forever
behind a window nobody is looking at is a fan spinning up for nothing. Repulsion
is O(n²) deliberately — a vault large enough for that to matter is one where the
picture has stopped being readable, and the honest fix there is filtering, not a
quadtree.

## The composer and the welcome page

`Welcome.svelte` is the new-chat page: with an empty transcript (no message
event — a session re-opened from the sidebar carries `session_created`, which
used to tip it into an empty `Transcript`; review round 1, 2026-09-13) the
centre pane shows the project, ~~what the next chat inherits from the docspace, recent projects
to switch to, a folder picker~~ — since 2026-09-13 the project's notes orbiting the
composer on an inner ring and the knowledge base's on an outer one (hover pauses a
note and previews it, click opens it), one count line, and a strip of the stable
keys at the foot; the project list moved to ⌘P (`Palette.svelte`, also the ⌘K
command palette) — and the composer floating in the middle rather than docked at
the bottom. `Composer.svelte` takes a `floating` prop for that
instead of being duplicated: a second composer would be a second place to fix a
paste bug. The switch is on `app.events.length === 0 && !app.live`, and
`app.live` is in the test so the pane flips on the first send rather than on the
re-sync a whole turn later.

### Incognito and ephemeral chats (nightshift backlog 059, 2026-09-15)

Three kinds of chat, one control, offered wherever *New chat* is and nowhere
else, never a modal. The mock is
`nightshift-code/notes/runner-design/incognito-chats-mock-2026-09-15.md`.

- **The sidebar's New chat is a split button**: the wide half is New chat as
  it was; the narrow ▾ half (or a right-click on the wide half) opens the
  project menu's popover shape under it — *New chat · Incognito · Ephemeral*,
  one line each (`MODE_LINES` in `state.svelte.ts`: "kept, indexed,
  remembered" / "kept and marked; writes nothing, unread by other chats" /
  "nothing is kept; gone when you close it"), a click-away scrim.
- **⌘K** has *New incognito chat* (⌘⇧N) and *New ephemeral chat* (no key)
  in the Go group with the same lines as `meta`; the **Welcome strip** has
  `⌘⇧N incognito` and a keyless `ephemeral` cap; the **macOS File menu** has
  *New Incognito Chat* ⌘⇧N and *New Ephemeral Chat*; off macOS ⌘⇧N is in
  `App.svelte`'s Shift table. All four go through `runMenuCommand`
  (`new_incognito`, `new_ephemeral`) to `newSession(mode)`.
- **The marks.** `chatMode(events)` projects the open chat's mode from its
  `session_created` line — ~~`newSession` now fetches the transcript back
  rather than resetting to `[]`, so the line is there before the first send~~
  (superseded 2026-09-15, backlog 061: `newSession` creates nothing, and
  before the first send `chatMode` reads `app.pendingMode` instead — see the
  next section). A sidebar row for an incognito chat carries `◐` before its name and the
  word `incognito` in its meta line (`SessionMeta.mode`); the top bar shows
  `◐ incognito` after the short id, or `◌ ephemeral — nothing is kept`; the
  Context page's caveat line says *incognito: writes nothing, unread by other
  chats* or the ephemeral sentence (and that on Claude Code the earlier turns
  are replayed). An ephemeral chat is never in the list, so the top bar's
  title for it is the fallback and the mark is what says what it is.
- **The reconnect.** The engine is built per rail change, and an incognito
  chat's engine has no writers (`build_chat` keeps `ReadOnly` and `Session`
  tools and drops every `Mutating` one but the web; `connect_agent` passes
  `--tools` read-only and starts the MCP server `--no-remember`, ephemeral
  adding `--no-session-persistence` — [service-agent.md](service-agent.md)).
  So `prompt_layers` reports `mode` beside `built_mode` and `syncPromptLayers`
  reconnects when they differ, exactly as it does for the layer set: open an
  incognito chat and the writers go; open an ordinary one after it and they
  come back.
- **Ephemeral leaves nothing**: no log, no listing row, no title call, no
  CLI session; switching chats or starting a new one drops the in-memory
  session, and there is no row to reopen it from. It does not clean up after
  other modes — nothing is deleted on his behalf.

### New chat is a state, not a file (nightshift backlog 061, 2026-09-15)

Clicking *New chat* — any of the three kinds — creates nothing on disk and
nothing in the list, and clicking it again is the same state again. Before
this, each click made a log at once and the sidebar filled with "empty
session" rows, one per click. Now the click leaves no chat open
(`app.activeSessionId = null`, `app.events = []`), records the kind asked
for as `app.pendingMode`, and tells the backend, which drops its session and
records the same kind (`AppState::pending_mode`). The sidebar's wide New chat
half is drawn as the selected row while no chat is open — it is the "tab"
being pressed — and reads `New chat ◐` / `New chat ◌` when the pending kind
is incognito or ephemeral (`newChatSelected`, `newChatLabel` in
`state.svelte.ts`). The first message creates the log in the pending kind
(`ensure_session` in `main.rs`, one helper for the four commands that used
to each create an ordinary log), `send` picks the id off the transcript it
fetches back and refreshes the list then, and that is when the row appears
and gets its name. Until then `chatMode` reads the pending kind, so the top
bar's mark and the Context caveat show it, and `session_mode` on the
backend reads the same — so `syncPromptLayers` reconnects and a pending
incognito chat's engine has no writers *before* its first message
(`App.svelte`'s effect keys on `app.pendingMode` as well as the open chat,
since New chat from the blank state leaves the id null as it was). Opening,
closing or forgetting a project resets the pending kind to ordinary on both
sides. The one edge: a Context layer unchecked, or given its own text,
before the first message creates the log then — an exclusion is a fact about
a chat, and a chat has to exist to have it — so that row appears early,
in the pending kind. Existing empty logs are not touched by app code.

### New project and Open project

Until 2026-09-14 *New project…* was a folder picker, which served the case it is
not for: "when you're making a new project, you pretty much have nothing to go
off of" (Swaraag, nightshift backlog 047). It is now two rows everywhere it was
one — ⌘P (N and O), ⌘K, the project menu, the Welcome page, the sidebar's
Nightshift mode, the macOS File menu — and the picker kept the chord it had.

**New project…** (`NewProject.svelte`) is a screen in Welcome's place, the note
editor's frame, not a modal: a name, a folder row, and an optional Instructions
textarea. The folder row shows `<projects folder>/<slug>` as the name is typed,
greyed because it is a preview of a folder that does not exist yet; *Change…*
opens the picker for "I already have work somewhere" and the picked path
replaces the resolved one. The slug is the importer's rule (`project::slug`,
`Value Generalization` → `Value-Generalization`), computed on the backend by
`resolve_new_project_path` so the preview and the folder Create makes cannot
disagree; a name of pure punctuation makes no slug, and Create is disabled with
the reason on the row. Create (`new_project` → `Registry::new_project`) checks
everything before writing anything — a resolved folder already holding files is
refused (that is somebody's work; *Open project…* is for it), a picked folder
already registered is refused by the project's name, instructions are never
written over an `AGENTS.md` a picked folder has — then makes the folder, writes
`AGENTS.md` when there was text (the file the preamble reads whole; nothing
else), registers under the typed name and opens the project. No dialog appears.

The draft is `app.newProjectDraft`, not component state (the never-lose-work
rule): Escape, Cancel, a click on a chat and a project switch all leave the form
with the name, the instructions and a picked folder still in it, marked
`● draft`; only Create and Discard (behind `ConfirmDialog`) clear it. ⌘↵ creates.

**Open project…** (`openProjectFolder`, `create_project` → `Registry::add`) is
the old flow renamed: pick a folder, it becomes a project named after the
folder; pick one already registered and it opens rather than duplicating, since
`add` is idempotent on the workspace.

`ApprovalPrompt.svelte` renders inline under the tool chip it concerns rather
than as a modal, shows each argument unelided (a `bash` command has to be
readable to be consented to), and takes initial focus on the card rather than a
button so a stray Enter cannot grant permission.

### Transcript type

Settings → Appearance carries, under the palette, a *Transcript type* card
(nightshift backlog 051, 2026-09-14): the face — IBM Plex Sans, his pick and
the default, or Newsreader, the serif replies wore before — and the size, 15,
16 or 17 px. Both are already bundled, so the choice costs nothing; a third
face is a decision about bundle weight, not code. The pair lives in the same
`localStorage["nightloom.transcript"]` as the toggles and reaches the
transcript as two root properties, `--transcript-font` and `--transcript-size`,
set by `applyTranscriptType` at load and on every change — read by the reply's
markdown and by the user bubble (one px smaller) and by nothing else, so the
chrome stays in Plex. There is no sample card: the change lands in the open
transcript behind the pane, which is where a face is judged.

### Transcript toggles

Two transcript-wide toggles in the top bar beside Context (nightshift backlog
052, 2026-09-14): *✦ thinking* and *⚒ tools*, ⌘⇧T and ⌘⇧B, also under ⌘K.
Thinking on opens every thinking block; off folds each to the `✦ thinking`
pill, except the one still streaming, which stays open until it is done — how
the pill behaved before the toggles. Tools on is the full block; off folds each
call to one line, `▸ name · the input's most telling field, cut to 60 chars ·
N chars` (or `error`, `denied`, `running`), and a parked approval prompt renders
outside the fold either way. A click on any single block overrides its toggle;
flipping the toggle clears those clicks for its kind (each override remembers
the toggle revision it was made under, `resolveOpen` in
`transcriptPrefs.svelte.ts`). Defaults are thinking off, tools on — the
pre-toggle reading — remembered in `localStorage["nightloom.transcript"]`.

The same change keys a block's override on a stable id (`tool:<id>`,
`thinking:<ordinal among the message's thinking blocks>`) rather than its
index, and toggles on `pointerdown` rather than `click`: while a reply streams
the transcript is pinned to its foot and every delta pushes the pills up the
page, so a press and its release land on different elements and no `click`
reaches the button — which is what "clicking a thinking pill mid-reply does
nothing" was. `click` still serves the keyboard (`detail === 0`).

### The prompt-cache timer (nightshift backlog 063, 2026-09-15)

Beside Context in the top bar: `cache · 41 min` counting down, `cache · 1:59`
under two minutes, `cache cold` after, nothing before the first turn that
recorded one. It is how long the last turn's prompt cache stays warm, counted
from when that turn's request was *sent* — the API measures the lifetime from
the start of the request that wrote or last read the entry, so a turn that
streamed for four minutes leaves one on a five-minute entry — for the lifetime
the reply named in `usage.cache_creation`, or the engine's usual one when it
only read (a read refreshes the entry): five minutes on the API engine, an
hour on Claude Code, both measured ([service-agent.md](service-agent.md) "The
cache lifetime is measured"). Both facts are on the log's `assistant_message`
(`sent_at`, `cache_ttl`, [core.md](core.md)), so the countdown is projected
from the log (`cacheState` in `src/lib/cache.ts`) and reopening a chat shows
the one it had. The newest *live* turn is the one read: a rewound turn's entry
is still real on the server, but the next request will not share its prefix.
The number is floored, never rounded up, so it is always one the cache can
still honour.

What it is not. It is not a bill: until it expires an edit to the history
re-writes the cache, after it the next turn pays for the whole history whether
or not you edited it — on the API engine that is what makes an edit free once
cold. On Claude Code you are on the subscription, and "free" means an edit
costs no more usage than an unedited turn would; whether cache reads are
discounted against the plan's limit is not documented, which the chip's title
says. It is not the engine's: the chip reads the log and the caveat reads the
connection, so after switching engines mid-chat it describes the *other*
engine's entry until the first turn on the new one lands — the next request
is a different prefix, so treat it as cold until then. And it is not the
countdown the cached chip used to infer (five minutes from the reply's *end*,
API engine only, superseded here): that origin was the wrong clock and the
Claude Code engine's hour was unreadable from a shell.

The clock is a chain of timeouts aligned to when the text would change
(`nextTickMs`): once a minute, once a second under two minutes, so it wakes as
rarely as the display allows and is never a second stale. A toast, "Prompt
cache cold — edits to the history now cost nothing extra", fires on the tick
that crosses to cold, once, and only for the open chat: the chain is torn down
and rebuilt whenever the open chat's log changes, a background chat has no
chain, and a chat reopened already cold is a state, not a crossing. `cacheState`
and `cacheClause` ("the cache is warm for 41 min" / "the cache is cold") are
exported for the edit controls (backlog 062).

### Editing past turns (nightshift backlog 062, 2026-09-15)

Hover a user or assistant turn in the transcript and three controls appear
where Rewind alone used to: **Rewind to here** (user turns), **Edit** (a user
turn, or an assistant reply that calls no tool), **Remove** (either). They
are offered on **both engines** now — on Claude Code they used to be hidden,
because nothing projected; each of them now rewrites the CLI's history by
copy and the next turn resumes the copy ([service-agent.md](service-agent.md)
"Editing the CLI's history, by copy"), which the controls' title says.

**Edit** opens the turn's text in place, in a textarea in the message's own
face and width, with one line from the cache timer above the buttons —
"cache warm · 41 min — this re-writes the history after this turn" or "cache
cold — edit freely" (`editLine` in `src/lib/edit.ts`, read once when the
editor opens: it is advice about the edit being typed, not a clock) — and
the buttons:

- **Send** (user turns only): his "edit and send" — a fork of the chat cut
  before this turn, opened as the chat, and the text sent as its next turn
  with the original turn's attachments (the words changed, the file did
  not). The parent stays in the list, untouched; the fork's sidebar row
  carries "from <parent's name>" in its meta line (`forkLine`), or "from a
  deleted chat" when the parent is gone. On the API engine the fork's log
  projects the copied prefix as today; on Claude Code the CLI's file is
  copied cut before the turn.
- **Save**: his "edit and save" — the turn reworded in this chat, from here
  on, by an `edit` marker on the log; the turn shows an `edited` mark and
  "the original" unfolds under it, greyed. Live only when the text changed
  and is not blank (`editButtons`); blank is what Remove is for.
- **Cancel**, and Escape. Enter is a newline in the editor — an edit is
  usually to a long paste — ⌘/Ctrl-Enter saves, ⌘/Ctrl-Shift-Enter sends.
  One turn is open at a time (`editReduce`); a turn starting to stream
  closes it.

**Remove** asks nothing: it is the same `elide` marker the context panel
records, and the transcript now draws a removed turn as its placeholder
("removed from the context — still in the log"), greyed, with "what was
removed" a click away; an assistant reply keeps its tool-call chips. It is
restorable from the context panel on the API engine, ~~and by backlog
064's undo once that exists; on Claude Code the context panel itemizes the
preamble alone, so until 064 a removal there stands~~ by ⌘Z (064), and
since 066 by the **Restore** control on the placeholder itself. ~~A reply
with a tool call has Remove and no Edit, on the core's argument~~ — since
066 every reply with text has Edit; see below.

### Editing a reply block by block; Restore; the Undo toast (nightshift backlog 066, 2026-09-16)

His ask: "being able to edit Claude's responses is honestly more valuable
than editing my own … I have no control over what Claude outputs"; keep
the start of a reply and drop the rest; replace a suggestion with "I won't
ask you about ___"; a Restore on anything removed; "an undo floating
button for 8s".

**Edit on any reply.** The editor for a reply is its **text blocks as
textareas in order, with each tool call between them as a fixed greyed
marker** (`⚙ Read a.txt`, `editParts` in `edit.ts`, labelled by
`toolInputSummary`) — the text around a call is edited, the call is not.
Save rewords each changed block (`edit_message` with `block`, an index
into the reply's `blocks`) and **removes each block whose text was deleted
entirely** (`remove_block`), in order, as *one* entry on the undo stack
(`saveReplyEdit`); a reply emptied whole is not a Save — that is Remove.
Thinking is not shown in the editor: not the user's to edit, and the API
leaves it out of later turns on its own (what it still *costs* is measured
in [service-agent.md](service-agent.md) and said in the thinking toggle's
title). The `edited` mark and "the original" unfold as before; on Claude
Code each step is its own copy of the CLI's file, and the controls' title
says so. The projections `blockEdits`, `blockElisions`, `replyText` in
`edit.ts` mirror `Session::block_edits`, `block_elisions`, `reply_text`,
on the same "must stay in step" terms as the three from 062;
`displayTexts` feeds the navigator one string per turn.

**Remove a tool call.** Hover the call's line in a reply and a small Remove
appears at its right end (`AssistantMessage.svelte`, `onremove`): the
`tool_use` block and the result that answers it leave the context
**together** — one `elide` marker with a `block`, the result following
the call by id ([core.md](core.md) "One block of a reply") — and the line
becomes "[tool call removed]", greyed, with the call and its result a click
away and **Restore** beside it. A removed text block reads "[text
removed]" the same way. The core refuses a lone half; the UI never offers
one.

**Restore.** Every removed placeholder — a user turn, a reply, a tool
call, a text block — carries a Restore control (the `refresh` icon, "Restore
to the context") in its tools row, calling the same restore its undo would
(`unelide`; on Claude Code the nodes back from the original), and pushing
its own inverse on the stack so a Restore is itself undoable
(`restoreTurn`, `restoreBlock`).

**The Undo toast.** Remove (a turn or a call) and Rewind raise a toast —
"Removed from context · Undo", "Rewound to here · Undo" — for **8 s**
(`ACTION_TOAST_MS`; plain toasts keep 5). `addToast` gained an optional
action `{ label, run }`, drawn as the toast's own text with the accent and
taking the pointer (other toasts stay inert). Undo runs the stack's undo
**for that entry alone**: `UndoHistory.push` returns a handle and
`undoIf(scopes, handle)` refuses once anything newer is on the stack, with
a toast saying to use ⌘Z in order — an Undo that lifted a later edit would
be worse than one that did nothing. The click spends the toast.

The transcript's projections for all this — `editTexts`, `elideFlags`,
`isEditable` in `edit.ts` — mirror `Session::edit_texts`, `elide_flags` and
`is_editable` exactly, and join `liveFlags` in the list of frontend
projections that must stay in step with the backend
([desktop.md](desktop.md)): the transcript is drawn from these and the
request from the core's, and a disagreement would be a user reading a
conversation the model is not having. Every one of the three commands
returns the transcript, and `send`/`fork` the fork's id, so the UI re-syncs
from the log rather than patching its own copy — `rewind`'s contract.

### Undo and redo (nightshift backlog 064, 2026-09-15)

His ask: "a Command Y, which does redo … in all of the chat related or
editing related stuff". Until today the Edit menu's Undo and Redo were the
OS's and reached text boxes only. Now the app has a stack of its own
(`src/lib/undo.ts`, met by `state.svelte.ts`), and it is a stack of
**inverse commands, never of snapshots**: every entry reverses its operation
by calling the same backend command the operation used, so the log sees an
ordinary event and nothing is struck out — supersede, never delete.

**What is undoable, and what its undo is:**

| operation | undo |
|---|---|
| Rewind to here | an `unrewind` marker lifting that rewind ([core.md](core.md)); on Claude Code the chat resumes the file the rewind was cut from, still on disk |
| Remove (transcript or Context panel) | a restore — `unelide`; on Claude Code a third copy of the CLI's file with the turn put back from the original ([service-agent.md](service-agent.md)) — the Restore that engine lacked in 062 |
| Remove a tool call or a text block of a reply (066) | that block's restore, the pair with it |
| Restore (Context panel, or the placeholder's own control since 066) | the removal again |
| Edit and save | an edit back to what the turn said before, the same marker |
| Save on a reply's editor (066) | every block back to what it said: an edit back for an edit, a restore for an emptied block, in reverse order — one entry for the whole Save |
| Rename | a rename back; a chat that was never named gets its first message *as* its name, since a title cannot be un-recorded |
| Delete | the log moved back out of `<logs>/trash/` (`restore_session`), and the chat reopened if nothing is open |
| A prompt layer on or off | the set as it was |
| A layer's text for this chat | the previous text, or none |

Redo does the operation again — a redone rewind is a fresh `rewind`, a
redone remove a fresh `elide` — and a new operation after an undo forgets
what could have been redone, as everywhere.

**Not undoable, and said so here:** sending a message (the model has
answered), edit-and-send (a fork — undo it by deleting the fork, which *is*
undoable), compact, dream, capture, and a project forget. **A sent turn
clears its chat's stack**: a rewind lifted from under a reply the model has
already given would put the model in a conversation it never had — on
Claude Code, one whose file it never wrote.

**Per chat, plus the list.** Operations on a chat's log live under that
chat's id (the pending New chat under its own key), so ⌘Z in one chat never
lifts a rewind made in another that is not on screen. A rename, a delete and
a restore live on the *list's* stack, reachable from any chat — after a
delete there is no chat to hold the entry. Undo takes whichever of the two
was pushed more recently; redo whichever was undone more recently.

**Keys.** ⌘Z undo; ⌘Y (his) and ⌘⇧Z (the macOS convention the Edit menu
already showed) redo. Ctrl on the other platforms. **A text box keeps its
own history:** when the focus is in an input, a textarea or a contenteditable,
the key is the box's — the composer's half-typed draft, a note being edited,
a rename in progress — and the app's stack is untouched. On macOS the Edit
menu's Undo and Redo are the app's own items now, retitled live with the
operation ("Undo rewind", "Redo remove") and disabled when there is nothing
to reverse and no text box has the focus (`set_undo_menu`); a click or ⌘Z
with a text box focused hands the box its own undo through the webview.
Elsewhere `App.svelte` binds the keys. ⌘K has "Undo …" / "Redo …" rows in
an Edit group, greyed when there is nothing. A toast names every step
("Undid rename"), since the change may be off screen. Both are no-ops while
a turn is running, on rewind's reasoning.

### Attachments

`Composer.svelte` takes images and PDFs by paste and drop, reads them to base64
(stripping the `data:` prefix — the backend stores raw base64 and each adapter
builds its own wire form), and refuses anything outside png/jpeg/webp/gif/pdf or
over its cap (~10 MB for an image, ~32 MB for a PDF, both Anthropic's) with a
named toast rather than dropping it silently.

`Attachment.kind` is carried rather than sniffed from the media type: a document
has no thumbnail, and a chip that guessed wrong would render a broken `<img>`. The
transcript lists an attached PDF by name for the same reason a turn shows its
images — a caption asking about a file the transcript never mentions reads as a
question about nothing.

**`disable_drag_drop_handler()` on the window in `build_window` is
load-bearing**: it defaults to on, and Tauri's OS-level handler then swallows file
drops before the webview ever sees an HTML5 `drop` event — on Windows, disabling
it is the documented requirement. Paste works either way, which is what makes the
omission easy to miss.

## Math (`src/lib/math.ts`)

A **marked tokenizer extension**, not a pass over the rendered HTML, and that is
the whole of why it works: by the time markdown has been parsed, `$a_i$` is an
italic run and `$x*y*z$` is an emphasis — the delimiters survive and the formula
between them does not.

All four spellings are taken (`$$…$$` and `\[…\]` display, `$…$` and `\(…\)`
inline, plus a ```math fence), because which one a model reaches for is not
negotiable and a reply that renders on one provider and not another would read as
a broken app. An unterminated formula stays literal text, which is also what makes
it safe on a half-streamed reply.

`$…$` is the one delimiter that also means money, so it carries four guards, each
answering a sentence seen in real output: no space just inside either delimiter
("between $5 and $10"), no digit past the close ("$100$200"), one line only
("$1,200 total.\nCode stays code:"), no backtick inside ("…or $5. Use `$PATH`").
None of these can lean on markdown's own code spans, since an extension tokenizer
runs *before* those exist. Two adjacent shell variables on one line
(`$HOME/$USER`) still read as a formula and are the known residue; a fifth guard
for it would cost `$ABC$`.

KaTeX renders with `throwOnError: false`, so a malformed formula is red where it
stands rather than costing the message, and **`trust` is left off**, which is what
keeps `\href{javascript:…}` inert.

Sanitization is unchanged except for `ADD_TAGS: ["semantics", "annotation"]`:
DOMPurify drops those two by default but *keeps their contents*, so the default is
not "no MathML" but the TeX source loose inside the `<math>` element for a screen
reader to read out. `annotation-xml` is deliberately not added back — that one is
an HTML integration point, which is the reason the family is off in the first
place.

## Per-chat drafts, scroll position and the message navigator (nightshift backlog 065, 2026-09-15)

Three things that were global or absent are now per chat. His report: a draft
typed in one chat was still in the box after switching to another; a chat
scrolled to somewhere high up had to be re-scrolled every time he came back;
and there was no way to move through a long chat but the wheel.

**Drafts (`src/lib/drafts.svelte.ts`).** The composer's text and attachments
were component state, and `Composer.svelte` outlives a chat switch — that was
the whole bug. They now live in a rune store keyed by the chat: the open chat's
id, or `"new"` while no chat is open (New chat is a state, not a file, see
above). The composer binds to the entry for the current key and nothing else,
so a switch swaps the box. The pending chat's draft follows the chat it makes:
`send` and `sendAgent` pick the id off the re-synced `session_created` line and
one line there calls `moveDraft("new", id)` before `activeSessionId` changes,
which carries anything typed *during* the first turn (the box is not locked
while a reply streams). Sending clears that chat's entry; nothing else does — not
a switch, not Escape, not deleting the chat. A failed send puts the words and
the chips back under the chat now open (the text only if nothing new was typed
meanwhile); until today only the attachments came back.

Persisted under one localStorage key, debounced 400 ms and flushed on
`pagehide`, every access in try/catch, the transcript prefs' pattern. Text
always; an attachment only when its base64 is under 512 KB and the store's
attachments together under 3 MB — a pasted screenshot is often most of the
few MB localStorage allows — so a large chip is in memory only and a relaunch
keeps the text and drops it. Over quota, the write is retried with the text
alone. A row whose chat has a non-empty draft carries a small `✎` (the incognito
mark's style, titled "has a draft"), and the New chat button carries one for the
pending draft.

**Scroll (`src/lib/scroll.svelte.ts`).** `{ top, pinned }` per chat key, in a
plain map — nothing draws from it, and a reactive map would re-run effects on
every frame. `Transcript.svelte` writes it from its scroll handler, one write per
frame at most, and reads it when the key changes: `pinned` at once, so the
existing pin-during-reply effect (which fires on the same switch, the event
count having changed) sees the switched-to chat's state; `top` after the tick
that renders the new events, and only when not pinned. A chat with no entry
lands at the bottom, as every chat did. Not persisted: a position is pixels of a
layout a relaunch redoes. The first turn of a pending chat is the one key change
that is not a switch — `"new"` becomes the created id while the same transcript
is on screen — and the entry moves with the key rather than being restored.

**Navigator (`src/lib/navigator.ts`, `src/lib/Navigator.svelte`).** The strip
at the transcript's right edge, from his screenshot of LibreChat's rail (their
`client/src/components/Chat/Messages/MessageNav.tsx`, read 2026-09-15; the
interaction is borrowed, nothing is copied). `ticks(events, liveFlags, texts?)`
is pure: one tick per live user or assistant message with its log index, role,
a log-scaled weight in [0.25, 1] (full width at 4 000 characters; past a
screenful the width says nothing the bubble does not), and its first non-empty
line — the edited wording where a turn has one, and "(2 tool calls)" for a
reply with no text. Rewound turns are drawn greyed in the transcript but get no
tick; compactions and tool results get none. `activeTick` is which one is being
read: the last tick whose top is at or above a reading line 48 px under the
viewport's top edge (a third of the viewport if that is less), and the last
message at the foot whatever the line says. A line a third of the way down was
tried first and picked the *next* message after every jump to a short one.

`Navigator.svelte` is a view: it draws what `Transcript.svelte` tells it —
chevron top (scroll to the top, unpins), chevron bottom (scroll to the foot and
follow the reply again), the ticks between as one grid row each of at most 7 px,
sharing the height evenly when a long chat has more rows than the strip has
pixels — and reports clicks. Assistant ticks take the accent, user ticks the
secondary ink at lower opacity; the active one is bright and full width. Hover
shows a bubble to the left with the role and up to two lines of the first line;
click smooth-scrolls to the turn's `data-turn` anchor, 12 px under the edge, and
focuses the viewport so `⌥↑` / `⌥↓` work from there. The strip is positioned by
`.content` in `App.svelte`, which is exactly the transcript's area — under the
top bar, above the composer — and is not drawn under four ticks or when the
viewport does not scroll.

`⌥↑` / `⌥↓` step to the previous / next message. They are bound on the
viewport (`tabindex="-1"`), not the window: the composer's own `⌥↑` moves the
caret by paragraph and should keep doing so. So they work after a click on the
transcript or the strip, not while typing; a window-wide binding would belong
in `App.svelte`'s `onShortcut` and was not added there.

Tests: `drafts.test.ts` (per key, the handover, clear on send only, the
persistence caps, a storage that throws), `scroll.test.ts` (remember, recall,
default bottom, move), `navigator.test.ts` (roles, weights, first lines,
rewound turns excluded, the reading line, the foot rule, stepping).
