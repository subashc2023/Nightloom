/**
 * The terminal pane's store (nightshift backlog 113, boards 12a–12c,
 * 2026-09-17): the docks' open/collapsed state, their shared height, the
 * shells in their strips, which one is in front in each, which dock has
 * the focus — and the calls that change them.
 *
 * Docks (blocker 155, his answer 2026-09-22): **one dock for the window by
 * default** — New terminal, ⌃` and the strip's + all add to the dock that
 * is there, under the pane it was opened from (`term.pane`). **Dragging a
 * shell's tab onto the other pane gives that pane its own dock** holding
 * that shell, so two terminals can be on screen at once ("often times i
 * have like two diff things working and they got two diff terminals i
 * need"). Dragging the only shell of a dock moves the dock; dragging a
 * shell onto a pane that has a dock adds it to that strip, which is also
 * how two docks become one again. A dock is keyed by its pane's id; each
 * shell names its pane (`ShellRow.pane`).
 *
 * The pty's bytes do not pass through here as state: each shell's
 * `TerminalShell` registers a sink and the `terminal-data` listener hands
 * bytes straight to it, buffering only what arrives before the sink
 * exists (a shell's first prompt beats its component's mount).
 */
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { app, addToast, menuInterceptors } from "./state.svelte";
import { TERM_DRAG } from "./tabs";
import {
  TERM_DEFAULT_HEIGHT,
  TERM_HEIGHT_KEY,
  clampHeight,
  decodeBase64,
  droppedMarker,
  trimPending,
  type LiveShell,
  type ShellRow,
} from "./terminal";

function loadHeight(): number {
  try {
    const v = Number(localStorage.getItem(TERM_HEIGHT_KEY));
    return Number.isFinite(v) && v > 0 ? v : TERM_DEFAULT_HEIGHT;
  } catch {
    return TERM_DEFAULT_HEIGHT;
  }
}

/** One pane's dock: whether it is on screen, folded, and its front shell. */
export interface Dock {
  /** On screen (its shells kept while it is not). */
  open: boolean;
  /** Folded to its 32px strip (12c). */
  collapsed: boolean;
  /** The shell in front; null with none. */
  active: number | null;
}

export const term = $state({
  /** Every dock's height in px, the grip's; kept per machine. One height
   *  for both docks, so two side by side line up. */
  height: loadHeight(),
  /** Every shell of every dock, in strip order; `pane` says whose. */
  shells: [] as ShellRow[],
  /** The docks, by pane id. A pane with no shells has none. */
  docks: {} as Record<string, Dock>,
  /** The dock whose front shell's xterm has the keyboard focus — ⌘T / ⌘W
   *  act on that dock's shells only then (12c); null when none has. */
  focused: null as string | null,
  /** A request from the store to focus the front shell of `focusDock`;
   *  the component answers it. Bumped, not set, so two in a row both land. */
  focusTick: 0,
  focusDock: null as string | null,
  /** The folder the shells open in — the project's at the time the first
   *  opened. Compared to the open chat's folder for the notice row. */
  cwd: null as string | null,
  /** The window's dock: where New terminal and ⌃` go when the focused
   *  pane has no dock of its own — the first dock opened, or, when that
   *  one empties, another still there; null with no shells. */
  pane: null as string | null,
  /** The shell whose tab is being dragged, for the drop zones' captions
   *  (`dataTransfer` is unreadable during `dragover`). */
  dragging: null as number | null,
});

/** The shells of one pane's dock, in strip order. */
export function shellsIn(pane: string): ShellRow[] {
  return term.shells.filter((s) => s.pane === pane);
}

/** A pane's dock, if it has one. */
export function dockAt(pane: string | null | undefined): Dock | undefined {
  return pane ? term.docks[pane] : undefined;
}

/** Whether any dock is on screen — the top bar's button lights. */
export function anyOpen(): boolean {
  return Object.values(term.docks).some((d) => d.open);
}

/**
 * The dock New terminal and ⌃` act on: the focused pane's, if it has one
 * — else the window's (`term.pane`) — else none yet (a new one opens
 * under the focused pane).
 */
