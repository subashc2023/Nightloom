/**
 * One list of everything running, in every project (nightshift backlogs 308
 * and 309, 2026-10-04): turns, councils, subagents, asides, note edits, the
 * dream, the capture, the daily pass, the Nightshift interview and runs.
 *
 * Not a second store kept beside the first: `runningWork()` in
 * `state.svelte.ts` reads the state that already says what runs (the turn on
 * screen, `app.background`, `app.subagents`, the asides and their stash, the
 * memory flags) and returns these rows, so a start, an end, an error or a
 * Stop changes the list with no bookkeeping of its own to forget — and a
 * project switch leaves it whole, since none of those are cleared by one.
 * Two readers: the Running-tasks panel and its badge (309), and the quit
 * guard (308), which sends Rust the lines a quit would stop.
 *
 * This file is the pure part: the row, what a live reply is doing, the
 * quit's lines, the order.
 */

export type RunKind =
  | "turn"
  | "council"
  | "subagent"
  | "council seat"
  | "aside"
  | "note edit"
  | "dream"
  | "capture"
  | "daily pass"
  | "interview"
  | "nightshift";

export interface RunEntry {
  /** Stable across re-reads, for keyed lists. */
  id: string;
  kind: RunKind;
  /** The project's id; null for unfiled chats and for app-wide work. */
  project: string | null;
  /** What the row calls where it runs: the project's name, "unfiled chats",
   *  "memory", "Nightshift". */
  where: string;
  /** The chat to open on a click; null when there is none to open. */
  session: string | null;
  /** The chat's name; empty for app-wide work. */
  chat: string;
  /** What it is doing now, in a few words. */
  doing: string;
  /** Clock at its start; null when unknown. */
  startedAt: number | null;
  /** The chat on screen's own turn (or a part of it). */
  onScreen: boolean;
  /** A prompt or a budget stop is waiting on him. */
  waiting: boolean;
  /** Keeps running when the app quits (a Nightshift run is detached), so a
   *  quit does not ask about it. */
  survivesQuit: boolean;
}

/** The minimal shape of a live segment this reads (`Segment` in
 *  `state.svelte.ts`), so the suite needs no store. */
type SegmentLike =
  | { kind: "thinking"; done: boolean }
  | { kind: "text"; text: string }
  | { kind: "tool"; call: { name: string; result: unknown } }
  | { kind: string };

/** What a live reply is doing, from its last segment: the call it waits on,
 *  thinking, or writing; "starting" before anything has arrived. */
export function doingOf(segments: readonly SegmentLike[] | null | undefined): string {
  if (!segments || segments.length === 0) return "starting";
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (s.kind === "tool") {
      const c = (s as { call: { name: string; result: unknown } }).call;
      return c.result === null || c.result === undefined ? `running ${c.name}` : `read ${c.name}'s result`;
    }
    if (s.kind === "thinking") return (s as { done: boolean }).done ? "thought" : "thinking";
    if (s.kind === "text") return "writing";
  }
  return "starting";
}

/** A question cut to a line, quoted. */
export function quoteLine(text: string, max = 60): string {
  const one = text.replace(/\s+/g, " ").trim();
  return `“${one.length > max ? `${one.slice(0, max - 1)}…` : one}”`;
}

/** Oldest first; unknown starts last. On-screen rows keep no priority: the
 *  list is "what runs", not "what is near". */
export function sortRuns(runs: RunEntry[]): RunEntry[] {
  return [...runs].sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || a.id.localeCompare(b.id));
}

/** The rows a quit would stop. */
export function quitBlockers(runs: readonly RunEntry[]): RunEntry[] {
  return runs.filter((r) => !r.survivesQuit);
}

/** One row as Rust holds it: `project · chat · kind`. Not what it is
 *  doing, which moves with every call — the dialog reads that live; the
 *  line changes only when a run starts or ends, so the push is rare. */
export function quitLine(r: RunEntry): string {
  return [r.where, r.chat, r.kind].filter(Boolean).join(" · ");
}

/** What Rust holds for the quit guard: one line per row a quit would stop;
 *  empty when nothing runs. */
export function quitLines(runs: readonly RunEntry[]): string[] {
  return sortRuns(quitBlockers(runs)).map(quitLine);
}

/**
 * A start time for work that records none (the memory flags, the
 * interview): the clock when it was first seen running, forgotten when it
 * is seen stopped. Plain, not state — read inside a derivation, written
 * only on a change it has just observed.
 */
export class FirstSeen {
  private at = new Map<string, number>();
  mark(key: string, running: boolean, now: number): number | null {
    if (!running) {
      this.at.delete(key);
      return null;
    }
    const t = this.at.get(key);
    if (t !== undefined) return t;
    this.at.set(key, now);
    return now;
  }
}
