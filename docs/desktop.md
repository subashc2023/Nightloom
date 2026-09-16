# apps/desktop — the Tauri backend

Crate `nightloom-desktop`: a Tauri 2 shell over `nightloom-service` with a Svelte
5 frontend. The frontend is [desktop-ui.md](desktop-ui.md).

## Commands and state

`src-tauri/src/main.rs` exposes `providers` / `set_api_key` / `clear_api_key` /
`list_models` / `connect` / `list_sessions` / `new_session` / `open_session` /
`transcript` / `send` / `cancel` / `compact` / `rewind` / `unrewind` / `context_view` /
`edit_context` / `prompt_layers` / `set_prompt_layers` / `set_prompt_layer_text` / `prompt_layer_file` / `delete_session` / `restore_session` / `set_undo_menu` / `approve_call` / `pick_folder` /
`list_projects` / `active_project` / `create_project` / `open_project` /
`close_project` / `rename_project` / `forget_project` / `list_notes` /
`read_note` / `save_note` / `delete_note` (each taking a `scope`) /
`knowledge_info` / `set_knowledge_dir` / `knowledge_graph` / `reveal` /
`pick_export` / `import_claude`.

State is managed: `Chat` + the active `Session` in tokio mutexes, plus a
swap-per-turn `CancellationToken`. `send` forwards `TurnEvent`s as `turn-event`
window events and retry stalls as `turn-notice`.

`delete_session` drops the active session's open log handle before ~~removing the
file~~ moving it to `<logs>/trash/` (review round 1, 2026-09-13: a delete in the
UI is reversible; the listing never descends into subdirectories, so the row is
gone and the log is not) — dropping the handle first is required on Windows.

`connect` is a thin wrapper over `build_chat(app, policy, spec)`, and `ChatSpec`
keeps everything the UI asked for. That exists so a subagent is built from the
same description as the window's own chat instead of a half-copied subset, which
is how the two would otherwise drift into different tools or a different
workspace. It also carries `chats: ChatDirs` — the sidebar's log directory plus
every registered project's and the unfiled one, named — for the `search_chats` /
`read_chat` tools, taken at connect time so a project added later is reachable
after the next reconnect. `Option`, and `None` for a reviewer, for the reason
`knowledge` is cleared there: a second vendor's critic has no business in the
user's transcripts.

`connect` takes an explicit `workspace`: it roots the file tools **and** is where
the preamble looks for project instructions and the git branch. A GUI process's
cwd is whatever the launcher set — the install directory, or
`C:\Windows\System32` — so leaving it implicit would point the tools somewhere
arbitrary and unmentioned. The resolved value comes back in the connect result
and the rail shows it.

## Sessions

Created **lazily by `send`**, never by `connect`, so provider switching and
launch auto-connect leave no empty logs.

Unfiled chats log to `~/.nightloom/unfiled/sessions`, adopted at startup from the
OS app-data dir they used to use — silently, since that adoption runs before a
window exists to say anything in, where a project's migration gets a toast
because it moved files inside a folder the user chose.

Renaming is a pencil on hover or a double-click on the row (`rename_session`),
Enter to commit and Escape to cancel; an emptied box is a cancel rather than a
rename, since an empty name would leave the row labelled by its opening message
with no way back. Renaming the *active* session goes through the handle already
open on its log rather than loading a second one, which would leave two writers
appending to a single file.

The sidebar's chat search is a backend call (`search_sessions`) rather than a
filter over the list it already holds: that list carries a name and an opening
message, and what you are trying to find is usually a sentence from the middle of
a conversation, which only the log has. It is debounced and sequence-guarded, so
a slow early request cannot overwrite the results of a fast later one, and it
re-runs when the open project changes — the directory it searches follows the
project, and rows from the folder you just left are rows that no longer list.

