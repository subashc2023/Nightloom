// Short tooltips (his rule, memory tooltips-two-short-lines; items 697, 776):
// every cache/cost/plan hover is at most two lines, numbers first, no rates,
// sources or caveats. Each line is held to TIP_MAX characters so it draws as
// one line in the 320 px tip pill (776 measured 44 characters in 279 px).
// Post-install 16c8e01 (2026-11-17): the plan reading and the gauge chip drew
// 7 and 10+ lines; the long item-595 plan sentence (source, age, account-wide,
// stale) already lives on the gauge card's foot, which a click on the chip opens.
import { clockText } from "./schedule";
import { paceWhen } from "./pace";
import type { CacheChange } from "./cache";
import { tokensShort } from "./cacheCost";
import type { PlanPace, PlanUsage, WindowPace } from "./types";

export const TIP_MAX = 44;
const WARN = 80;

/** The first part always, then each next part while the line stays ≤ max. */
export function fit(parts: (string | null | undefined | false)[], max = TIP_MAX): string {
  const ps = parts.filter((p): p is string => !!p);
  let out = ps[0] ?? "";
  for (const p of ps.slice(1)) {
    const next = `${out} · ${p}`;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

/** One window's line: `5-hour 62% · 80% 12:37 AM · empty 1:37 AM`,
 *  `Week 84%: wrap up · empty Wed 5:46 AM`. The 5-hour window's times are
 *  always within five hours, so they carry no day. */
export function windowTip(name: string, pct: number | null, w: WindowPace | null | undefined, nowMs: number, resetMs?: number | null): string {
  if (pct == null) return `${name} ?`;
  const hot = pct >= WARN;
  const head = `${name} ${pct}%${hot ? ": wrap up" : ""}`;
  const when = (ms: number) => (w?.window === "five_hour" ? clockText(ms) : paceWhen(ms, nowMs));
  if (!w) return fit([head, resetMs != null ? `resets ${when(resetMs)}` : null]);
  if (!w.ready) return fit([head, `learning pace (${w.backtest.checks} checks)`]);
  return fit([
    head,
    !hot && w.at80_ms != null ? `${WARN}% ${when(w.at80_ms)}` : null,
    w.at100_ms != null ? `empty ${when(w.at100_ms)}` : `~${Math.round(w.end_pct)}% at reset`,
  ]);
}

/** The plan reading's hover (Jarvis top bar): one line per window. */
export function planReadingTip(plan: Pick<PlanUsage, "five_hour" | "seven_day">, pace: PlanPace | null, nowMs: number): string {
  const lines = [windowTip("5-hour", plan.five_hour, pace?.five_hour, nowMs)];
  if (plan.seven_day != null) lines.push(windowTip("Week", plan.seven_day, pace?.seven_day, nowMs));
  return lines.join("\n");
}

/** The gauge chip's hover (both themes): the context and spend, then the
 *  plan's two figures. Pace, sources and subagents are on the gauge card. */
export function gaugeChipTip(o: {
  context: string | null;
  spend?: string | null;
  plan?: Pick<PlanUsage, "five_hour" | "seven_day"> | null;
}): string {
  const l1 = fit([o.context ?? "Context: nothing sent yet", o.spend ? `spent ${o.spend}` : null]);
  const p = o.plan;
  const hot = !!p && ((p.five_hour ?? 0) >= WARN || (p.seven_day ?? 0) >= WARN);
  const l2 = p
    ? fit([`5-hour ${p.five_hour ?? "?"}%`, p.seven_day != null ? `week ${p.seven_day}%` : null, hot ? "wrap up" : null, "click for figures"])
    : "Click for the figures · ⌘⇧C itemises them";
  return `${l1}\n${l2}`;
}

/** The "cache will be lost" bar's hover (items 408, 776, 777): the price
 *  first, then what a click on the bar actually does — never an undo it
 *  cannot do (a layer change is put back on the Context page; a Chat
 *  switched to Claude Code keeps its tools declared). */
export function lossTipText(o: {
  changes: CacheChange[];
  layer: boolean;
  cachedTokens: number;
  /** 777's priced line, e.g. `next ≈ $2.70 (vs $0.37 warm)`. */
  priceLine?: string | null;
  /** 776's cold price, when 777 has no priced line. */
  resendUsd?: number | null;
}): string {
  let l1: string;
  if (o.priceLine) l1 = o.priceLine.charAt(0).toUpperCase() + o.priceLine.slice(1);
  else {
    const whole = o.layer || o.changes.some((c) => c.whole);
    const price = o.resendUsd != null ? ` (≈ $${o.resendUsd.toFixed(2)})` : "";
    l1 = `Next send re-sends ${whole ? "" : "up to "}${tokensShort(o.cachedTokens)}${price}`;
  }
  return `${l1}\n${lossClick(o.changes, o.layer)}`;
}

export function lossClick(changes: CacheChange[], layer: boolean): string {
  const fixed = changes.filter((c) => c.restorable === false);
  const back = changes.length - fixed.length;
  if (back === 0) {
    if (changes.length === 0) return "The Context page puts them back";
    return layer ? "Nothing to click; layers: the Context page" : `Nothing to click: ${fixed[0].text} stays`;
  }
  if (layer) return fixed.length ? "Click undoes some settings, not the layers" : "Click undoes the settings, not the layers";
  if (fixed.length) return fit([`Click undoes all but ${fixed[0].text}`]);
  return `Click to put ${back === 1 ? "it" : "them"} back`;
}
