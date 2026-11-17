/**
 * The plan's pace in words (nightshift item 769, 2026-11-16): "at this
 * pace, empty at <time>" and the time each window reaches 80% — his stop
 * line ("a usage line means stop at 80% of this window") — for the plan
 * chip's hover and the gauge card, the tighter window first.
 *
 * The forecast itself is the backend's (`pace.rs`): his own reading
 * history by hour of the week, not a straight line (his words: "the limit
 * pace is kinda useless when it's jus like a linear extrapolation"), and
 * each line says how far off it was on past windows, beside the straight
 * line's miss, so the figure carries its own error. Under the minimum of
 * past checks it says it is still learning rather than show a time.
 *
 * Pure over its inputs, so the suite pins the words.
 */
import type { PlanPace, PlanUsage, WindowPace } from "./types";
import { clockText, dayClockText } from "./schedule";

/** His stop line, percent (his rule, 2026-11-16). */
export const WARN_PCT = 80;

/** Past checks needed before a time is shown — `pace.rs`'s `MIN_CHECKS`. */
export const MIN_CHECKS: Record<WindowPace["window"], number> = { five_hour: 20, seven_day: 10 };

const NAME: Record<WindowPace["window"], string> = { five_hour: "5-hour", seven_day: "Week" };

/** `3:40 PM` today, `Thu 9:00 AM` on another day. */
export function paceWhen(ms: number, nowMs: number): string {
  return new Date(ms).toDateString() === new Date(nowMs).toDateString() ? clockText(ms) : dayClockText(ms);
}

function ahead(hours: number): string {
  if (hours === 1) return "an hour ahead";
  if (hours === 24) return "a day ahead";
  return `${hours} h ahead`;
}

/** One window's full line, with its measured miss — the gauge card's. */
export function paceDetail(w: WindowPace, nowMs: number): string {
  const name = NAME[w.window];
  if (!w.ready) {
    return `${name}: learning your pace — ${w.backtest.checks} of ${MIN_CHECKS[w.window]} past checks so far (${w.readings} readings logged)`;
  }
  const parts: string[] = [];
  if (w.at100_ms != null) parts.push(`at your pace, empty at ${paceWhen(w.at100_ms, nowMs)}`);
  else parts.push(`at your pace, near ${Math.round(w.end_pct)}% at the reset`);
  if (w.pct >= WARN_PCT) parts.push(`past ${WARN_PCT}%, your stop line`);
  else if (w.at80_ms != null) parts.push(`${WARN_PCT}% at ${paceWhen(w.at80_ms, nowMs)}`);
  const err = w.backtest.err_pts;
  const lin = w.backtest.linear_err_pts;
  const check =
    err == null
      ? ""
      : ` (off by ~${Math.round(err)} pts ${ahead(w.horizon_hours)} on ${w.backtest.checks} past checks` +
        (lin == null ? ")" : `; a straight line was off by ~${Math.round(lin)})`);
  return `${name}: ${parts.join(", ")}${check}`;
}

/** One window's hover line (item 776's rule: numbers first, no caveats):
 *  `5-hour: 80% at 2:10 PM · empty at 2:50 PM`. The measured miss lives on
 *  the gauge card (`paceDetail`). */
export function paceLine(w: WindowPace, nowMs: number): string {
  const name = NAME[w.window];
  if (!w.ready) return `${name}: learning your pace (${w.backtest.checks} of ${MIN_CHECKS[w.window]} checks)`;
  const parts: string[] = [];
  if (w.pct >= WARN_PCT) parts.push(`past ${WARN_PCT}%`);
  else if (w.at80_ms != null) parts.push(`${WARN_PCT}% at ${paceWhen(w.at80_ms, nowMs)}`);
  if (w.at100_ms != null) parts.push(`empty at ${paceWhen(w.at100_ms, nowMs)}`);
  else parts.push(`~${Math.round(w.end_pct)}% at reset`);
  return `${name}: ${parts.join(" · ")}`;
}

/** The windows, tighter first: the one that empties (then reaches 80%)
 *  sooner, else the fuller one. */
export function tighterFirst(p: PlanPace | null): WindowPace[] {
  const ws = [p?.five_hour, p?.seven_day].filter((w): w is WindowPace => w != null);
  const key = (w: WindowPace) => [
    w.ready ? (w.at100_ms ?? Infinity) : Infinity,
    w.ready ? (w.pct >= WARN_PCT ? -Infinity : (w.at80_ms ?? Infinity)) : Infinity,
    -w.pct,
  ];
  return ws.sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    return 0;
  });
}

/** Every window's line, tighter first, one per line; "" with no pace. */
export function paceText(p: PlanPace | null, nowMs: number): string {
  return tighterFirst(p)
    .map((w) => paceLine(w, nowMs))
    .join("\n");
}

/** The chip's 80% warning from the reading itself (fresher than the
 *  pace): which windows are at or past the line, fuller first; null
 *  under it. */
export function paceWarn(u: Pick<PlanUsage, "five_hour" | "seven_day"> | null): string | null {
  if (!u) return null;
  const hot = [
    { name: "5-hour", pct: u.five_hour },
    { name: "week", pct: u.seven_day },
  ]
    .filter((x): x is { name: string; pct: number } => x.pct != null && x.pct >= WARN_PCT)
    .sort((a, b) => b.pct - a.pct);
  if (hot.length === 0) return null;
  return `${hot.map((h) => `${h.name} ${h.pct}%`).join(", ")} · past your ${WARN_PCT}% line: wrap up`;
}

/** One window's line for the gauge card, without its name. */
export function paceCardLine(w: WindowPace | null | undefined, nowMs: number): string | null {
  if (!w) return null;
  return paceDetail(w, nowMs).replace(/^[^:]+: /, "");
}
