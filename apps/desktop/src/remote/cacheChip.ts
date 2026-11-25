/**
 * The phone's cache chip (wave O, 2026-11-17; item 776's left-out: "the
 * phone page has no cache price"). The same figures as the Mac's composer
 * chip — the newest live reply's prompt read back while warm, all of it
 * written once cold, at the model's rates from the host's
 * `GET /api/cache-rates` (the Mac's own `cache_rates` read) — and the same
 * two-line tooltip, numbers first (memory tooltips-two-short-lines).
 * No rates: no price, never a guess.
 */
import { chipNextLine, nextSendCost, nextTitle, ratesFromWire, type CacheRatesWire } from "../lib/cachePrice";
import type { SessionEvent, Usage } from "../lib/types";
import { cacheLeft } from "./look";

/** The newest live reply with usage: what the chip prices. */
export function newestReply(
  events: readonly SessionEvent[],
  live: readonly boolean[],
): { usage: Usage; model: string } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (live[i] === false) continue;
    const e = events[i];
    if (e.event !== "assistant_message" || !e.usage) continue;
    if (e.usage.input_tokens <= 0 && e.usage.output_tokens <= 0) continue;
    return { usage: e.usage, model: e.model };
  }
  return null;
}

export interface PhoneCache {
  /** Past the cache's time: the face reads `cache cold`. */
  cold: boolean;
  /** The time left (`31 min`, `4:10`), or null when cold. */
  left: string | null;
  /** `next ≈ $0.37 · cold ≈ $4.32` (warm) or `next ≈ $4.32` (cold); null without rates. */
  price: string | null;
  /** The cold price alone, for the aside sheet's line; null without rates. */
  coldUsd: number | null;
  /** The chip's tooltip, at most two lines. */
  tip: string;
}

/**
 * The chip for the chat on screen, or null with no cache timer (no reply
 * yet, or a log from before cache timing). `warmUntil` is the page's own
 * reckoning (the log's reply and the desktop's word, item 786).
 */
export function phoneCache(
  reply: { usage: Usage } | null,
  warmUntil: number | null,
  now: number,
  rates: CacheRatesWire | null | undefined,
  /** Item 904: the phone box's draft (text and photos), in tokens. */
  draft = 0,
): PhoneCache | null {
  if (warmUntil === null) return null;
  const left = cacheLeft(warmUntil, now);
  const warm = left !== null;
  const r = ratesFromWire(rates);
  const cost = reply && r ? nextSendCost(reply.usage, r, draft) : null;
  const price = cost ? chipNextLine(cost, warm) : null;
  const est = reply && r ? nextTitle(reply.usage, r, warm, draft) : null;
  if (!warm) {
    return { cold: true, left: null, price, coldUsd: cost?.cold ?? null, tip: est ?? "Cache cold · the next send writes it again" };
  }
  const u = reply?.usage;
  const share = u && u.cache_read_tokens != null && u.input_tokens > 0 ? Math.round((u.cache_read_tokens / u.input_tokens) * 100) : null;
  const first = share != null ? `${share}% from cache · warm for ${left} more` : `Cache warm for ${left} more`;
  return { cold: false, left, price, coldUsd: cost?.cold ?? null, tip: est ? `${first}\n${est}` : first };
}
