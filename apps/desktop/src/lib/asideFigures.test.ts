// Item 605: an aside tab's top bar and right column read the aside's own figures.
import { describe, expect, it } from "vitest";
import type { Aside, AsideTurn } from "./state.svelte";
import { asideFigures, asideSpendText, threadTokens } from "./asideFigures";
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
    expect(asideFigures(null)).toEqual({ used: null, cost: null, cacheHit: null, turn: null, model: null, estimated: null, exchanges: 0 });
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

  it("sums what each answer added and marks it a floor when an answer had none", () => {
    expect(asideFigures(aside([turn({ added: 0.01 }), turn({ added: 0.02 })])).cost).toEqual({ usd: 0.03, complete: true });
    const partial = asideFigures(aside([turn({ added: 0.01 }), turn({})])).cost;
    expect(partial?.complete).toBe(false);
    expect(asideFigures(aside([turn({})])).cost).toBeNull();
  });

  // Item 675 (his "an easy ass response jus doubled the cost. another easy
  // ass response just added 15 bucks"): until then a turn's `cost` was the
  // CLI's `total_cost_usd`, which on an aside's fork is the whole chat's
  // running cost plus the answer's. His screenshot's shape: a chat near
  // $12, three exchanges, "$40.47".
  it("never sums a turn's old cost — the chat's running total — into the aside (675)", () => {
    const old = aside([turn({ cost: 11.5 }), turn({ seq: 2, cost: 13.2 }), turn({ seq: 3, cost: 15.77 })]);
    expect(asideFigures(old).cost).toBeNull();
    // The same thread once its next answer comes with its own cost: that
    // answer alone, marked a floor for the three that kept none.
    const next = aside([...old.turns, turn({ seq: 4, added: 0.42 })]);
    expect(asideFigures(next).cost).toEqual({ usd: 0.42, complete: false });
    expect(asideSpendText(asideFigures(next).cost)).toBe("+$0.42");
  });

  // Item 675: an aside may now take twenty rounds, each sending the
  // chat's prefix again; `usage` sums them, `context` is the last one's.
  it("reads the context from the last round, not the rounds' sum (675)", () => {
    const a = aside([turn({ usage: { input_tokens: 560_000, output_tokens: 900, cache_read_tokens: 540_000 }, context: 187_300 })]);
    expect(asideFigures(a).used).toBe(187_300);
  });

  it("times an ended turn from its question to its answer", () => {
    const f = asideFigures(aside([turn({ startedAt: 1_000, at: new Date(6_000).toISOString() })]), 99_000);
    expect(f.turn?.ms).toBe(5_000);
    expect(f.turn?.live).toBe(false);
  });

  it("writes the spend as the chat's bar does, with a plus: it is added over the chat (675)", () => {
    expect(asideSpendText(null)).toBeNull();
    expect(asideSpendText({ usd: 0, complete: true })).toBeNull();
    expect(asideSpendText({ usd: 0.0042, complete: true })).toBe("+$0.0042");
    expect(asideSpendText({ usd: 1.5, complete: false })).toBe("+$1.50");
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

  it("keeps what each answer added and the context it left (675)", () => {
    const a = aside([turn({ usage: { input_tokens: 900, output_tokens: 20 }, added: 0.37, context: 480 })]);
    const back = asideFromStored(JSON.parse(JSON.stringify(storedAsideOf(a))));
    expect(back?.turns[0]?.added).toBe(0.37);
    expect(back?.turns[0]?.context).toBe(480);
    expect(asideFigures(back!).cost).toEqual({ usd: 0.37, complete: true });
    expect(asideFigures(back!).used).toBe(480);
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

// Item 639 (his "why does an aside not get context info?"): an aside answered
// before 605 kept no tokens, and its dial read "—".
describe("the dial's figure for an old and a new aside (639)", () => {
  // An old aside as the store gives it back: text only, no usage, no cost.
  const old = () =>
    asideFromStored({ quote: null, turns: [{ question: "What is a monad?", answer: "x".repeat(4000), error: null, cancelled: false }] })!;

  it("estimates an old aside from the chat's context plus the thread, and says so", () => {
    const a = old();
    const f = asideFigures(a, Date.now(), 180_000);
    expect(f.estimated).toBe("chat");
    const thread = threadTokens(a);
    expect(thread).toBeGreaterThanOrEqual(1000); // the 4000-character answer alone is 1000
    expect(f.used).toBe(180_000 + thread);
  });

  it("falls back to the thread alone, marked a floor, when the chat has no reading — never null", () => {
    const f = asideFigures(old(), Date.now(), null);
    expect(f.estimated).toBe("thread");
    expect(f.used).toBe(threadTokens(old()));
    expect(f.used).toBeGreaterThan(0);
  });

  it("reads a new aside's own usage exactly, whatever the chat's reading", () => {
    const a = aside([turn({ usage: { input_tokens: 184_000, output_tokens: 400 } })]);
    const f = asideFigures(a, Date.now(), 999_999);
    expect(f.used).toBe(184_400);
    expect(f.estimated).toBeNull();
    expect(f.turn?.estOut).toBeUndefined();
  });

  it("estimates the newest answer's output from its text when no usage was kept", () => {
    expect(asideFigures(old()).turn?.estOut).toBe(1000);
  });

  it("counts the exchanges, so the This aside section has something for an old aside", () => {
    expect(asideFigures(old()).exchanges).toBe(1);
    expect(asideFigures(old()).cost).toBeNull();
  });

  it("estimates a first question still asking from the chat's prefix", () => {
    const a = aside([turn({ answer: null, partial: "", startedAt: 1_000 })]);
    const f = asideFigures(a, 2_000, 50_000);
    expect(f.estimated).toBe("chat");
    expect(f.used).toBeGreaterThan(50_000);
  });

  it("leaves a draft with no chat reading at no figure", () => {
    const d: Aside = { id: 1, quote: null, draft: true, turns: [], anchor: null };
    expect(asideFigures(d, Date.now(), null).used).toBeNull();
    expect(asideFigures(d, Date.now(), 10).estimated).toBe("chat");
  });
});

describe("an aside answer's clock survives the store (639)", () => {
  it("keeps when it ended and how long it took", () => {
    const at = new Date(10_000).toISOString();
    const a = aside([turn({ startedAt: 4_000, at })]);
    const back = asideFromStored(JSON.parse(JSON.stringify(storedAsideOf(a))))!;
    expect(back.turns[0]?.at).toBe(at);
    expect(back.turns[0]?.tookMs).toBe(6_000);
    expect(back.turns[0]?.startedAt).toBeUndefined();
    expect(asideFigures(back).turn?.ms).toBe(6_000);
    expect(asideFigures(back).turn?.live).toBe(false);
  });
});
