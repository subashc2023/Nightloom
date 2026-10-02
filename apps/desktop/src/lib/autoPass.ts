/**
 * When memory upkeep runs by itself (nightshift item 278, 2026-10-02).
 *
 * The capture → dream pipeline had one automatic trigger, a compaction,
 * and he never compacts — he hands off — so from 2026-09-18 nothing ran.
 * Two triggers that happen for him replace it as the ones that matter:
 *
 * 1. **A hand-off.** A turn that wrote `HANDOFF.md` (his hand-run wrap-up,
 *    or the hand-off card's), and *Continue in a new chat*. The chat being
 *    left is finished as far as memory is concerned, so it is the moment
 *    to read it. Two hand-off signals minutes apart (the wrap-up turn, then
 *    Continue) are one pass: `handoffPassDue` spaces them.
 * 2. **Once a night, when the Mac is idle.** The daily pass's hour still
 *    decides the day; it now also waits until nobody has touched the Mac
 *    for `NIGHTLY_IDLE_MS` — he works past midnight, and a pass that starts
 *    under his hands competes with his own turns for the plan — unless the
 *    last pass is older than `NIGHTLY_STALE_MS`, so a Mac that is never
 *    left idle while the app is open still gets one.
 *
 * Pure, so the suite pins the rules; `state.svelte.ts` reads the clock,
 * the log and the Mac's idle time and calls these.
 */
import type { SessionEvent } from "./types";

/** The file tools whose write of `HANDOFF.md` counts as a hand-off: the
 *  Claude Code engine's names and Nightloom's own. */
const WRITERS = new Set(["Write", "Edit", "MultiEdit", "write_file", "edit_file"]);

/** Did the last turn of this log write a `HANDOFF.md`? The last turn is
 *  everything after the last user message. */
export function turnWroteHandoff(events: SessionEvent[] | null | undefined): boolean {
  if (!events || events.length === 0) return false;
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === "user_message") {
      start = i + 1;
      break;
    }
  }
  for (let i = start; i < events.length; i++) {
    const e = events[i];
    if (e.event !== "assistant_message") continue;
    for (const b of e.blocks) {
      if (b.type !== "tool_use" || !WRITERS.has(b.name)) continue;
      const input = (b.input ?? {}) as Record<string, unknown>;
      const path = typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : "";
      if (/(^|[\\/])HANDOFF\.md$/.test(path)) return true;
    }
  }
  return false;
}

/** Two hand-off signals closer than this are one pass. */
export const HANDOFF_PASS_GAP_MS = 10 * 60_000;

/** Whether a hand-off may start a pass, given when the last automatic one
 *  started (null: none this run of the app). */
export function handoffPassDue(lastMs: number | null, now: number): boolean {
  return lastMs === null || now - lastMs >= HANDOFF_PASS_GAP_MS;
}

/** The Mac counts as idle after this long without a key or the pointer —
 *  the hand-off watchdog's "away" (`brief.rs`, `AWAY_MS`). */
export const NIGHTLY_IDLE_MS = 10 * 60_000;

/** A pass older than this runs at the day's hour whatever the Mac is doing. */
export const NIGHTLY_STALE_MS = 36 * 60 * 60_000;

/**
 * The nightly pass's extra condition, on top of `dailyDue`: the Mac idle
 * for `NIGHTLY_IDLE_MS`, or the last pass stale. An idle time that could
 * not be read (`null`) is not idle — waiting costs a night at most, since
 * the stale rule catches it.
 */
export function nightlyReady(idleMs: number | null, lastMs: number | null, now: number): boolean {
  if (lastMs === null || now - lastMs >= NIGHTLY_STALE_MS) return true;
  return idleMs !== null && idleMs >= NIGHTLY_IDLE_MS;
}
