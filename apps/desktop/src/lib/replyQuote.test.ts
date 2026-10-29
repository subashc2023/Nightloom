import { describe, expect, it } from "vitest";
import {
  hasQuoteLine,
  quoteNeedsRender,
  quoteRuns,
  insertQuote,
  mirrorLines,
  pillParts,
  quoteBlock,
  replyRequest,
  requestReply,
  splitQuotes,
  takeReply,
  tightenDisplayMath,
} from "./replyQuote.svelte";
import transcriptSrc from "./Transcript.svelte?raw";

describe("quoteBlock (backlog 215)", () => {
  it("puts each line behind `> ` and a blank line as a bare `>`", () => {
    expect(quoteBlock("one\n\ntwo")).toBe("> one\n>\n> two");
  });
  it("drops leading blank lines and trailing whitespace", () => {
    expect(quoteBlock("\n\nhello  \n")).toBe("> hello");
  });
});

// Item 453: the passages are what `selectionText` read from the rendered
// replies in the harness (nightshift-code notes/runner-design/452-453-harness, #quote).
describe("quoteBlock with display maths (item 453)", () => {
  const aligned = "The two steps are\n\n$$\\begin{aligned}\na &= b + c \\\\\nd &= e - f\n\\end{aligned}$$\nand then the last one.";
  const tight = "The update is\n\n$$w \\leftarrow w - \\eta \\nabla L$$\nwhere eta is the rate.\n\n$$L = \\tfrac12 (y - \\hat y)^2$$\nand that is all.";
  const list = "First\n\n$$a^2 + b^2\n= c^2$$\n\nSecond\n\n$$e^{i\\pi} + 1 = 0$$";
  const cases = "Define\n\n$$f(x) = \\begin{cases}\n1 & x > 0 \\\\\n\n0 & \\text{otherwise}\n\\end{cases}$$\nThen go on.";
  const bracket = "Gauss says\n\n\\[\\sum_{i=1}^{n} i\n= \\frac{n(n+1)}{2}\\]\n\nwhich is the trick.";
  const bare = (q: string) => q.split("\n").filter((l) => l === ">").length;

  it("has no bare `>` line beside or inside a formula", () => {
    for (const p of [aligned, tight, list, cases, bracket]) expect(bare(quoteBlock(p))).toBe(0);
  });
  it("keeps every line of a multi-line formula, each quoted", () => {
    expect(quoteBlock(aligned)).toBe(
      "> The two steps are\n> $$\\begin{aligned}\n> a &= b + c \\\\\n> d &= e - f\n> \\end{aligned}$$\n> and then the last one.",
    );
    expect(quoteBlock(bracket)).toBe("> Gauss says\n> \\[\\sum_{i=1}^{n} i\n> = \\frac{n(n+1)}{2}\\]\n> which is the trick.");
  });
  it("is one quote block in the bubble (one bar)", () => {
    const sent = insertQuote("", 0, 0, list).text + "why?";
    expect(splitQuotes(sent).filter((s) => s.kind === "quote")).toHaveLength(1);
  });
  it("leaves paragraph breaks away from maths, and inline maths, as they were", () => {
    expect(quoteBlock("one\n\ntwo $x$ and $$y$$ here\n\nthree")).toBe("> one\n>\n> two $x$ and $$y$$ here\n>\n> three");
    expect(tightenDisplayMath("no maths\n\nat all")).toBe("no maths\n\nat all");
  });
});

describe("insertQuote", () => {
  it("into an empty box: the quote, a blank line, the caret", () => {
    const r = insertQuote("", 0, 0, "the passage");
    expect(r.text).toBe("> the passage\n\n");
    expect(r.caret).toBe(r.text.length);
  });

  it("mid-line: the quote starts on its own line, the rest follows the caret", () => {
    const r = insertQuote("I think this is wrong", 7, 7, "x = 2");
    expect(r.text).toBe("I think\n> x = 2\n\n this is wrong");
    expect(r.text.slice(r.caret)).toBe(" this is wrong");
  });

  it("stacks: a second reply at the caret after the first is its own quote", () => {
    const a = insertQuote("", 0, 0, "first");
    const typed = a.text + "about the first";
    const b = insertQuote(typed, typed.length, typed.length, "second");
    expect(b.text).toBe("> first\n\nabout the first\n> second\n\n");
    // Straight after the first quote's blank line: two quotes, not one.
    const c = insertQuote(a.text, a.caret, a.caret, "again");
    expect(c.text).toBe("> first\n\n> again\n\n");
    expect(splitQuotes(c.text).filter((s) => s.kind === "quote")).toHaveLength(2);
  });

  it("replaces a selection in the box", () => {
    const r = insertQuote("keep DROP keep", 5, 9, "q");
    expect(r.text).toBe("keep \n> q\n\n keep");
  });

  it("does not pile newlines when some already follow the caret", () => {
    const r = insertQuote("a\n\nb", 1, 1, "q");
    expect(r.text).toBe("a\n> q\n\nb");
    expect(r.text.slice(r.caret)).toBe("b");
  });

  it("an empty passage changes nothing", () => {
    expect(insertQuote("abc", 1, 1, "  \n")).toEqual({ text: "abc", caret: 1 });
  });
});

