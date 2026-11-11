// Item 605: an aside tab's top bar and right column read the aside's own figures.
import { describe, expect, it } from "vitest";
import type { Aside, AsideTurn } from "./state.svelte";
import { asideFigures, asideSpendText } from "./asideFigures";
import { asideFromStored, storedAsideOf } from "./asides";
import { ASIDE_HIDDEN, ASIDE_KEPT, composerShows } from "./asideControls";

function turn(over: Partial<AsideTurn> = {}): AsideTurn {
  return { seq: 1, question: "q", partial: "a", answer: "a", error: null, cancelled: false, cacheRead: 0, ...over };
}
function aside(turns: AsideTurn[]): Aside {
  return { id: 1, quote: null, draft: false, turns, anchor: null };
}

describe("asideFigures (605)", () => {
  it("is empty for no aside or no turns", () => {
    expect(asideFigures(null)).toEqual({ used: null, cost: null, cacheHit: null, turn: null, model: null });
    expect(asideFigures(aside([])).used).toBeNull();
  });

  it("reads the context from the newest turn with usage, as the chat's gauge does", () => {
    const a = aside([
      turn({ usage: { input_tokens: 1000, output_tokens: 50, cache_read_tokens: 900 } }),
      turn({ seq: 2, usage: { input_tokens: 2000, output_tokens: 100, cache_read_tokens: 1500 }, model: "claude-opus-5-5" }),
    ]);
    const f = asideFigures(a);
    expect(f.used).toBe(2100);
    expect(f.cacheHit).toBe(0.75);
    expect(f.model).toBe("claude-opus-5-5");
  });

  it("keeps the last context while a follow-up is still asking", () => {
    const a = aside([
      turn({ usage: { input_tokens: 1000, output_tokens: 50 } }),
      turn({ seq: 2, answer: null, partial: "", startedAt: 1_000 }),
    ]);
    const f = asideFigures(a, 4_000);
    expect(f.used).toBe(1050);
    expect(f.turn).toEqual({ usage: null, ms: 3_000, live: true });
  });

  it("sums the cost and marks it a floor when an answer had none", () => {
    expect(asideFigures(aside([turn({ cost: 0.01 }), turn({ cost: 0.02 })])).cost).toEqual({ usd: 0.03, complete: true });
    const partial = asideFigures(aside([turn({ cost: 0.01 }), turn({})])).cost;
    expect(partial?.complete).toBe(false);
    expect(asideFigures(aside([turn({})])).cost).toBeNull();
  });

  it("times an ended turn from its question to its answer", () => {
    const f = asideFigures(aside([turn({ startedAt: 1_000, at: new Date(6_000).toISOString() })]), 99_000);
    expect(f.turn?.ms).toBe(5_000);
    expect(f.turn?.live).toBe(false);
  });

  it("writes the spend as the chat's bar does", () => {
    expect(asideSpendText(null)).toBeNull();
    expect(asideSpendText({ usd: 0, complete: true })).toBeNull();
    expect(asideSpendText({ usd: 0.0042, complete: true })).toBe("$0.0042");
    expect(asideSpendText({ usd: 1.5, complete: false })).toBe("$1.50");
  });
});

describe("an aside's figures survive the store (605)", () => {
  it("keeps each answer's tokens and cost, and the cache read from them", () => {
    const a = aside([turn({ usage: { input_tokens: 500, output_tokens: 20, cache_read_tokens: 400 }, cost: 0.004 })]);
    const back = asideFromStored(JSON.parse(JSON.stringify(storedAsideOf(a))));
    expect(back?.turns[0]?.usage).toEqual({ input_tokens: 500, output_tokens: 20, cache_read_tokens: 400 });
    expect(back?.turns[0]?.cost).toBe(0.004);
    expect(back?.turns[0]?.cacheRead).toBe(400);
  });

  it("reads an older store with no figures as before", () => {
    const back = asideFromStored({ quote: null, turns: [{ question: "q", answer: "a", error: null, cancelled: false }] });
    expect(back?.turns[0]?.usage).toBeUndefined();
    expect(back?.turns[0]?.cost).toBeUndefined();
    expect(back?.turns[0]?.cacheRead).toBe(0);
  });
});

describe("the transcript toggles reach an aside (605)", () => {
  it("lists them as kept, not hidden", () => {
    expect(ASIDE_KEPT).toContain("thinkingToggle");
    expect(ASIDE_KEPT).toContain("toolsToggle");
    expect("thinkingToggle" in ASIDE_HIDDEN).toBe(false);
    expect(composerShows("handoff", true)).toBe(false);
  });
});
