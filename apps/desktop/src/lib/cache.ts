import type { CacheTtl, SessionEvent } from "./types";
import { liveFlags } from "./state.svelte";

/**
 * The prompt-cache timer (nightshift backlog 063, 2026-09-15): when the
 * last turn's cache entry expires, projected from the log.
 *
 * Every turn records when its request was *sent* and how long the cache it
 * left lives (`sent_at`, `cache_ttl` on `assistant_message` — the backend
 * reads the lifetime off the reply's `cache_creation` split, or falls back
 * to what the engine writes with). The clock runs from the send, not the
 * reply: the API measures the lifetime from the start of the request that
 * wrote or last read the entry, and a turn that streamed for four minutes
 * leaves one on a five-minute entry. Every read refreshes the entry, so
 * the newest turn is the one that matters.
 *
 * Projected from the log rather than held in memory so that reopening a
 * chat — or relaunching the app — shows the same countdown the chat had.
 * Nothing here knows which engine ran the turn; the top bar pairs the
 * result with the connection's engine for its caveat, since that is the
 * engine the *next* request goes to.
 */
export interface CacheState {
  /** When the request that wrote or last read the entry was sent, ms epoch. */
  sentAt: number;
  ttl: CacheTtl;
  /** When the entry expires, ms epoch: `sentAt` plus the lifetime. */
  warmUntil: number;
  /** `warmUntil - now`; at or below zero the cache is cold. */
  remainingMs: number;
  warm: boolean;
}

const TTL_MS: Record<CacheTtl, number> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
};

/**
 * The newest *live* turn's cache, or null before the first turn that
 * recorded one — which includes every chat logged before the fields
 * existed, since a countdown invented from `at` would be the wrong clock.
 *
 * Live, after the rewind flags, on purpose: a rewound turn's entry is still
 * real on the server, but the next request will not share its prefix — the
 * conversation now ends earlier — so the entry that matters is the newest
 * one the next request can actually hit.
 */
export function cacheState(events: SessionEvent[], now: number): CacheState | null {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event !== "assistant_message") continue;
    if (!e.sent_at || !e.cache_ttl) return null;
    const sentAt = Date.parse(e.sent_at);
    if (!Number.isFinite(sentAt)) return null;
    const warmUntil = sentAt + TTL_MS[e.cache_ttl];
    const remainingMs = warmUntil - now;
    return { sentAt, ttl: e.cache_ttl, warmUntil, remainingMs, warm: remainingMs > 0 };
  }
  return null;
}

/** Below this much left the display counts seconds rather than minutes. */
const SECONDS_BELOW_MS = 2 * 60_000;

/**
 * What is left, as the chip shows it: whole minutes floored (`41 min` at
 * 41:59 — never a minute the cache does not have), `m:ss` at two minutes
 * and under, and null once it is gone. Floors throughout, so the number
 * shown is always one the cache can still honour.
 */
export function remainingText(remainingMs: number): string | null {
  if (remainingMs <= 0) return null;
  if (remainingMs > SECONDS_BELOW_MS) return `${Math.floor(remainingMs / 60_000)} min`;
  const s = Math.floor(remainingMs / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The top bar's line: `cache · 41 min`, `cache · 1:59`, `cache cold`. */
export function cacheLine(state: CacheState): string {
  const left = remainingText(state.remainingMs);
  return left ? `cache · ${left}` : "cache cold";
}

/**
 * The same fact as a clause for the edit controls (nightshift backlog 062):
 * "the cache is warm for 41 min" or "the cache is cold".
 */
export function cacheClause(state: CacheState | null): string {
  const left = state ? remainingText(state.remainingMs) : null;
  return left ? `the cache is warm for ${left}` : "the cache is cold";
}

/**
 * How long until `remainingText` would read differently: just past the
 * next whole minute while it counts minutes (or past the two-minute mark,
 * whichever comes first), just past the next whole second under that, and
 * null once it is cold. "Just past" because a floored value changes the
 * millisecond *after* the boundary, not on it. A timer aligned to these
 * wakes once a minute and then once a second, and never shows a value a
 * second stale.
 */
export function nextTickMs(remainingMs: number): number | null {
  if (remainingMs <= 0) return null;
  if (remainingMs <= SECONDS_BELOW_MS) return (remainingMs % 1000) + 1;
  return Math.min((remainingMs % 60_000) + 1, remainingMs - SECONDS_BELOW_MS + 1);
}
