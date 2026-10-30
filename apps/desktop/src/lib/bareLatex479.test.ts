import { describe, expect, it } from "vitest";
import { applyTypedMath, findTypedMath, wrapTypedMath } from "./typedMath";

// Item 479: bare LaTeX (typed without its dollars) gets the typed-maths
// bar's one-click "wrap as maths". The table: each draft, and the bare runs
// it must offer ([] = no bare offer). `$$` marks a whole-line run.
const bare = (text: string) =>
  findTypedMath(text)
    .filter((s) => s.bare)
    .map((s) => (s.display ? `$$${s.src}` : s.src));

const TABLE: [string, string[]][] = [
  // --- true offers ---
  ["4. \\sigma{1, 2, 4}", ["\\sigma{1, 2, 4}"]], // his example: the list marker stays out
  ["\\sigma{1, 2, 4}", ["$$\\sigma{1, 2, 4}"]],
  ["\\overline{A}+B", ["$$\\overline{A}+B"]],
  ["so the union is \\overline{A}+B here", ["\\overline{A}+B"]],
  ["the ratio \\frac{a}{b} is small", ["\\frac{a}{b}"]],
  ["x = \\frac{1}{2}", ["$$x = \\frac{1}{2}"]],
  ["we know x = \\frac{1}{2} from before", ["x = \\frac{1}{2}"]],
  ["x^{2} + y^{2} = r^{2}", ["$$x^{2} + y^{2} = r^{2}"]],
  ["the error is \\epsilon.", ["\\epsilon"]],
  ["take \\alpha, \\beta and \\gamma", ["\\alpha, \\beta", "\\gamma"]],
  ["\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}", ["$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}"]],
  ["it holds for all x \\in A", ["x \\in A"]],
  ["4 \\times 3 = 12", ["$$4 \\times 3 = 12"]],
  ["(see \\sqrt{2})", ["\\sqrt{2}"]],
  ["a \\alpha particle", ["\\alpha"]], // the article is prose
  ["the limit \\lim_{x \\to 0} f(x) exists", ["\\lim_{x \\to 0} f(x)"]],
  ["P(A \\cap B) is what we want", ["P(A \\cap B)"]],
  ["\\mathbb{R}^n is a vector space", ["\\mathbb{R}^n"]],
  ["set a_{ij} to zero", ["a_{ij}"]],
  ["two lines\n\\int_0^1 x dx\nmore text", ["$$\\int_0^1 x dx"]],
  // --- false offers: paths, escapes, code, prose, existing maths ---
  ["it is in C:\\Users\\me\\Documents", []],
  ["open \\\\server\\share\\notes", []],
  ["print a newline with \\n and a tab with \\t", []],
  ["the regex \\d+\\s*", []],
  ["run `echo \\alpha` in the shell", []],
  ["```\nlet s = \"\\sigma\";\n```", []],
  ["> \\alpha is quoted", []],
  ["already maths: $\\alpha + \\beta$", []],
  ["display maths:\n$$\\frac{1}{2}$$", []],
  ["\\(\\alpha\\) and \\[\\beta\\]", []],
  ["just ordinary prose without any maths in it", []],
  ["a backslash \\ alone, and \\\\ two", []],
  ["\\documentclass{article}", []], // not a maths command
  ["\\frac{1}{", []], // still being typed: unbalanced
  ["see https://example.com/\\alpha/x", []],
  ["\\textbf{bold} words", []],
];

describe("item 479: bare LaTeX is offered as maths", () => {
  for (const [text, want] of TABLE) {
    it(JSON.stringify(text), () => expect(bare(text)).toEqual(want));
  }

  it("the table has at least 30 cases, true and false", () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(30);
    expect(TABLE.filter(([, w]) => w.length > 0).length).toBeGreaterThanOrEqual(15);
    expect(TABLE.filter(([, w]) => w.length === 0).length).toBeGreaterThanOrEqual(15);
  });

  it("accepting wraps a run in $…$, and a whole line in $$…$$", () => {
    const t = "4. \\sigma{1, 2, 4}";
    expect(applyTypedMath(t, findTypedMath(t)).text).toBe("4. $\\sigma{1, 2, 4}$");
    const line = "\\overline{A}+B";
    const spans = findTypedMath(line);
    expect(spans.map(wrapTypedMath)).toEqual(["$$\\overline{A}+B$$"]);
    expect(applyTypedMath(line, spans).text).toBe("$$\\overline{A}+B$$");
  });

  it("an accepted run is not offered again (it is maths now)", () => {
    const t = "so \\frac{a}{b} here";
    const once = applyTypedMath(t, findTypedMath(t)).text;
    expect(once).toBe("so $\\frac{a}{b}$ here");
    expect(findTypedMath(once)).toEqual([]);
  });

  it("costs little at the pause on a long draft (measured, logged)", () => {
    const para =
      "so the union is \\overline{A}+B and the ratio \\frac{a}{b} is small, see C:\\Users\\me and s^2 here. ";
    const draft = para.repeat(Math.ceil(2500 / para.length)).slice(0, 2500);
    findTypedMath(draft); // warm the memos as a second pause would
    const ms: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      findTypedMath(draft + " ".repeat(i)); // a new text each time
      ms.push(performance.now() - t0);
    }
    ms.sort((a, b) => a - b);
    console.log(`item 479: findTypedMath on ${draft.length} chars, median ${ms[4].toFixed(2)} ms, worst ${ms[8].toFixed(2)} ms`);
    expect(ms[4]).toBeLessThan(50);
  });

  it("bare LaTeX wins over a typed-maths piece inside it, and typed maths elsewhere stays", () => {
    const spans = findTypedMath("\\overline{A}+B and later s^2 here");
    expect(spans.map((s) => [s.src, !!s.bare])).toEqual([
      ["\\overline{A}+B", true],
      ["s^2", false],
    ]);
  });
});
