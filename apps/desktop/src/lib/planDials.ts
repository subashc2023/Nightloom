/**
 * Item 824 (his "bunch of yap on this page, unnecessary.. needs simpler and
 * more intuitive and with the theme design"; blocker 2123, B Dials picked;
 * blocker 2136, the whole popover): the Context and Plan card as three
 * dials — context, the 5-hour window, the week — with the projected
 * percent at the reset as a ghost arc, his stop line as a tick, the spend
 * and Itemise. No sentence longer than a label.
 *
 * Pure over its inputs, so the suite pins the figures; `PlanDials.svelte`
 * draws them on the Mac (main chat, Classic, asides) and the phone.
 */
import type { PlanUsage, WindowPace } from "./types";
import { resetText } from "./resetTime";

/** One plan window's dial. */
export interface DialWindow {
  /** Used now, percent (0..100). */
  pct: number;
  /** Projected at the reset, percent — only when above `pct`. */
  proj: number | null;
  /** `4:29 AM` today, `Wed 1:59 AM` on another day, `—` unknown. */
  reset: string;
}

/** The context dial. */
export interface DialContext {
  used: number;
  /** The window's size; null when the model's window is unknown. */
  limit: number | null;
  /** An estimate (an aside that kept no counts, a reply still streaming). */
  estimated: boolean;
  /** Subagents' tokens, not in the window; 0 for none. */
  agents: number;
}

/** Everything the card shows. */
export interface DialFigures {
  head: string;
  /** `34m old` when the plan reading is stale; null fresh. */
  stale: string | null;
  /** Null: nothing sent yet. */
  ctx: DialContext | null;
  /** Null: no plan reading (the API engine, or none read yet). */
  five: DialWindow | null;
  week: DialWindow | null;
  /** His stop line, percent; null when switched off or unknown. */
  stop: number | null;
  /** `$14.37`; null when nothing is known. */
  spend: { text: string; complete: boolean } | null;
}

/** `172k`, `1M`, `1.25M`, `840`. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${parseFloat((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

const clamp = (x: number) => Math.max(0, Math.min(100, x));

/** His stop line from his setting (the subagent limits' `stop_at`, item
 *  253's switch): null when off or not a percent. Never hard-coded. */
export function stopLine(l: { stop_at: number; off?: { stop_at?: boolean } } | null | undefined): number | null {
  if (!l || l.off?.stop_at) return null;
  const s = Number(l.stop_at);
  return Number.isFinite(s) && s > 0 && s <= 100 ? s : null;
}

/** The projected percent at the reset: the pace's `end_pct` once it has
 *  enough past checks, rounded, capped at 100, and only above `pct`. */
export function projected(w: WindowPace | null | undefined, pct: number): number | null {
  if (!w || !w.ready || !Number.isFinite(w.end_pct)) return null;
  const q = Math.round(Math.min(100, w.end_pct));
  return q > pct ? q : null;
}

/** The reset as the dial's last line: `4:29 AM`, `Wed 1:59 AM`, `—`. */
export function resetShort(iso: string | null, nowMs: number): string {
  const t = resetText(iso, nowMs);
  return t.startsWith("resets ") ? t.slice("resets ".length) : "—";
}

/** One plan window's dial from the reading and its pace; null without a reading. */
export function dialWindow(pct: number | null | undefined, iso: string | null, pace: WindowPace | null | undefined, nowMs: number): DialWindow | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  const p = Math.round(pct);
  return { pct: p, proj: projected(pace, p), reset: resetShort(iso, nowMs) };
}

/** The head's age tag: `34m old`, `2h old` while the reading is stale. */
export function staleTag(
  plan: { stale?: PlanUsage["stale"]; sampled_at_ms?: number | null; age_seconds?: number | null } | null,
  nowMs: number,
): string | null {
  if (!plan?.stale) return null;
  const s = plan.sampled_at_ms != null ? Math.max(0, (nowMs - plan.sampled_at_ms) / 1000) : (plan.age_seconds ?? null);
  if (s == null) return "old";
  return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m old` : `${Math.round(s / 3600)}h old`;
}

/** The ring's geometry, viewBox 0 0 74 74, radius 30. */
export const RING = { size: 74, c: 37, r: 30, stroke: 5 } as const;
const CIRC = 2 * Math.PI * RING.r;

/** The arcs of one ring: the used part, the projected ghost after it
 *  (null when none), as SVG dash arrays. */
export function ringArcs(pct: number, proj: number | null): { now: string | null; ghost: string | null } {
  const p = clamp(pct) / 100;
  const q = proj == null ? p : clamp(proj) / 100;
  return {
    now: p > 0 ? `${(p * CIRC).toFixed(2)} ${CIRC.toFixed(2)}` : null,
    ghost: q > p ? `0 ${(p * CIRC).toFixed(2)} ${((q - p) * CIRC).toFixed(2)} ${CIRC.toFixed(2)}` : null,
  };
}

/** The stop tick across the ring at `stop` percent, clockwise from the top. */
export function tickAt(stop: number): { x1: number; y1: number; x2: number; y2: number } {
  const a = (clamp(stop) / 100) * 2 * Math.PI - Math.PI / 2;
  const { c, r } = RING;
  const f = (n: number) => Math.round(n * 100) / 100;
  return {
    x1: f(c + (r - 6) * Math.cos(a)),
    y1: f(c + (r - 6) * Math.sin(a)),
    x2: f(c + (r + 6) * Math.cos(a)),
    y2: f(c + (r + 6) * Math.sin(a)),
  };
}

/** Past (or at) the stop line. */
export function pastStop(pct: number, stop: number | null): boolean {
  return stop != null && pct >= stop;
}

/** The context dial's percent; null when the window is unknown. */
export function contextPct(c: DialContext): number | null {
  return c.limit ? Math.round(Math.min(c.used / c.limit, 1) * 100) : null;
}
