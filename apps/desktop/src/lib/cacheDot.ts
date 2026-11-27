import { remainingText, type CacheState } from "./cache";
import { clockTime, endingWords, isKeeping, isWarmEnding, type KeepWarmStatus } from "./keepWarm";

/**
 * Item 1022 (his "i dont even notice when the cache is being saved or not
 * saved. some visual cue maybe would be nice?"): a dot before each chat's
 * name — every sidebar row in every project, every chat and aside tab, the
 * asides' rows, and Settings' "Chats kept warm now" (913) — that says at a
 * glance whether the chat's prompt cache is kept warm, warm, or cold.
 * Option A of the mock round (nightshift-code
 * `notes/runner-design/1022-771-1026-mocks/1022-cache-cue.html`), left to
 * the agent's judgement by him ("u can use ur instinct or best guess").
 *
 * - `kept`: keep-warm pings are scheduled (`isKeeping`) — solid amber.
 * - `warm`: the entry lives, no pings — an amber ring drained by the share
 *   of its lifetime spent (`share`, 1 just sent, 0 cold).
 * - `cold`: the entry ran out — a hollow blue ring.
 * - null: no cache to time (no reply that touched one) — nothing drawn.
 *
 * The tooltip is two short lines, numbers first. Pure, for the suite; the
 * component (`CacheDot.svelte`) reads the state and the clock.
 */
export type DotFace = "kept" | "warm" | "cold";

export interface CacheDot {
  face: DotFace;
  /** The share of the entry's lifetime left, 0–1 (1 while kept). */
  share: number;
  tip: string;
}

const TTL_MS = { "5m": 5 * 60_000, "1h": 60 * 60_000 } as const;

/** 190 min → "3 h 10 min"; under an hour as the chip says it. */
export function leftText(ms: number): string {
  if (ms >= 60 * 60_000) {
    const min = Math.floor(ms / 60_000);
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  return remainingText(ms) ?? "0 min";
}

/** 184_000 → "184k"; 1_250_000 → "1.3M"; under a thousand as is. */
export function tokensText(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The dot for a chat: `cache` is its timer (`cacheState` for the open
 * chat, `cacheFrom` off the listing for the rest), `kw` its keep-warm
 * status when the backend has one, `context` the newest reply's fill (what
 * a cold send writes back). `own`: the cache is an aside's own model's
 * (item 786), named on the second line instead of the keep-warm words.
 */
export function cacheDot(
  cache: CacheState | null,
  kw: KeepWarmStatus | null | undefined,
  now: number,
  context?: number | null,
  own?: string | null,
): CacheDot | null {
  if (!own && kw && isKeeping(kw, now)) {
    const until = kw.warm_until_ms as number;
    const next = kw.next_ping_ms != null && kw.next_ping_ms > now ? `Next ping ${clockTime(kw.next_ping_ms)}` : "Pings running";
    const p = kw.spent;
    const spent = p.pings > 0 ? ` · ${p.pings} ping${p.pings === 1 ? "" : "s"}${p.cost_usd > 0 ? ` ≈ $${p.cost_usd.toFixed(2)}` : ""}` : "";
    return { face: "kept", share: 1, tip: `Kept warm · ${leftText(until - now)} left\n${next}${spent}` };
  }
  const ending = !own && kw && isWarmEnding(kw, now) ? kw : null;
  const until = Math.max(cache?.warm ? cache.warmUntil : 0, ending ? (ending.warm_until_ms as number) : 0);
  if (until > now) {
    const ttlMs = TTL_MS[cache?.ttl ?? "1h"];
    const share = Math.max(0, Math.min(1, (until - now) / ttlMs));
    const second = own
      ? `Its own cache · ${own}`
      : ending
        ? cap(endingWords(ending))
        : `Not kept warm · ${cache?.ttl === "5m" ? "5 min" : "1 h"} cache`;
    return { face: "warm", share, tip: `Warm · ${leftText(until - now)} left\n${second}` };
  }
  if (!cache) return null;
  // Earlier than today: the day, not a clock time that reads as today's.
  const since = new Date(cache.warmUntil).toDateString() === new Date(now).toDateString() ? clockTime(cache.warmUntil) : new Date(cache.warmUntil).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const second = context && context > 0 ? `Next send writes ~${tokensText(context)} tokens` : "Next send writes the cache again";
  return { face: "cold", share: 0, tip: `Cold since ${since}\n${second}` };
}
