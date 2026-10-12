import { describe, expect, it } from "vitest";
import { mathCopyText } from "./mathCopy";
import { renderMath } from "./math";

// Item 352: a copied selection of a rendered reply gives each formula's TeX
// on the plain-text side. The HTML here is what the app draws: KaTeX's own
// output (`renderMath`) inside marked's paragraphs.
const inl = (tex: string) => renderMath(tex, false);

describe("mathCopyText", () => {
  it("inline math: his 2^4, not 24", () => {
    expect(mathCopyText(`<p>Two to the four is ${inl("2^4")}, which is 16.</p>`)).toBe("Two to the four is $2^4$, which is 16.");
  });

  it("display math on its own lines, between paragraphs", () => {
    const html = `<p>The sum is</p>\n${renderMath("\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}", true)}\n<p>for every <em>n</em>.</p>`;
    expect(mathCopyText(html)).toBe("The sum is\n\n$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$\n\nfor every n.");
  });

  it("mixed with text, lists and code", () => {
    const html = `<p>Facts:</p>\n<ul>\n<li>${inl("a^2+b^2=c^2")} holds</li>\n<li>plain</li>\n</ul>\n<pre><code>x = 2 ** 4\n</code></pre>`;
    expect(mathCopyText(html)).toBe("Facts:\n\n- $a^2+b^2=c^2$ holds\n- plain\n\nx = 2 ** 4");
  });

  it("a fragment cut through a formula (no annotation left) keeps its visible text once", () => {
    // What a range ending inside the visible copy clones before the copy
    // handler widens it: no MathML, only KaTeX's spans.
    const cut = `<p>is <span class="katex"><span class="katex-html" aria-hidden="true"><span class="base"><span class="mord">2</span><span class="msupsub"><span class="mord mtight">4</span></span></span></span></span></p>`;
    expect(mathCopyText(cut)).toBe("is $24$");
  });

  it("the widened fragment (the whole formula) gives its TeX", () => {
    expect(mathCopyText(`<p>is ${inl("2^4")}</p>`)).toBe("is $2^4$");
  });

  it("no rendered formula: null, so the browser's own copy stands", () => {
    expect(mathCopyText("<p>Plain <strong>text</strong> and $5 bills.</p>")).toBeNull();
    expect(mathCopyText("")).toBeNull();
  });

  it("a pre-wrapped element the copy marked keeps its line breaks; one marked normal inside it does not (review 2026-10-12)", () => {
    // `drawnOnly` marks his turn (`white-space: pre-wrap` in UserBubble) so
    // a copy across it and a reply with math keeps his lines.
    const html = `<div data-nl-ws="pre">line one\nline two\n\nline four <span data-nl-ws="normal">a\nb</span></div><p>so ${inl("2^4")}</p>`;
    expect(mathCopyText(html)).toBe("line one\nline two\n\nline four a b\n\nso $2^4$");
  });

  it("a table cell after a formula's cell: a tab, no stray space (review 2026-10-12)", () => {
    const html = `<table><tr><th>a</th><th>b</th></tr><tr><td>${inl("x_1")}</td><td>2</td></tr></table>`;
    expect(mathCopyText(html)).toBe("a\tb\n$x_1$\t2");
  });
});
