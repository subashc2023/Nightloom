/**
 * The terminal pane's store (nightshift backlog 113, boards 12a–12c,
 * 2026-09-17): the pane's open/collapsed/height, the shells in its strip,
 * which one is in front, whether it has the focus — and the calls that
 * change them. One dock for the window today (blocker 189): the boards
 * draw one per panel, and there is one panel until 099's split lands.
 *
 * The pty's bytes do not pass through here as state: each shell's
 * `TerminalShell` registers a sink and the `terminal-data` listener hands
 * bytes straight to it, buffering only what arrives before the sink
 * exists (a shell's first prompt beats its component's mount).
 */
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { app, addToast, menuInterceptors } from "./state.svelte";
import {
  TERM_DEFAULT_HEIGHT,
  TERM_HEIGHT_KEY,
  clampHeight,
  decodeBase64,
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

export const term = $state({
  /** The pane is on screen (shells kept while it is not). */
  open: false,
  /** Folded to its 32px strip (12c). */
  collapsed: false,
  /** The pane's height in px, the grip's; kept per machine. */
  height: loadHeight(),
  shells: [] as ShellRow[],
  /** The shell in front; null with none. */
  active: null as number | null,
  /** The front shell's xterm has the keyboard focus — ⌘T / ⌘W act on
   *  shells only then (12c). */
  focused: false,
  /** A request from the store to focus the front shell; the component
   *  answers it. Bumped, not set, so two in a row both land. */
  focusTick: 0,
  /** The folder the dock's shells open in — the project's at the time the
   *  pane opened. Compared to the open chat's folder for the notice row. */
  cwd: null as string | null,
  /** The pane (099's) the dock sits under — the focused one when it was
   *  opened; null before the first shell. `TerminalDock` mounts in every
   *  pane's dock slot and draws only in this one (blocker 189: one dock
   *  for the window, under the panel it was opened from). */
  pane: null as string | null,
});

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

type Sink = (bytes: Uint8Array) => void;
const sinks = new Map<number, Sink>();
const pending = new Map<number, Uint8Array[]>();

/** A shell's component takes its bytes from here; what arrived before it
 *  mounted is replayed first. */
export function registerSink(id: number, sink: Sink): () => void {
  sinks.set(id, sink);
  const early = pending.get(id);
  if (early) {
    pending.delete(id);
    for (const b of early) sink(b);
  }
  return () => {
    if (sinks.get(id) === sink) sinks.delete(id);
  };
}

function deliver(id: number, bytes: Uint8Array) {
  const sink = sinks.get(id);
  if (sink) sink(bytes);
  else {
    const q = pending.get(id) ?? [];
    q.push(bytes);
    pending.set(id, q);
  }
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
 * mount corrects the odd column. The column is the focused pane's
 * (`.pane-dock`'s parent), or the window's less the sidebar.
 */
function firstGrid(): { cols: number; rows: number } {
  let width = window.innerWidth - (app.layout.sidebarCollapsed ? 0 : app.layout.sidebarWidth);
  try {
    const slot = document.querySelector<HTMLElement>(`.pane-dock[data-pane="${app.tabs.focused}"]`);
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
 * A new shell in the dock (the strip's +, ⌘T, the top bar's button with
 * a pane already open). Opens the pane if it was hidden.
 */
export async function newShell(): Promise<ShellRow | null> {
  const cwd = terminalCwd();
  if (!cwd) {
    addToast("No folder to open a shell in — a terminal needs a project with a folder.");
    return null;
  }
  try {
    const grid = firstGrid();
    const info = await api.terminalOpen(cwd, grid.cols, grid.rows);
    const row: ShellRow = { ...info, title: info.shell, exit: null };
    term.shells.push(row);
    term.active = row.id;
    term.cwd ??= cwd;
    term.pane ??= app.tabs.focused;
    term.open = true;
    term.collapsed = false;
    term.focusTick++;
    return row;
  } catch (e) {
    addToast(`Could not open a shell: ${String(e)}`);
    return null;
  }
}

/**
 * ⌃` and the top bar's button (12c): no pane → open one with a shell;
 * a pane not focused → focus it; focused → hide it, shells kept.
 */
export async function toggleTerminal(): Promise<void> {
  if (!term.open) {
    if (term.shells.length > 0) {
      term.open = true;
      term.focusTick++;
    } else {
      await newShell();
    }
    return;
  }
  if (term.collapsed) {
    term.collapsed = false;
    term.focusTick++;
    return;
  }
  if (!term.focused) {
    term.focusTick++;
    return;
  }
  hidePane();
}

/** Open the pane — the top bar's button with the pane hidden or absent;
 *  a second click there adds a shell (12a's tooltip). */
export async function openTerminalFromBar(): Promise<void> {
  if (term.open && !term.collapsed) {
    await newShell();
  } else if (term.shells.length > 0) {
    term.open = true;
    term.collapsed = false;
    term.focusTick++;
  } else {
    await newShell();
  }
}

/** Hide the pane; the shells keep running. The composer gets the focus
 *  back through the normal tab order, not forced. */
export function hidePane(): void {
  term.open = false;
  term.focused = false;
}

/** The strip's × on a tab, ⌘W with the terminal focused: the shell ends
 *  (the running dot was the warning; nothing is asked, blocker 041's
 *  rule). Closing the last shell hides the pane. */
export function closeShell(id: number): void {
  const i = term.shells.findIndex((s) => s.id === id);
  if (i < 0) return;
  term.shells.splice(i, 1);
  sinks.delete(id);
  pending.delete(id);
  void api.terminalClose(id).catch(() => {});
  if (term.active === id) {
    const next = term.shells[Math.min(i, term.shells.length - 1)];
    term.active = next ? next.id : null;
  }
  if (term.shells.length === 0) {
    term.open = false;
    term.focused = false;
    term.cwd = null;
    term.pane = null;
  } else {
    term.focusTick++;
  }
}

/** The pane's own ×: every shell ends, the pane goes. */
export function closePane(): void {
  for (const s of [...term.shells]) closeShell(s.id);
}

/**
 * The dock's pane went (its last tab closed, board 9d): the shells end,
 * nothing is asked — the running dot was the warning (blocker 041). Called
 * from the dock whenever the workspace changes; a no-op while the pane
 * is still there.
 */
export function dockPaneCheck(): void {
  if (term.pane && !app.tabs.panes.some((p) => p.id === term.pane)) closePane();
}

/** A click on an exited tab restarts the shell in the same folder (12c),
 *  in the same slot of the strip. */
export async function restartShell(id: number): Promise<void> {
  const i = term.shells.findIndex((s) => s.id === id);
  if (i < 0) return;
  const old = term.shells[i];
  if (!old.exit) {
    selectShell(id);
    return;
  }
  try {
    const grid = firstGrid();
    const info = await api.terminalOpen(old.cwd, grid.cols, grid.rows);
    const row: ShellRow = { ...info, title: info.shell, exit: null };
    // The dead one's pty is already gone; forgetting it on the Rust side
    // is a courtesy that can never fail.
    void api.terminalClose(old.id).catch(() => {});
    sinks.delete(old.id);
    pending.delete(old.id);
    term.shells.splice(i, 1, row);
    term.active = row.id;
    term.focusTick++;
  } catch (e) {
    addToast(`Could not restart the shell: ${String(e)}`);
  }
}

export function selectShell(id: number): void {
  if (!term.shells.some((s) => s.id === id)) return;
  term.active = id;
  term.collapsed = false;
  term.focusTick++;
}

/** ⌘⇧] / ⌘⇧[ — the next or previous tab, wrapping. */
export function stepShell(dir: 1 | -1): void {
  const n = term.shells.length;
  if (n === 0) return;
  const i = term.shells.findIndex((s) => s.id === term.active);
  const j = ((i < 0 ? 0 : i) + dir + n) % n;
  selectShell(term.shells[j].id);
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
 * The tab chords while the terminal has the keyboard (board 12c): ⌘T a
 * new shell, ⌘W close this one, ⌘⇧] / ⌘⇧[ the next and previous. On
 * macOS they are File and View menu items (099's tabs) and arrive as
 * `menu` commands, so this takes them there — before the tab flow —
 * whenever the front shell has the focus; elsewhere the dock's own key
 * handler does the same from the keydown.
 */
export function takeMenuCommand(id: string): boolean {
  if (!term.open || !term.focused || term.collapsed) return false;
  switch (id) {
    case "new_tab":
      void newShell();
      return true;
    case "close_tab":
      if (term.active !== null) closeShell(term.active);
      return true;
    case "next_tab":
      stepShell(1);
      return true;
    case "prev_tab":
      stepShell(-1);
      return true;
    default:
      return false;
  }
}
menuInterceptors.push(takeMenuCommand);

export function toggleCollapsed(): void {
  term.collapsed = !term.collapsed;
  if (!term.collapsed) term.focusTick++;
  else term.focused = false;
}
