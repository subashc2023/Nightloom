import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import { math, renderMath } from "./math";

// The `$…$` guards are the interesting half of this file: each one was added
// against a sentence a model actually wrote, where the alternative was a
// paragraph of prose silently disappearing into a red KaTeX error. A guard
// removed as "redundant" fails on exactly those sentences and nowhere else, so
// each is pinned here with the text it was written for.

const marked = new Marked();
marked.use(math);

function render(src: string): string {
  return marked.parse(src, { async: false, gfm: true }) as string;
}

function typeset(src: string): boolean {
  return render(src).includes("katex");
}

describe("the four dollar-guards", () => {
  it("leaves a money range alone: a space just inside a delimiter", () => {
    // "between $5 and $10" — the closing `$` is a second price, and without
    // the no-space rule the words between two prices become a formula.
    expect(typeset("The plan runs between $5 and $10 a month.")).toBe(false);
  });

  it("leaves two adjacent prices alone: a digit just past the closing $", () => {
    // "$100$200" — both delimiters sit against digits, which is what a price
    // pair looks like and never what a formula does.
    expect(typeset("Tiers are $100$200 depending on seats.")).toBe(false);
  });

  it("does not let a formula span a line break", () => {
    // "$1,200 total.\nCode stays code:" — a stray `$` two lines down would
    // otherwise reach back and swallow the sentence in between.
    expect(
      typeset("It came to $1,200 total.\nThe variable is $HOME on Linux."),
    ).toBe(false);
  });

  it("does not let a formula reach into a code span", () => {
    // "…or $5. Use `$PATH`" — this rule cannot be left to markdown's own code
    // spans, because an extension tokenizer runs before those exist.
    expect(typeset("Costs $5. Use `$PATH` to find it.")).toBe(false);
  });

  it("refuses a span longer than the cap", () => {
    // Every one of the failures above is a long span, so the cap is the
    // backstop for the shapes the four rules do not name.
    const long = "x".repeat(200);
    expect(typeset(`A $${long}$ B`)).toBe(false);
  });

  it("still typesets a real formula that ends against a letter", () => {
    // The digit guard is deliberately narrow. Broadening it to any word
    // character would take out `$n$th` and most inline algebra in prose.
    expect(typeset("the $n$th term")).toBe(true);
  });

  it("still typesets a single-character formula", () => {
    // The rule needs a separate one-character arm, because "no space just
    // inside either delimiter" reads as two distinct characters otherwise and
    // `$x$` is the most common inline formula there is.
    expect(typeset("let $x$ be even")).toBe(true);
  });
});

describe("the four delimiter spellings", () => {
  it("typesets $…$ inline", () => {
    // Models write math in four spellings and there is no negotiating which.
    // A spelling that stops being recognized shows up as raw TeX in the
    // transcript, not as an error.
    expect(typeset("mass-energy: $E = mc^2$ exactly")).toBe(true);
  });

  it("typesets \\(…\\) inline", () => {
    // The one at real risk: `\(` is also a markdown escape, so this only
    // works while the extension is consulted before the built-in tokenizer.
    expect(typeset("mass-energy: \\(E = mc^2\\) exactly")).toBe(true);
  });

  it("typesets $$…$$ as display", () => {
    expect(render("$$E = mc^2$$")).toContain("katex-display");
  });

  it("typesets \\[…\\] as display", () => {
    expect(render("\\[E = mc^2\\]")).toContain("katex-display");
  });

  it("typesets a ```math fence and leaves ```latex as source", () => {
    // ```math is the fenced spelling GitHub renders. A fenced LaTeX listing
    // is usually source the reader wants to see rather than typeset.
    expect(render("```math\nE = mc^2\n```")).toContain("katex");
    expect(typeset("```latex\nE = mc^2\n```")).toBe(false);
  });

  it("does not pair a $$ opener with a \\] closer", () => {
    // The block tokenizer matches either opener against either closer and has
    // to reject the mismatch itself, or `$$x\]` swallows the rest of the note.
    expect(typeset("$$E = mc^2\\]")).toBe(false);
  });

  it("typesets a display block containing a blank line", () => {
    // The entire reason there is a block tokenizer as well as an inline one:
    // markdown has already split a `\begin{aligned}` across a blank line into
    // two paragraphs by the time the inline rule would see it.
    const src = "$$\n\\begin{aligned}\na &= b \\\\\n\nc &= d\n\\end{aligned}\n$$";
    expect(render(src)).toContain("katex-display");
  });
});

describe("half-streamed text", () => {
  it("leaves an unterminated formula as literal characters", () => {
    // This runs on every delta of a streaming reply, so every formula is
    // unterminated for a moment. Rendering the opener as a formula-so-far
    // would flash a red error through the whole of a long derivation.
    expect(typeset("the integral $$\\int_0^1")).toBe(false);
    expect(typeset("the integral \\(\\int_0^1")).toBe(false);
  });

  it("leaves an empty pair of delimiters alone", () => {
    // `$$` `$$` with nothing between it is a typo, and asking KaTeX to
    // typeset nothing produces an empty box rather than the text.
    expect(typeset("$$  $$")).toBe(false);
  });
});

describe("renderMath", () => {
  it("shows a malformed formula in place instead of failing the message", () => {
    // `throwOnError: false`. A throw here costs the whole assistant message,
    // which is the wrong trade for one bad brace in a long reply.
    const html = renderMath("\\frac{", false);
    expect(html).toContain("katex-error");
  });
});
