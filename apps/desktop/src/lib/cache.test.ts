import { describe, expect, it } from "vitest";
import { cacheClause, cacheLine, cacheState, nextTickMs, remainingText } from "./cache";
import type { CacheTtl, SessionEvent } from "./types";

// A log with known timestamps. `sent_at` is what the timer runs from; `at`
// is the reply's end and must not matter.
const T0 = Date.parse("2026-09-15T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function turn(sentAt: number | null, ttl: CacheTtl | null, endedAt = sentAt ?? T0): SessionEvent[] {
  return [
    { event: "user_message", text: "q", at: iso(endedAt - 1000) },
    {
      event: "assistant_message",
      model: "m",
      blocks: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
      ...(sentAt != null ? { sent_at: iso(sentAt) } : {}),
      ...(ttl ? { cache_ttl: ttl } : {}),
      at: iso(endedAt),
    },
  ];
}

describe("cacheState", () => {
  it("runs from the request's start for the recorded lifetime, not from the reply's end", () => {
    // Sent at T0, replied four minutes later: one minute left on a 5m entry.
    const events = turn(T0, "5m", T0 + 4 * 60_000);
    const s = cacheState(events, T0 + 4 * 60_000);
    expect(s).not.toBeNull();
    expect(s!.warmUntil).toBe(T0 + 5 * 60_000);
    expect(s!.remainingMs).toBe(60_000);
    expect(s!.warm).toBe(true);
    expect(s!.ttl).toBe("5m");

    const hour = cacheState(turn(T0, "1h"), T0 + 19 * 60_000);
    expect(hour!.remainingMs).toBe(41 * 60_000);
  });

  it("is cold at and after the lifetime, and null before any turn", () => {
    const events = turn(T0, "5m");
    expect(cacheState(events, T0 + 5 * 60_000)!.warm).toBe(false);
    expect(cacheState(events, T0 + 5 * 60_000)!.remainingMs).toBe(0);
    expect(cacheState(events, T0 + 60 * 60_000)!.warm).toBe(false);
    expect(cacheState([], T0)).toBeNull();
    expect(cacheState([{ event: "session_created", id: "s", at: iso(T0) }], T0)).toBeNull();
  });

  it("reads the newest live turn, past a rewound one", () => {
    const first = turn(T0, "1h");
    const second = turn(T0 + 10 * 60_000, "5m");
    const events: SessionEvent[] = [
      ...first,
      ...second,
      // Rewind the second turn: the next request will not share its prefix,
      // so the first turn's hour is what the next request can hit.
      { event: "rewind", to: 2, at: iso(T0 + 12 * 60_000) },
    ];
    const s = cacheState(events, T0 + 12 * 60_000);
    expect(s!.ttl).toBe("1h");
    expect(s!.sentAt).toBe(T0);
    // Without the rewind the second turn wins.
    const t = cacheState([...first, ...second], T0 + 12 * 60_000);
    expect(t!.ttl).toBe("5m");
    expect(t!.sentAt).toBe(T0 + 10 * 60_000);
  });

  it("shows nothing for a turn logged without the fields rather than inventing a clock", () => {
    // A log from before the fields: `at` alone is the wrong origin.
    expect(cacheState(turn(null, null), T0)).toBeNull();
    // A turn that touched no cache records a send time and no lifetime.
    expect(cacheState(turn(T0, null), T0)).toBeNull();
    // And the newest live turn is the verdict even when an older one had
    // the fields — its entry is behind a prefix the next request changes.
    expect(cacheState([...turn(T0, "1h"), ...turn(T0 + 60_000, null)], T0 + 60_000)).toBeNull();
  });
});

describe("remainingText and the lines", () => {
  it("floors to minutes, then to seconds under two minutes, then goes cold", () => {
    expect(remainingText(41 * 60_000 + 59_000)).toBe("41 min");
    expect(remainingText(60 * 60_000)).toBe("60 min");
    expect(remainingText(2 * 60_000 + 1)).toBe("2 min");
    expect(remainingText(2 * 60_000)).toBe("2:00");
    expect(remainingText(119_999)).toBe("1:59");
    expect(remainingText(61_000)).toBe("1:01");
    expect(remainingText(999)).toBe("0:00");
    expect(remainingText(0)).toBeNull();
    expect(remainingText(-5)).toBeNull();
  });

  it("formats the chip and the clause", () => {
    const warm = cacheState(turn(T0, "1h"), T0 + 19 * 60_000)!;
    const cold = cacheState(turn(T0, "5m"), T0 + 6 * 60_000)!;
    expect(cacheLine(warm)).toBe("cache · 41 min");
    expect(cacheLine(cold)).toBe("cache cold");
    expect(cacheClause(warm)).toBe("the cache is warm for 41 min");
    expect(cacheClause(cold)).toBe("the cache is cold");
    expect(cacheClause(null)).toBe("the cache is cold");
  });
});

describe("nextTickMs", () => {
  it("wakes just past the next minute, the two-minute mark, then each second, then never", () => {
    expect(nextTickMs(41 * 60_000 + 30_000)).toBe(30_001);
    // On the boundary the floored value has not changed yet; 1 ms later it has.
    expect(nextTickMs(3 * 60_000)).toBe(1);
    expect(nextTickMs(2 * 60_000 + 30_000)).toBe(30_001);
    expect(nextTickMs(2 * 60_000 + 1)).toBe(2);
    expect(nextTickMs(2 * 60_000)).toBe(1);
    expect(nextTickMs(1500)).toBe(501);
    expect(nextTickMs(1000)).toBe(1);
    expect(nextTickMs(0)).toBeNull();
  });

  it("walks a countdown to cold without skipping a displayed value", () => {
    let remaining = 3 * 60_000 + 500;
    const seen: string[] = [];
    for (;;) {
      const text = remainingText(remaining);
      if (text == null) break;
      if (seen[seen.length - 1] !== text) seen.push(text);
      const next = nextTickMs(remaining);
      expect(next).not.toBeNull();
      remaining -= next!;
    }
    expect(seen.slice(0, 3)).toEqual(["3 min", "2 min", "1:59"]);
    expect(seen[seen.length - 1]).toBe("0:00");
    // 3 min, 2 min, then 1:59 down to 0:00 is 120 values.
    expect(seen.length).toBe(2 + 120);
  });
});
