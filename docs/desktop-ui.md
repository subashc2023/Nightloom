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
`prefers-reduced-motion` — ~~that the first delta, tool call or error replaces~~
that the first delta, tool call or error replaces **with the same moon as the
live reply's last row, `working · 41 s`, until the turn ends (backlog 096,
2026-09-16; "The activity block" below)**
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
below; *Usage* and *Cost* since 2026-09-16), and — since 2026-09-14 — the per-model
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

**The nav's order (2026-09-16 evening, nightshift backlog 127, his):**
Usage · Cost · Subscription · Knowledge · Projects · Providers · Web search ·
Appearance — the two usage pages at the top, Providers and Web search just
above Appearance (which holds Palette). ~~Providers · Subscription · Web
search · Knowledge · Projects · Usage · Appearance~~ was the order before.
The group chords of backlog 109 follow it: ⌘1 Usage … ⌘8 Appearance, each
key its group's first pane or the next pane of the group when already in
it; ⌘] / ⌘[ walk every pane in nav order; the two-minute pane memory is
unchanged (pane ids, not positions).

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

~~A row *Usage* under its own heading~~ **Two rows and two panes since
2026-09-16 evening (nightshift backlog 127, his words): *Usage* then *Cost*,
at the top of the nav** — since 2026-09-14 (nightshift backlog
045; blocker 060 chose a Settings pane over anything in the transcript, on
the dashboard's own reasoning that text in a message is stored and replayed
forever). ~~The nav row carries a dot for whether a ledger exists and the
seven-day figure; the pane, in order:~~ **The split (2026-09-16): every card
below landed on exactly one pane. *Usage* — how much of the plan is used
and where the week went — opens with a **Plan** card that is the top bar's
plan chip said in full (the 5-hour and 7-day windows as bars with their
reset times, the sample's source and age, stale past twenty minutes;
`app.planUsage`, refreshed when the pane opens), then **Surfaces** (2.) and
**Ledger** (3.), with *Refresh now* in its head (the banner of backlog 116
opens this pane). *Cost* — what it would have cost — is the stance
paragraph and **Spend** (1.). The *Usage* nav row reads the 5-hour figure
(else "ledger" / "none"); the *Cost* row reads the seven-day dollars. The
old list, for what each card holds:**

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

**The layout, his four asks (2026-09-17, nightshift backlog 103; blocker
233's board A).** Before a name is typed the folder row reads the projects
folder with a trailing `/` — where the slug will go — never "…"
(`resolve_new_project_path("")` already answered the folder; the row now
shows it). The Name label and its text are centred in the column, the
input capped at 28rem. The Instructions box is a third of its old height
(four lines) with a resize corner that pulls it down, and no longer grows
to fill the column. Under its hint, a second *Cancel · Create* pair,
right-aligned, Create filled in the accent (`ns-btn accent`); the header's
pair stays, and both do exactly the same thing. Board B — the pair in the
footer band beside the Open-project sentence — is the alternative the
blocker names.

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

### The activity block (nightshift backlog 096, 2026-09-16)

A reply's thinking and tool calls no longer render as a run of bare mono
lines and pills. Consecutive thinking, redacted-thinking and tool segments
form one **activity block** (`groupSegments` in `src/lib/activity.ts`, drawn
by `AssistantMessage.svelte`): a bordered group with a 2px left rule — accent
while the turn is live, `--line2` once done — whose rows share one grid:
icon · the tool's name in the sans · the input's telling field in mono,
truncated · the result size right-aligned and dim (`8,122 chars`, `running`,
`error · 40 chars`, `denied`). Thinking is a thin italic `✦ thinking` row in
the same grid, not a pill; an MCP tool is named by its short name
(`mcp__nightloom__search_chats` → `search chats`, the full name on hover,
`shortToolName`). A text segment between calls ends the block and the next
call starts another, so the reply reads in the order it happened. Removed
blocks (backlog 066) and notices stand outside any block.

The block's first line is its summary, `▾ 4 tool calls · 2 thinking`
(`· 1 error`, `· 1 denied`, `· working` while live), and folds the block to
that one line — `resolveFolded`: folded once the reply is done and the tools
toggle is off, open otherwise, a click on the line remembered under
`block:<first row's id>` and cleared by the tools toggle like a row's click.
So the toggles of backlog 052 still govern: tools on is the block open with
every call expanded (its whole input, then the result); tools off while
streaming is the block open with one line per call; tools off after the
reply is the fold. A click on a row still overrides that row alone. A parked
approval prompt renders through a folded block, as it did through a folded
call.

While the message streams its last row is the moon of backlog 049 with
`working · 41 s` beside it — inside the last block when the reply's last
segment is in one, else a row of its own under the text — counted from the
optimistic `user_message`'s `at` (`liveSince` in `Transcript.svelte`) and
removed only when `app.live` clears. Reduced motion gets the three dots and
the count.

**Restyled to the approved board (2026-09-16 afternoon, nightshift
`claude-code-ui-design-2026-09-16/Main.dc.html`, boards 1 and 6).** The
block now carries the board's measures: a faint sheet background, rows 28px
tall with a hairline between them, one grid of icon 18 · name 118 · argument
· size, 12px in from either edge; each call's icon by its kind (`toolIcon`
— a book for Read, a glass for Grep and Glob, a pencil for Edit and Write,
the terminal for Bash, a figure for Agent, stacked bars for an MCP tool, the
⚒ for anything else) and a spark for thinking. A finished thinking row reads
`✦ thought for 6 s` when the live turn timed it (`Segment.ms`, set by
`closeThinking` in `state.svelte.ts`; a recorded reply has no clock, so
`thought`), `✦ thought · summary` with the summary's first line in italic
when the model is one that omits its thinking and returned text anyway (the
API engine's summary), and opens with a `▸` at its right. The subagent row
names its child's tools (`▸ subagent · Read, Grep · 3 calls · 1.4k words so
far`) on the paper, one column in. The moon rides the last block even when
the reply's words follow it; the reply footer's figure is what the turn
added to the window (`48k`, the bar's own number), the reply's `N out` and
the tool results in its title.

### Runs of replies drawn as one (nightshift backlog 121, 2026-09-16)

On the Claude Code engine a turn that spans several CLI processes — the
deferred-call resumes of backlog 084, the CLI's own multi-message turns —
records as several consecutive `assistant_message` events, and the transcript
drew each with its own `OPUS` header, activity block, footer line and tool
row, with the list's 26px gap between: his screenshot of three replies each
holding one folded `1 tool call` box, "big spaces between each of the tool
calls". The log is right and is untouched — each message keeps its own id,
edit, remove and rewind — only the drawing merges.

`src/lib/runs.ts` — `continuedFlags(items)`: a reply that follows a reply
from the same model, with nothing between them, is a *continuation*. A user
message, a compaction, a change of model, or a change in whether the turn was
superseded by a rewind starts a new run. `Transcript.svelte` computes the
flags in step with its items and, for a continuation, passes
`headed={false}` to `AssistantMessage` (no model header) and adds
`.run-cont`, which pulls the turn up through the list's gap to the activity
block's own 6px. So a run reads as one reply: one header, the blocks back
to back, one text run at the end — and the reply's final text block is
always drawn whole; nothing in a run hides or replaces the answer.

The reply's Edit and Remove moved onto the footer row (`Copy · 850 · 38
minutes ago · ✎ · ⊖`) as `AssistantMessage`'s `onedit` / `onremoveturn`
props, hidden until the reply is hovered as the tool rows were; they were a
row of their own below, three rows per message. The per-message token figure
of backlog 090 stays per message, on that one row. Restore for a removed
reply stays a row under its placeholder.

### Thinking the model kept to itself (nightshift backlog 097, 2026-09-16)

A thinking block can arrive with no text. The Claude 5 family defaults
`thinking.display` to `omitted`, so the block carries a signature and nothing
else; the Claude Code CLI runs that way (measured 2026-09-16, CLI 2.1.263,
Haiku 4.5: one `thinking` block with `thinking: ""` and two empty
`thinking_delta`s), while Nightloom's own API engine asks for `summarized`
([providers.md](providers.md)) and gets a summary to show. Before today every
thinking block was the same pill, so on Claude Code the live reply offered a
button onto nothing — "clicking the thinking button does nothing".

Now a finished thinking block with no text (`thinkingHidden` in
`src/lib/activity.ts`) is a static row in the activity block, `✦ thought ·
hidden by the model`, dim, no pointer, titled "This model does not return its
thinking; only that it thought." A block still streaming with no text yet is
`✦ thinking …`, also static — early, not hidden. Only a block with text is the
button. On Claude Code the recorder drops an empty block (`record.rs`,
`flush_prose`), so the marker shows during the live turn and the re-synced
reply has no thinking row at all; on the API engine an empty recorded block
keeps its marker. `thinkingState(events)` — `none` / `hidden` / `shown` — and
`modelOmitsThinking(model)` are exported for the top-bar chip and ⌘⇧T, which
should read disabled with the same title when every thinking block in the
chat is hidden; ~~that hunk in `TopBar.svelte` is not yet made (the file was
held by another build the night this landed — the patch is in nightshift
`notes/runner-design/097-report-2026-09-16.md`)~~ — **made later the same
night (corrected 2026-09-16):** `thinkingToggleDead(events, connection)` in
`activity.ts` is the one function; `TopBar.svelte` disables the chip on it
with `HIDDEN_THINKING_TITLE`, `App.svelte` gates ⌘⇧T on it, and
`Palette.svelte` disables the palette row. No new request parameter:
the summaries were already asked for (nightshift blocker 093 asks whether he
wants a switch to stop asking).

### The sent message's entrance (nightshift backlog 095, 2026-09-16)

The turn just sent rises into the transcript over 180 ms (opacity 0 → 1, a
6 px lift, `ease-out` — the app has no easing token to reuse) and the waiting
row of backlog 049 follows a 90 ms beat later. Only that turn moves: a user
turn appended while the transcript was already showing the chat, in the same
flush that set `app.live` (`enterFrom` in `Transcript.svelte`, an index
floor reset whenever the chat key changes), so a chat opened or reopened
loads whole with no cascade, and the post-turn re-sync keeps the element and
does not replay it. Opacity and transform only, `backwards` fill so nothing
lingers to fight `.superseded`; `prefers-reduced-motion` turns both off.

### Per-message tokens and the share of the window (nightshift backlog 090, 2026-09-16)

Every turn's meta line carries what that turn added to the context, in the
gauge's mono figure (`You · 14m ago · 1.2k`), and a turn worth a bar — five
percent of the window or more — gets the gauge's own 56px bar scaled to its
share, with the percentage (`48k ▮▮ 24%`). One vocabulary for "share of the
window", top bar and transcript alike. Hover for the sentence.

Where the numbers come from (`turnSizes` in `src/lib/tokens.ts`, pinned on a
fixture log): the log records one `usage` per assistant message, and its
`input_tokens` is the **whole** prompt, cached or not, on both engines. So
the context after reply *j* is `in_j + out_j` — the gauge's figure — and the
growth from one reply to the next, `in_j − (in_{j−1} + out_{j−1})`, is what
arrived between them: a user message with its attachments when one did, or
the tool results of a round when none did. A reply's own size is its
output; a round's results are charged to the reply that made the calls, and
its footer says `40 out · 2k from tools`. The sizes telescope: **the turns
sum to the last reply's `in + out`**, which is what the gauge shows — except
that the first reply's input holds the system prompt and the first message
together, which the log does not separate, so the first user turn's figure
carries both and its title says so (the difference the item wanted "stated
as preamble" is inside that first figure). No tokenizer, no extra request.

Nothing is guessed. A rewound turn shows no figure and the chain runs over
the live replies; a growth that comes out negative (a compaction or an edit
shrank the context) shows nothing for that turn; a reply whose usage was
not recorded (an old log's zeros, a failed turn) shows nothing and breaks
the chain for the turn after it; a model with no known window gets the
figure and no bar.

The reply footer ~~summed `input + output`~~ (struck 2026-09-16: on both
engines that was the whole prompt plus the reply — near the gauge's figure,
and neither the message nor the total) now says **`N out`** only, the
prompt's size in the title. The navigator's ticks (backlog 065) still weigh
by characters, not tokens: the strip is about where a message sits, not
what it costs, and the token figure is null for exactly the turns a strip
must still show.

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

### The edit as an inline diff (nightshift backlog 105, 2026-09-16)

~~The `edited` mark unfolds "the original" under the message.~~ **Since
2026-09-16 the mark is a toggle**: clicked, the message is drawn once with
what the edit removed struck through in the code diff view's red
(`--del-bg`/`--del-fg`) and what it added in its green (`--add-bg`/
`--add-fg`) — his "like Google Docs has a way of doing this for edits";
clicked again, the plain current text. `textdiff.ts` (`wordDiff`, pure,
tested) aligns the two texts by longest common subsequence over words,
whitespace runs and single punctuation marks, so a changed full stop is
its own mark and a spacing-only edit marks the spacing, with a cap past
which the diff is one removal and one insertion. A user message diffs in
its bubble; a reply diffs **block by block** — the transcript hands
`AssistantMessage` each text segment's pre-edit text (`originals`, `""` for
an appended block) and the toggle — over the **markdown source**,
pre-wrapped in the transcript's face, since the source is what was edited
and a mark inside rendered HTML would cross links and code spans. The
folded "what was removed" under a removed turn is unchanged; the folded
"the original" under an edited one is gone.

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

**An attachment opens in front (2026-09-17, nightshift backlog 145).**
~~The transcript lists an attached PDF by name~~ — the thumbnail and the
PDF chip in a user bubble are buttons now: a click opens the attachment
in a **floating tab** — a tab in the workspace's one floating slot
(`Workspace.floating`, `tabs.ts`: `openFloating` replaces, `closeFloating`;
the content `{kind: "attachment", session, turn, index, media, name}`
addresses the event in the chat's log and the attachment in it, so the
bytes are read from the log and copied nowhere) drawn by
`AttachmentLayer.svelte` over the panes: a scrim, a centred card
(`fitRect` in `attachmentView.ts`: the image's natural size, never
enlarged, fit inside the viewport less 40px, a 240px floor) that zooms
up from the thumbnail (a Web Animation from `zoomTransform(thumb, card)`
— translate the corners, scale the sides — to none, 200 ms, ease-out;
none under reduced motion). An image shows fit-to-screen and at its own
size on a second click (the card takes the viewport less its margins
and scrolls); a PDF shows in an `<embed>` of its data URL (no viewer
outside the app). It closes on the scrim, ×, or Escape — caught on the
window's capture phase from anywhere but a text field (138's rule), so
the window never sees it. One floating tab at a time; a tab whose bytes
are gone (a rewound log, another chat brought forward) closes itself.
**Kept (pass 2):** the card's head drags with the same `CONTENT_DRAG`
descriptor; a drop on a strip or a pane's half goes through
`dropContent`, which sees the floating tab's own content and *keeps* it
— `keepFloating` moves the tab into the strip at the index (or
activates the tab already holding it), `keepFloatingBeside` makes the
second pane — and the slot empties; the tab then draws as
`AttachmentView.svelte` in its pane (the image fit, its own size on a
click; the PDF filling it), or a card when its chat is not the open one
(*Open the chat*, a chat tab beside), or a line when the log no longer
has it. A deleted chat takes its attachment tabs and the floating one
(`dropChat`). The strip titles it by name, glyph `read` for an image and
`download` for a file. The model's own file cards (078) do not open this
way yet — blocker 226.

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
id, or ~~`"new"` while no chat is open~~ `new:<project id>:<kind>` while no chat
is open (since 2026-09-16, backlog 094 below; New chat is a state, not a file,
see above). The composer binds to the entry for the current key and nothing
else, so a switch swaps the box. The pending chat's draft follows the chat it
makes: `send` and `sendAgent` pick the id off the re-synced `session_created`
line and one line there calls ~~`moveDraft("new", id)`~~ `moveDraft(pendingKey,
id)` before `activeSessionId` changes, which carries anything typed *during*
the first turn (the box is not locked while a reply streams). Sending clears that chat's entry; nothing else does — not
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

**An open edit is per chat too (nightshift backlog 122, 2026-09-16).** The
in-place editor's state (`editing` in `Transcript.svelte`: the turn, the
draft, the cache line as it read when the editor opened) was one value for
the whole transcript. It survived a chat switch by accident — nothing cleared
it — which also meant the other chat's message at the same index showed the
editor with this chat's draft in it, and on the way back the textarea
re-mounted at its minimum height until the first keystroke (his "majorly
condenses the text box"). The transcript's key-change effect now stashes the
open edit under the chat it belongs to and restores the switched-to chat's,
if it has one, in a plain map beside the scroll entries; so an edit draft
survives a switch away and back, stays with its chat, and is dropped by
Save, Send, Cancel, Escape or a turn starting, as before. Not persisted: it
is an edit in progress, not a composer draft. A `use:grow` action sizes the
editor's textarea to its text the moment it mounts, however it came to
mount. And the editor keeps the reader's place: opening it, Cancel, Save and
Send each measure the message's bottom edge before the change and move the
viewport by however much it moved after (`keepPlace`), and the textarea is
focused with `preventScroll` — a bare `focus()` scrolled the top of a long
message into view, which is what "Cancel scrolls me up to the top" was.

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

**The reply's completion keeps the reader's place (nightshift backlog 131,
2026-09-17).** A turn ends in two flushes — `app.live` cleared at once, the
log re-synced after an IPC round trip — and between them the reply was not in
the DOM. Measured in a harness with a reader at the reply's first lines: the
content shrank to the viewport, the browser clamped `scrollTop` to 0, and the
clamp's scroll event was read by the follow-the-bottom rule as the user
reaching the foot, so `pinned` went true again and the re-sync scrolled to the
bottom. Now the last live segments stay drawn as a *ghost* — the same
`AssistantMessage` instance over the same array — until the re-synced events
land (or 2 s, should the re-sync fail), and the ghost is swapped for the
recorded reply in one flush from an `$effect.pre`. Across the swap the element
he is reading is held: the first element with text inside the live reply in the
top half of the viewport (the reply is what changes shape — it gains the model
header and the footer, and on Claude Code becomes a run of messages), else the
first under the top edge; found again in the new DOM by tag and the start of
its text, nearest to where it was. A pinned reader is left to the pin effect
and lands at the foot as before.

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

## The New-chat draft is per project and per kind (nightshift backlog 094, 2026-09-16)

His report: a draft typed into one project's New chat was still in the box
after ⌘O into another project's New chat. The pending chat's draft was keyed by
one literal, `"new"`, so it was one slot for the whole app; real chats, keyed by
id, behaved.

`draftKey(activeSessionId, projectId, mode)` in `src/lib/drafts.svelte.ts` now
returns the chat id, or `newDraftKey(projectId, mode)` — `new:<project
id>:<kind>`, `unfiled` for no project — while none is open. The kind is in the
key too: the pending kind is held on both sides (blocker 061), and an incognito
draft has no business in an ordinary new chat of the same project. `Composer.svelte`
derives its key from `app.activeSessionId`, `app.project?.id` and
`app.pendingMode`, so a project switch or a change of kind swaps the box the
way a chat switch does, and both drafts come back on return. The New chat
button's `✎` in `Sidebar.svelte` asks `hasDraft` of the same key. `send` and
`sendAgent` compute the pending key at the moment of the send and hand that
entry to the created chat, so the project and kind are the ones the chat was
made in, not whatever is open when the turn ends.

A store written before today has its pending draft under the bare `"new"`;
`loadDrafts` reads that entry once as `new:unfiled:normal` (there is no record
of which project it was typed in) — appended after anything already under that
key — and the next save writes the new shape. Nothing stored is dropped.

Tests: `drafts.test.ts` — the key per project and per kind, a project switch
leaving the other project's draft untouched, the handover from a project-scoped
key with another project's draft staying put, the one-time read of the old key
and its append onto an existing unfiled entry.

## Messages queued during a turn (nightshift backlog 089, 2026-09-16)

Until today ↵ during a turn did nothing: `submit` returned on `app.busy`. Now a
message sent while a turn runs is **held** and goes as the next turn when the
running one ends. The CLI does more — it hands a queued message to the running
turn between tool calls — but that needs a process that stays open across
turns (blocker 062), and this is the half that needs nothing from it.

The queue lives in the draft store (`src/lib/drafts.svelte.ts`), as `queue` on
the chat's `Draft` entry, oldest first: it is the same kind of thing as the
draft — words typed that have not reached the model — so it gets the same key
(per chat, the pending chat's queue moving into the chat it makes), the same
localStorage entry (a relaunch keeps it; attachments under the same caps), and
the same `✎` on the sidebar row. `clearDraft`, which a send calls, now clears
the box and keeps the entry while a queue remains. `enqueueMessage`,
`shiftQueue` (the oldest, out), `takeBackQueued` (a row back into the box —
its words in front of anything typed, its chips after the ones there; no id
means the newest) and `dropQueued` are the operations.

`Composer.svelte`: ↵ and the **Queue** button (beside Stop, which stays where
Send was) hold the box's contents while `app.busy`; the key chip reads
`↵ queue · ⇧↵ newline`. The tray above the box is a dashed box, `queued · sent
when this turn ends` while busy and `queued · waiting` with a **Send next**
button when not (a queue left by a failed turn, a stop that left an error, or
a relaunch); each row is numbered, shows the first line and a file count, and
has *take back* and ×. ↑ in an empty box takes the newest row back, the CLI's
rule; with text in the box ↑ is the caret's. Sending is one function,
`dispatch`: it calls `send`, and when that returns without `app.error` it
`drain`s — shifts the oldest row and dispatches it, so a chain of held
messages goes one turn each. A failed turn puts its words back (the existing
rule) and does not drain: a second send would most likely fail the same way
and bury the error. A Stop is a clean end on both engines (the agent returns
its outcome with an `interrupted` notice), so the oldest held message goes at
once — the queue is why he stopped, or he takes it back first.

Both engines: `send` dispatches to `sendAgent` on Claude Code, and the composer
is the same component, so nothing here is engine-specific.

Tests: `drafts.test.ts` — oldest-first and shift, a send clearing the box and
not the queue, take-back order and the newest by default, drop and the empty
entry, the handover with the pending chat and the persistence round-trip, a
queued attachment over the cap kept out of the store with its text in.

## The draft history, and a queue never dropped (nightshift backlog 158, 2026-09-18)

An 11k-character draft was queued during a turn, then gone: taken back into
the box (↑ in an empty box takes back the newest held message, silently —
the CLI's rule from 089) and replaced by a paste that carried a screenshot
rather than the words. The chat logs of that evening hold no such message,
so it was not sent; it was overwritten, and the store held only the newest
text. Two changes:

- **The draft history** (`draftHistory`, `nightloom.draft-history` in
  localStorage): per composer key, the last `HISTORY_PER_KEY` (10) texts of
  `HISTORY_MIN_CHARS` (200) or more that *left the box* — a send
  (`clearDraft`), a queue (`enqueueMessage`), or a replacement that dropped
  more than half of what was there in one change (`setDraftText`, judged by
  `retained`: the common prefix plus suffix; a keystroke keeps all but one
  character, a select-all paste keeps none). Deduplicated against the ring;
  `HISTORY_TOTAL_MAX` (200 KB) across every key, the oldest snapshot
  anywhere dropped first. The pending chat's ring follows `moveDraft`. The
  composer shows a *drafts · N* picker beside the effort picker once the
  ring has an entry, never locked during a turn; the menu lists each by
  first line, time and length, and a click (`restoreDraft`) puts the text
  back in front of whatever is typed, leaving the ring as it was.
- **A held message the app never drops**: a queued message whose send
  failed used to go back into the box only when the box was empty, and
  nowhere otherwise. Now it goes to the head of the queue (`requeueFront`)
  when the box holds new words.

Tests: `drafts.test.ts` §158 — sent, queued and replaced texts recorded,
short ones and keystrokes not; `retained`; ten per key and restore;
following `moveDraft`; the persistence round-trip and the cap; a queue moved
whole onto an existing one; the failed send re-queued at the head; queue →
take back → send with the ring still holding the words.

## Browsing while a turn runs (nightshift backlog 159, pass 1, 2026-09-18)

~~A chat other than the open one, and New chat, were refused while a turn
ran (blocker 182's default).~~ Since 159 pass 1 the turn keeps running in
the background and he may look elsewhere (`src/lib/browse.ts` is the pure
half; `peekSession`, `park`, `unpark`, `settleTurnView` in `state.svelte.ts`):

- Opening another chat during a turn **parks** the running chat —
  `app.parked` holds its id, events, live stream, pending kind — and shows
  the other chat's log read from disk by the new reader `peek_session`
  (no lock: the turn holds `state.session` for its whole length, so
  `open_session` would wait a turn). The stream keeps landing in the parked
  live state (`liveHost` in `applyTurnEvent`), so coming back (`unpark`)
  shows the reply where it got to, still streaming. The running chat's tab
  keeps the moon (`TabStrip.running`).
- A message typed in the viewed chat queues there (the drafts are per
  chat already) with the toast *A turn is running in ‹chat› — this sends
  when that ends*; the composer's Stop names the chat it stops.
- At the turn's end with a chat parked (`settlePlan`): nothing recorded
  is copied into the view; the pending chat's draft still follows the chat
  its first turn made; the backend is re-opened on the chat on screen
  (`open_session`, or `new_session` for New chat) before the composer
  drains, so what goes next goes where he is looking. The hand-off's
  gauge reading is attributed to the chat that ran.
- The one refusal left: New chat while the running turn is the *pending*
  chat's own first — the pending draft key is one slot per project and
  kind, and a second pending draft under it would be moved into the chat
  the running turn makes (blocker 270).
- Still one live turn (pass 2, blocker 182) and the nine commands that wait
  on the lock (pass 3).

Tests: `browse.test.ts` (the host of a stream event, the four settle
plans, the toast, the state's appender with a chat parked);
`state.tabs.test.ts` (a tab and a drop under a running turn open as a view
with the running chat parked; the return; the New-chat refusal).

## The plan chip on a Claude Code chat (nightshift backlog 073, 2026-09-16)

His two most-run CLI commands were `/usage` and `/context`; neither exists in
`-p`. The context half was already on the top bar — the gauge chip (`61k of
200k · 31%`) reads the newest round's whole prompt plus output against the
model's window on both engines. The plan half is new: on the Claude Code
engine a **plan** chip beside the gauge, `plan 5h ▮ 85% · wk ▮ 86%`, two small
bars in the live blue so it never reads as the context gauge, `· stale` when
the reading is past twenty minutes. Its title says the account-wide caveat
(every surface, not this chat), each window's reset time, where the reading
came from and how old it is. Basic rendering; the Fable board of 2026-09-16
has the shape.

Where the number comes from, in order (`app.planUsage`, `state.svelte.ts`):

1. **The turn itself.** On CLI 2.1.263 the `rate_limit_event` carries both
   windows' share used (`unifiedWindows`; measured 2026-09-16,
   `docs/service-agent.md`). `sendAgent` reads it off `res.plan` through
   `planUsageFromTurn` — whole percentages, ISO reset times, `source: "turn"`,
   age zero — and it is the account's figure at the moment the turn ran.
2. **The two sample files**, through the `plan_usage` command
   (`crates/nightloom-service/src/plan_usage.rs`): the Claude desktop app's
   `~/Library/Application Support/Claude/plan-usage-history.json` (sampled
   about every fifteen minutes while that app runs) and the CLI's
   `~/.claude.json` cache (refreshed only by an interactive `/usage`), the
   fresher sample winning — `bin/usagectl.py`'s rule in the nightshift repo,
   reproduced rather than re-derived. Read on connect to the engine and at
   every turn end; a file older than a turn-sourced reading already held does
   not replace it. Never on a timer: nothing here changes faster than the
   sample.

Nothing is shown before a sample exists, and no denominator is estimated —
the percentage is the one Anthropic reports. No dollar figure, and no
threshold action (blocker 073 decides that).

Tests: `state.svelte.test.ts` (`planUsageFromTurn`: both windows, the 2.1.237
shape as no reading); Rust `plan_usage::tests` (the recency race, the null
five-hour record, no files, a broken file) and `mcp_server::tests`
(`context_status` before and after a write, the tool listing).

## Cards under a reply: artifact links and named files (nightshift backlog 078, 2026-09-16)

Under Nightloom the Claude Code CLI never offers `SendUserFile` — that tool
exists only for a Remote Control client or a cloud session — so a file the
model produced reaches the user as a path in a sentence, and an `Artifact`
call's page comes back as a `claude.ai/artifact/…` URL in text. Once a reply
has stopped streaming, `AssistantMessage.svelte` draws both as cards **under
the reply text**, before the footer: a link card (mark · the markdown link's
text or "Artifact" · the URL · *Open ↗*) and a file card (extension badge ·
the path, relative to the chat's workspace when it is under it · size · *Open*
· *Reveal*). Nothing is drawn while the reply streams — a path half-typed is
not a file yet — and a recorded reply is scanned once.

Detection is in `src/lib/cards.ts` and is deliberately conservative, because a
false card is worse than a missed one:

- An artifact link is `https://claude.ai/artifact/<id>` (six or more id
  characters), each once, in order, at most eight.
- A path is a candidate only when it is **absolute** (`/…` or `~/…`) or
  **quoted in backticks with a slash in it** (`` `notes/ace/x.md` ``), the
  latter resolved against the chat's workspace (`app.connection.workspace`,
  else the project's root) and against nothing else. A bare filename
  (`state.svelte.ts`) is never a candidate: in a coding chat every reply names
  files in passing. Fenced code blocks are skipped; trailing sentence
  punctuation is trimmed; a path ending in `/` is a folder and stays text.
- The backend has the last word: `named_files` (`project::named_files`)
  stats every candidate and answers only for an existing regular file, with
  its size. A folder, a broken link or a path the model made up stays text.
  `~/` is expanded there.

*Open* on a file goes through `open_file` (`project::reveal`, the platform
opener — the OS pairs the file with its application); *Reveal* through
`reveal_file` (`open -R` on macOS, `explorer /select,` on Windows, the parent
folder on Linux), which creates nothing, unlike the docspace's `reveal`. The
link card's *Open* is `open_url`, `https://` only. A failure is a toast.

Cards are drawn on both engines: the API engine's `write_file` names files too,
and the detection is gated on the disk, not the provider.

Tests: `cards.test.ts` (the link and its title, punctuation, fences, the
bare-filename and folder exclusions, the root rules, the cap, the label);
Rust `project::tests::named_files_answers_only_for_a_real_regular_file`.

## The dream row as rows and pills (nightshift backlog 071, 2026-09-16)

Settings → Knowledge → Dreaming picks which engine and model run a dream and
a capture (one knob for both, nightshift blocker 054). ~~It was a `<select>`
of engines and a mono text box for a typed model id under a four-line hint~~
**(2026-09-16: it is now one sentence and a set of rows.)** The sentence at
the top says what will happen — *Dreams and captures run on Claude Code ·
haiku, billed to the subscription* — and is derived from the preference, or
from the rail's current draft when the preference is "the rail's
connection". Under it, one row per engine in the Models card's idiom (a
round check · the name · a billing pill): *The rail's connection* (pill
*bills as the chat does*, with what the rail is on right now under the
name), *Claude Code* (pill *the subscription*), then each provider (pill *its
API key*, or the red *no key set* when none is stored — the row still picks;
the pill says why a pass would fail). The chosen row unfolds a *Model* line
of pills: on Claude Code the CLI's aliases from `AGENT_MODELS` with *the
CLI's default* first; on a provider *default (<id>)* then the ids in that
provider's picker (`modelsFor`, the popover's own list). A stored id that is
in neither list — typed into the box this replaced — is kept as one more
pill. Picking a different engine clears the model, since an alias is not a
provider id.

