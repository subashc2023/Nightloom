# apps/desktop — the Tauri backend

Crate `nightloom-desktop`: a Tauri 2 shell over `nightloom-service` with a Svelte
5 frontend. The frontend is [desktop-ui.md](desktop-ui.md).

## Commands and state

`src-tauri/src/main.rs` exposes `providers` / `set_api_key` / `clear_api_key` /
`list_models` / `connect` / `list_sessions` / `new_session` / `open_session` /
`transcript` / `send` / `cancel` / `compact` / `rewind` / `context_view` /
`edit_context` / `delete_session` / `approve_call` / `pick_folder` /
`list_projects` / `active_project` / `create_project` / `open_project` /
`close_project` / `rename_project` / `forget_project` / `list_notes` /
`read_note` / `save_note` / `delete_note` (each taking a `scope`) /
`knowledge_info` / `set_knowledge_dir` / `knowledge_graph` / `reveal` /
`pick_export` / `import_claude`.

State is managed: `Chat` + the active `Session` in tokio mutexes, plus a
swap-per-turn `CancellationToken`. `send` forwards `TurnEvent`s as `turn-event`
window events and retry stalls as `turn-notice`.

`delete_session` drops the active session's open log handle before removing the
file — required on Windows.

`connect` is a thin wrapper over `build_chat(app, policy, spec)`, and `ChatSpec`
keeps everything the UI asked for. That exists so a subagent is built from the
same description as the window's own chat instead of a half-copied subset, which
is how the two would otherwise drift into different tools or a different
workspace.

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
mode, no preamble or sidecar, no MCP, no reviewers), and an entry point whose
arguments are mostly inert is the shape that invites a knob to be silently
ignored.

Three things follow, each stated in the UI rather than left to be discovered:

- **Nightloom's approval gate does not run.** It gates calls its own engine is
  about to execute, and this engine executes its own, so the switch maps to the
  CLI's `dontAsk` / `bypassPermissions` and the rail says which.
- **Rewind, compaction and the context panel are withheld.** They change what the
  *log* projects onto the next request, and here nothing projects, so each would
  alter what the window shows and nothing about the conversation.
  `not_in_agent_mode` is the backstop under the hidden controls, since the two
  have to agree and only one of them is checkable.
- **Attachments are refused at the composer**, not at send, because Claude Code
  takes a prompt on argv: a chip sitting in the box is a promise the send would
  have to break.

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
npm package — it can ask, and it gets back a path the user chose. `reveal` is a
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

## Rewind, context, cost, todos

**Rewind**: the `rewind` command returns the resulting transcript rather than an
acknowledgement, so the UI re-syncs from the log in the same call instead of
updating its own copy optimistically. It needs no guard against a turn in flight
— `send` holds the session lock for the whole turn, so a rewind waits rather than
cutting the log out from under a reply being recorded — but the control is hidden
while busy, because a queued rewind that fires after the next turn lands would be
a surprise.

**Context** (`ContextPanel.svelte`, the rail's third tab): the `WireView`, one
row per block, each with its estimated size, a share-of-total bar and a
remove/restore button where the source event allows it.

`context_view` needs **both** locks because the view is the request and not the
log — the preamble and sidecar live on the `Chat`, the conversation on the
`Session` — and takes them in the same order `compact` does so the two can never
deadlock. With no session yet it views an empty one rather than erroring:
sessions are created lazily by `send`, so that is the ordinary state at launch,
and an empty session still has a preamble worth showing.

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
`knowledge::resolve_link`.

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
