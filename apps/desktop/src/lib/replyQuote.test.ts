import { describe, expect, it } from "vitest";
import { insertQuote, quoteBlock, replyRequest, requestReply, splitQuotes, takeReply } from "./replyQuote.svelte";

describe("quoteBlock (backlog 215)", () => {
  it("puts each line behind `> ` and a blank line as a bare `>`", () => {
    expect(quoteBlock("one\n\ntwo")).toBe("> one\n>\n> two");
  });
  it("drops leading blank lines and trailing whitespace", () => {
    expect(quoteBlock("\n\nhello  \n")).toBe("> hello");
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