export function targetDock(): string | null {
  const f = app.tabs.focused;
  if (f && term.docks[f]) return f;
  if (term.pane && term.docks[term.pane]) return term.pane;
  return null;
}

function requestFocus(pane: string): void {
  term.focusDock = pane;
  term.focusTick++;
}

/**
 * Where a new shell starts: the project's folder. Null — and the button
 * dim — for an unfiled chat or a project about no folder (12c: "no
 * terminal without a folder"; 113's not-to-do). A Chat inside a folder
 * project gets the folder (blocker 190).
 */
export function terminalCwd(): string | null {
  const p = app.project;
  if (!p || !p.root || !p.exists) return null;
  return p.root;
}

// ---- the bytes ------------------------------------------------------------

type Sink = (bytes: Uint8Array | string) => void;
const sinks = new Map<number, Sink>();
/** Bytes that arrived before a shell's component had a sink, capped at
 *  `PENDING_MAX_BYTES` (backlog 137) — the oldest go, and `dropped`
 *  counts them for the marker the replay writes first. */
const pending = new Map<number, { chunks: Uint8Array[]; dropped: number }>();

/** A shell's component takes its bytes from here; what arrived before it
 *  mounted is replayed first, behind a marker if some of it was dropped. */
export function registerSink(id: number, sink: Sink): () => void {
  sinks.set(id, sink);
  const early = pending.get(id);
  if (early) {
    pending.delete(id);
    if (early.dropped > 0) sink(droppedMarker(early.dropped));
    for (const b of early.chunks) sink(b);
  }
  return () => {
    if (sinks.get(id) === sink) sinks.delete(id);
  };
}

function deliver(id: number, bytes: Uint8Array) {
  const sink = sinks.get(id);
  if (sink) sink(bytes);
  else {
    const q = pending.get(id) ?? { chunks: [], dropped: 0 };
    q.chunks.push(bytes);
    const trimmed = trimPending(q.chunks);
    q.chunks = trimmed.chunks;
    q.dropped += trimmed.dropped;
    pending.set(id, q);
  }
}

// ---- the instances ---------------------------------------------------------

/** Each shell's xterm, kept across its component's mounts (113's
 *  scrollback): a move of the dock to another pane, or the dock hiding
 *  and showing, re-attaches the same instance rather than drawing a new
 *  one over an empty grid. Disposed only with the shell. */
const lives = new Map<number, LiveShell>();

/** The instance a mounting component takes back, if the shell has one. */
export function liveShell(id: number): LiveShell | undefined {
  return lives.get(id);
}

/** A component's freshly built instance, kept for its next mount. */
export function keepLive(id: number, live: LiveShell): void {
  lives.set(id, live);
}

/** The shell is gone: its instance with it. */
function dropLive(id: number): void {
  const live = lives.get(id);
  if (!live) return;
  lives.delete(id);
  live.host.remove();
  live.dispose();
}

/** For the suite: how many instances the store holds. */
export function liveCount(): number {
  return lives.size;
}

/** For the suite: what a shell holds undrawn. */
export function pendingFor(id: number): { bytes: number; dropped: number } {
  const q = pending.get(id);
  if (!q) return { bytes: 0, dropped: 0 };
  let bytes = 0;
  for (const c of q.chunks) bytes += c.length;
  return { bytes, dropped: q.dropped };
}

/** For the suite: a `terminal-data` event's bytes, as the listener hands
 *  them on. */
export function deliverForTest(id: number, bytes: Uint8Array): void {
  deliver(id, bytes);
}

let listening = false;

/** The three events, listened for once — from the dock's mount. */
export async function initTerminalEvents(): Promise<void> {
  if (listening) return;
  listening = true;
  await listen<{ id: number; data: string }>("terminal-data", (e) => {
    deliver(e.payload.id, decodeBase64(e.payload.data));
  });
  await listen<{ id: number; code: number | null; signal: string | null }>("terminal-exit", (e) => {
    const row = term.shells.find((s) => s.id === e.payload.id);
    if (row) row.exit = { code: e.payload.code, signal: e.payload.signal };
  });
  await listen<{ id: number; title: string }>("terminal-title", (e) => {
    const row = term.shells.find((s) => s.id === e.payload.id);
    if (row) row.title = e.payload.title;
  });
}

