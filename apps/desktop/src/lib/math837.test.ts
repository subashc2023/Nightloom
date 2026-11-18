// Item 837 — one maths path, pinned on every case he reported (831 834 835 836, sigma vs Sigma) and on every
// streaming prefix of each: his sent words (`userMath.ts`), a reply and its streaming tail (`markdown.ts`,
// `math.ts`), the phone's renderer, the box's offers (`typedMath.ts`, `bareLatex.ts`) and the paste auto-fence
// (`codeDetect.ts`). The DOM side (both looks, WebKit) is in notes/runner-design/837-report-2026-11-18.md.
import { describe, expect, it, vi } from "vitest";
// The suite runs in node, where DOMPurify has no window; its pass changes no text here.
vi.mock("dompurify", () => ({ default: { sanitize: (h: string) => h } }));
import { renderMarkdown, renderReply, streamingTail } from "./markdown";
import { openMathAt, renderMath } from "./math";
import { drawnParts, mathParts, type MathPart } from "./userMath";
import { findTypedMath } from "./typedMath";
import { codePasteLanguage, detectCode } from "./codeDetect";
// vitest empties CSS imports, so mathBase.css is read from disk (the repo's way, codeCopy.test.ts).
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(u: URL, enc: string): string };
const mathBaseCss = fs.readFileSync(new URL("./mathBase.css", import.meta.url), "utf8");
import markdownSrc from "./markdown.ts?raw";

const M831 =
  'will the exam use this terminology "where it applies"?\n\nU1. (theta - 3) is the length. height is 1/(theta - 3)\nU2. E(X) is (theta+3)/2. estimator is (theta+3)/2 = $$\\bar{X}$$.\n(11+3)/2 = X_bar -> 7.';
const M834 = "M2.\n$L(\\lambda) = \\Sigma \\lambda^{2} x e^{- \\lambda x}$\nl(lambda) = Sigma(ln(\\lambda^{2} x e^{- \\lambda x})";
// Line 2 ends in a call shape (his shot cuts it off): the ending that makes the old detector fence it.
const M835 =
  "M4 cuz shaped like exam.\nl(theta) = n (3 ln (x) + - n(x/theta) + ln(1)*n - ln(6) + 4ln(theta)\nderivative:\n0 = nx/theta^2 + 4/theta\n* theta ^2\nnx + $4 \\cdot \\theta = 0$\ntheta = -nx/4";
const R836 =
  "Term by term:\n\n| term | what the sum does | why |\n|---|---|---|\n| $-\\ln 6$ | $n$ × it: $-4n\\ln\\theta$, $-n\\ln 6$ | the same thing added $n$ times |\n| $-\\frac{x}{\\theta}$ | pull the something out, and $\\sum x_i = T$: $-\\frac{T}{\\theta}$ | $\\frac{x-1}{\\theta}$ would not split |\n\nSo the log-likelihood is $\\ell(\\theta) = -4n\\ln\\theta - \\frac{T}{\\theta}$.";
const R_ALL =
  "Inline \\(a_i^2\\) and $\\sigma^2$ versus $\\Sigma$, then display:\n\n$$\n\\begin{aligned}\nL(\\lambda) &= \\prod_i \\lambda^{2} x_i e^{-\\lambda x_i} \\\\\n\\ell(\\lambda) &= 2n\\ln\\lambda - \\lambda T\n\\end{aligned}\n$$\n\nand \\[\\hat\\lambda = \\frac{2n}{T}\\] with **bold $\\Delta$** and `code $x$` after.\n\n- item $\\delta x \\to 0$\n- item $\\Omega(n \\log n)$ vs $\\omega$\n";
const R_MONEY = "The plan runs between $5 and $10 a month, or $1,200 total. Set $HOME first; `$PATH` stays code.\n\nIt came to $40.";

