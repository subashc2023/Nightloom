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
import type { PlanUsage, SessionEvent } from "./types";

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

/*
 * Usage headroom (nightshift item 279, 2026-10-02). An automatic pass on
 * the Claude Code engine spends the same plan as his own turns; his
 * question was whether it should wait for "plenty of usage available".
 * So before an automatic capture/dream/tidy starts, the plan's figure is
 * read (the top bar's chip, `PlanUsage`) and the pass is deferred while
 * the five-hour window or the week is over its limit. A deferred pass runs
 * at the next trigger that finds both under, or when the window that held
 * it resets. *Run now* and the Dream/Capture buttons never ask.
 */

/** His limits, Settings → Knowledge: a pass waits while the five-hour
 *  window is above `fiveHour` % or the week above `week` %. */
export interface UsageLimits {
  fiveHour: number;
  week: number;
}

export const DEFAULT_USAGE_LIMITS: UsageLimits = { fiveHour: 50, week: 80 };

/** A stored limit read back: a whole percent in 1–100, else the default. */
export function parseLimit(v: unknown, dflt: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return dflt;
  return Math.max(1, Math.min(100, Math.round(v)));
}

/** A reading older than this is not trusted to defer a pass — the
 *  backend's own `stale` line (`plan_usage.rs`, `STALE_AFTER`). */
export const USAGE_STALE_MS = 20 * 60_000;

export type UsageVerdict =
  /** `why` is set when the gate could not judge and let the pass run. */
  | { run: true; why: string | null }
  /** `why` is the line Settings shows: "usage 5h 63 % (limit 50 %)". */
  | { run: false; why: string };

/**
 * May an automatic pass start now? `onPlan` is whether the pass bills the
 * plan (the Claude Code engine); a pass on an API provider does not touch
 * the plan's windows, so the plan's figure is no reason to hold it.
 * Usage that cannot be read — no reading, `source: "none"`, no figures, or
 * a reading past `USAGE_STALE_MS` — lets the pass run, with the reason:
 * starving the dream for want of a number is the worse failure.
 */
export function usageGate(
  u: PlanUsage | null,
  limits: UsageLimits,
  onPlan: boolean,
  now: number,
): UsageVerdict {
  if (!onPlan) return { run: true, why: "the pass bills an API provider, not the plan" };
  if (!u || u.source === "none") return { run: true, why: "the plan's usage could not be read" };
  if (u.five_hour == null && u.seven_day == null) return { run: true, why: "the plan's usage has no figures" };
  const age = u.sampled_at_ms != null ? now - u.sampled_at_ms : null;
  if (u.stale || (age != null && age > USAGE_STALE_MS)) {
    const mins = age != null ? `${Math.round(age / 60_000)} min old` : "stale";
    return { run: true, why: `the plan's usage reading is ${mins}` };
  }
  const over: string[] = [];
  if (u.five_hour != null && u.five_hour > limits.fiveHour) over.push(`5h ${u.five_hour} % (limit ${limits.fiveHour} %)`);
  if (u.seven_day != null && u.seven_day > limits.week) over.push(`week ${u.seven_day} % (limit ${limits.week} %)`);
  if (over.length > 0) return { run: false, why: `usage ${over.join(", ")}` };
  return { run: true, why: null };
}

/**
 * When a deferred pass should look again without waiting for a trigger:
 * the reset of the window that holds it (the later reset when both do, as
 * both must be under), a minute after it so the new figure has landed.
 * Null when the reading names no reset; the next trigger is then the only
 * re-check.
 */
export function deferredRecheckAt(u: PlanUsage | null, limits: UsageLimits): number | null {
  if (!u) return null;
  const at = (iso: string | null) => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const times: (number | null)[] = [];
  if (u.five_hour != null && u.five_hour > limits.fiveHour) times.push(at(u.five_hour_resets_at));
  if (u.seven_day != null && u.seven_day > limits.week) times.push(at(u.seven_day_resets_at));
  if (times.length === 0 || times.some((t) => t === null)) return null;
  return Math.max(...(times as number[])) + 60_000;
}
