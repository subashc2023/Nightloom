import { describe, expect, it } from "vitest";
import dialSrc from "./ContextDial.svelte?raw";
import railSrc from "./RightRail.svelte?raw";
import {
  clockText,
  dialGeometry,
  freshIn,
  handoffText,
  lastLoggedTurn,
  modelShort,
  niceCeil,
  shortTokens,
  tickCounts,
  toolMarks,
  toolsText,
} from "./contextDial";

// Item 533 (Filament IV stage 2): the context dial's arithmetic and the
// right column's readings.

describe("dialGeometry", () => {
  const base = { size: 104, share: 0.212, mark: 0.3, inner: 0.84 };

  it("draws the mockup's column dial: 104 track, 14 pad, 132 box", () => {
    const g = dialGeometry(base);
    expect(g.box).toBe(132);
    expect(g.mid).toBe(66);
    expect(g.track.r).toBe(52);
  });

  it("keeps the arc amber below the notch", () => {
    const g = dialGeometry(base);
    expect(g.cool).toBeCloseTo(0.212 * g.track.c);
    expect(g.hot).toBe(0);
    expect(g.past).toBe(false);
  });

  it("turns the part past the notch hot, starting at the notch", () => {
    const g = dialGeometry({ ...base, share: 0.402 });
    expect(g.cool).toBeCloseTo(0.3 * g.track.c);
    expect(g.hot).toBeCloseTo(0.102 * g.track.c);
    expect(g.hotOffset).toBeCloseTo(-0.3 * g.track.c);
    expect(g.past).toBe(true);
  });

  it("never turns hot with no notch", () => {
    const g = dialGeometry({ ...base, share: 0.9, mark: null });
    expect(g.notch).toBeNull();
    expect(g.hot).toBe(0);
    expect(g.cool).toBeCloseTo(0.9 * g.track.c);
  });

  it("puts the notch at the mark's angle, clockwise from twelve", () => {
    const g = dialGeometry({ ...base, mark: 0.25 });
    // A quarter turn: three o'clock, a horizontal line right of centre.
    expect(g.notch!.y1).toBeCloseTo(g.mid);
    expect(g.notch!.y2).toBeCloseTo(g.mid);
    expect(g.notch!.x2).toBeGreaterThan(g.notch!.x1);
    expect(g.notch!.x1).toBeGreaterThan(g.mid);
  });

  it("turns the head with the share and clamps out-of-range shares", () => {
    expect(dialGeometry({ ...base, share: 0.5 }).headDeg).toBe(180);
    expect(dialGeometry({ ...base, share: 1.7 }).headDeg).toBe(360);
    expect(dialGeometry({ ...base, share: -1 }).headDeg).toBe(0);
    expect(dialGeometry({ ...base, share: Number.NaN }).cool).toBe(0);
  });

  it("draws the inner arc only when asked, empty when cold", () => {
    expect(dialGeometry({ ...base, inner: null }).inner).toBeNull();
    expect(dialGeometry({ ...base, inner: 0 }).inner).toBe(0);
    const g = dialGeometry(base);
    expect(g.inner).toBeCloseTo(0.84 * g.innerRing.c);
  });

  it("spaces the ticks evenly round the circle", () => {
    const g = dialGeometry({ ...base, minor: 50, major: 10 });
    const [mark, gap] = g.minorDash.split(" ").map(Number);
    expect((mark + gap) * 50).toBeCloseTo(g.minorRing.c);
    expect(dialGeometry({ ...base, minor: 0, major: 0 }).minorDash).toBe("");
  });
});

describe("tickCounts", () => {
  it("is 20k and 100k steps: 50 and 10 on a 1M window", () => {
    expect(tickCounts(1_000_000)).toEqual({ minor: 50, major: 10 });
    expect(tickCounts(200_000)).toEqual({ minor: 10, major: 2 });
  });
  it("draws no scale for an unknown window", () => {
    expect(tickCounts(null)).toEqual({ minor: 0, major: 0 });
  });
});