Nothing else changed: the preference is still `nightloom.dream`
(`provider`, `model`, `auto`), `passTargetFor` reads it as before, the
auto-after-compaction switch is where it was. The rows and pills are built
by `src/lib/dreamRows.ts` (`dreamEngineRows`, `dreamModelPills`,
`dreamSentence`, `railNow`), pinned in `dreamRows.test.ts`.

## The turn-end banner (nightshift backlog 079, 2026-09-16)

In the terminal his own Stop hook says when a turn finishes; under Nightloom
nothing did. Now the app posts a native notification itself, through the
`notify` command (`tauri-plugin-notification`, from Rust — blocker 106), in
two cases and on both engines:

- **A turn finished** — `<chat> — turn finished` over `3 files changed ·
  48k out · 2 min 10 s` (each part only when there is one; `done` when
  none), or `<chat> — turn failed` over the error's first line. Posted from
  the top of the `finally` in `send` and `sendAgent` (`state.svelte.ts`),
  before the live state it reads is cleared: the files from the turn's
  `Write` / `Edit` / `MultiEdit` / `NotebookEdit` / `write_file` /
  `edit_file` calls that were neither denied nor failed, distinct by path;
  the tokens from the last usage event; the time from the optimistic
  `user_message`'s `at`.
- **A turn needs him** — `<chat> — Run Bash?` over `<the argument> · waits
  until you answer`; `Claude asks a question` and `Approve the plan?` for
  `AskUserQuestion` and `ExitPlanMode`. Posted from the `tool-approval`
  listener, which both engines' prompts arrive through (the CLI's deferred
  call since backlog 084).

