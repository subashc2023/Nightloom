import { describe, expect, it } from "vitest";
import { mathPasteText, mathmlToTex, parseHtml } from "./mathPaste";
import katexInline from "./__fixtures__/katex-inline-0xac.html?raw";
import katexDisplay from "./__fixtures__/katex-display-fraction.html?raw";
import mathjax3 from "./__fixtures__/mathjax3-chtml.html?raw";
import noMath from "./__fixtures__/no-math.html?raw";
import { findMath } from "./math";
import { composerMathOk } from "./composerEditor";

// Item 348: math copied from a web page pastes as its LaTeX, in the
// delimiters the composer renders, instead of KaTeX's flattened letters.

/** Every `$…$` / `$$…$$` span the composer would draw as math. */
const rendered = (t: string) => findMath(t).filter((m) => composerMathOk(t, m)).map((m) => t.slice(m.from, m.to));

describe("mathPasteText", () => {
  it("his 10/12 example: KaTeX inline math becomes $0xAC$, and the composer renders it", () => {
    const out = mathPasteText(katexInline);
    expect(out).toBe("What is 16-bit representation of $0xAC$ in hex?");
    expect(rendered(out!)).toEqual(["$0xAC$"]);
  });

  it("KaTeX display math goes on its own lines as $$…$$; inline math beside it stays inline", () => {
    expect(mathPasteText(katexDisplay)).toBe(
      "The mean of the sample is\n\n$$\\bar{x} = \\frac{1}{n}\\sum_{i=1}^{n} x_i$$\n\nwhere $n$ is the sample size.",
    );
  });

  it("MathJax v3 (CHTML, assistive MathML) converts its MathML", () => {
    const out = mathPasteText(mathjax3)!;
    expect(out).toBe(
      "The roots of $ax^2+bx+c=0$ are\n\n$$x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}$$\n\nfor $a\\neq0$.",
    );
    expect(rendered(out)).toHaveLength(3);
  });

  it("a page with no math returns null, so the paste is left alone", () => {
    expect(mathPasteText(noMath)).toBeNull();
    expect(mathPasteText("")).toBeNull();
    expect(mathPasteText("<p>MathJax is a library.</p>")).toBeNull();
  });

  it("KaTeX with no annotation (a selection cut through it) falls back to its MathML", () => {
    const html =
      '<span>Area: <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>π</mi><msup><mi>r</mi><mn>2</mn></msup></mrow></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="mord">π</span><span class="mord">r</span><span class="msupsub">2</span></span></span></span>';
    expect(mathPasteText(html)).toBe("Area: $\\pi r^2$");
  });

  it("KaTeX with neither annotation nor MathML keeps its visible text, once", () => {
    const html = 'x <span class="katex"><span class="katex-html"><span class="mord">a</span><span class="mbin">+</span><span class="mord">b</span></span></span>';
    expect(mathPasteText(html)).toBe("x $a+b$");
  });

  it("MathJax v3 without assistive MathML reads its CSS glyph classes", () => {
    const html =
      '<p>so <mjx-container class="MathJax" jax="CHTML"><mjx-math class="MJX-TEX"><mjx-mi class="mjx-i"><mjx-c class="mjx-c1D465 TEX-I"></mjx-c></mjx-mi><mjx-mo class="mjx-n"><mjx-c class="mjx-c2264"></mjx-c></mjx-mo><mjx-mn class="mjx-n"><mjx-c class="mjx-c31"></mjx-c></mjx-mn></mjx-math></mjx-container></p>';
    expect(mathPasteText(html)).toBe("so $x\\le1$");
  });

  it("Wikipedia's math element gives its alttext without the \\displaystyle wrapper", () => {
    const html =
      '<p>Euler: <span class="mwe-math-element"><span class="mwe-math-mathml-inline mwe-math-mathml-a11y" style="display: none;"><math xmlns="http://www.w3.org/1998/Math/MathML" alttext="{\\displaystyle e^{i\\pi }+1=0}"><semantics><mrow><msup><mi>e</mi><mrow><mi>i</mi><mi>π</mi></mrow></msup><mo>+</mo><mn>1</mn><mo>=</mo><mn>0</mn></mrow><annotation encoding="application/x-tex">{\\displaystyle e^{i\\pi }+1=0}</annotation></semantics></math></span><img src="x.svg" class="mwe-math-fallback-image-inline" alt="{\\displaystyle e^{i\\pi }+1=0}"></span>.</p>';
    expect(mathPasteText(html)).toBe("Euler: $e^{i\\pi }+1=0$.");
  });

  it("MathJax v2's frame and its source script give the formula once", () => {
    const html =
      '<p>Let <span class="MathJax_Preview">x^2</span><span class="MathJax" id="MathJax-Element-1-Frame"><nobr><span class="math"><span class="mi">x</span><span class="mn">2</span></span></nobr></span><script type="math/tex" id="MathJax-Element-1">x^2</script> grow.</p>';
    expect(mathPasteText(html)).toBe("Let $x^2$ grow.");
  });

  it("math touching a word gets a space so the composer still reads it as math", () => {
    const html = '<p>value<span class="katex"><span class="katex-mathml"><math><semantics><mi>k</mi><annotation encoding="application/x-tex">k</annotation></semantics></math></span></span>th</p>';
    const out = mathPasteText(html)!;
    expect(out).toBe("value $k$ th");
    expect(rendered(out)).toEqual(["$k$"]);
  });

  it("keeps paragraphs, lists and entities", () => {
    const html =
      '<p>A &amp; B:</p><ol><li>first <span class="katex"><span class="katex-mathml"><math><semantics><mi>a</mi><annotation encoding="application/x-tex">a</annotation></semantics></math></span></span></li><li>second</li></ol>';
    expect(mathPasteText(html)).toBe("A & B:\n\n1. first $a$\n2. second");
  });
});

describe("mathmlToTex", () => {
  const tex = (m: string) => mathmlToTex(parseHtml(m).children[0]);
  it("covers the common elements", () => {
    expect(tex("<math><msub><mi>a</mi><mrow><mi>i</mi><mo>+</mo><mn>1</mn></mrow></msub></math>")).toBe("a_{i+1}");
    expect(tex("<math><mroot><mi>x</mi><mn>3</mn></mroot></math>")).toBe("\\sqrt[3]{x}");
    expect(tex("<math><mi>sin</mi><mo>&#x2061;</mo><mi>θ</mi></math>")).toBe("\\sin\\theta");
    expect(tex("<math><mi>α</mi><mi>x</mi></math>")).toBe("\\alpha x");
    expect(tex("<math><mtext>if </mtext><mi>x</mi></math>")).toBe("\\text{if }x");
    expect(tex("<math><mover><mi>v</mi><mo>→</mo></mover></math>")).toBe("\\vec{v}");
    expect(tex('<math><mfenced open="[" close="]"><mi>a</mi><mi>b</mi></mfenced></math>')).toBe("[a,b]");
    expect(tex("<math><mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>0</mn></mtd></mtr><mtr><mtd><mn>0</mn></mtd><mtd><mn>1</mn></mtd></mtr></mtable></math>")).toBe(
      "\\begin{matrix}1 & 0 \\\\ 0 & 1\\end{matrix}",
    );
  });
});
