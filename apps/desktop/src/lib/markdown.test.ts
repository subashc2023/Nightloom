import { Marked } from "marked";
import { describe, expect, it } from "vitest";
import { markdownOptions } from "./markdown";

// renderMarkdown sanitises through DOMPurify, which needs a DOM this
// environment lacks; its marked options are what changed (nightshift 300 A32).
const parse = (src: string, breaks?: boolean) => new Marked().parse(src, markdownOptions(breaks === undefined ? {} : { breaks })) as string;

describe("markdownOptions (300 A32)", () => {
  it("keeps the desktop's default: a single newline joins the paragraph", () => {
    expect(markdownOptions()).toEqual({ async: false, gfm: true, breaks: false });
    expect(parse("21\n22\n23")).toBe("<p>21\n22\n23</p>\n");
  });
  it("on the phone keeps one number per line as line breaks", () => {
    expect(parse("21\n22\n23", true)).toBe("<p>21<br>22<br>23</p>\n");
  });
  it("leaves a code fence's lines alone", () => {
    expect(parse("```\na\nb\n```", true)).toBe("<pre><code>a\nb\n</code></pre>\n");
  });
});
