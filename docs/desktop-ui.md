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
submenu silently breaks copy and paste in every text box the app has. The four
custom items (Settings ⌘,, New Chat ⌘N, Open Folder as Project… ⌘O, Import from
claude.ai…) are **forwarded to the webview** as a `menu` event carrying the item's
id, and `runMenuCommand` in `state.svelte.ts` acts on it: each one is a frontend
flow — a modal, a file dialog, a re-connect — and the backend has no way to run
half of one. Nothing is reachable *only* from the menu, so no other platform is
missing a capability.

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

`RightRail.svelte` with three tabs:

- **`ProviderRail.svelte`** — provider/model dropdowns and seven switches: tools,
  ask-before-writing, web access and self-compaction (the last three shown only
  with tools on), knowledge, preamble, and per-turn status. It re-connects on
  every change and auto-connects at launch to the last-used draft.
- **`TaskPanel.svelte`** — the model's task list, badged with the open count.
- **`ContextPanel.svelte`** — the `WireView`; see [desktop.md](desktop.md).

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
search keys, and the vault's folder.

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

### The model picker

Candidates are curated ∪ custom ∪ live-fetched (via `list_models`), in that
order — curated, then fetched, then custom — and **that order is load-bearing**:
`customModels` is *also* the storage for "this id is on", so an id from the API
joins it the moment it is switched on. Read before the fetched list, turning one
chip on moved its whole family (which sorts by its first member's index) to the
top of the list under the user's cursor.

It is **cartouches, not a checkbox column**, and two shaping passes
(`catalog.ts::groupModels`) are what make a fetched list readable: a vendor's
`/v1/models` is a few hundred ids in its own order, and most of that length is the
same handful of models wearing different release dates.

**Folding** collapses `-20250219` / `-2025-02-19` / `-latest` / `-001` variants
onto one chip, whose id is always a string the vendor actually listed — untagged
if there is one, else `-latest`, else the newest snapshot — since a synthesized
base is a 404 the user finds out about a turn later. A `+n` badge opens the group
to pin a specific snapshot, and one already pinned stays visible unasked, or it
would be a model in the rail's dropdown with no switch anywhere to turn it back
off.

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
differs. An unrecognized value is an error rather than a default, because a typo
that quietly wrote a personal note into somebody's repository is exactly the
failure the split exists to prevent.

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

`Welcome.svelte` is the new-chat page: with an empty transcript the centre pane
shows the project, what the next chat inherits from the docspace, recent projects
to switch to, a folder picker — and the composer floating in the middle rather
than docked at the bottom. `Composer.svelte` takes a `floating` prop for that
instead of being duplicated: a second composer would be a second place to fix a
paste bug. The switch is on `app.events.length === 0 && !app.live`, and
`app.live` is in the test so the pane flips on the first send rather than on the
re-sync a whole turn later.

`ApprovalPrompt.svelte` renders inline under the tool chip it concerns rather
than as a modal, shows each argument unelided (a `bash` command has to be
readable to be consented to), and takes initial focus on the card rather than a
button so a stray Enter cannot grant permission.

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
