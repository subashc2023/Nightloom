/**
 * Item 1013 (740 Simulator audit, 2026-11-26): the phone's Dream and Capture say that they started, that they
 * are still working (a clock), and how they ended — held until he closes it, as item 1005 made the Mac's
 * toast do. Before, the phone showed "Capturing on the Mac" for 4 s; a 3-minute pass that saved 58
 * observations then ended with a 4-second note under Home's screen, which nobody saw.
 *
 * Pure, so the suite pins it; `PassStatus.svelte` draws it and `Remote.svelte` feeds it the start, the Mac's
 * `pass-event`s, and the Running read (the fallback when the end's event was missed: a dropped stream).
 */

export type PassKind = "dream" | "capture";

export interface PassStatus {
  kind: PassKind;
  phase: "working" | "done" | "failed";
  /** The words shown: while working the start's, after it the Mac's own result line. */
  text: string;
  /** When the phone started it (ms), for the clock. */
  since: number;
  /** When it ended (ms), or null while working. */
  ended: number | null;
}

const NAME: Record<PassKind, string> = { dream: "Dream", capture: "Capture" };

/** Pressed on the phone; the Mac took it. */
export function passStarted(kind: PassKind, host: string, now: number): PassStatus {
  const text = kind === "dream" ? `Dreaming on ${host} — sorting the memory inbox into memory` : `Capturing on ${host} — reading the chats into the memory inbox`;
  return { kind, phase: "working", text, since: now, ended: null };
}

/** The Mac's `pass-event` (`{kind, state, text}`): the end replaces the working line; others change nothing. */
export function passEvent(cur: PassStatus | null, data: string, now: number): PassStatus | null {
  let p: { kind?: string; state?: string; text?: string | null };
  try {
    p = JSON.parse(data);
  } catch {
    return cur;
  }
  if (p.kind !== "dream" && p.kind !== "capture") return cur;
  if (p.state !== "done" && p.state !== "failed") return cur;
  const kind = p.kind;
  const text = p.text?.trim() || (p.state === "failed" ? `${NAME[kind]} failed on the Mac` : `${NAME[kind]} finished on the Mac`);
  return { kind, phase: p.state, text, since: cur?.kind === kind ? cur.since : now, ended: now };
}

/** How long a working pass must have run before a Running read without it ends it (the event was missed). */
export const MISSED_AFTER_MS = 20_000;

/**
 * A Running read (`/running`'s `dream` / `capture`) while the phone shows a pass working: the pass is no longer
 * listed, so it ended and the phone missed its result. Says so rather than spin for ever.
 */
export function passRunningRead(cur: PassStatus | null, listed: { dream: boolean; capture: boolean }, now: number): PassStatus | null {
  if (!cur || cur.phase !== "working") return cur;
  if (listed[cur.kind] || now - cur.since < MISSED_AFTER_MS) return cur;
  return {
    ...cur,
    phase: "done",
    text: `${NAME[cur.kind]} ended on the Mac — the phone missed its result; ${cur.kind === "capture" ? "Dream files what it saved" : "Notes shows what it wrote"}`,
    ended: now,
  };
}

/** "0:07", "2:31", "1:02:05". */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
