/**
 * An aside's own figures (item 605, 2026-11-11 — his "shouldn't asides
 * still have cost, context, all of the stuff in the side bar?"): what the
 * top bar's gauge and the right column read for a chat, read instead from
 * an aside thread's turns, so `TopBar` and `RightRail` draw an aside tab
 * as they draw the chat. Pure; the suite pins it.
 *
 * - **Context** is the newest answered request's input plus output — the
 *   chat's prefix the aside forked from, the thread so far, and its answer:
 *   what the next follow-up carries (the chat's gauge's rule, `contextUsed`).
 * - **Cost** sums the CLI's estimate for each answer (`cost_usd`, an API-
 *   price estimate, not a bill under a subscription); `complete` is false
 *   when some answered turn carried none, so the sum is a floor.
 * - **Cache hit** is the newest answer's input read back from the cache.
 * - **This turn** is the newest exchange: its fresh input, output, clock.
 */
import type { Aside, AsideTurn } from "./state.svelte";

export interface AsideFigures {
  /** Tokens the next follow-up carries as its prefix; null before any answer. */
  used: number | null;
  /** The thread's summed cost estimate; null when no answer carried one. */
  cost: { usd: number; complete: boolean } | null;
  /** The newest answer's share of input read from cache; null if unknown. */
  cacheHit: number | null;
  /** The newest exchange, live or ended; null before the first question. */
  turn: {
    usage: { input_tokens: number; output_tokens: number; cache_read_tokens?: number } | null;
    /** Milliseconds from the question to the answer's end (or now, while asking). */
    ms: number | null;
    live: boolean;
  } | null;
  /** The model that answered last, if the backend named it. */
  model: string | null;
}

function answered(t: AsideTurn): boolean {
  return t.answer !== null || t.cancelled || t.error !== null;
}

export function asideFigures(a: Aside | null, now: number = Date.now()): AsideFigures {
  const out: AsideFigures = { used: null, cost: null, cacheHit: null, turn: null, model: null };
  if (!a || a.turns.length === 0) return out;
  // The newest turn with usage stands for the context (a turn still asking has none yet).
  for (let i = a.turns.length - 1; i >= 0; i--) {
    const u = a.turns[i]!.usage;
    if (u) {
      out.used = u.input_tokens + u.output_tokens;
      out.cacheHit = u.cache_read_tokens != null && u.input_tokens > 0 ? Math.min(1, u.cache_read_tokens / u.input_tokens) : null;
      break;
    }
  }
  let usd = 0;
  let any = false;
  let complete = true;
  for (const t of a.turns) {
    if (!answered(t)) continue;
    if (typeof t.cost === "number") {
      usd += t.cost;
      any = true;
    } else complete = false;
  }
  if (any) out.cost = { usd, complete };
  const last = a.turns[a.turns.length - 1]!;
  const live = !answered(last);
  const end = last.at ? Date.parse(last.at) : NaN;
  const ms = last.startedAt != null ? (live ? now - last.startedAt : Number.isFinite(end) ? Math.max(0, end - last.startedAt) : null) : null;
  out.turn = { usage: last.usage ?? null, ms, live };
  for (let i = a.turns.length - 1; i >= 0; i--) {
    const m = a.turns[i]!.model;
    if (m) {
      out.model = m;
      break;
    }
  }
  return out;
}

/** The spend as the bar writes it: four decimals under a cent, else two. */
export function asideSpendText(c: AsideFigures["cost"]): string | null {
  if (!c) return null;
  if (c.usd === 0 && c.complete) return null;
  const digits = c.usd > 0 && c.usd < 0.01 ? 4 : 2;
  return `$${c.usd.toFixed(digits)}`;
}