const maths = (ps: MathPart[]) => ps.filter((p) => p.kind === "math") as Extract<MathPart, { kind: "math" }>[];
const joined = (ps: MathPart[]) => ps.map((p) => (p.kind === "math" ? p.src : p.text)).join("");
/** What is on screen: the tags off, KaTeX's hidden MathML copy (which holds the TeX) out. */
const seen = (html: string) =>
  html
    .replace(/<span class="katex-mathml">[\s\S]*?<\/math><\/span>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&");
const formulas = (html: string) => (html.match(/class="katex"/g) ?? []).length;

describe("his sent words are typeset (831, 834)", () => {
  it("831: $$\\bar{X}$$ inside a sentence is a formula, set in text style", () => {
    const ps = mathParts(M831);
    expect(maths(ps)).toEqual([{ kind: "math", tex: "\\bar{X}", display: false, src: "$$\\bar{X}$$" }]);
    expect(joined(ps)).toBe(M831);
  });
  it("834: both lines are typeset — the wrapped one and the bare LaTeX in the other", () => {
    const ms = maths(mathParts(M834));
    // Only the `(` of `Sigma(` is unmatched, so `ln(…)` stays in the run, its `ln` set upright.
    expect(ms.map((m) => m.tex)).toEqual(["L(\\lambda) = \\Sigma \\lambda^{2} x e^{- \\lambda x}", "\\ln(\\lambda^{2} x e^{- \\lambda x})"]);
    expect(joined(mathParts(M834))).toBe(M834);
  });
  it("all four delimiters; a display formula alone on its line is a block and its line breaks are its margin", () => {
    const t = "so \\(a_i\\) and \\[b\\] here\n$$\\int_0^1 x\\,dx$$\nafter $x^2$.";
    const ps = mathParts(t);
    expect(maths(ps).map((m) => [m.tex, m.display])).toEqual([["a_i", false], ["b", false], ["\\int_0^1 x\\,dx", true], ["x^2", false]]);
    expect(joined(ps)).toBe(t);
    const d = drawnParts(ps);
    expect(d[4]).toEqual({ kind: "text", text: " here" });
    expect(d[6]).toEqual({ kind: "text", text: "after " });
  });
  it("money, shell and code stay his words", () => {
    for (const t of ["it costs $5 and $10 a month, or $1,200 total", "my path is $HOME/bin:$PATH and echo $USER$HOST", "run `$x^2$` and C:\\Users\\me\\notes", "a regex \\d+ and a newline \\n", "plain words, nothing else"])
      expect(mathParts(t)).toEqual([{ kind: "text", text: t }]);
  });
  it("is the same text, whatever it holds", () => {
    for (const t of [M831, M834, M835, R836, R_ALL, R_MONEY]) expect(joined(mathParts(t))).toBe(t);
  });
});

describe("case is kept (sigma vs Sigma)", () => {
  const glyph = (tex: string) => seen(renderMath(tex, false));
  it("KaTeX draws the letter that was written", () => {
    expect(glyph("\\sigma")).toBe("σ");
    expect(glyph("\\Sigma")).toBe("Σ");
    expect(glyph("\\delta")).toBe("δ");
    expect(glyph("\\Delta")).toBe("Δ");
    expect(glyph("\\omega")).toBe("ω");
    expect(glyph("\\Omega")).toBe("Ω");
  });
  it("a parent set in capitals cannot reach into a formula", () => {
    expect(mathBaseCss).toMatch(/\.katex \{[^}]*text-transform: none;[^}]*letter-spacing: normal;/);
    expect(markdownSrc).toContain('import "./mathBase.css";');
  });
  const offer = (s: string) => findTypedMath(s).map((x) => x.tex);
  it("the box's offers keep the capital, and a small letter stays small", () => {
    expect(offer("Sigma x")).toEqual(["\\Sigma x"]);
    expect(offer("sigma x")).toEqual(["\\sigma x"]);
    expect(offer("Delta x = 3")).toEqual(["\\Delta x = 3"]);
    expect(offer("delta x = 3")).toEqual(["\\delta x = 3"]);
    expect(offer("Omega = 2")).toEqual(["\\Omega = 2"]);
    expect(offer("omega = 2")).toEqual(["\\omega = 2"]);
  });
  it("a Greek name before a parenthesis is offered, capital and small apart (834)", () => {
    // AsciiMath's spacing (`\\Sigma (x)`); KaTeX draws it the same as `\\Sigma(x)`.
    expect(offer("Sigma(x)")).toEqual(["\\Sigma (x)"]);
    expect(offer("sigma(x)")).toEqual(["\\sigma (x)"]);
    expect(offer("Phi(z) = 2")).toEqual(["\\Phi (z) = 2"]);
  });
  it("834 line 1 as he would type it gets one offer for the whole line", () => {
    const got = findTypedMath("L(lambda) = Sigma lambda^2 x e^(-lambda x)");
    expect(got).toHaveLength(1);
    expect(got[0].src).toBe("L(lambda) = Sigma lambda^2 x e^(-lambda x)");
    expect(got[0].tex).toContain("\\Sigma \\lambda^{2}");
  });
  it("834 line 2: the LaTeX in a line with an unmatched parenthesis is still offered", () => {
    const got = findTypedMath("l(lambda) = Sigma(ln(\\lambda^{2} x e^{- \\lambda x})");
    expect(got.filter((s) => s.bare).map((s) => s.src)).toEqual(["ln(\\lambda^{2} x e^{- \\lambda x})"]);
  });
  it("a capital Sigma with a running index is the summation sign; without one it is the letter", () => {
    expect(offer("Sigma_(i=1)^n x_i")[0]).toMatch(/^\\sum_\{i = 1\}\^\{n\}/);
    expect(offer("Sigma_x")).toEqual(["\\Sigma_{x}"]);
    expect(offer("sigma_x^2")).toEqual(["\\sigma_{x}^{2}"]);
  });
});

