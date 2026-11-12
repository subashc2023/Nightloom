import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import { composerState, liveSpans } from "./composerEditor";
import { emphasisLines } from "./emphasisLines";
import { math } from "./math";
import { tilde } from "./tilde";

// Item 670 (his bug, 2026-11-12): writing about C pointers, two `*` on unrelated lines were paired into italics.
// Bold, italics and strikethrough never cross a line break — in the formatted message box and in replies.

/** The reply instance's emphasis rules (`renderReply` minus DOMPurify, which needs a DOM). */
const reply = new Marked();
reply.use(math);
reply.use(tilde);
reply.use(emphasisLines);
const html = (src: string) => reply.parse(src, { async: false, gfm: true }) as string;

/** What the box draws as emphasis, as [kind, source] pairs. */
function drawn(text: string): [string, string][] {
  return liveSpans(composerState(text, [], text.length, false))
    .filter((s) => s.kind === "em" || s.kind === "strong" || s.kind === "strike")
    .map((s) => [s.kind, text.slice(s.from, s.to)]);
}

const HIS_C = [
  "Pointers in C:",
  "int x = 3;",
  "int *p = &x;",
  "*p = 5;",
  "int* q = p;",
  "char **argv;",
  "int** pp = &q;",
  "y = a * b;",
].join("\n");

describe("item 670: emphasis stays on one line", () => {
  it("his case: C on several lines draws no emphasis", () => {
    expect(drawn(HIS_C)).toEqual([]);
    expect(html(HIS_C)).not.toMatch(/<em>|<strong>/);
  });

  it("int *p; … *p = 5; across lines", () => {
    for (const t of ["int *p;\nx = 1;\n*p = 5;", "*p = 5;\nint* q = p;", "x = *p;\ny = q* 2;"]) {
      expect(drawn(t)).toEqual([]);
      expect(html(t)).not.toMatch(/<em>/);
    }
  });

  it("**argv on one line does not bold up to int** on the next", () => {
    const t = "char **argv;\nint** pp;";
    expect(drawn(t)).toEqual([]);
    expect(html(t)).not.toMatch(/<strong>/);
  });

  it("a * b * c stays text (a star with a space inside neither opens nor closes)", () => {
    expect(drawn("a * b * c")).toEqual([]);
    expect(html("a * b * c")).toBe("<p>a * b * c</p>\n");
  });

  it("*italic* and **bold** still draw, on each line", () => {
    const t = "**bold** and *it*\n*x* y";
    expect(drawn(t)).toEqual([
      ["strong", "**bold**"],
      ["em", "*it*"],
      ["em", "*x*"],
    ]);
    expect(html(t)).toBe("<p><strong>bold</strong> and <em>it</em>\n<em>x</em> y</p>\n");
  });

  it("a rejected run's later marks on the same line still pair", () => {
    expect(drawn("***a** b\nc*")).toEqual([["strong", "**a**"]]);
    expect(html("***a** b\nc*")).toBe("<p>*<strong>a</strong> b\nc*</p>\n");
  });

  it("strikethrough stays on one line too", () => {
    const t = "~~a\nb~~ and ~~c~~";
    expect(drawn(t)).toEqual([["strike", "~~c~~"]]);
    expect(html(t)).toBe("<p>~~a\nb~~ and <del>c</del></p>\n");
  });

  it("code spans and fenced blocks are never emphasis", () => {
    const t = "`*p` and\n`q*` then *ok*";
    expect(drawn(t)).toEqual([["em", "*ok*"]]);
    expect(html(t)).toBe("<p><code>*p</code> and\n<code>q*</code> then <em>ok</em></p>\n");
    const fence = "```c\nint *p;\n*p = 5;\n```\nthen *it*";
    expect(drawn(fence)).toEqual([["em", "*it*"]]);
    expect(html(fence)).toMatch(/<code class="language-c">int \*p;\n\*p = 5;\n<\/code>/);
  });

  it("a blank line still ends a run (CommonMark's own rule)", () => {
    expect(drawn("*p = 5;\n\nint* q;")).toEqual([]);
    expect(html("*p = 5;\n\nint* q;")).not.toMatch(/<em>/);
  });
});