describe("the legend's words", () => {
  it("says how far the hand-off line is, or that it is passed", () => {
    expect(handoffText(212_000, 300_000)).toBe("88k away");
    expect(handoffText(402_000, 300_000)).toBe("past hand-off");
    expect(handoffText(null, 300_000)).toBe("300k");
    expect(handoffText(10, null)).toBeNull();
  });
  it("shortens token counts the way the mockup writes them", () => {
    expect(shortTokens(212_345)).toBe("212k");
    expect(shortTokens(1_000_000)).toBe("1M");
    expect(shortTokens(3_120)).toBe("3.1k");
    expect(shortTokens(418)).toBe("418");
  });
  it("names the model short", () => {
    expect(modelShort("claude-opus-5-5")).toBe("opus 5.5");
    expect(modelShort("claude-opus-5-5-20261101")).toBe("opus 5.5");
    expect(modelShort("default")).toBe("default");
    expect(modelShort(null)).toBe("");
  });
});

describe("this turn", () => {
  it("puts In and Out on one round scale", () => {
    expect(niceCeil(3_100)).toBe(5_000);
    expect(niceCeil(418)).toBe(500);
    expect(niceCeil(2_000)).toBe(2_000);
    expect(niceCeil(0)).toBe(1);
  });
  it("counts In as what the cache did not supply, and nothing without a split", () => {
    expect(freshIn({ input_tokens: 215_100, cache_read_tokens: 212_000 })).toBe(3_100);
    expect(freshIn({ input_tokens: 215_100 })).toBeNull();
    expect(freshIn(null)).toBeNull();
  });
  it("counts tool calls done and running from the live segments", () => {
    const marks = toolMarks([
      { kind: "text" },
      { kind: "tool", call: { result: { is_error: false } } },
      { kind: "tool", call: { result: { is_error: true } } },
      { kind: "tool", call: { result: null } },
    ]);
    expect(marks).toEqual([
      { done: true, error: false },
      { done: true, error: true },
      { done: false, error: false },
    ]);
    expect(toolsText(marks)).toBe("2 done · 1 running");
    expect(toolsText([])).toBeNull();
  });
  it("writes the clock as m:ss, h:mm:ss past an hour", () => {
    expect(clockText(41_000)).toBe("0:41");
    expect(clockText(3_729_000)).toBe("1:02:09");
    expect(clockText(-5)).toBe("0:00");
  });
  it("reads the last turn back from the log", () => {
    const t = lastLoggedTurn([
      { event: "user_message", at: "2026-11-09T21:00:00Z" },
      { event: "assistant_message", at: "2026-11-09T21:00:01Z", usage: { input_tokens: 5, output_tokens: 5 }, blocks: [] },
      { event: "user_message", at: "2026-11-09T21:41:00Z" },
      {
        event: "assistant_message",
        at: "2026-11-09T21:41:30Z",
        usage: { input_tokens: 9_000, output_tokens: 300, cache_read_tokens: 8_000 },
        blocks: [
          { type: "tool_use", id: "a" },
          { type: "tool_result", tool_use_id: "a" },
          { type: "tool_use", id: "b" },
        ],
      },
      { event: "tool_result", tool_use_id: "b", is_error: true },
      { event: "assistant_message", at: "2026-11-09T21:41:41Z", usage: { input_tokens: 0, output_tokens: 0 }, blocks: [] },
    ]);
    expect(t).not.toBeNull();
    expect(clockText(t!.endedAt! - t!.startedAt!)).toBe("0:41");
    expect(t!.tools).toEqual([
      { done: true, error: false },
      { done: true, error: true },
    ]);
    // An empty usage (a stopped reply) does not replace the last real one.
    expect(t!.usage?.output_tokens).toBe(300);
    expect(lastLoggedTurn([{ event: "session_created" }])).toBeNull();
  });
});

describe("the dial's motion rules (521 report §7)", () => {
  it("eases only under prefers-reduced-motion: no-preference, and never loops", () => {
    const style = dialSrc.slice(dialSrc.indexOf("<style>"));
    const media = style.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(media).toBeGreaterThan(0);
    expect(style.slice(0, media)).not.toMatch(/transition|animation/);
    expect(dialSrc).not.toMatch(/animation|@keyframes|infinite/);
    expect(railSrc).not.toMatch(/@keyframes|infinite/);
  });
  it("glows only through the lit token, so calm draws no filter", () => {
    const filters = dialSrc.match(/filter:[^;]+;/g) ?? [];
    expect(filters.length).toBeGreaterThan(0);
    for (const f of filters) expect(f).toContain("var(--glow-accent)");
    expect(dialSrc).not.toMatch(/backdrop-filter|<canvas/);
  });
});