`list_sessions` and `search_sessions` both go through the local `blocking`
helper. A Tauri command is a future on the shared runtime, and these two walk a
directory of logs that an import can leave thousands of files deep, so running
them inline held a thread a streaming turn was also using. `ProjectInfo` asks
`store::count` for its chat count rather than `store::list(dir).len()`, which
read every log named in a listing to arrive at a number `read_dir` already had —
on the rail-refresh path, and once per project in the picker. See
[service-data.md](service-data.md#listing-is-a-cache-not-an-index) for what
`store` does now and why the cached listing is a cache rather than an index.

## Agent mode (`connect_agent` / `send_agent`)

The Claude Code engine, reached from the rail's Provider / Claude Code switch:
turns run through the signed-in CLI and are billed to a subscription rather than
an API key.

**`Some` in `AppState.agent` is what "agent mode" means** — `connect` clears it
and `connect_agent` clears the `Chat` — rather than a third field saying so,
which would be an invariant to maintain between a flag and the thing it
describes.

It is a command of its own rather than a `provider` value on `connect`, because
almost none of that call's arguments mean anything here (no base URL, no thinking
mode, no sidecar, no MCP, no reviewers), and an entry point whose arguments are
mostly inert is the shape that invites a knob to be silently ignored. The
preamble is the one layer that crosses (2026-09-14): it goes in
`--append-system-prompt` ahead of the library prompt, without identity or
environment — see [service-agent.md](service-agent.md#what---append-system-prompt-carries).

Three things follow, each stated in the UI rather than left to be discovered:

- **Nightloom's approval gate does not run** ~~.~~ **— unless the chat is in
  the Ask position (2026-09-16, nightshift backlog 084).** It gates calls its own engine is
  about to execute, and this engine executes its own, so the switch maps to the
  CLI's ~~`dontAsk`~~ `auto` / `bypassPermissions` and the rail says which.
  (`auto` since 2026-09-14, nightshift blocker 045: the CLI's classifier
  decides each call and, headless, denies what it cannot approve rather than
  waiting; `dontAsk` with a fresh install's empty allowlist refused every
  write, command and fetch.) With **Ask me** on under *Restrict permissions*
  (`agentAsk` on the draft, `ask` on `connect_agent`), the CLI runs in Manual
  mode with this binary as its `PreToolUse` hook and pauses on each call a
  person should decide; the transcript then asks — see "The Ask position"
  below.
- **Rewind, compaction and ~~the context panel~~ context edits are withheld.** They change what the
  *log* projects onto the next request, and here nothing projects, so each would
  alter what the window shows and nothing about the conversation.
  `not_in_agent_mode` is the backstop under the hidden controls, since the two
  have to agree and only one of them is checkable. `context_view` stopped
  refusing on 2026-09-14: it returns the bridged segments the flag carries
  (kept as built, `PromptBuilt`, rather than re-parsed from the string) with no
  messages, since the layers Nightloom appends are ours to show even though the
  history is not. `set_prompt_layers` is allowed too — it changes what the next
  connect appends, which this engine does read.
- **Attachments attach as on the API engine** (since 2026-09-14). They reach the
  CLI on stdin as one `stream-json` user line rather than on argv — see
  [service-agent.md](service-agent.md) §"How attachments reach the engine" — and
  the log records them the same way on both engines. One cap differs: a PDF over
  20 MiB encoded is refused at attach on this engine (32 MiB on the API path),
  because past ~23 MiB the CLI drops the document silently and the model answers
  as if none was sent; the toast names the engine so the lower limit reads as a
  different limit, not a broken one.

`connect_agent` probes `--version`, so a missing binary fails at connect with
something the rail can show rather than as a process error on the user's first
message.

The model field is a **combobox over `AGENT_MODELS`, not a select**: `--model`
takes a full id as readily as an alias, the aliases move with the CLI's releases
rather than ours, and which ones an account can reach depends on its plan. A
closed list can only fail in the direction that matters — withholding a model the
user pays for with nowhere to type it (it shipped one release missing `fable`).
The *resolved* snapshot arrives with the first turn's result, which is also the
first moment a context window can be looked up at all.

Dropping the active session — `new_session`, `open_session`, `open_project`,
`close_project`, `delete_session` — carries the agent's handle with it through
`adopt_agent_session`, or the next turn would create a fresh log and resume the
previous chat's history behind it.

Cost is deliberately **not** recorded on an agent exchange: nothing was charged
per token, and the CLI's dollar figure is its own estimate of what the same turn
would have cost on the API, so it is shown in the rail saying that rather than in
the top bar's spend readout, which means money.

## Tool approval

`WindowApprover` emits a `tool-approval` window event and parks a oneshot keyed
by the call id, which `approve_call` completes. The wait is raced against the
turn's cancellation token, because a dismissed prompt or a closed window would
otherwise park the turn forever.

### The Ask position on the Claude Code engine (2026-09-16, nightshift backlog 084)

The same `tool-approval` event and the same `pendingApprovals` list carry a
call the CLI **deferred** — the protocol is in
[service-agent.md](service-agent.md#the-ask-position-the-defer-hook-and-the-decision-file-2026-09-16-nightshift-backlog-084).
On this side:

- `connect_agent` takes `ask`; with it (and approval on) the spec gets an
  `AskSpec` whose hook is `current_exe() --permission-hook`, the MCP server is
  started with `--ask` so the prompt tool the CLI insists on exists, and the
  rail's `permission_mode` reads `default (ask)`.
- `send_agent` points the agent at `<log dir>/ask/<chat id>/` before the turn,
  then loops: a `deferred` outcome emits the `tool-approval` event, waits on
  `AppState.ask` (an `AskGate`, raced with Stop), writes the answer for the
  hook, and resumes into the same `Recorder` — one Nightloom turn, however
  many CLI processes. Stop while a prompt is up refuses the call on disk so
  the next turn's hook delivers the refusal and no later "allow for this
  chat" can run it unasked.
- `approve_call` answers the deferred gate first when the id is one of its
  calls: `allow`, `always` (a rule in the chat's `rules.json` — not the
  process-wide policy), `deny` with the reason; the new optional `answer` is
  the `updatedInput` a question or a plan sends back.
- `ApprovalPrompt.svelte` renders three shapes on this engine, inline under
  the paused call in the live turn (the design's placement): the permission
  prompt with **Allow · Allow for this chat · Deny** and the reason field
  always shown; the question form for `AskUserQuestion` (radio rows, checkbox
  rows for `multiSelect`, an "Other" text, *Answer* / *Skip — let it
  decide*); the plan card for `ExitPlanMode` (*Approve* / *Keep planning*
  with an optional note). The API engine's prompt is unchanged.
- Reads inside the working directory never pause; a read outside it goes to
  the prompt tool and is refused with a sentence the model can act on.

### The Plan position (2026-09-16, nightshift backlog 085)

Plan mode on the same hook — the protocol and the measured edges are in
[service-agent.md](service-agent.md#the-plan-position-plan-mode-under-the-same-hook-2026-09-16-nightshift-backlog-085).
On this side:

- The rail's Behaviour section on the Claude Code engine shows one
  **Approval** segment, `Auto · Ask · Plan · Off` (the design's control, in
  the thinking-segments idiom), over the same three draft fields the two
  switches it replaces were bound to: `approval` (Off = off), `agentAsk`,
  `agentPlan`. Plan implies Ask. The API engine's *Ask before writing* switch
  is unchanged.
- `connect_agent` takes `plan`; with it (and approval on) the `AskSpec` is
  `AskMode::Plan` and the rail's `permission_mode` reads `plan (ask)`.
- The plan card gains a `then Ask | Auto` pick beside **Approve** (Ask
  first) and names the CLI's plan file. `resolveApproval` passes the pick as
  `then`; `approve_call` puts it on `Answer::Allow.plan_then`; `send_agent`
  calls `plan_approved(then)` before the resume and `plan_exited()` after,
  so the chat leaves plan mode as Ask or Auto. The rail flips its own switch
  in `resolveApproval` at the same moment (saved like any rail change, no
  reconnect — the backend's agent already holds the new position).
- **Keep planning** is a `deny` whose reason is the note typed, or "keep
  planning: the user wants changes to the plan".

### Subagents under their call (2026-09-16, nightshift backlog 075)

A `subagent` turn event (`{parent_tool_use_id, event}`; the protocol is in
[service-agent.md](service-agent.md#subagents-their-words-and-calls-under-the-call-that-spawned-them-2026-09-16-nightshift-backlog-075))
is applied to the `children` of the call it names — found by id at any
depth (`findCall`) — through the same `applyToSegments` the live reply
uses, so a child's text, thinking and calls accumulate as the main thread's
do. From the log, `Transcript.svelte` recognises the recorder's marked text
block (`subagent.ts`), attaches its narrative as one text segment to the
parent call in this message or an earlier one of the turn, and never counts
it as the reply's prose. `AssistantMessage.svelte` draws `children` as one
indented `<details>` row under the call — `▸ subagent · 3 calls · 120 words
so far` — opening to the child's rows (nested subagents recurse).

### Effort and the fallback model on the rail (2026-09-16, nightshift backlog 076)

Under the Model section of the Claude Code pane: **Effort**, a five-way
segment `low · medium · high · xhigh · max` (`high` on by default), and
**Fallback model**, the alias pills with `none` first. Draft fields
`agentEffort` and `agentFallback`, saved with the rest of the rail;
`connect_agent` takes `effort` and `fallback_model` and the spec sends the
flags (the protocol section in
[service-agent.md](service-agent.md#effort-and-a-fallback-model-2026-09-16-nightshift-backlog-076)).
The Context page's *This session* foot line ends `· effort high · no
fallback` (or `· fallback sonnet`).

### Ask aside (2026-09-16, nightshift backlog 081)

On the Claude Code engine the composer has an **Ask aside** button beside
Send (text only, idle only): the typed question goes to `ask_aside`, which
runs `ClaudeCodeAgent::ask_aside` under the agent's lock (so it waits for a
turn rather than racing it; Stop cancels it) and returns the answer, the
CLI's cost estimate and the cache read — recorded nowhere, not in the log
and not in the CLI's files (the protocol and the measurements are in
[service-agent.md](service-agent.md#ask-aside-a-side-question-on-the-warm-cache-2026-09-16-nightshift-backlog-081)).
`app.aside` holds one at a time; `Transcript.svelte` draws it at the foot
as a dashed card — `aside · not in the chat`, the question, `asking…` then
the answer, `N read from cache`, × — cleared by its × or a chat switch. A
chat with no CLI session yet is refused with a sentence.

The `AutoApprove` policy lives in `AppState`, **not** in `connect` — the rail
re-connects on every knob change, and rebuilding the policy there would silently
forget every "always allow" the user granted.

A denied call arrives as `tool_denied` and **not** `tool_result`, so the live
buffer closes the pending call on it; after the post-turn re-sync the same
refusal is recognised in the logged `is_error` result. That recognition is a
prefix match on `approval.rs::denial_message` — the one place the two sides are
coupled by a string rather than a type, and it degrades to plain error rendering
if the wording changes.

## Projects

A project chip over `ProjectMenu.svelte` (switch, rename, show folder, remove)
and a Chats/Notes tab strip in `Sidebar.svelte`.

An open project **wins over the rail's saved workspace** in `connect`, because a
chat filed under a project that rooted its tools somewhere else would be a
project in name only. The rail's workspace field goes read-only and says which
project set it, rather than offering an edit the backend overrides.

`AppState.workspaces` holds the registry and the open project under **one**
mutex, and it is a *leaf*: callers clone what they need out of it and drop the
guard before taking `chat` or `session`, so no lock-ordering rule has to be
remembered.

`open_project` drops the active session, since a `Session` is a handle on a log
file in the *previous* project's directory and carrying it across would append
the next turn to a conversation the sidebar no longer lists. It deliberately does
**not** re-connect, because doing so would need every argument `connect` takes
just to pass them through unchanged — `useProject` in `state.svelte.ts` owns that
order instead (open, then connect, then re-read the chats), one function rather
than a sequence each caller re-derives.

Unfiled chats go to `~/.nightloom/unfiled`: the quickest useful thing this app
does is answer a question that has nothing to do with any directory, and making
that require choosing a folder first would be a worse app.

`pick_folder` drives the native dialog **from Rust** (`tauri-plugin-dialog`), so
the webview needs no filesystem permission in its capability set and no matching
npm package — it can ask, and it gets back a path the user chose. `notify`
posts a banner the same way (`tauri-plugin-notification`, added 2026-09-16 for
the turn-end notification of nightshift backlog 079, blocker 106): the frontend
decides whether — the window's focus and the Settings switch — and Rust only
posts; macOS shows it only for a bundled, signed app, so a `cargo tauri dev`
build posts into nothing. `reveal` is a
per-OS spawn (`explorer` / `open` / `xdg-open`) and is **not** a tool: nothing the
model asks for opens a window on the user's desktop.

## MCP, reviewers and web keys

MCP servers are cached in `AppState` keyed by workspace, **not** started per
`connect`: the rail re-connects on every knob change, and reconnecting there
would spawn a second copy of every server and leak the first. Turning tools off
drops the connections.

The rail lists each server with its tool count, and a server that failed to start
is shown as unavailable rather than hidden — its tools are simply missing
otherwise, and a model told nothing will confidently explain why it cannot help.

The binary is also an MCP *server*: `nightloom-desktop --mcp-serve [--project
<id>]`, checked at the top of `main` before Tauri builds anything, runs
`nightloom_service::mcp_server` on stdin and stdout and exits at EOF — no
window, no app state. It exists so the Claude Code engine can be handed
Nightloom's `search_chats`, `read_chat`, `remember` and `fetch_page` through
`--mcp-config`, naming `current_exe()` as the command: the one binary the app
can always find, where the CLI is usually not on PATH. What the server does and
how a call is judged is in [mcp.md](mcp.md), *The server*.

Reviewers for the `review` tool come from `tools::bench` — the same table the CLI
uses — built from the window's own `ChatSpec` with the kind and model swapped in
and `base_url` cleared, since it belonged to the provider being replaced. A key
counts whether it is in the credential store or the environment, the same test
`key_source` reports. `ConnectedInfo.reviewers` echoes name and model so the rail
can chip them and say *no second provider — add another API key in Settings* when
there are none: a tool that is off because there is no second key is not
something a user can work out from one that simply never gets used.

The web tools follow a `web` toggle of their own rather than the `tools` one,
because the questions are different — a folder you are happy to let a model edit
is not automatically one you are happy to have quoted into a third party's query
log. `ConnectedInfo.search` echoes which backend answers so the rail can chip
`web_search` or say there is no key.

Search keys live in the same credential store as provider keys but namespaced
(`search:tavily`), since the two share one keyring service and a future provider
named "brave" would otherwise read a search key as its API key. The store is
consulted before the environment, which matters more here than for providers
because a GUI process started from a shortcut usually inherits no environment at
all.

## Keychain prompts on macOS, and the dev-build signature

**Symptom (2026-09-11):** every `cargo tauri dev` rebuild made macOS ask for
the login password once per stored key — five to fifteen dialogs — and
"Always Allow" never held. **Cause:** a plain dev build is ad-hoc,
linker-signed, and its code identity is a per-build hash
(`Identifier=nightloom_desktop-<hash>`, designated requirement `cdhash
H"…"`). The keychain stores "Always Allow" against the requesting app's code
identity, so each rebuild is, to the keychain, a new application. Measured
with user interaction disabled (`SecKeychainSetUserInteractionAllowed(false)`,
which turns a would-be dialog into `errSecAuthFailed`): an item created by one
ad-hoc build is refused to the next; an item created by a build signed with a
developer certificate and a fixed identifier is readable by every later build
signed the same way, and still refused to an ad-hoc one.

**Fix:** `.cargo/config.toml` sets a `runner` for the two `*-apple-darwin`
targets — `scripts/macos-sign-and-run.sh` — so `cargo run` (which is what
`tauri dev` executes) signs `nightloom-desktop` with the first "Apple
Development" identity in the keychain and the identifier
`app.nightloom.desktop` before starting it. The designated requirement is then
`identifier "app.nightloom.desktop" and anchor apple generic and certificate
leaf[subject.CN] = "<identity>" …`, the same for every build, so one "Always
Allow" per key holds for good. The script skips a binary that already carries
that signature, leaves every other binary (the CLI, test executables) alone
unless `NIGHTLOOM_SIGN_ALL=1`, and never fails a run: no identity means an
ad-hoc run and a line on stderr saying the keychain will ask again.
`scripts/macos-build-signed.sh` does the same for `cargo tauri build` through
Tauri's `APPLE_SIGNING_IDENTITY`, so the installed `Nightloom.app` shares the
grant. Linux and Windows never see the runner table. The first launch after
this change asks once more per key — the old grants name the old hashes — and
that round is the last.

Not done on purpose: consolidating the per-key items into one keychain entry
(would cut that final round to one click, but changes the stored format and
needs a migration that itself reads every item), and creating items with an
"any application" ACL (`security add-generic-password -A`'s mode — no dialogs
ever, at the cost of any process as the user reading the keys silently).
Both are decisions for the owner, not a build script.

## Rewind, context, cost, todos

**Rewind**: the `rewind` command returns the resulting transcript rather than an
acknowledgement, so the UI re-syncs from the log in the same call instead of
updating its own copy optimistically. It needs no guard against a turn in flight
— `send` holds the session lock for the whole turn, so a rewind waits rather than
cutting the log out from under a reply being recorded — but the control is hidden
while busy, because a queued rewind that fires after the next turn lands would be
a surprise.

**Undo's commands** (nightshift backlog 064, 2026-09-15): `unrewind { of }`
lifts a rewind (`Session::unrewind`) and, on Claude Code, records and resumes
the id in force before it; `restore_message { index }` is `remove_message`'s
inverse — `unelide`, and on Claude Code a third CLI copy with the turn put
back from the original (`restore_on_cli` / `restore_cli_file`, over
`CliSession::restore`); `restore_session { id }` moves a log back out of
`<logs>/trash/`; `set_undo_menu { undo, redo, text_field }` retitles and
enables the macOS Edit menu's Undo and Redo, which are the app's own items
now (`undo_app` / `redo_app`, forwarded like every custom item). The
frontend's stack is `src/lib/undo.ts`; [desktop-ui.md](desktop-ui.md) lists
what is undoable.

**Edit, remove, fork** (`edit_message { index, text, mode: "save" | "send" }`,
`remove_message { index }`, `fork_session { upto }`, 2026-09-15, nightshift
backlog 062): each returns the transcript and the id of the chat now open
(`MessageEdit`), on `rewind`'s contract. `save` records an `Edit` marker;
`send` is `fork_session` — the parent forked before the turn
(`Session::fork_from`), the fork made the open session, and the UI then
sends the text as its next turn; `remove_message` is the context panel's
`Elide`, reached from the transcript. On the Claude Code engine all three,
and `rewind`, first copy the CLI's session file with the change made under
a new id (`edit_on_cli`, over `agent::cli_session`; `CliChange` says whether
there was a copy to resume, nothing to change, or nothing left), then record
the marker, then record the copy's id as the chat's `AgentSession` and
`set_resume` it — the copy first, so a refusal (an unmeasured CLI version, a
turn the CLI never saw) leaves the log as it was. `not_in_agent_mode` is
lifted for exactly these four; `compact` and `edit_context` keep it. A turn
is addressed on the CLI side by how many live user turns follow it
(`turns_after`) and by its projected text (`cli_target`), never by its log
index — and, since 2026-09-15 (nightshift backlog 066), a *block* of a
reply by its count among the reply's text blocks or by its call id
(`cli_block` → `cli_session::Block`). `edit_message` takes an optional
`block` (an index into the reply's `blocks`; `Session::edit_block`,
`CliSession::rewrite_block`), and **`remove_block { index, block }` /
`restore_block { index, block }`** remove and restore one block — a text
block, or a tool call together with its result (`Session::elide_block`,
`CliSession::remove_block` / `restore_block`), on `remove_message`'s and
`restore_message`'s terms. The desktop test drives the same sequence against a synthesised
CLI file and checks the original is byte-identical afterwards.

**Context** (`ContextPanel.svelte`, the rail's third tab): the `WireView`, one
row per block, each with its estimated size, a share-of-total bar and a
remove/restore button where the source event allows it.

`context_view` needs **both** locks because the view is the request and not the
log — the preamble and sidecar live on the `Chat`, the conversation on the
`Session` — and takes them in the same order `compact` does so the two can never
deadlock. With no session yet it views an empty one rather than erroring:
sessions are created lazily by `send`, so that is the ordinary state at launch,
and an empty session still has a preamble worth showing.

`set_prompt_layers` records the chat's switched-off layers
(`SessionEvent::PromptLayers`) and returns the transcript; it writes the log and
nothing else, since the UI reconnects afterwards the way a rail knob does and
`connect` / `connect_agent` read the set back off the open session
(`layers_off`). It creates the session if the chat has none yet, as `send`
would: the exclusion is a fact about the chat, and a chat has to exist to have
it. `prompt_layers` returns the open chat's set beside the one the live engine
was built with (`PromptBuilt.off`), which is how the UI knows a reconnect is due
after opening another chat — and since 2026-09-15 (nightshift backlog 057) the
chat's own texts beside the ones the engine was built with (`edits`,
`built_edits`; `PromptBuilt.edits`), compared on the same terms.

`set_prompt_layer_text` records the chat's own text for one of the three
editable layers (`SessionEvent::PromptLayers.edits`), or drops it with `text`
absent, on exactly `set_prompt_layers`' terms: the log only, the session
created if need be, the UI reconnects, allowed on Claude Code. The text is the
file's *body*; `assemble` wraps it. `prompt_layer_file` returns what that layer
reads from disk right now — the seed for an edit — by the model id and the
workspace the live prompt was built with (`PromptBuilt.model`, `.cwd`), through
`nightloom_service::layer_source`: the same reads the prompt makes, not the
segment's text with its wrapper stripped.

`edit_context` returns the new view **and** the new transcript, for the same
reason `rewind` returns a transcript: an elision changes every projection off the
log, so the UI re-syncs from the backend instead of patching its own copy. The
panel re-reads on any change to `app.events`, `app.connection` or `app.busy`, and
deliberately **not** on `liveVersion` — refreshing per streamed delta would be a
projection rebuild per token.

**Cost** in `TopBar.svelte` sums recorded costs off the log and prices only the
in-flight round live from `connect`'s `price` — the same live-then-log shape as
the context ticker. It renders nothing at all for an unpriced model rather than
"$0.00", and prefixes `≥` when any exchange in the session was unpriced.

**The task panel and the context ticker are projections too**, and deliberately
share no state with the model's view. `currentTodos()` mirrors `Session::todos()`
exactly (latest snapshot wins, a compaction clears it), so the panel and the copy
the model reads in its sidecar cannot drift. The ticker reads `TurnEvent::Usage`
live during a turn and falls back to the trailing `assistant_message` between
turns, over a denominator from `connect`'s `context_limit`; with no known limit
it shows a bare token count and no bar rather than inventing a window, since the
same figure reaches the model through the sidecar.

**Three frontend projections have to stay in step with the backend**: `liveFlags`
(mirrors `Session::live_flags`; it returns flags over the whole array rather than
a filtered list, because superseded turns are still rendered), `currentTodos`,
and the ticker. `links.ts::resolveNote` is a fourth, mirroring
`knowledge::resolve_link`. Since 2026-09-15 three more, in `edit.ts`:
`editTexts`, `elideFlags` and `isEditable`, mirroring `Session::edit_texts`,
`elide_flags` and `is_editable`; and since backlog 066 `blockEdits`,
`blockElisions` and `replyText`, mirroring `Session::block_edits`,
`block_elisions` and `reply_text`.

## Importing from claude.ai

Two commands and one entry point. `import_claude` runs on a **blocking thread** —
it is file I/O over an archive that is routinely hundreds of megabytes, and the
runtime it would otherwise sit on is the one carrying the window's events — and
it **registers what it produced** rather than returning paths for the frontend to
add, since an imported folder that is not in the registry is a folder and not a
project, and the user would have to re-pick each one through the file dialog to
reach chats already sitting in it.

`pick_export` drives the file dialog from Rust for the same reason `pick_folder`
does.

The flow asks for **one** path. It used to ask for two, the second being where
the project folders should go — a question that stopped existing when a project
stopped being a folder.
