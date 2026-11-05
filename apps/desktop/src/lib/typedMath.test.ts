import { describe, expect, it } from "vitest";
import katex from "katex";
import sets from "./__fixtures__/455-typed-math.json";
import { applyTypedMath, findTypedMath } from "./typedMath";

// Item 456: the item-455 test sets (nightshift-code notes/runner-design/455-math/),
// 187 sentences: maths that must convert, prose that must not, and ambiguous
// cases that are only rendered.
interface Case {
  kind: "pos" | "neg" | "amb";
  text: string;
  expect: string[];
}
const all = sets as Record<string, Case[]>;

/** TeX compared without spacing, braces or \left/\right: `s^{2}` = `s^2`. */
const norm = (t: string) =>
  t
    .replace(/\\left|\\right/g, "")
    .replace(/\\mid/g, "|")
    .replace(/\\cdot/g, "*")
    .replace(/[\s{}]/g, "");
/** Offered as a piece, not whole (the 455 report's surviving partials). */
const PARTIAL: Record<string, string[]> = {
  "the gradient of x^T A x is 2Ax for symmetric A": ["x^T"],
  "the softmax is e^(z_i) / sum of e^(z_j)": ["e^{z_j}"],
};
const texes = (text: string) => findTypedMath(text).map((s) => s.tex);

describe("typed maths: prose never converts", () => {
  for (const [name, cases] of Object.entries(all)) {
    for (const c of cases.filter((c) => c.kind === "neg")) {
      // The one false positive the 455 runs found; pinned so a change is seen.
      if (c.text === "a + b testing is not a thing") continue;
      it(`${name}: ${c.text}`, () => expect(texes(c.text)).toEqual([]));
    }
  }
  it("the known false positive is still the only one", () => {
    expect(texes("a + b testing is not a thing")).toEqual(["a + b"]);
  });
});

describe("typed maths: what converts, converts right", () => {
  for (const [name, cases] of Object.entries(all)) {
    for (const c of cases.filter((c) => c.kind === "pos")) {
      it(`${name}: ${c.text}`, () => {
        const got = texes(c.text).map(norm);
        const want = c.expect.map(norm);
        // Every formula offered is a right one (a miss offers nothing), except
        // the known part-offers: a correct piece of a formula the rules cannot
        // take whole. Pinned so a change to either list is seen.
        const part = PARTIAL[c.text];
        if (part) expect(got).toEqual(part.map(norm));
        else for (const g of got) expect(want).toContain(g);
        // dev and holdout 1 convert whole; holdout 2's known misses are allowed.
        if (name !== "holdout2" && !part) expect(got).toEqual(want);
      });
    }
  }
  it("holdout 2 still converts at least 12 of its 20 maths sentences whole", () => {
    const pos = all.holdout2.filter((c) => c.kind === "pos");
    const whole = pos.filter((c) => {
      const got = texes(c.text).map(norm);
      return got.length === c.expect.length && got.every((g, k) => g === norm(c.expect[k]));
    });
    expect(whole.length).toBeGreaterThanOrEqual(12);
  });
  it("every formula offered on every set renders in KaTeX", () => {
    for (const cases of Object.values(all))
      for (const c of cases)
        for (const t of texes(c.text)) expect(() => katex.renderToString(t, { throwOnError: true }), t).not.toThrow();
  });
});

describe("typed maths: traps found in 455", () => {
  it("groups a call beside a spaced slash: P(B|A) P(A) / P(B)", () => {
    const [s] = findTypedMath("P(A|B) = P(B|A) P(A) / P(B) is Bayes");
    expect(norm(s.tex)).toBe(norm("P(A|B) = P(B|A) \\frac{P(A)}{P(B)}"));
    expect(s.tex).not.toContain("\\frac{A}{P}");
  });
  it("keeps primes: y'' + y = 0", () => {
    expect(texes("from y'' + y = 0 to sin")).toEqual(["y'' + y = 0"]);
  });
  it("a comma ends a formula: a_1, a_2, a_3", () => {
    expect(texes("let a_1, a_2, a_3 be the terms").map(norm)).toEqual(["a_1", "a_2", "a_3"]);
  });
  it("a root takes the whole run: the square root of b^2 - 4ac", () => {
    expect(texes("the square root of b^2 - 4ac").map(norm)).toEqual([norm("\\sqrt{b^2 - 4ac}")]);
  });
  it("never wraps half a formula", () => {
    expect(texes("the gradient step is w = w - eta * grad")).toEqual([]);
    expect(texes("so the recurrence T(n) = 2T(n/2) + n gives n log n?")).toEqual([]);
  });
});

describe("typed maths: in the composer", () => {
  it("leaves code, quotes and existing maths alone", () => {
    expect(texes("```\nx^2 + 1\n```")).toEqual([]);
    expect(texes("```py\nx^2 + 1")).toEqual([]); // a fence still being typed
    expect(texes("the code is `x_1 = 2`")).toEqual([]);
    expect(texes("> so x^2 here\n\nwhat does that mean")).toEqual([]);
    expect(texes("already $s^2$ here")).toEqual([]);
  });
  it("still finds maths beside a quote", () => {
    expect(texes("> the reply\n\nis s^2 the variance")).toEqual(["s^{2}"]);
  });
  it("the spans' offsets are the typed text", () => {
    const t = "is s squared or s^2 the variance";
    expect(findTypedMath(t).map((s) => t.slice(s.from, s.to))).toEqual(["s squared", "s^2"]);
  });
});

describe("applyTypedMath", () => {
  const t = "so s^2 and x_1 here";
  const spans = findTypedMath(t);
  it("wraps every span given", () => {
    expect(applyTypedMath(t, spans).text).toBe("so $s^{2}$ and $x_{1}$ here");
  });
  it("wraps only the spans given", () => {
    expect(applyTypedMath(t, [spans[1]]).text).toBe("so s^2 and $x_{1}$ here");
  });
  it("carries the caret: before, between, after, inside", () => {
    expect(applyTypedMath(t, spans, 1).caret).toBe(1);
    const mid = t.indexOf("and");
    const r = applyTypedMath(t, spans, mid);
    expect(r.text.slice(r.caret, r.caret + 3)).toBe("and");
    const end = applyTypedMath(t, spans, t.length);
    expect(end.caret).toBe(end.text.length);
    const inside = applyTypedMath(t, spans, t.indexOf("^"));
    expect(inside.text.slice(0, inside.caret)).toBe("so $s^{2}$");
  });
});
