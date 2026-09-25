import { describe, expect, it } from "vitest";
import { CHARS_PER_TOKEN, DRAFT_TOKENS_FROM, draftEstimate, draftEstimateTitle, estimateTokens } from "./tokens";

// Nightshift backlog 155: the draft's live estimate and its threshold.

describe("estimateTokens", () => {
  it("is characters over four, rounded up — nightloom_core's rule", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("counts code points, as Rust's chars() does", () => {
    // Four emoji: eight UTF-16 units, four chars → one token.
    expect(estimateTokens("😀😀😀😀")).toBe(1);
    expect(estimateTokens("éééé")).toBe(1);
  });
});

describe("draftEstimate", () => {
  it("shows nothing for a short message", () => {
    expect(draftEstimate("hello")).toBeNull();
    expect(draftEstimate("x".repeat(DRAFT_TOKENS_FROM * 4 - 4))).toBeNull();
  });

  it("shows from the threshold up", () => {
    const e = draftEstimate("x".repeat(DRAFT_TOKENS_FROM * 4));
    expect(e?.tokens).toBe(DRAFT_TOKENS_FROM);
    expect(e?.long).toBe(`~${DRAFT_TOKENS_FROM} tokens`);
  });

  it("spells a long draft with a thousands separator, and short as the gauge does", () => {
    const e = draftEstimate("y".repeat(1240 * 4));
    expect(e).toEqual({ tokens: 1240, long: "~1,240 tokens", short: "~1.2k" });
  });

  it("the hover says it is an estimate", () => {
    expect(draftEstimateTitle(1240)).toMatch(/estimate/);
    expect(draftEstimateTitle(1240)).toContain("1,240");
  });
});