// ---- the calls ------------------------------------------------------------

/**
 * The grid a shell is opened at, before its component has measured: the
 * dock's column width and the pane's height over the 13px mono cell
 * (about 7.8 × 15.6 px), so the shell's first lines — a prompt, a
 * warning from a profile — wrap where the fitted grid will; the fit on
 * mount corrects the odd column. The column is the dock's pane's
 * (`.pane-dock`'s parent), or the window's less the sidebar.
 */
function firstGrid(pane: string | null): { cols: number; rows: number } {
  let width = window.innerWidth - (app.layout.sidebarCollapsed ? 0 : app.layout.sidebarWidth);
  try {
    const slot = document.querySelector<HTMLElement>(`.pane-dock[data-pane="${pane ?? app.tabs.focused}"]`);
    const column = slot?.parentElement ?? document.querySelector<HTMLElement>(".main");
    if (column && column.clientWidth > 0) width = column.clientWidth;
  } catch {
    /* no DOM — the estimate stands */
  }
  return {
    cols: Math.max(20, Math.floor((width - 12) / 7.8)),
    rows: Math.max(3, Math.floor((term.height - 36) / 15.6)),
  };
}

/**
 * A new shell. `pane` names the dock (the strip's +, ⌘T in a focused
 * dock); without one it goes to `targetDock()` — the focused pane's dock,
 * else the window's — or opens the window's dock under the focused pane
 * (one dock for the window by default, blocker 155). Opens the dock if it
 * was hidden.
 */
export async function newShell(pane?: string | null): Promise<ShellRow | null> {
  const cwd = terminalCwd();
  if (!cwd) {
    addToast("No folder to open a shell in — a terminal needs a project with a folder.");
    return null;
  }
  const key = pane ?? targetDock() ?? app.tabs.focused ?? "main";
  try {
    const grid = firstGrid(key);
    const info = await api.terminalOpen(cwd, grid.cols, grid.rows);
    const row: ShellRow = { ...info, title: info.shell, exit: null, pane: key };
    term.shells.push(row);
    // Read back through the store: the assignment's value is the plain
    // object, not the reactive one.
    term.docks[key] ??= { open: true, collapsed: false, active: null };
    const dock = term.docks[key];
    dock.active = row.id;
    dock.open = true;
    dock.collapsed = false;
    term.cwd ??= cwd;
    term.pane ??= key;
    requestFocus(key);
    return row;
  } catch (e) {
    addToast(`Could not open a shell: ${String(e)}`);
    return null;
  }
}

/**
 * ⌃` and the top bar's button (12c), on `targetDock()`: no dock → open
 * one with a shell; hidden → show it; collapsed → expand; not focused →
 * focus it; focused → hide it, shells kept.
 */
export async function toggleTerminal(): Promise<void> {
  const key = targetDock();
  const dock = dockAt(key);
  if (!key || !dock) {
    await newShell();
    return;
  }
  if (!dock.open) {
    dock.open = true;
    requestFocus(key);
    return;
  }
  if (dock.collapsed) {
    dock.collapsed = false;
    requestFocus(key);
    return;
  }
  if (term.focused !== key) {
    requestFocus(key);
    return;
  }
  hidePane(key);
}

/** The top bar's button and the palette's row: open the dock with the
 *  pane hidden or absent; a second click adds a shell (12a's tooltip). */
export async function openTerminalFromBar(): Promise<void> {
  const key = targetDock();
  const dock = dockAt(key);
  if (!key || !dock) {
    await newShell();
  } else if (dock.open && !dock.collapsed) {
    await newShell(key);
  } else {
    dock.open = true;
    dock.collapsed = false;
    requestFocus(key);
  }
}

/** Hide a dock; its shells keep running — and keep their screens: the
 *  dock stays mounted and is only not displayed (backlog 137), so the
 *  scrollback, and a `vim` or `less` in front, come back as they were.
 *  The composer gets the focus back through the normal tab order, not
 *  forced. */