describe("splitQuotes", () => {
  it("round-trips an inserted quote into a quote and his words", () => {
    const r = insertQuote("", 0, 0, "line one\n\nline two");
    expect(splitQuotes(r.text + "my answer")).toEqual([
      { kind: "quote", text: "line one\n\nline two" },
      { kind: "text", text: "my answer" },
    ]);
  });
  it("leaves a message without quotes whole, and `>5` is not a quote", () => {
    expect(splitQuotes("just words\n>5 apples")).toEqual([{ kind: "text", text: "just words\n>5 apples" }]);
  });
  it("text before a quote keeps its own lines", () => {
    expect(splitQuotes("before\n\n> q\n\nafter")).toEqual([
      { kind: "text", text: "before" },
      { kind: "quote", text: "q" },
      { kind: "text", text: "after" },
    ]);
  });
});

describe("requestReply", () => {
  it("bumps the sequence with the passage", () => {
    const seq = replyRequest.seq;
    requestReply("p");
    expect(replyRequest).toEqual({ seq: seq + 1, passage: "p" });
  });
  it("is taken once", () => {
    requestReply("q");
    expect(takeReply()).toBe("q");
    expect(takeReply()).toBeNull();
  });
});

describe("the quote styled in the composer (item 223)", () => {
  it("marks `> ` lines and a bare `>`, not ordinary lines or `>5`", () => {
    const lines = mirrorLines("> quoted\n>\nplain\n>5 not a quote");
    expect(lines.map((l) => l.quote)).toEqual([true, true, false, false]);
    expect(lines[0]).toEqual({ quote: true, marker: "> ", rest: "quoted" });
    expect(lines[1]).toEqual({ quote: true, marker: ">", rest: "" });
  });

  it("does not mark what he types after an inserted quote", () => {
    const r = insertQuote("", 0, 0, "the passage\nover two lines");
    const typed = r.text.slice(0, r.caret) + "my answer" + r.text.slice(r.caret);
    const lines = mirrorLines(typed);
    expect(lines.filter((l) => l.quote).map((l) => l.rest)).toEqual(["the passage", "over two lines"]);
    expect(lines.find((l) => l.rest === "my answer")?.quote).toBe(false);
    expect(hasQuoteLine(typed)).toBe(true);
    expect(hasQuoteLine("no quote here\n>5")).toBe(false);
  });

  it("the layer's text is the textarea's value, character for character", () => {
    for (const t of ["", "a", "a\n", "> q\n\nafter", "x\n>\n> y \n  z\n\n", ">5\n> >nested"]) {
      expect(mirrorLines(t).map((l) => l.marker + l.rest).join("\n")).toBe(t);
    }
  });

  it("uses the bubble's rule: the same lines are quotes in both", () => {
    const t = "> a\n> b\nplain\n>\n> c";
    const quoteRests = mirrorLines(t).filter((l) => l.quote).map((l) => l.rest).join("\n");
    const bubble = splitQuotes(t).filter((s) => s.kind === "quote").map((s) => s.text).join("\n");
    expect(quoteRests).toBe(bubble);
  });
});

describe("the selection pill (item 223)", () => {
  it("one container, a divider between Ask aside and Reply", () => {
    expect(pillParts(true)).toEqual(["ask", "divider", "reply"]);
  });
  it("Reply alone, no divider, when asking aside is not offered", () => {
    expect(pillParts(false)).toEqual(["reply"]);
  });
  it("the markup draws every part inside one `.aside-pill`", () => {
    const pill = transcriptSrc.slice(transcriptSrc.indexOf('<div class="aside-pill"'));
    expect(pill).toMatch(/^<div class="aside-pill"[^>]*>\s*(<!--[\s\S]*?-->\s*)?\{#each pillParts\(canAsk\)/);
    expect(pill).toMatch(/class="pill-div"/);
  });
});

describe("quoteRuns and quoteNeedsRender (item 470: a reply's maths in the box)", () => {
  const draft = [
    "> $$\\begin{aligned}",
    "> A(\\overline{A}+B) + AB &= A\\overline{A} + AB + AB && \\text{T8}\\\\",
    "> &= AB && \\text{T3}'",
    "> \\end{aligned}$$",
    "",
    "Okay what I did was",
    "> a plain quote",
  ].join("\n");

  it("finds each run's lines, its range in the draft and its text without markers", () => {
    const runs = quoteRuns(draft);
    expect(runs.map((r) => [r.first, r.last])).toEqual([
      [0, 3],
      [6, 6],
    ]);
    expect(draft.slice(runs[0]!.start, runs[0]!.end).split("\n")).toHaveLength(4);
    expect(draft.slice(runs[0]!.start, runs[0]!.end).endsWith("\\end{aligned}$$")).toBe(true);
    expect(runs[0]!.src.startsWith("$$\\begin{aligned}\nA(")).toBe(true);
    expect(runs[1]!).toMatchObject({ src: "a plain quote", end: draft.length });
  });

  it("renders a quote with maths or Markdown, keeps a plain one line for line", () => {
    expect(quoteNeedsRender("$$x^2$$")).toBe(true);
    expect(quoteNeedsRender("inline \\(x\\) maths")).toBe(true);
    expect(quoteNeedsRender("some **bold** words")).toBe(true);
    expect(quoteNeedsRender("- a list item")).toBe(true);
    expect(quoteNeedsRender("a plain quote, nothing to typeset")).toBe(false);
  });

  it("leaves the text sent unchanged: the runs are read from it, never written", () => {
    const before = draft;
    quoteRuns(draft);
    expect(draft).toBe(before);
  });
});
