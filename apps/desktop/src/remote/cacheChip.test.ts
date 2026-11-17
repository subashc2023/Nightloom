// Wave O (2026-11-17): the phone's cache chip prices the next send as the
// Mac's does — same figures, same two-line tooltip — at the host's rates.
import { describe, expect, it } from "vitest";
import { newestReply, phoneCache } from "./cacheChip";
import { nextSendCost, nextTitle, ratesFromWire, chipNextLine, type CacheRatesWire } from "../lib/cachePrice";
import type { SessionEvent } from "../lib/types";

const opus: CacheRatesWire = { model: "claude-opus-5-5", read: 0.5, write_1h: 10, write_5m: 6.25, source: "rates", pings: 0 };
const usage = { input_tokens: 211_400, output_tokens: 620, cache_read_tokens: 208_000 };
const now = 1_800_000_000_000;

describe("the phone's cache chip", () => {
  it("warm: both prices on the face and the Mac's two lines in the tooltip", () => {
    const c = phoneCache({ usage }, now + 31 * 60_000, now, opus)!;
    expect(c.cold).toBe(false);
    expect(c.left).toBe("31 min");
    // 211.4k read at $0.50 + 620 written at $10 ≈ $0.11; cold: 212k written ≈ $2.12.
    expect(c.price).toBe("next ≈ $0.11 · cold ≈ $2.12");
    const r = ratesFromWire(opus)!;
    expect(c.price).toBe(chipNextLine(nextSendCost(usage, r), true));
    expect(c.tip).toBe(`98% from cache · warm for 31 min more\n${nextTitle(usage, r, true)}`);
    expect(c.tip.split("\n")).toHaveLength(2);
  });

  it("cold: one price, one line", () => {
    const c = phoneCache({ usage }, now - 1000, now, opus)!;
    expect(c.cold).toBe(true);
    expect(c.left).toBeNull();
    expect(c.price).toBe("next ≈ $2.12");
    expect(c.tip).toBe("Cache cold · next send ≈ $2.12 (API price)");
    expect(c.coldUsd).toBeCloseTo(2.12, 2);
  });

  it("no rates: no price, never a guess; no timer: no chip", () => {
    const warm = phoneCache({ usage }, now + 5 * 60_000, now, null)!;
    expect(warm.price).toBeNull();
    expect(warm.tip).toBe("98% from cache · warm for 5:00 more");
    expect(phoneCache({ usage }, now - 1, now, null)!.tip).toBe("Cache cold · the next send writes it again");
    expect(phoneCache({ usage }, null, now, opus)).toBeNull();
    expect(phoneCache(null, now + 60_000, now, opus)!.price).toBeNull();
  });

  it("prices the newest live reply, past a stopped one and a rewound one", () => {
    const ev = [
      { event: "assistant_message", model: "claude-opus-5-5", usage, blocks: [] },
      { event: "assistant_message", model: "claude-fable-5-2", usage: { input_tokens: 9, output_tokens: 1 }, blocks: [] },
      { event: "assistant_message", model: "claude-sonnet-5-5", usage: { input_tokens: 0, output_tokens: 0 }, blocks: [] },
    ] as unknown as SessionEvent[];
    expect(newestReply(ev, [true, true, true])!.model).toBe("claude-fable-5-2");
    expect(newestReply(ev, [true, false, true])!.model).toBe("claude-opus-5-5");
    expect(newestReply([], [])).toBeNull();
  });
});
