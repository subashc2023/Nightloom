import { describe, expect, it } from "vitest";
import { cacheState } from "./cache";
import { clockTime, idleWords, isKeeping, isOn, noticeLine, switchLabel, switchTitle, touchedUntil, type KeepWarmStatus } from "./keepWarm";
import type { SessionEvent } from "./types";

const HOUR = 3_600_000;
const MIN = 60_000;
// 5:00 PM local on a fixed day, so the clock words are his.
const T0 = new Date(2026, 10, 10, 17, 0, 0).getTime();

function status(over: Partial<KeepWarmStatus> = {}): KeepWarmStatus {
  return {
    chat: "c1",
    mode: "on",
    scheduled: true,
    warm_until_ms: T0 + 390 * MIN,
    touched_ms: null,
    next_ping_ms: T0 + 55 * MIN,
    why: null,
    spent: { pings: 0, cache_read: 0, cache_write: 0, output: 0, cost_usd: 0 },
    policy: { every_ms: 55 * MIN, cap_ms: 6 * HOUR, min_context: 50_000 },
    ...over,
  };
}

describe("keep-warm words (backlog 582)", () => {
  it("reads the clock in 12-hour time", () => {
    expect(clockTime(T0 + 390 * MIN)).toBe("11:30 PM");
  });

  it("labels the switch off, running, and on-but-idle", () => {
    expect(switchLabel(null, T0)).toBe("keep warm");
    expect(switchLabel(status({ mode: "off", scheduled: false, why: "off" }), T0)).toBe("keep warm");
    expect(switchLabel(status(), T0)).toBe("warm until 11:30 PM");
    expect(switchLabel(status({ mode: "once" }), T0)).toBe("warm until 11:30 PM");
    const idle = (why: KeepWarmStatus["why"]) => switchLabel(status({ scheduled: false, why, next_ping_ms: null }), T0);
    expect(idle("small")).toBe("keep warm · starts at 50k tokens");
    expect(idle("noreply")).toBe("keep warm · starts after the next reply");
    expect(idle("cap")).toBe("keep warm · ended — 6 h since the last reply");
    expect(idle("cold")).toContain("went cold");
    expect(idle("missed")).toContain("missed the cache");
    expect(idle("busy")).toBe("keep warm on");
  });

  it("says nothing under his message unless the cache is being kept", () => {
    expect(noticeLine(status(), T0)).toBe("Keeping warm until ~11:30 PM");
    expect(noticeLine(null, T0)).toBeNull();
    expect(noticeLine(status({ mode: "off" }), T0)).toBeNull();
    expect(noticeLine(status({ scheduled: false, why: "cap" }), T0)).toBeNull();
    // Past the schedule's end the line is gone.
    expect(noticeLine(status(), T0 + 391 * MIN)).toBeNull();
    expect(isKeeping(status(), T0)).toBe(true);
    expect(isOn(status({ scheduled: false, why: "small" }))).toBe(true);
  });

  it("tells the whole rule and what was spent in the tooltip", () => {
    const off = switchTitle(null, T0);
    expect(off).toContain("every 55 min");
    expect(off).toContain("up to 6 h");
    expect(off).toContain("50k tokens or more");
    expect(off).toContain("Off — click to switch on");
    const on = switchTitle(status({ spent: { pings: 2, cache_read: 240_000, cache_write: 600, output: 8, cost_usd: 0.05 } }), T0);
    expect(on).toContain("warm until about 11:30 PM, next request 5:55 PM");
    expect(on).toContain("2 pings, 240k tokens read from the cache, 600 written, about $0.05");
    // A retuned cap shows as set, not as shipped.
    expect(switchTitle(status({ policy: { every_ms: 55 * MIN, cap_ms: 4 * HOUR, min_context: 50_000 } }), T0)).toContain("up to 4 h");
    expect(idleWords(status({ why: "cap", policy: { every_ms: 55 * MIN, cap_ms: 4 * HOUR, min_context: 50_000 } }))).toContain("4 h");
  });

  it("says whether the switch is the default's or his (item 608)", () => {
    const byDefault = switchTitle(status({ chosen: false, default_on: true }), T0);
    expect(byDefault).toContain("on by default for every chat — Settings → Subscription → Keeping caches warm");
    expect(byDefault).toContain("Click to switch off for this chat.");
    expect(switchTitle(status({ chosen: true, default_on: true }), T0)).toContain("switched on for this chat");
    const hisOff = switchTitle(status({ mode: "off", scheduled: false, why: "off", chosen: true, default_on: true }), T0);
    expect(hisOff).toContain("Off for this chat — you switched it off");
    expect(hisOff).toContain("click to switch on for this chat");
    const defaultOff = switchTitle(status({ mode: "off", scheduled: false, why: "off", chosen: false, default_on: false }), T0);
    expect(defaultOff).toContain("Off — the default is off");
    // A new chat on by default reads on before its first reply.
    const fresh = status({ scheduled: false, why: "noreply", next_ping_ms: null, warm_until_ms: null, chosen: false, default_on: true });
    expect(isOn(fresh)).toBe(true);
    expect(switchLabel(fresh, T0)).toBe("keep warm · starts after the next reply");
  });

  it("moves the cache timer to the last ping's hour", () => {
    const events = [
      { event: "user_message", text: "q", at: new Date(T0).toISOString() },
      {
        event: "assistant_message",
        model: "m",
        blocks: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 100_000, output_tokens: 10 },
        at: new Date(T0 + MIN).toISOString(),
        sent_at: new Date(T0).toISOString(),
        cache_ttl: "1h",
      },
    ] as unknown as SessionEvent[];
    // Without a ping: cold at 70 minutes.
    expect(cacheState(events, T0 + 70 * MIN)?.warm).toBe(false);
    // A ping at 55 minutes: warm until 115.
    const kept = touchedUntil(status({ touched_ms: T0 + 55 * MIN }));
    expect(kept).toBe(T0 + 115 * MIN);
    const c = cacheState(events, T0 + 70 * MIN, kept);
    expect(c?.warm).toBe(true);
    expect(c?.warmUntil).toBe(T0 + 115 * MIN);
    // An older touch never shortens the reply's own hour; off ignores it.
    expect(cacheState(events, T0, T0 - MIN)?.warmUntil).toBe(T0 + HOUR);
    expect(touchedUntil(status({ mode: "off", touched_ms: T0 }))).toBeNull();
  });
});