export function hidePane(pane: string): void {
  const dock = term.docks[pane];
  if (dock) dock.open = false;
  if (term.focused === pane) term.focused = null;
}

/** A dock emptied: it goes, and the window's dock passes to one still
 *  there. */
function dropDockIfEmpty(pane: string): void {
  if (term.shells.some((s) => s.pane === pane)) return;
  delete term.docks[pane];
  if (term.focused === pane) term.focused = null;
  if (term.pane === pane) term.pane = Object.keys(term.docks)[0] ?? null;
  if (term.shells.length === 0) term.cwd = null;
}

/** The front shell of a dock after `gone` left it: its neighbour in the
 *  strip, or none. */
function nextActive(pane: string, gone: number, at: number): void {
  const dock = term.docks[pane];
  if (!dock || dock.active !== gone) return;
  const rest = shellsIn(pane);
  const next = rest[Math.min(at, rest.length - 1)];
  dock.active = next ? next.id : null;
}

/** The strip's × on a tab, ⌘W with the terminal focused: the shell ends
 *  (the running dot was the warning; nothing is asked, blocker 041's
 *  rule). Closing a dock's last shell closes the dock. */
export function closeShell(id: number): void {
  const i = term.shells.findIndex((s) => s.id === id);
  if (i < 0) return;
  const pane = term.shells[i].pane ?? "";
  const at = shellsIn(pane).findIndex((s) => s.id === id);
  term.shells.splice(i, 1);
  sinks.delete(id);
  pending.delete(id);
  dropLive(id);
  void api.terminalClose(id).catch(() => {});
  nextActive(pane, id, at);
  if (shellsIn(pane).length === 0) dropDockIfEmpty(pane);
  else requestFocus(pane);
}

/** A dock's own ×: its shells end, the dock goes. */
export function closePane(pane: string): void {
  for (const s of shellsIn(pane)) closeShell(s.id);
}

/**
 * A dock's pane went (its last tab closed, board 9d): its shells end,
 * nothing is asked — the running dot was the warning (blocker 041). Called
 * whenever the workspace changes; a no-op while every dock's pane is
 * still there.
 */
export function dockPaneCheck(): void {
  for (const pane of Object.keys(term.docks)) {
    if (!app.tabs.panes.some((p) => p.id === pane)) closePane(pane);
  }
}

/**
 * A shell's tab dropped on a pane (blocker 155): the shell goes to that
 * pane's dock — a new dock there if it has none, so two terminals stand
 * side by side; the dock it left keeps its other shells, or goes if it
 * was the last (then the drag moved the dock, blocker 189's 12b). The pty
 * and the process run on; the xterm is kept across the re-mount.
 */
export function moveShell(id: number, to: string): void {
  const row = term.shells.find((s) => s.id === id);
  if (!row || row.pane === to) return;
  const from = row.pane ?? "";
  const at = shellsIn(from).findIndex((s) => s.id === id);
  // Last in its strip, whichever dock it lands in; the dock it lands in
  // shows, expanded, with it in front.
  term.shells.splice(
    term.shells.findIndex((s) => s.id === id),
    1,
  );
  row.pane = to;
  term.shells.push(row);
  term.docks[to] ??= { open: true, collapsed: false, active: null };
  const dock = term.docks[to];
  dock.active = id;
  dock.open = true;
  dock.collapsed = false;
  nextActive(from, id, at);
  const wasWindows = term.pane === from;
  dropDockIfEmpty(from);
  if (wasWindows && !term.docks[from]) term.pane = to;
  requestFocus(to);
}

/** A drop of a shell's tab on a pane or its strip: which shell (the
 *  drag's data, or the mirror when a synthetic event carries none), into
 *  that pane's dock. */
export function draggedShell(e: DragEvent, pane: string): void {
  const raw = e.dataTransfer?.getData(TERM_DRAG);
  const id = raw ? Number(raw) : term.dragging;
  term.dragging = null;
  if (id !== null && Number.isFinite(id)) moveShell(id, pane);
}

