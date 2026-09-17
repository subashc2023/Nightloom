/**
 * The terminal pane (nightshift backlog 113, boards 12a–12c, 2026-09-17):
 * the pure part — what a strip tab says and in which state, which chords
 * the pane takes, how the pty's bytes are decoded, what the notice row
 * under the strip counts while a Claude Code turn works in the same
 * folder — so the suite can pin it without a DOM. `terminal.svelte.ts`
 * holds the reactive store and the calls; `TerminalDock.svelte` and
 * `TerminalShell.svelte` draw it.
 */
import type { Segment } from "./state.svelte";
import type { SessionEvent } from "./types";
import { shortToolName } from "./activity";

/** What `terminal_open` answers, plus what the events add. */
export interface ShellRow {
  id: number;
  /** The program's name — `zsh` — the tab's title while nothing runs. */
  shell: string;
  /** The foreground process group's name, as `terminal-title` reports it;
   *  the shell's own name when it is in front. */
  title: string;
  cwd: string;
  pid: number | null;
  /** Set once the shell ended: the code, or the signal that ended it. */
  exit: { code: number | null; signal: string | null } | null;
}

/** The pane's default height (the boards' 220–260px), its floor, and the
 *  share of the column it may take at most. */
export const TERM_DEFAULT_HEIGHT = 240;
export const TERM_MIN_HEIGHT = 96;
export const TERM_MAX_SHARE = 0.8;
/** The key the dragged height is kept under — per machine, like the
 *  composer's cap. */
export const TERM_HEIGHT_KEY = "nightloom.term.height";

export function clampHeight(px: number, columnHeight: number): number {
  const max = Math.max(TERM_MIN_HEIGHT, Math.floor(columnHeight * TERM_MAX_SHARE));
  return Math.min(max, Math.max(TERM_MIN_HEIGHT, Math.round(px)));
}

/** A foreground process other than the shell itself — the blue dot. */
export function isRunning(row: ShellRow): boolean {
  return row.exit === null && row.title !== "" && row.title !== row.shell;
}

/** The tab's text: the shell, then the running command (12c). */
export function tabLabel(row: ShellRow): string {
  if (row.exit) return row.shell;
  return isRunning(row) ? row.title : row.shell;
}

/** `exit 1` in red, or `ended` for a signal (12c's exited state). */
export function exitLabel(row: ShellRow): string | null {
  if (!row.exit) return null;
  if (row.exit.code !== null) return `exit ${row.exit.code}`;
  return row.exit.signal ? `ended (${row.exit.signal})` : "ended";
}

/**
 * The folder as the boards write it: `~/…/Value-Generalization` — the
 * home shortened, the middle elided, the last segment whole. A path
 * outside the home keeps its first segment instead of the tilde.
 */
export function shortCwd(path: string, home: string | null): string {
  let p = path.replace(/\/+$/, "");
  let head = "";
  if (home && (p === home || p.startsWith(home + "/"))) {
    p = p.slice(home.length);
    head = "~";
  }
  const parts = p.split("/").filter(Boolean);
  if (parts.length === 0) return head || "/";
  if (head === "" ) head = "/" + parts.shift();
  if (parts.length === 0) return head;
  if (parts.length === 1) return `${head}/${parts[0]}`;
  return `${head}/…/${parts[parts.length - 1]}`;
}

/**
 * ⌃` on every platform (12c: "the editors' convention; blocker 035's set
 * has no ⌃ chord"): opens the pane, focuses it, hides it. Matched on the
 * physical key so a layout cannot move it; no other modifier, so ⌘⌃`
 * and the like stay free.
 */