Two rules. **A focused window is never notified** (`document.hasFocus()`,
checked at the moment of posting, not a setting). And Settings → Appearance
→ *Notifications* has one switch per kind (`nightloom.notify`, both on by
default). The chat is named by its title, else the first line of its first
message, else *New chat*. Nothing is sent anywhere: no push, no phone
(blocker 078). The pure parts — the preference, the copy, the file count —
are in `src/lib/notify.ts`, pinned by `notify.test.ts`.

A third switch since 2026-09-16 evening (nightshift backlog 116): *When
Usage → Refresh now finishes*, the one banner that is posted to a focused
window too and whose click opens a page — [usage-ledger.md](usage-ledger.md)
"A banner when it lands" has the mechanism and its limits.

Not built: a per-chat mute, and the third banner the design draws for a
filled window (~~the handoff of backlog 086 does not exist yet~~ — corrected
2026-09-16: the hand-off landed later the same night, "The context-full
hand-off" below; ~~`notify.ts` still posts no banner for it~~ — built
2026-09-25 with backlog 193: the wrap-up's own turn ends as `<chat> —
handoff written` / `72% · Continue in a new chat, or stay` in place of
*turn finished*, on the turn-end switch; a failed wrap-up reads as any
failed turn; `turnEndBanner` in `notify.ts`). Clicking a
banner activates Nightloom; it does not open the chat the banner names,
~~because the plugin exposes no click event on desktop~~ **(corrected
2026-09-16 evening, backlog 116: the plugin's `show()` discards the click,
but its macOS backend reports one when held synchronously — the Refresh-now
banner does that; these two still ride the plugin's call and could be moved
over the same way)**.

## The Context page on Claude Code: This session, the CLI's own prompt, its memory (nightshift backlog 077 and 088, 2026-09-16)

Three additions to the Context modal (`ContextPanel.svelte`) on the Claude
Code engine, all read-only except one switch; the design they are the
basic form of is `Session.dc.html` and `Layers.dc.html` in nightshift's
`notes/runner-design/claude-code-ui-design-2026-09-16/`.

- **This session** — a third segment of the head, after *Layers · As sent*.
  What the CLI reported at the start of the chat's latest turn, kept
  whole from its `system/init` line (`TurnEvent::AgentInit`, `app.agentInit`,
  cleared on a chat switch): cards for **MCP servers** (name, the status the
  CLI gave — `connected`, `pending`, `needs-auth`, `failed` with its error —
  a bad one in the error colour, and the server's tool count from the
  `mcp__<server>__` prefixes), **Tools** (the built-ins as chips, then each
  server's tools by short name), **Skills** (rows: type `/` in the
  composer), **Slash commands** (the built-ins beyond the skills, as
  chips), **Agents**; a mono foot with the CLI version, the session id,
  the model and the permission mode; and one line saying what safe mode
  drops (measured on 2.1.263: every MCP server and its tools, every skill
  and slash command, and the `Skill` tool; agents and built-ins stay).
  Before the chat's first turn the pane says so — the list is the CLI's,
  and it has not reported yet.
- **Claude Code's own prompt** — the first card under *Layers*, marked
  `read-only`, no switch: replacing the CLI's prompt (`--system-prompt`)
  breaks the tools whose behaviour is written into it, so it is shown, not
  offered. Read from the `prompt_snapshot` attachment the CLI writes into
  its own session file after the first turn (`cli_prompt_snapshot` in
  `main.rs`; the shape is in nightshift
  `notes/runner-design/077-measurements-2026-09-16.md`), with a token size
  estimated at four characters a token and said as an estimate; Read opens
  the sections joined. None before the first turn or for an ephemeral chat
  (no file), and the gloss says which.
- **Claude Code memory** — the card at the foot of the layers, with the
  per-chat switch; see `docs/service-agent.md` "The CLI's auto memory, as a
  layer".

**The `/` picker** (`Composer.svelte`): on this engine, once the chat has
had a turn, a message that starts with `/` opens a list over the skills and
slash commands from the same init line, filtered by what follows the slash;
↑↓ move, ↵ or Tab insert `/name ` and close, Esc closes, a click picks. It
inserts text only — the CLI runs a skill named in the message when Send
goes. Nothing on the other engine, and nothing before the first turn.

**Restyled to the approved boards (2026-09-16 afternoon, nightshift
`claude-code-ui-design-2026-09-16/Session.dc.html` and `Layers.dc.html`).**
*This session*: an MCP server's row is the board's grid — status dot (green
connected, red failed) · name in mono · what it offers (its tools by short
name, or a failed server's error in the failed red, or its status) · the
tool count — with a hairline between rows; Tools and Skills sit side by
side, as do Slash commands and Agents; the slash chips past twelve fold
behind `+ n more` (a click shows them all, `fewer` folds them back); the
Agents card says a subagent's turns fold under its Agent call; the foot is
one span per fact (`claude 2.1.263 · session 5eb30ca1 · model … ·
permission auto · effort high · no fallback · safe mode off — on, this
panel loses MCP, skills, commands and hooks`), the safe-mode measurement on
hover of its span. *Layers* on Claude Code: `read-only` is the board's
ruled pill in the accent ink; the CLI's own prompt and its memory show
their size against the window as the gauge's bar (`11k ▮ 5.5%`, the
estimate on hover); the pane's foot says the CLI's prompt is shown, never
replaced.

## The context-full hand-off (nightshift backlog 086, 2026-09-16)

On the Claude Code engine the CLI's auto-compact is off (`docs/service-agent.md`
"Auto-compact off"), and this is what a full window does instead. The
stage machine is `handoff.svelte.ts` (`nextStage`, unit-tested; the app
could not be driven the night it was built); everything on screen is the
composer's bar, the top bar's mark and one control on the Context page.

1. **Due.** At the end of each agent turn the gauge's pair — the last
   reply's `input + output` over the CLI's window — is compared to the
   chat's threshold. Past it, a ruled bar above the message box reads
   *Context N% — past this chat's 70% hand-off mark. Your next message
   carries a wrap-up…* with **Send the wrap-up now** and **Stay here**.
2. **Wrapping.** The next message goes out with the wrap-up appended under
   a `---` rule, marked *Added by Nightloom* so his words and the app's
   are never confused: write `HANDOFF.md` at the top of the project —
   doing, done, next, decisions, files that matter — in the model's own
   words, then stop. Visible in the transcript as part of his message.
3. **Wrapped.** When that turn ends the bar offers **Continue in a new
   chat** · **Stay here**. Continue (`continueChat` → `continue_session`)
   opens a fresh chat in the same folder, linked to this one, with "Read
   HANDOFF.md and continue." ready in the box — not sent; this chat stays
   in the sidebar, readable. The new chat's top bar carries *↳ continued
   from <the earlier chat>*, a click on which opens it; the sidebar row
   shows the lineage line it already shows for forks.
4. **Stay here** at either stage goes back to quiet, and the wrap-up is
   asked again only past 85% and higher than where it was dismissed.

**The threshold** is per chat (localStorage, 70% by default): Context page
→ Conversation, *Hand off at [70] % of the window*. Lowering it to a few
percent on a test chat is how to see the whole flow on Haiku without a
long context.

### Pass 2 (2026-09-16 afternoon, nightshift blocker 120; answers blocker 092)

The shape above is his own hand-run practice made automatic — ask the
model for a wrap-up and a start prompt, paste the prompt into a fresh
session — with three refinements in his words: nothing fires mid-work, the
message is editable per chat, and the default is editable globally. What
changed, stage by stage (`handoff.svelte.ts`; the pure parts are
unit-tested, the app was not driven):

1. **The fill is read mid-turn too.** The CLI reports usage after each of
   its own requests within a turn (`app.liveUsage`); the composer feeds
   each reading to `noteFill` alongside the turn's end, so a crossing
   while a long turn runs is seen while it runs. A mid-turn reading never
   ends the `wrapping` stage: the wrap-up's reply is not in yet.
2. **The notice** replaces the due bar. The board's hand-off card in the
   composer: *Context 72% — past this chat's 70% hand-off mark*, the pair
   at the right (`144k of 200k · 72%`), one line of what happens, then
   **Hand off this chat at [70] %** (the per-chat mark; raising it above
   the fill puts the notice away without counting as a *Stay here*, so the
   new mark asks afresh — `reconsider`), the **wrap-up message** in a
   field (prefilled from Settings; edits are kept for this chat in the
   same localStorage entry as its mark — `nightloom.handoff`, `messages`),
   **Wrap up now** (accent), **Stay here**, *Reset the message* when the
   chat has its own, and the strip *stay past 85% and the wrap-up is asked
   again*. **Nothing is sent by itself while a notice he has seen is
   open.** ~~Your next message carries a wrap-up~~ — the wrap-up is a
   message of its own now; his own messages go as typed.
3. **Away, at the crossing only.** Away means no send and no keystroke in
   the composer for 60 s (`AWAY_MS`; `noteActivity` on the textarea's
   input and on submit) *and* the window not in front (`windowFocused`)
   or the chat not the open one (`isAway`). When the mark is crossed
   (`idle → due`, `autoQueues`) with him away, the wrap-up is put in the
   composer's queue (backlog 089, `enqueueMessage`) — the row reads
   *wrap-up · queued while you were away* — so it goes when the turn ends
   and the queue's own × takes it back; *Stay here* takes it back too.
   Present, only the notice shows. Never after a *Stay here*: the re-ask
   past 85% shows the notice and nothing more (nightshift blocker 121's
   default). A notice already open never queues.
4. **The wrap-up message** (`WRAP_UP`, the built-in default): finish or
   save whatever edit is half-done; write `HANDOFF.md` at the top of the
   project (doing, done, next, decisions and why, files that matter, in
   the model's words); end the reply with a short start prompt for the new
   chat — which files to read, in which order, what to do first — in a
   fenced block tagged `start-prompt`; then stop. ~~`---` rule and *Added
   by Nightloom* marker~~ — gone with the append. **Settings → Claude
   Code** (a new pane, nav under Providers) holds the default mark (*Hand
   off at [70] %* for every chat without its own) and the message in a
   field with *Reset to default*; both in the same `nightloom.handoff`
   entry (`default`, `message`; null message = built-in). The store is a
   reactive `$state`, so the notice, the Context page's field and Settings
   agree at once. A box emptied while typing stays empty for this launch
   (Wrap up now disables, nothing queues) and reads as the built-in after a
   relaunch.
5. **The switch.** When the wrap-up's turn ends the composer keeps the
   *last* `start-prompt` block of the reply (`extractStartPrompt`,
   `lastReplyText` over the log). **Continue in a new chat** creates the
   linked chat (`continueChat` → `continue_session`, unchanged) with that
   prompt in the box, **never sent** — blocker 092's answer. No block: the
   box is empty, a toast says so, and the composer's hint line under the
   box (*continued from the earlier chat — its wrap-up reply had no
   start-prompt block…*) repeats it until he types. ~~"Read HANDOFF.md and
   continue." in its box~~. The wrapped bar says which of the two it will
   be before he clicks.
6. **The queue after the hand-off.** `queueHold`: ~~due holds (F11)~~ —
   the wrap-up rides no message, so a notice holds nothing and the queued
   wrap-up drains through the queue like any row; what holds is a Stop
   (F12, as before) and `wrapped` — HANDOFF.md written, the model stopped,
   and the next thing is *Continue in a new chat*, not more work in the
   full one. *Send next* is the explicit choice.

Kept from pass 1: the `wrapping` and `wrapped` stages, *Stay here* on both
the notice and the wrapped bar with the 85%-and-higher re-ask, the
per-chat field on the Context page (now with the Settings default named),
the top bar's *↳ continued from* mark, `continue_session` and the
`handoff` lineage reason. No backend change. Not verified in the running
app; the DoD's measurement on Haiku is the orchestrator's, after the roll.

**Restyled to the approved boards (2026-09-16 afternoon, nightshift
`claude-code-ui-design-2026-09-16/Handoff.dc.html`, `Continued.dc.html`).**
The behaviour above is unchanged; three drawings were matched. A chat the
hand-off card opened (`forked_from.reason === "handoff"`) now carries the
board's header above its first turn in `Transcript.svelte` — a dashed row
with the branch mark, *Continued from "q5 divergence sweep" · HANDOFF.md*,
and *open the earlier chat* at its right — beside the top bar's own mark.
The done card (*HANDOFF.md written*) carries the branch mark in the accent.
A notice row in the transcript (today the compaction notice; the board's
`context 72% — wrapping up` row is the same kind) is the board's ruled
amber mono: a rule either side, the words between.

**The read order (nightshift backlog 193, 2026-09-25).** *Continue in a new
chat* now fills the new chat's box with a fixed prompt — the read order —
and under it the model's `start-prompt` block (`firstMessage` in
`handoff.svelte.ts`), both editable, nothing sent. The built-in read order
is the practices one (the newest `## STATE AS OF` section of `HANDOFF.md` by
line range, then `backlog/INDEX.md`, then `blockers/INDEX.md`, one file per
command; nightshift blocker 366, question 11). Settings → Subscription →
Hand-off has *The read order* with *Reset to default*; a blank stays blank
across launches (the box then opens with the start prompt alone). The
wrapped card has this chat's own copy and *Reset the read order*; a chat's
own copy goes on to the chat that continues it (`carryReadOrder`). With no
block in the reply the box opens with the read order alone and the toast
says the block was missing. The built-in wrap-up changed with it: it adds a
new `## STATE AS OF` section at the top of `HANDOFF.md` ~~overwrites
HANDOFF.md~~ (an overwrite lost every earlier hand-off) and asks the model
for only what the read order does not say. A wrap-up of his own in
Settings is untouched. Also fixed: the notice's *Reset the message* set a
blank wrap-up for the launch instead of dropping the chat's own
(`clearMessage`). Tested against a scripted engine in
`handoff.continue.test.ts` (usage readings, the wrap-up's reply, a stubbed
`continue_session`). The prompt is stored in `nightloom.handoff`
(`readOrder`, `readOrders`).

