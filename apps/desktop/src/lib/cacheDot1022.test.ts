/*
 * Item 1022 (his "i dont even notice when the cache is being saved or not saved"): a dot before each chat's name —
 * kept warm, warm, or cold — on every sidebar row, tab, aside row and the 913 list; two-line tooltips, numbers first.
 * Logic only (item 980: no test reads component source); where it is drawn was shot on harness/dot1022.html.
 */
import { describe, expect, it } from "vitest";
import { cacheFrom, type CacheState } from "./cache";
import { cacheDot, leftText, tokensText } from "./cacheDot";
import type { KeepWarmStatus } from "./keepWarm";

const H = 3_600_000;
const M = 60_000;
const now = new Date(2026, 10, 27, 15, 0).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

function kw(o: Partial<KeepWarmStatus> = {}): KeepWarmStatus {
  return {
    chat: "a",
    mode: "on",
    scheduled: true,
    warm_until_ms: now + 3 * H + 10 * M,
    touched_ms: now - 10 * M,
    next_ping_ms: new Date(2026, 10, 27, 15, 45).getTime(),
    why: null,
    spent: { pings: 4, cache_read: 1, cache_write: 0, output: 1, cost_usd: 0.31 },
    policy: { every_ms: 55 * M, cap_ms: 6 * H, min_context: 50000 },
    ...o,
  };
}
const warm = (left: number, ttl: "1h" | "5m" = "1h"): CacheState => cacheFrom(iso(now + left - (ttl === "1h" ? H : 5 * M)), ttl, 1000, now)!;

describe("the cache dot's face and words (item 1022)", () => {
  it("is kept while pings run: solid, time to the schedule's end and the next ping first", () => {
    const d = cacheDot(warm(20 * M), kw(), now, 184_000)!;
    expect(d.face).toBe("kept");
    expect(d.share).toBe(1);
    expect(d.tip).toBe("Kept warm · 3 h 10 min left\nNext ping 3:45 PM · 4 pings ≈ $0.31");
  });

  it("is warm with the share left when nothing keeps it, and says the lifetime", () => {
    const d = cacheDot(warm(21 * M), null, now, 184_000)!;
    expect(d.face).toBe("warm");
    expect(d.share).toBeCloseTo(21 / 60, 3);
    expect(d.tip).toBe("Warm · 21 min left\nNot kept warm · 1 h cache");
    expect(cacheDot(warm(3 * M, "5m"), null, now)!.tip).toBe("Warm · 3 min left\nNot kept warm · 5 min cache");
  });

  it("stays warm through the last hour after the pings ended for his sleep, and says why", () => {
    const end = kw({ scheduled: false, why: "sleep", warm_until_ms: now + 40 * M });
    const d = cacheDot(null, end, now)!;
    expect(d.face).toBe("warm");
    expect(d.tip.split("\n")[0]).toBe("Warm · 40 min left");
    expect(d.tip.split("\n")[1]).toMatch(/^No pings in your sleep/);
  });

  it("is cold once the entry ran out: since when, and what the next send writes", () => {
    const cold = cacheFrom(iso(new Date(2026, 10, 27, 12, 12).getTime()), "1h", 1000, now)!;
    expect(cacheDot(cold, null, now, 184_000)).toEqual({ face: "cold", share: 0, tip: "Cold since 1:12 PM\nNext send writes ~184k tokens" });
    const days = cacheFrom(iso(new Date(2026, 10, 24, 9, 0).getTime()), "1h", 1000, now)!;
    expect(cacheDot(days, null, now)!.tip).toBe("Cold since Nov 24\nNext send writes the cache again");
  });

  it("draws nothing before a chat has a cache, and a stopped switch does not read as kept", () => {
    expect(cacheDot(null, null, now)).toBeNull();
    expect(cacheDot(null, kw({ mode: "off" }), now)).toBeNull();
  });

  it("names an aside's own model and ignores the chat's keep-warm for it", () => {
    const d = cacheDot(warm(30 * M), kw(), now, null, "Sonnet 4.6")!;
    expect(d.face).toBe("warm");
    expect(d.tip).toBe("Warm · 30 min left\nIts own cache · Sonnet 4.6");
  });

  it("formats its numbers short", () => {
    expect(leftText(3 * H + 10 * M)).toBe("3 h 10 min");
    expect(leftText(2 * H)).toBe("2 h");
    expect(leftText(41 * M + 59_000)).toBe("41 min");
    expect(tokensText(184_400)).toBe("184k");
    expect(tokensText(1_250_000)).toBe("1.3M");
    expect(tokensText(900)).toBe("900");
  });
});

describe("cacheFrom times a listing as cacheState times a log (item 1022)", () => {
  it("runs from the send, a later ping's hour and a later aside read", () => {
    const sent = now - 50 * M;
    expect(cacheFrom(iso(sent), "1h", 1000, now)!.remainingMs).toBe(10 * M);
    expect(cacheFrom(iso(sent), "1h", 1000, now, now + 30 * M)!.warmUntil).toBe(now + 30 * M);
    expect(cacheFrom(iso(sent), "1h", 1000, now, null, [{ at: now - 5 * M, read: 800 }])!.warmUntil).toBe(now + 55 * M);
    expect(cacheFrom("not a time", "1h", 1000, now)).toBeNull();
  });
});
