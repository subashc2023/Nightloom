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
(~~`hangup_ends_the_shell_when_the_master_drops`~~ — superseded 2026-09-17,
backlog 135: that test dropped the master while the reader's copy of it
stayed open, so what ended the shell was the EOF the writer's drop sends,
not a hangup; it is now `eof_ends_the_shell_when_its_input_queue_drops`,
and `hangup_ends_a_foreground_job_when_every_master_fd_closes` pins the
hangup itself — a `sleep` in front, which reads nothing, dies of `SIGHUP`
once the last master fd closes). Nothing is persisted across launches:
the pane reopens empty.

## Neither direction blocks the window (backlog 135, 2026-09-17)

The night's review (D) measured two floods. A paste into a program that
is not reading its input — `cargo build` in front, 3 KB pasted — sat
3.75 s inside `terminal_write` on the main thread, the whole window
frozen until the build finished, because the kernel's tty input queue
holds about a kilobyte and a write past it waits. And `yes` reached the
window as a million four-byte events a second: the pty hands back a line
or two per read, and every read was its own event on the window's queue.

Now: each shell has a **writer thread** with a bounded queue (256 writes
or 256 KB). `terminal_write` queues and returns — measured 5 µs for the
same 3 KB paste with a `sleep` in front. A queue that is full answers
*the program is not reading its input*, which the pane shows once as a
toast until a write goes through again; once the program reads, the
queue drains in order. `terminal_open` and `terminal_close` are async
commands too, so a fork or a wait on a dying shell (bash takes its whole
200 ms grace) is off the main thread.

Output goes reader → **emitter thread** → window. The emitter sends one
event per frame (16 ms; the first chunk after a quiet spell goes at once,
so a keystroke's echo is not held), at most 64 KB each — the 20 MB `yes`
now arrives as 460 events of ~64 KB instead of 8 million of 3 bytes. And
the window **acknowledges** what xterm.js has drawn (`terminal_ack`, sent
from xterm's write callback): past 256 KB unacknowledged the emitter
waits, the reader's queue to it fills, the reader stops reading, and the
kernel makes the program wait — a `yes` runs at the speed the window
draws, as it does in Terminal.app, and nothing is dropped. A window that
stops answering (the pane hidden, a reload, the webview gone) is released
every 2 s, so a shell is never stuck on a lost acknowledgement; while the
dock is hidden the store's buffer of undrawn bytes is therefore bounded
by the same mark.

Thread-spawn failures (out of threads) are the window's error — the
child is killed and `terminal_open` answers — rather than a panic; a
title thread that cannot start leaves the tab reading the shell's name.

Not changed (blocker 200): × still ends a shell with `SIGHUP` to the
shell and lets the shell hang up its own jobs — the default shells do
(measured: `/bin/sh`, `zsh`, `bash` all ended a foreground `sleep 300`);
a `setopt NO_HUP` zsh, or a job that traps `SIGHUP`, survives the ×.

`apps/desktop/src/lib/terminal.ts` is the pure part (the chords, the tab's
label and states, the notice's counts; tested), `terminal.svelte.ts` the
store (the pane, the shells, `newShell` · `closeShell` · `restartShell` ·
`toggleTerminal`, the byte sinks), `TerminalShell.svelte` one xterm.js
instance per shell (kept mounted while its tab is behind another; refitted
when it returns), `TerminalDock.svelte` the pane. The dock mounts in every
pane's `.pane-dock` slot in `App.svelte` and draws under the pane it was
opened from — ~~one dock for the window (blocker 189)~~ one dock for the
window by default, a second by a drag (blocker 155, 2026-09-22, below).

## Two docks (2026-09-22, blocker 155)

His answer: "i think one for the whole window. but lowk, if it's possible
to also have like an intuitive way to drag it into both such that there
can be two terminals, that'd be great." So:

- **By default there is one dock.** New terminal, ⌃`, the palette's row
  and the strip's + add to the dock that is there — the focused pane's if
  it has one, else the window's (`term.pane`, `targetDock()`).
- **Drag one shell's tab onto the other pane** (its content or its tab
  strip): that pane gets a dock of its own with that shell in front. The
  zone says *a second terminal here*. Each dock has its own strip, its own
  front shell, its own collapse / hide / close; the height is shared, so
  the two line up.
- **Drag the only shell of a dock** onto the other pane: the dock moves
  (*dock the terminal here*) — what 12b did before.
- **Drag a shell onto a pane that has a dock**: it joins that strip
  (*add to this pane's terminal*) — which is how two docks become one.
- ⌘T / ⌘W / ⌘⇧] / ⌘⇧[ act in the dock whose shell has the keyboard.
- A pane closing ends its own dock's shells only.

The store: `term.docks` (by pane id: `open`, `collapsed`, `active`),
`ShellRow.pane` on each shell, `moveShell(id, pane)` for a drop
(`draggedShell` reads the id off the drag), `dropLabel(pane)` for the
zone's caption, `term.dragging` the mirror `dragover` reads. The
xterm-outlives-its-mount mechanism below carries a shell across docks.

## The xterm outlives its mount (2026-09-17, backlog 113's scrollback)

The dock draws in whichever pane `term.pane` names, so a drag of the
terminal to another pane (12b, `TERM_DRAG`) unmounts every `TerminalShell`
there and mounts them here — and a fresh xterm per mount showed an empty
grid where the scrollback had been, though the pty and its shell were
untouched. Now the instance is the store's: `TerminalShell` builds its
xterm once, into a `.term-host` element of its own, with everything that
belongs to the instance wired then (the key handler, `onData`, `onResize`,
the sink, the focus listeners), and hands it to `keepLive`; a later mount
takes it back with `liveShell` and only appends the host to its container
and refits (`LiveShell` in `terminal.ts`, typed loosely so the store never
imports xterm). The unmount detaches the host and nothing else; `closeShell`
and `restartShell` dispose it with the shell. The exit line is written once
per shell (`exitWritten`), not once per mount. The same mechanism carries
the dock's hide and show (backlog 137 FE6), which already kept the
component; a move now costs the grid one refit and no output.

## Not yet

- ~~**Dragging the terminal into the other pane** (board 12b): the tab drag
  (`TAB_DRAG`) carries chat and note tabs only; a terminal tab needs its
  own drag type, the dock and strip drop zones lit on the other pane, and
  the store's `pane` moved on drop — the shells keep running through it,
  since the pty is the window's.~~ Built 2026-09-17 (12b: `TERM_DRAG`, the
  whole-pane zone); the scrollback across the move, above.
- A second dock is made only by a drag; there is no "New terminal in this
  pane" command beside the default (his answer asked for the drag).
- The "into a tab" control (a terminal as a full-height tab of the pane).
- The title is the process's short name (`npm`, not `npm run dev`); the
  arguments would need `proc_pidinfo` / `/proc/<pid>/cmdline`.
