# Terminal — a shell docked under the chat

Nightshift backlog 113, boards 12a–12c (2026-09-17). His ask: "you go to
the top bar and then there's something where you can click new terminal
and then it adds a terminal as a separate pane on the bottom. And then that
terminal can also be dragged into any of the other windows." The first
sentence is built; the drag between panes is not yet (see the end).

## What it is

A pane docked under the pane's composer, with a strip of shells. Each
shell is his login shell (`$SHELL`, run as a login shell, `TERM=xterm-256color`)
on a pseudo-terminal in the **project's folder**, drawn by xterm.js. The
Claude Code chat's own `claude -p` turns are never in it — they are
Nightloom's processes and their calls live in the transcript; `claude`
typed here runs like anything else, in the same folder.

## Ways in

- **The top bar's button**, at the right end of the chips (`TerminalButton.svelte`).
  One click opens the pane with a shell; with the pane open, a second click
  adds a shell to its strip. Dim without a folder — an unfiled chat, or a
  project about no folder (blocker 190 takes a Chat inside a folder project
  as live, in the project's folder).
- **⌃`** on every platform: no pane → opens one with a shell; a pane not
  focused → focuses it; focused → hides it, the shells kept running.
- **⌘K → New terminal**, the same as the button.

## The strip

One tab per shell: its name (`zsh`) while nothing runs, the foreground
command's name (`npm`, `vim`) while one does — a blue dot beside it, the
live colour, not the accent, since it is not a turn. The active tab has
the accent rule. An exited shell reads dim with `exit 1` in red and a
line in its body; a click on it starts a new shell in the same folder, in
the same slot. `+` adds a shell; the `×` on a tab (on hover, always on the
active one) ends that shell — nothing is asked, the running dot was the
warning (blocker 041). Closing the last shell hides the pane. At the
right: collapse to the 32px strip, hide (⌃`), close the pane (every shell
ends). The folder reads `~/…/folder` beside the ⌃` hint.

With the terminal focused, **⌘T** is a new shell, **⌘W** closes this one,
**⌘⇧]** / **⌘⇧[** step through them — the tab chords, taken by the
terminal before the tab flow (`menuInterceptors` in `state.svelte.ts`;
on macOS they arrive as menu events). With the chat focused they are
099's tab keys. ⌘C copies the selection, ⌘V pastes; ⌃C, ⌃D, ⌃L and Esc go
to the shell; ⌘K stays the palette. On Windows and Linux Ctrl is the
shell's, so only ⌃` leaves it — the strip's buttons do the rest.

## The grip and the notice

The pane's top edge drags its height (96px to 80% of the column), kept
per machine under `localStorage["nightloom.term.height"]`; double-click
resets to 240px. While a Claude Code turn works in this dock's folder, one
row under the strip says so — the moon, the chat's name, its latest call
(`Edit notes/ace/q5-depth.md`), the files changed so far, the turn's
clock — read from the live reply's segments, the same events the activity
block draws. The shell stays yours; typing is never blocked. The row
leaves when the turn ends.

## Under the hood

`apps/desktop/src-tauri/src/terminal.rs` — `portable-pty` (blocker 187)
opens the pty; a reader thread streams its bytes to the window as
`terminal-data` events (base64: a read can end mid-character, and a JSON
string cannot carry that), `terminal-exit` at EOF with the code, and
`terminal-title` once a second when the foreground process group's name
changes (`tcgetpgrp` + `proc_name` on macOS, `/proc/<pid>/comm` on
Linux). Commands: `terminal_open(cwd, cols, rows)`, `terminal_write(id,
data)`, `terminal_resize(id, cols, rows)` (the kernel sends `SIGWINCH`),
`terminal_close(id)`, `terminal_list()`. The bundle is unsandboxed (as
backlog 101 checked for `caffeinate`), so the pty and the shell need no
entitlement.

The shells die with the app three ways: `terminal_close` on a ×, the
registry's `Drop`, and — the backstop needing no exit hook — the kernel's
hangup: when the process ends, its master fds close and the shell, the
session leader, gets `SIGHUP`. A unit test pins that
(`hangup_ends_the_shell_when_the_master_drops`). Nothing is persisted
across launches: the pane reopens empty.

`apps/desktop/src/lib/terminal.ts` is the pure part (the chords, the tab's
label and states, the notice's counts; tested), `terminal.svelte.ts` the
store (the pane, the shells, `newShell` · `closeShell` · `restartShell` ·
`toggleTerminal`, the byte sinks), `TerminalShell.svelte` one xterm.js
instance per shell (kept mounted while its tab is behind another; refitted
when it returns), `TerminalDock.svelte` the pane. The dock mounts in every
pane's `.pane-dock` slot in `App.svelte` and draws under the pane it was
opened from — one dock for the window (blocker 189).

## Not yet

- **Dragging the terminal into the other pane** (board 12b): the tab drag
  (`TAB_DRAG`) carries chat and note tabs only; a terminal tab needs its
  own drag type, the dock and strip drop zones lit on the other pane, and
  the store's `pane` moved on drop — the shells keep running through it,
  since the pty is the window's.
- The "into a tab" control (a terminal as a full-height tab of the pane).
- The title is the process's short name (`npm`, not `npm run dev`); the
  arguments would need `proc_pidinfo` / `/proc/<pid>/cmdline`.
