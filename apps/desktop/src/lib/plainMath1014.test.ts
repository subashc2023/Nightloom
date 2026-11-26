// Item 1014 (740 audit): search snippets showed raw LaTeX (`$\bar x$`, `$np \ge 10$`); spelled plain now,
// on the phone's drawer search and the desktop's search panel alike (both draw `plainFragment`).
import { describe, expect, it } from "vitest";
import { plainFragment, plainHit, plainMath, plainOneLine } from "./plainMd";

describe("1014: LaTeX in a one-line place", () => {
  it("the audit's two snippets", () => {
    expect(plainFragment("the mean $\\bar x$ of the sample")).toBe("the mean x̄ of the sample");
    expect(plainFragment("check $np \\ge 10$ and ")).toBe("check np ≥ 10 and ");
  });
  it("a snippet cut inside the math loses the lone dollar", () => {
    expect(plainFragment("so $\\hat p")).toBe("so p̂");
    expect(plainFragment("\\ge 10$, then")).toBe("≥ 10, then");
  });
  it("fractions, roots, Greek, text, sub/superscripts", () => {
    expect(plainMath("$\\frac{a}{b} + \\sqrt{n}$")).toBe("a/b + √n");
    expect(plainMath("$\\frac{x-\\mu}{\\sigma}$")).toBe("(x-μ)/σ");
    expect(plainMath("\\(\\sigma^{2}_{x} \\text{ is var}\\)")).toBe("σ^2_x  is var");
    expect(plainMath("$$\\sum_{i=1}^{n} x_i$$")).toBe("Σ_i=1^n x_i");
  });
  it("a tight pair without commands loses its dollars", () => {
    expect(plainFragment("where $n$ is large")).toBe("where n is large");
  });
  it("leaves prices, paths and templates alone", () => {
    expect(plainFragment("costs $5 and $10 a month")).toBe("costs $5 and $10 a month");
    expect(plainFragment("C:\\Users\\me\\notes")).toBe("C:\\Users\\me\\notes");
    expect(plainFragment("`${base}/api`")).toBe("${base}/api");
    expect(plainFragment("an escaped \\$ sign")).toBe("an escaped \\$ sign");
  });
  it("a chat name or preview on one line too", () => {
    expect(plainOneLine("Is $\\bar x$ unbiased?")).toBe("Is x̄ unbiased?");
  });
});

describe("1014: a hit inside the math (found live in the Simulator: searching 'bar x')", () => {
  it("the math span moves into the hit and reads plain", () => {
    const h = plainHit("…the output is random, like $\\", "bar X", "$. Once you plug in");
    expect(h).toEqual({ before: "…the output is random, like ", matched: "X̄", after: ". Once you plug in" });
  });
  it("a command cut at the hit, with no dollars in the window", () => {
    const h = plainHit("…is below 19.8 oz σ_\\", "bar x", "=\\frac{0.4}{\\sqrt{25}}=0.08");
    expect(h.matched).toBe("x̄");
    expect(h.after).toBe("=0.4/√25=0.08");
  });
  it("a hit outside math is left as it was", () => {
    expect(plainHit("costs $5 and ", "more", " later")).toEqual({ before: "costs $5 and ", matched: "more", after: " later" });
  });
});