describe("a plain message is never made a code block (835)", () => {
  it("his pasted notes are not fenced", () => {
    expect(detectCode(M835).code).toBe(false);
    expect(codePasteLanguage(M835, "", 0)).toBeNull();
  });
  it("more maths notes, with and without LaTeX", () => {
    for (const t of ["x = 3\ny = x^2 + 1\nf(x) = ln(x)\ntheta = -nx/4", "E(X) = (theta+3)/2\nVar(X) = sigma^2/n\nmu = 7", "a = \\frac{1}{2}\nb = \\sqrt{a}\nc = a + b"])
      expect(codePasteLanguage(t, "", 0)).toBeNull();
  });
  it("real code is still fenced", () => {
    // (A bare `for … do … done` script was never fenced, before 837 either: score 0.25.)
    expect(codePasteLanguage("if [ -z \"$HOME\" ]; then\n  echo \"no home\";\n  exit 1;\nfi\nexport X=\"$HOME/bin\";", "", 0)).toBe("bash");
    expect(codePasteLanguage("import math\n\ndef area(r):\n    return math.pi * r ** 2\n\nprint(area(2))", "", 0)).toBe("python");
    expect(codePasteLanguage("const theta = Math.sin(alpha);\nconst mu = theta * 2;\nconsole.log(mu);", "", 0)).toBe("javascript");
  });
});

describe("streaming (836): every prefix renders without raw half-commands", () => {
  it("openMathAt finds the formula still arriving, and leaves money and code alone", () => {
    expect(openMathAt("so $\\frac{x-1}{\\")).toBe(3);
    expect(openMathAt("so $$\\int_0^1 x")).toBe(3);
    expect(openMathAt("so \\(\\frac{a}{")).toBe(3);
    expect(openMathAt("intro\n\n$$\n\\begin{aligned}\na &= b \\\\\n\nc")).toBe(7);
    expect(openMathAt("done $x$ and $$y$$ and \\(z\\)")).toBe(-1);
    expect(openMathAt("it costs $5 and $10")).toBe(-1);
    expect(openMathAt("set $HOME and then")).toBe(-1);
    expect(openMathAt("```\necho $x_1\n")).toBe(-1);
    expect(openMathAt("```\na\n```\nthen `$x_` and $y_")).toBe(25);
    expect(openMathAt("ends in half a delimiter \\")).toBe(25);
  });
  it("836: the half-arrived cell is not drawn; the row waits until it is whole", () => {
    const cut = R836.indexOf("$\\frac{x-1}{\\") + "$\\frac{x-1}{\\".length;
    const html = renderReply(streamingTail(R836.slice(0, cut)));
    expect(seen(html)).not.toContain("\\frac");
    expect(seen(html)).not.toContain("$");
    expect((html.match(/<tr>/g) ?? []).length).toBe(2); // the head and the one finished row
    expect(seen(html)).not.toContain("pull the something out");
  });
  const cols = (html: string) => (/<thead>[\s\S]*?<\/thead>/.exec(html)?.[0].match(/<th[ >]/g) ?? []).length;
  for (const [name, reply, money] of [["836's table", R836, false], ["every delimiter", R_ALL, false], ["money and shell", R_MONEY, true]] as const) {
    it(`${name}: all ${reply.length} prefixes, on the Mac's renderer and the phone's`, () => {
      const final = seen(renderReply(reply));
      for (let n = 1; n <= reply.length; n++) {
        const tail = streamingTail(reply.slice(0, n));
        for (const html of [renderReply(tail), renderMarkdown(tail, { breaks: true })]) {
          const text = seen(html);
          const where = `prefix ${n} ${JSON.stringify(reply.slice(Math.max(0, n - 30), n))}`;
          // No TeX command and no formula delimiter on screen (code keeps its own text).
          const prose = text.replace(/code \$x\$|\$[A-Z_]+|\$\d[\d,.]*/g, "");
          expect(prose, where).not.toMatch(/\\[A-Za-z(\[]|\$/);
          expect(html, where).not.toContain("katex-error");
          // A table is whole rows: every row has the head's cells.
          const c = cols(html);
          if (c > 0) for (const row of html.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) expect((row.match(/<t[dh][ >]/g) ?? []).length, where).toBe(c);
          if (money) expect(formulas(html), where).toBe(0);
        }
      }
      expect(seen(renderReply(streamingTail(reply)))).toBe(final);
    });
  }
  it("a formula appears in one step, when it closes", () => {
    const r = "the mean is $\\bar{X} = \\frac{1}{n}\\sum x_i$ here";
    const open = r.indexOf("$");
    const close = r.lastIndexOf("$");
    for (let n = open + 1; n <= close; n++) expect(formulas(renderReply(streamingTail(r.slice(0, n)))), `prefix ${n}`).toBe(0);
    expect(formulas(renderReply(streamingTail(r.slice(0, close + 1))))).toBe(1);
  });
  it("the settled reply is untouched by any of it", () => {
    for (const r of [R836, R_ALL]) expect(formulas(renderReply(r))).toBeGreaterThan(3);
    expect(formulas(renderReply(R_MONEY))).toBe(0);
  });
});