/** The drop zone's caption over a pane while a shell's tab is dragged. */
export function dropLabel(pane: string): string {
  const row = term.shells.find((s) => s.id === term.dragging);
  if (!row) return "dock the terminal here";
  if (row.pane === pane) return "the terminal is here";
  if (term.docks[pane]) return "add to this pane's terminal";
  return shellsIn(row.pane ?? "").length > 1 ? "a second terminal here" : "dock the terminal here";
}

/** A click on an exited tab restarts the shell in the same folder (12c),
 *  in the same slot of the same strip. */
export async function restartShell(id: number): Promise<void> {
  const i = term.shells.findIndex((s) => s.id === id);
  if (i < 0) return;
  const old = term.shells[i];
  if (!old.exit) {
    selectShell(id);
    return;
  }
  const pane = old.pane ?? "";
  try {
    const grid = firstGrid(pane);
    const info = await api.terminalOpen(old.cwd, grid.cols, grid.rows);
    const row: ShellRow = { ...info, title: info.shell, exit: null, pane };
    // The dead one's pty is already gone; forgetting it on the Rust side
    // is a courtesy that can never fail.
    void api.terminalClose(old.id).catch(() => {});
    sinks.delete(old.id);
    pending.delete(old.id);
    dropLive(old.id);
    const j = term.shells.findIndex((s) => s.id === id);
    term.shells.splice(j < 0 ? term.shells.length : j, j < 0 ? 0 : 1, row);
    const dock = term.docks[pane];
    if (dock) dock.active = row.id;
    requestFocus(pane);
  } catch (e) {
    addToast(`Could not restart the shell: ${String(e)}`);
  }
}

export function selectShell(id: number): void {
  const row = term.shells.find((s) => s.id === id);
  const dock = dockAt(row?.pane);
  if (!row || !dock) return;
  dock.active = id;
  dock.collapsed = false;
  requestFocus(row.pane!);
}

/** ⌘⇧] / ⌘⇧[ — the next or previous tab of a dock, wrapping. */
export function stepShell(pane: string, dir: 1 | -1): void {
  const list = shellsIn(pane);
  const n = list.length;
  if (n === 0) return;
  const i = list.findIndex((s) => s.id === term.docks[pane]?.active);
  const j = ((i < 0 ? 0 : i) + dir + n) % n;
  selectShell(list[j].id);
}

export function setHeight(px: number, columnHeight: number): void {
  term.height = clampHeight(px, columnHeight);
}

/** The grip's release: keep the height. Double-click: back to the default. */
export function saveHeight(): void {
  try {
    localStorage.setItem(TERM_HEIGHT_KEY, String(term.height));
  } catch {
    /* no storage — the height lasts the session */
  }
}

export function resetHeight(): void {
  term.height = TERM_DEFAULT_HEIGHT;
  try {
    localStorage.removeItem(TERM_HEIGHT_KEY);
  } catch {
    /* as above */
  }
}

/**
 * The tab chords while a terminal has the keyboard (board 12c): ⌘T a
 * new shell, ⌘W close this one, ⌘⇧] / ⌘⇧[ the next and previous — in the
 * focused dock. On macOS they are File and View menu items (099's tabs)
 * and arrive as `menu` commands, so this takes them there — before the
 * tab flow — whenever a front shell has the focus; elsewhere the dock's
 * own key handler does the same from the keydown.
 */
export function takeMenuCommand(id: string): boolean {
  const pane = term.focused;
  const dock = dockAt(pane);
  if (!pane || !dock || !dock.open || dock.collapsed) return false;
  switch (id) {
    case "new_tab":
      void newShell(pane);
      return true;
    case "close_tab":
      if (dock.active !== null) closeShell(dock.active);
      return true;
    case "next_tab":
      stepShell(pane, 1);
      return true;
    case "prev_tab":
      stepShell(pane, -1);
      return true;
    default:
      return false;
  }
}
menuInterceptors.push(takeMenuCommand);

export function toggleCollapsed(pane: string): void {
  const dock = term.docks[pane];
  if (!dock) return;
  dock.collapsed = !dock.collapsed;
  if (!dock.collapsed) requestFocus(pane);
  else if (term.focused === pane) term.focused = null;
}