## Prompt suggestions as a ghost line (nightshift backlog 083, 2026-09-16)

Off by default. Context page → *This session* → **Prompt suggestions**
switch (app-wide, localStorage; a flip reconnects the open Claude Code
chat). On, the CLI is started with `--prompt-suggestions true` — the value
spelled out, since the option would otherwise swallow the prompt — and
after each turn's `result` it emits `{"type":"prompt_suggestion",
"suggestion":"…"}` (`TurnEvent::PromptSuggestion`, `app.suggestion`). The
composer shows it dimmed over the empty box with a `Tab` cap
(`suggestions.svelte.ts` `ghostFor`): Tab or a click puts it in the box,
Esc drops it, typing hides it, a send or a chat switch clears it. Never
sent on its own; nothing on the API engine. The cost the switch names:
the CLI waits for the prediction before its process exits — about six
seconds added to every turn on Haiku (measured, nightshift
`notes/runner-design/083-measurements-2026-09-16.md`) — and one more
request against the plan, unreported by the CLI. A one-word exchange
produces no suggestion; a real question does.

## The bell and the daily pass (nightshift backlog 069, 2026-09-16)

His words on the item: the dream should run on its own once a day and he
should find what it did waiting for him, in one place, with a way to
review or undo each thing. Three parts, all in `nightshift`.

**The daily pass.** Settings → Knowledge → *Every day*, a card under
*Dreaming*: a switch (off by default — the pass runs unattended and bills
whatever engine runs it), an hour (default 04:00), *A macOS notification
when the bell gains something* (off; blocker 106), *Run the daily pass
now*, and a last-run line (*never run* until it has). The preference is
`nightloom.daily` (`on`, `hour`, `notifyMac`); the last run's stamp is
`nightloom.daily.last`. The pass is `runDailyPass` in `state.svelte.ts`:
capture (skipped when no chat has new bytes) → dream (skipped when the
inbox is empty) → tidy (`tidy_memory`, apply — the thirty-day archive of
struck lines, [service-data.md](service-data.md) "The daily pass"), on
the connection `passTargetFor` already picks, so it runs on the
subscription engine or a provider alike, under the Dream and Capture
buttons' one-at-a-time lock. A toast closes it: *daily pass: captured
from 3 chats, dreamed 7 observations, nothing old enough to archive* — or
*nothing new to capture, nothing to dream* on a quiet day, which spends
nothing. The due rule is `dailyDue` in `src/lib/centre.ts` (pinned by
`centre.test.ts`): on, today's hour has come, no pass since that hour. A
minute clock fires it while the app is open; start-up and the wake
watcher's `system-woke` (backlog 101) fire it when the hour passed closed
or asleep. The stamp is written at the *start* of a run, so a failed pass
waits for the next day or the button rather than retrying every minute.

**The bell.** `NotificationCentre.svelte`, a 🔔 with a count, in the chat
view's top bar and in the Nightshift page's header. Its list is
*derived*, not stored — rebuilt by `refreshCentre` after every pass, when
the panel opens, on a `nightshift-change`, and when a morning page is
marked read — from five sources, and only the dismissed ids
(`nightloom.centre.dismissed`) and the last seen build stamp
(`nightloom.centre.build`) live in localStorage. The panel, *To review*,
lists each kind with a count and a *Dismiss all*, each row with *Dismiss*:

- **Proposals** — every project's and his own, from the proposal stores
  (`centre_proposals` walks the registry). *Review the diff* switches the
  project if it must and opens `NoteView` in its proposal mode (Load into
  editor / Dismiss), the flow that already existed.
- **Notes changed by a dream** — the `nightloom: dream —` commits in the
  vault and in each project's `.agents` (`centre_dream_commits`, `git log`
  with numstat, the last ten). *Show the diff* draws the commit in
  `DiffView` under the row with the file list (+/−) and a **Revert** per
  file: the app's confirm dialog, then `git checkout <sha>^ -- <file>`
  (or `git rm` for a file the dream created) **committed** as
  `nightloom: reverted <file> from dream <sha>` — blocker 168's default,
  so the vault's history stays a straight line and the dream's version is
  still in it.
- **Morning pages** unread and **Blockers** open — from the Nightshift
  rows every project already reports (`nightshift_projects`, the same
  counts as the tab badges). *Read it* / *Answer* open the Review tab on
  that project.
- **Releases** — the running binary's modification time
  (`build_stamp`) differs from the one this window last saw: *A release
  was installed (0.1.0)*. The roll script rewrites the binary and nothing
  else does, which is why the stamp is the time and not a version.

At the foot: *Run the daily pass now* (the Settings button again) and the
schedule line. A click outside the panel or Escape closes it. With the
card's *macOS notification* switch on, a refresh that found notices this
window has not listed before posts one banner through the `notify`
command (*Nightloom — to review* over the first title and *and N more*);
a window's first refresh never posts, so a relaunch is silent.

**To see it today** (the checklist in nightshift's
`notes/runner-design/069-report-2026-09-16.md`, condensed): press *Run the
daily pass now*; watch the toasts; click the 🔔; *Show the diff* on a
dream row and *Revert* one file — the toast, and `git log` in the vault
showing the revert commit; *Review the diff* on a proposal; *Dismiss* a
row and relaunch — it stays gone; switch the pass on with the next full
hour and leave the app open. Nothing here was seen on screen the night it
was built (no `cargo tauri dev` under the running app); the checklist is
the measurement, and the morning's build is where it is walked.

The Rust side is `crates/nightloom-service/src/centre.rs` (proposals
everywhere, the dream commits, the diff, the per-file revert, the exe
stamp) and `tidy.rs` with `dream::tidy_targets`; six commands in the
desktop's `main.rs` (`centre_proposals`, `centre_dream_commits`,
`centre_dream_diff`, `centre_revert_file`, `build_stamp`, `tidy_memory`).
Not built: a per-row mute, a notice for a capture's outcome on its own,
and anything sent off the machine (blocker 078 still binds).

## The top bar folds by priority (nightshift backlog 129, 2026-09-17)

`TopBar.svelte` is a CSS container (`container-name: topbar`); three
`@container` rules fire on the bar's own width, so ⌘= zoom (backlog 108)
and a half-width pane fold it the same way. Under 1000px the gauges lose
their words (`of 200k`, `plan`, `· stale`); under 860px the spend chip
folds into the context gauge's hover, the gauge drops its percentage and
the plan chip its week; under 700px the counts fold too — both gauges are
bars alone, 44px — the kind chip drops `· subscription` and the short id
after the title folds. Every folded figure is in a hover (the gauge's
title carries tokens, percentage and spend at every width); the rail (⌘M)
and Context (⌘⇧C) hold all of it. The title is the one thing on the left
that ellipsizes. Containment makes the bar a stacking context, so it has
`z-index: 1` to keep the rail popover over the transcript. His rule
(review of the tabs boards): drop elements by priority, never truncate
them all; the plan's 5h bar, the context bar and the kind survive last.

## Tabs and panes (nightshift backlog 099, 2026-09-17; blockers 140, 142, 182, 183)

The centre is one or two **panes** side by side, each with a strip of
**tabs**; a tab is a chat or a note ~~— and nothing else~~ (since
backlog 140, below: or the Nightshift page, the graph, the New project
form, a project card, an aside). The model is `tabs.ts` (plain
objects, tested); the one workspace is `app.tabs`; `App.svelte` draws the
panes and `TabStrip.svelte` a strip.

**Two directions, nothing else.** *Activation* — a tab clicked, ⌘⇧] /
⌘⇧[, a close landing its neighbour — calls the same `openSession` /
`newSession` / `showNote` the sidebar always has (`activateTab`).
*Reflection* — an effect in `App.svelte` on `app.view`,
`app.activeSessionId` and `app.openNote` — records what the centre now
shows into the focused pane's active tab (`reflectTabs`): the tab already
holding it is activated, else the active tab is retargeted (a plain
click *replaces*, blocker 140), or a new tab is opened beside it when
`app.openNext` is `"new"` (⌘-click on a chat or note row, ⌘T). So every
opener — the sidebar, ⌘K, the search panel, the hand-off card, the
phone's `remote-send` — lands in a tab without knowing tabs exist, and a
new chat's tab retargets to its session on the first message.

**A pane draws by its own active tab.** A note tab is `NoteView` with the
note as a prop — live in either pane, reading and saving under its own
scope and name. A chat tab whose chat is the open one (`liveTab`) is the
transcript and composer; the top bar sits over that pane. Any other chat
tab is a card naming the chat with *Open here*: the backend holds one
session (`AppState.session`), so one chat is live at a time until a
session per tab exists (blocker 182). Switching to another chat's tab,
⌘T, and closing the live tab are refused with a toast while a turn runs;
a note beside a streaming chat works. A mousedown in a pane focuses it
(`focusPane`): a note in front becomes the open note, a chat card stays
a card.

**Rules.** A pane never has zero tabs — the last tab of one of two panes
closes the pane, the last tab of the last pane becomes a new-chat tab;
⌘W never closes the window (blocker 183). At most two panes. Closing
lands the right neighbour, else the left. The sidebar's rows carry ▭
when open in a tab that is not the live one. `useProject` resets the
workspace; a deleted chat's or note's tabs go with it. Nothing is
persisted across a relaunch. `closeNote()` (the note view's ← Chat)
closes the focused pane's note tab; `leaveNote()` is the old view-level
body the chat openers call.

**Keys and menus.** ⌘T `new_tab`, ⌘W `close_tab` (File; the predefined
Close Window is gone — the traffic light closes), ⌘⇧] `next_tab`, ⌘⇧[
`prev_tab`, Open Beside `split_tab` (View); the same chords in
`App.svelte` off macOS. A tab's right-click menu: Close · Close others ·
Open beside / Move to the other pane. Middle-click closes.

**Drag.** A tab dragged onto a strip reorders or moves (`moveTab`); onto
a pane's content, the *open beside* half lights and a drop splits
(`splitTab`, one pane) or moves (two panes). The divider is the composer's
`Grip`; the left pane's width is `app.layout.panes.split`.

**The terminal's dock.** Each pane ends in `<div class="pane-dock"
data-pane={pane.id}>`, under the composer, empty until backlog 113's
terminal mounts into it.

### Tabs above everything; the + chooser; drags in (nightshift backlog 140, 2026-09-17; blockers 193, 194, 195)

His walk of `b6a9c07`: the + did nothing, the × on the sole tab did
nothing, nothing could be dragged into a tab, and Nightshift made the
strip vanish. All four came from one rule — the strip was drawn only
for a chat or a note.

**Tabs sit above everything.** `TabContent` is `chat | note |
nightshift | graph | new-project | project {id} | aside {session}`.
`shownContent()` maps every `app.view` to a content, so the reflection
lands the Nightshift page, the graph and the New project form as tabs
the way it lands a chat; `activateTab` opens them through
`showNightshift` / `showGraph` / `showNewProject`. Those three are
**singletons** (`SINGLETON_KINDS`): `land`, `openBeside` and `insertAt`
activate the one there is, in either pane, rather than making a second.
The openers call `reflectTabs()` themselves at their end, so a click
with the view already that page (its tab in the other pane's
background) still lands; `useProject` reflects after resetting the
workspace, so the Nightshift page survives a project switch as a tab;
`closeNewProject` closes the form's tab. The panes always draw; a pane
renders by its active tab's kind. The **top bar** draws over the pane
whose *active* tab is the live chat, else over the focused pane when a
note is in front (the chat is open under it), else nowhere — the bar is
a chat's. The sidebar's Chats and Notes modes no longer leave the
Nightshift view.

**A project tab is a card** (blocker 193): name, folder, counts, *Open
this project* — the click is the switch, which resets the workspace as
it always has; the open project's card says so and has no button.
`forgetProject` drops the card.

**An aside tab** (backlog 130 part 2, blocker 194) is a second view of
the chat's thread where it lives — `app.aside` for the open chat, the
stash for another (`asideOf`) — never a copy. While one exists
(`asideInTab`) the transcript hides its card; closing the tab shows the
card again; nothing enters the chat. `AsideView.svelte` draws the
thread and offers a follow-up and × only while its chat is the open one
(the backend forks the open chat); another chat's thread reads as it
was, with a line saying to open the chat. A deleted chat takes its aside
tab. The card's head row is the drag source (one hunk in
`Transcript.svelte`).

**The × on the sole tab.** The model swapped a sole New-chat tab for an
identical one, which showed nothing; `closeTab` now says so in a toast
(the window closes from its red light, blocker 183). A sole *chat* tab's
× still leaves the new-chat page.

**The +** opens `TabChooser.svelte` under the strip (blocker 195): New
chat with the two kinds of backlog 102 (dot on the project's default),
New note in this project / in the knowledge base (the row becomes a
name field; ↵ creates and opens), the six newest notes of each store,
Nightshift, Graph, the projects (cards). Every pick opens a **new tab
beside the active one** (`openContent(content, "new")` — the sidebar's
openers plus an explicit reflection, so a pick that changes nothing
visible still lands and hands `openNext` back). ⌘T is unchanged.

**Drags in.** A sidebar chat row, a note row (both stores), the
sidebar's Nightshift button, the Notes panel's ◈ graph button, a project
row in the project menu and the aside card's head are `draggable`,
carrying a content descriptor as JSON under `CONTENT_DRAG` (parsed back
by `parseContentDrag`, which refuses anything else) and mirrored in
`app.draggingContent` for `dragover`. A strip takes it as a new tab at
the slot (`insertAt`: the accent bar shows where; the tab already
holding it is activated instead); a pane's half as *open beside* (one
pane: a second pane holding it) or *open here* (two panes: a tab in that
pane) — `dropContent`. A chat other than the open one is refused with
the toast while a turn runs (blocker 182). The terminal dock's shell
tabs drag too under `TERM_DRAG` (backlog 113's 12b, blocker 189): every
pane lights whole — *dock the terminal here* / *the terminal is here* —
and a drop on a pane or its strip sets `term.pane`, moving the one dock;
the shells run on. Known: the dock's shells re-mount in the new pane, so
the drawn scrollback is cleared by the move (the pty and its process are
untouched) — a patch note for the terminal's owner names the fix (keep
each shell's host element in the store and re-append it on mount).


## Search everywhere in the sidebar's column (nightshift backlog 117; 138, 2026-09-17)

⌥⌘F (~~⌘⇧E~~ until 2026-09-23: blocker 164 answered "command option F";
Ctrl+Alt+F elsewhere), the sidebar's search box, or ⌘K → *Search chats…*
opens the panel in
the sidebar's column (blocker 153: a panel, not a page): the field, the
scope *this project · all chats · notes*, the count line, the hits grouped
by chat with the passage, who said it and when. ↑↓ previews the chat
behind with ⌘F's bar on the match; ↵ opens it and closes the panel, the
query staying in the box with an `n ▸` to reopen; ⌘F's bar carries its
query into the panel and back. `SearchPanel.svelte`, `search.ts`,
`search.svelte.ts`; the store's `search.rs` answers.

**Since backlog 138 (2026-09-17):** the column no longer jumps to 380px the
frame the panel opens — it grows up to 80px past the sidebar's own width,
never past 380, eased over 160 ms, and comes back the same way on close
(`searchGrowth`, a tween the panel drives on mount and unmount;
`sidebarColumn()` adds it to the sidebar's width; blocker 202 holds "same
width" and "the full 380" as one-line alternatives). In a narrow column the
scope row tightens (~~under ~330px, a container query~~ since 2026-09-23
by measurement, `fold.ts`, backlog 183: WebKit under ⌘+ zoom queried the
container a zoom step late). And there is a way out from anywhere: **esc closes the panel
wherever the focus is** — a result row, a fold chevron, the transcript —
not only from its field (before, an esc after any click reached the window,
and macOS took it as *leave full screen*); another text field's esc stays
that field's (the composer, a rename, ⌘F's bar). An **×** at the panel's
head closes it by mouse; the field's own × clears the query and shows only
while there is one.

**⌘F's bar's right end (backlog 139, 2026-09-17; blocker 203):** the
"search all chats ⌘⇧E" (now ⌥⌘F) text link after the bar's × — a second thing in a
second voice, tacked on after the bar's last control — is now a glyph
button in the bar's own shape (the sidebar's search glass, 22px like ‹ › ×)
placed *before* the ×, so the × is the last thing again; the words and the
chord live in its tooltip ("Search all chats for this (⌥⌘F)"), and a small
accent dot at its corner says the panel still holds results to go back to
("Back to the results (⌥⌘F)"). The boards for the three shapes considered
are `notes/runner-design/139-boards-2026-09-17.md` in the Nightshift repo.

**The file card's Open refuses what the OS would run (nightshift backlog
136, 2026-09-17; blocker 205).** Open hands the reply's path to the OS
opener, and for an installer, a `.command`, an `.app` or a file with the
execute bit that is a run, not a view — on a path the model chose. Those
are refused with a sentence naming what the file is and Reveal, which only
shows it (`main.rs` `launchable()`; the list is the blocker's). Two more
from the same review: a sidebar rename or delete of a chat that is *not*
the one running a turn no longer waits the turn out (`rename_session` /
`delete_session` `try_lock`, told the open chat's id; the running chat is
refused with a sentence), and the held nightshift launch's `caffeinate`
carries `-w <pid>` so a crash cannot leave the Mac unable to sleep.

**The rest of the eleven, sorted (2026-09-17 later, backlog 136 pass 2).**
The rule is the review's: a command that only *reads* takes a `try_lock`
and refuses at once, naming the open chat's turn; a command that must
*write* waits, so the write lands on the finished turn instead of being
lost to a toast. Readers: `transcript` ("the open chat is running a turn —
the transcript is what is on screen, and it refreshes when the turn ends";
every caller keeps `app.events`) and `cli_prompt_snapshot` (the Context
popover's CLI-prompt card; it shows nothing for the moment and asks again
on its next open). Writers, left queued as today (blocker 206's default):
`new_session` (⌘N), `open_session`, `open_project`, `close_project`,
`forget_project`, `set_prompt_layers`, `set_prompt_layer_text` — each sets
or appends to the session the turn holds, and a queued one runs against the
finished turn with nothing lost. What a queued ⌘N still lacks is a visible
tie to the keypress; that is a front-end gate per control ("…when the turn
ends"), the tab flow's files.

## The subagent limits (nightshift backlog 165, 2026-09-18)

The one cap of `a4a681f` (six spawns per turn, refused in words by the
Agent hook) became a family, each a setting with a default on the rail's
*Subagent limits* row (`app.draft.agentLimits`, `catalog.ts`
`SubagentLimits` / `DEFAULT_LIMITS`, sent at connect as `limits` →
`AgentSpec::subagent_limits`, `brief::SubagentLimits` in the service):

- **per turn** (6) — Nightloom's hook, as before.
- **at once** (20) and **depth** (3) — the CLI's own limits, *passed* as
  its environment at spawn (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`,
  `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`; `external`, read from the 2.1.263
  bundle's strings). The CLI refuses past them in its own words ("Concurrent
  subagent limit reached… Do not retry"; "Subagent nesting limit reached
  (depth d of D)…") and counts the refusals in its result JSON under
  `subagent_stats.refused.{concurrency_limit, depth_limit}`. The third
  native limit, `refused.budget`, is the rail's existing *Budget* field
  (`--max-budget-usd`).
