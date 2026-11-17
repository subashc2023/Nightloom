import { describe, expect, it } from "vitest";
import { chipCosts, coldButtons, coldChipShows, coldTip, LEAD_MS, warmDetail, warmTitle, warmWrapAct, type ColdFacts, type WarmFacts } from "./warmWrap";
import { parseWarmStored } from "./warmWrap.svelte";
import type { Usage } from "./types";

const NOW = 1_800_000_000_000;
const warm: WarmFacts = {
  mode: "offer",
  minTokens: 150_000,
  context: 300_000,
  warmUntil: NOW + 4 * 60_000,
  now: NOW,
  keeping: false,
  busy: false,
  handingOff: false,
  never: false,
  away: true,
};
const cold: ColdFacts = { minTokens: 150_000, context: 300_000, warm: false, busy: false, handingOff: false, noticeUp: false, kept: false };
// Opus 5.5 on the CLI's 1-hour cache: read $0.20, write $8 per MTok.
const rates = { read: 0.2, write: 8, from: "usage-rates.json's row for claude-opus-5-5" };
const usage = { input_tokens: 296_000, output_tokens: 4_000 } as Usage;

describe("item 768: the warm moment", () => {
  it("offers inside the lead on a big idle chat", () => {
    expect(warmWrapAct(warm)).toBe("offer");
  });
  it("does nothing outside the lead, once cold, or with no cache recorded", () => {
    expect(warmWrapAct({ ...warm, warmUntil: NOW + LEAD_MS + 1 })).toBeNull();
    expect(warmWrapAct({ ...warm, warmUntil: NOW })).toBeNull();
    expect(warmWrapAct({ ...warm, warmUntil: null })).toBeNull();
  });
  it("leaves small, busy, kept-warm and handing-off chats alone, and Off does nothing", () => {
    expect(warmWrapAct({ ...warm, context: 149_999 })).toBeNull();
    expect(warmWrapAct({ ...warm, minTokens: 0 })).toBeNull();
    expect(warmWrapAct({ ...warm, busy: true })).toBeNull();
    expect(warmWrapAct({ ...warm, keeping: true })).toBeNull();
    expect(warmWrapAct({ ...warm, handingOff: true })).toBeNull();
    expect(warmWrapAct({ ...warm, mode: "off" })).toBeNull();
  });
  it("Do it sends only when he is away and the chat may be handed off; else it offers", () => {
    expect(warmWrapAct({ ...warm, mode: "do" })).toBe("do");
    expect(warmWrapAct({ ...warm, mode: "do", away: false })).toBe("offer");
    expect(warmWrapAct({ ...warm, mode: "do", never: true })).toBe("offer");
  });
  it("says the minutes left and both prices", () => {
    expect(warmTitle(4 * 60_000 - 1, 300_000)).toBe("Cache cold in 4 min — this chat is 300k");
    expect(warmDetail(chipCosts(usage, rates))).toBe("wrap up now ≈ $0.09 · after it lapses ≈ $2.40");
  });
});

describe("item 768: the cold chip", () => {
  it("shows on a cold big chat with nothing else carrying the way on", () => {
    expect(coldChipShows(cold)).toBe(true);
  });
  it("hides while warm, unknown, small, busy, kept, handing off, or under the hand-off notice", () => {
    for (const f of [
      { warm: true },
      { warm: null },
      { context: 100_000 },
      { busy: true },
      { kept: true },
      { handingOff: true },
      { noticeUp: true },
    ] as Partial<ColdFacts>[])
      expect(coldChipShows({ ...cold, ...f })).toBe(false);
  });
  it("prices both buttons from the newest reply: the same cold send either way", () => {
    const c = chipCosts(usage, rates)!;
    expect(c.cold).toBeCloseTo(2.4, 5);
    expect(c.perTurn).toBeCloseTo((296_000 * 0.2 + 4_000 * 8) / 1e6, 9);
    expect(coldButtons(c)).toEqual({ handoff: "Hand off (≈ $2.40)", keep: "Keep (re-writes 300k ≈ $2.40)" });
    expect(coldButtons(null)).toEqual({ handoff: "Hand off", keep: "Keep" });
    // Item 776's rule: two short lines, numbers first, no rate source or caveat.
    const tipLines = coldTip(c, rates).split("\n");
    expect(tipLines).toEqual(["Next send ≈ $2.40 · then ≈ $0.09 a turn", "Hand off: that send is the wrap-up"]);
    // One drawn line each in the 320 px pill: ≤ 44 characters (776 measured 44 in 279 px).
    for (const l of [...tipLines, ...coldTip(null, rates).split("\n")]) expect(l.length).toBeLessThanOrEqual(44);
    expect(coldTip(null, rates).split("\n")).toHaveLength(2);
  });
});

describe("item 768: the stored preferences", () => {
  it("defaults to Offer at 150k and reads back what was saved", () => {
    expect(parseWarmStored(null)).toEqual({ mode: "offer", minTokens: 150_000, kept: {}, acted: {} });
    expect(parseWarmStored('{"mode":"do","minTokens":200000,"kept":{"a":5},"acted":{"b":7,"c":"x"}}')).toEqual({
      mode: "do",
      minTokens: 200_000,
      kept: { a: 5 },
      acted: { b: 7 },
    });
    expect(parseWarmStored('{"mode":"sometimes","minTokens":-1}').mode).toBe("offer");
    expect(parseWarmStored("not json").minTokens).toBe(150_000);
  });
});