export function terminalChord(e: {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return e.code === "Backquote" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
}

export type FocusedChord = "new" | "close" | "next" | "prev";

/**
 * The chords that act on shells only while the terminal has the focus
 * (12c): ⌘T a new shell in the dock, ⌘W close this one, ⌘⇧] / ⌘⇧[ the
 * next and previous tab. macOS only — elsewhere the primary key is Ctrl,
 * and Ctrl+T, Ctrl+W are the shell's own (transpose, delete a word), so
 * there the strip's buttons do it.
 */
export function focusedChord(
  e: { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  isMac: boolean,
): FocusedChord | null {
  if (!isMac || !e.metaKey || e.ctrlKey || e.altKey) return null;
  if (e.shiftKey) {
    if (e.code === "BracketRight") return "next";
    if (e.code === "BracketLeft") return "prev";
    return null;
  }
  if (e.code === "KeyT") return "new";
  if (e.code === "KeyW") return "close";
  return null;
}

/** The pty's bytes, out of the event's base64. */
export function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The most a shell's undrawn output may hold (backlog 137): bytes that
 * arrive before the shell's component has a sink — its first prompt,
 * mostly — queue in the store; past this the oldest go and a marker says
 * how much. The Rust side stops sending past 256 KB unacknowledged, but
 * releases that every 2 s when nothing answers, so without a cap a shell
 * with no component for an hour would hold hundreds of megabytes.
 */
export const PENDING_MAX_BYTES = 1024 * 1024;

/**
 * The queue trimmed to the cap from the front — whole chunks, oldest
 * first — and how many bytes went. Pure, for the suite.
 */
export function trimPending(chunks: Uint8Array[], max: number = PENDING_MAX_BYTES): { chunks: Uint8Array[]; dropped: number } {
  let total = 0;
  for (const c of chunks) total += c.length;
  let dropped = 0;
  let i = 0;
  while (total > max && i < chunks.length) {
    total -= chunks[i].length;
    dropped += chunks[i].length;
    i++;
  }
  return { chunks: i === 0 ? chunks : chunks.slice(i), dropped };
}

/** The line xterm shows where dropped output would have been. */
export function droppedMarker(bytes: number): string {
  const kb = Math.round(bytes / 1024);
  return `\r\n\x1b[2m[${kb} KB of output not shown — it arrived while this shell was not drawn]\x1b[0m\r\n`;
}

/** The tools that change a file, by their short name (`mcp__…__` peeled). */
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "edit", "write", "multi_edit"]);

function inputPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  for (const k of ["file_path", "path", "notebook_path"]) {
    if (typeof o[k] === "string" && o[k]) return o[k] as string;
  }
  return null;
}

/**
 * How many distinct files the live turn has changed so far — the notice
 * row's `2 files so far` (12c). Counted from the calls in the live
 * reply's segments, and a subagent's calls under its parent's.
 */
export function filesChanged(segs: readonly Segment[]): number {
  const seen = new Set<string>();
  const walk = (list: readonly Segment[]) => {
    for (const s of list) {
      if (s.kind !== "tool") continue;
      if (FILE_TOOLS.has(shortToolName(s.call.name))) {
        const p = inputPath(s.call.input);
        if (p) seen.add(p);
      }
      if (s.call.children) walk(s.call.children);
    }
  };
  walk(segs);
  return seen.size;
}

/**
 * The turn's latest call, as the activity block's row names it: the tool,
 * then its file or its command — `Edit notes/ace/q5-depth.md`, `Bash git
 * diff --stat`. Null before the first call.
 */
export function latestCall(segs: readonly Segment[], root: string | null): string | null {
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (s.kind !== "tool") continue;
    const name = shortToolName(s.call.name);
    const input = s.call.input;
    let arg = inputPath(input);
    if (arg && root && arg.startsWith(root + "/")) arg = arg.slice(root.length + 1);
    if (!arg && input && typeof input === "object") {
      const o = input as Record<string, unknown>;
      const cmd = o.command ?? o.pattern ?? o.query;
      if (typeof cmd === "string") arg = cmd.length > 48 ? cmd.slice(0, 47) + "…" : cmd;
    }
    return arg ? `${name} ${arg}` : name;
  }
  return null;
}

/**
 * When the live turn was sent (ms since epoch): the newest user message's
 * time, as the transcript counts its `working · 41 s` from. Null when
 * the log has none.
 */
export function turnStartedAt(events: readonly SessionEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event === "user_message") {
      const t = new Date(e.at).getTime();
      return Number.isNaN(t) ? null : t;
    }
  }
  return null;
}

/** `41 s`, `2 min 3 s` — the notice row's clock. */
export function clockLabel(elapsedMs: number): string {
  const s = Math.max(0, Math.floor(elapsedMs / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}