- **per day** (30) — a running count per chat across turns
  (`subagent-spawns-day.txt`, `YYYY-MM-DD n`, restarting with the date).
- **slow at % / to** (70 → 2) and **stop at %** (90) — the usage-aware
  pair. The hook reads the freshest of two readings of the five-hour
  window: the desktop's gauge (`plan_usage::read` — the Claude app's sample
  and the CLI's cache file, which `claude -p "/usage"` refreshes for zero
  tokens, 166's finding) and the last `rate_limit_event` this chat's turns
  carried (`subagent-usage.txt`, written by the translator's `usage_sink`).
  A reading whose window has reset, or older than a window, is no reading.
  Past *slow at* the per-turn cap drops to *to* and the refusal says so;
  past *stop at* every spawn is refused with the reset time in the reason.

The limits ride to the hook as `subagent-limits.json` beside the brief,
written when the connection is pointed at a chat (`set_ask_dir`), so a
per-chat override is a file away (blocker 272). The Running-tasks header
shows the caps in force: *3 of 6 · window 74% · slowed*.

Tests: `brief.rs` (round trip and partial file, the environment, slow then
stop with the reset time and the freshest/current rules, a simulated 92%
window refusing and 75% holding a turn to two, the day count across turns
and its restart); `catalog.test.ts` (`readLimits`).

### Pass 2 — the budget enforced mid-flight, and the council under it (2026-09-22)

The Stuart 9 diagnosis (nightshift `stuart9-usage-diagnosis-2026-09-22.md`):
six subagents took the window from under 50 % to 100 % in eight minutes, and
the limits above only looked at the window *when a subagent was launched*.
His answers (blockers 278–280): **35 %** of the window a message, **4** at
once, subagents on **the chat's own model** with Sonnet as a switch.

- **The budget (`budget_pct`, 35).** The one hook process (`--subagent-hook`)
  is registered on **every tool** now (`BRIEF_MATCHER` is `.*`) and in every
  position — the Chat policy's and a council seat's included — so it sees each
  call of the main thread, its subagents and the seats (measured on 2.1.263:
  the hook's stdin for a subagent's `Read` carries `agent_id` and
  `agent_type`, and its deny reached the child). A message's ledger,
  `turn-budget.json` beside the brief (`TurnBudget`), starts with
  `begin_turn` — the window reading on hand, no `/usage` run, so no latency
  on the turn; when none is on hand the first hook reading pins the start,
  which can only understate the spend — and every hook call records the
  latest reading under the file lock (`note_reading`). `budget_verdict`
  refuses a call once the window is past `stop_at`, or once latest − start
  reaches the budget, with words that say to stop and report (a reply needs
  no tool) and not to retry. The window reading is the freshest of the turn's
  own `rate_limit_event`s (the wire file, seconds old during a turn) and the
  gauge, refreshed through `/usage` when over two minutes old — under a
  **cross-process** throttle now (`plan_usage::read_fresh_shared`: a stamp
  and a lock file in the temp dir, one run a minute machine-wide, and a hook
  that finds the lock held uses the stamp rather than waiting). How far a
  burst can overshoot: the gauge moved 40 → 41 % in 3½ minutes under two
  agents' turns (sampled every ~23 s), and Stuart 9's six moved it ~6.5
  points a minute; with 4 at once (~4.4 points a minute at that rate) and a
  reading at most ~2 minutes old, the overshoot past 35 % is bounded by
  roughly 9 points, typically far less since the wire reading refreshes on
  every response.
- **Fewer at once:** `concurrent` 20 → 4 (the CLI's environment, as before).
- **The subagents' model (`model`, `chat` | `sonnet`):** the rail's *Subagents
  use* select; the hook sets the spawn's `model` input to `sonnet` unless the
  parent asked for `haiku`.
- **The meter:** the Tauri command `turn_budget(session)` reads the ledger
  (by session id — the running turn holds the session lock); the front end
  polls it every 5 s while busy and once at the turn's end
  (`app.turnBudget`, `budget.ts`). Shown as `spent 4% of 35%` on the top
  bar's agents chip (`stopped · 35% of 35%` in red once refused), in the
  Running-tasks header's caps line, and — as a patch note in the pass-2
  report, since `Composer.svelte` was another builder's that day — beside
  Queue and Stop. The hover says what the numbers are and that they are
  account-wide.
- **The council under the same budget:** `seat_spec` keeps the brief (its
  hook is the budget's; the policy still refuses `Agent`), `run_seats`
  starts the ledger in phase `seats` and marks `seats-done`, and the chair's
  `run_turn` continues it (a `seats-done` older than ten minutes is not
  continued); `send_agent` points the ask directory *before* the seats. The
  popover shows the line *Budget: 35% of the 5-hour window for this message
  — the seats and the chair together · window now 21%, 35% before the 85%
  stop line* above *Send to the council*.

Tests: `brief.rs` (the verdict's two lines and the zero budget; the chair's
continuation; every tool judged through the hook with the ledger's latest
never moving back; the Sonnet switch); `plan_usage.rs` (the stamp);
`council.rs` (the seat keeps the brief); `agent/mod.rs` (the entry rides the
Chat policy); `catalog.test.ts`, `budget.test.ts`.
