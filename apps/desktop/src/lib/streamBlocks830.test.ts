// Item 830: a streaming reply rendered by blocks must draw exactly what the whole render drew, at every delta.
import { describe, expect, it, vi } from "vitest";
// The sanitizer needs a DOM vitest does not have here; it runs per block and whole alike (stream626, math837 do the same).
vi.mock("dompurify", () => ({ default: { sanitize: (h: string) => h } }));
import { renderReply, renderMarkdown, streamingTail } from "./markdown";
import { renderStreamingMarkdown, renderStreamingReply, settledBlocks } from "./streamBlocks";

const STATS = [
  "## Part 4: sampling distribution of the mean",
  "For lecture 4 the estimator is $\\bar X = \\frac{1}{n}\\sum_{i=1}^n X_i$ with $E[\\bar X] = \\mu$. So the error shrinks like $1/\\sqrt{n}$.",
  "$$\\text{CI}_{95\\%} = \\bar x \\pm t_{0.975,\\,n-1}\\,\\frac{s}{\\sqrt{n}}$$",
  "$$\n\\hat\\sigma^2 = \\frac{1}{n-1}\n\n\\sum_i (x_i - \\bar x)^2\n$$",
  "\\[\n\\Phi(z) = \\int_{-\\infty}^z \\phi(t)\\,dt\n\\]",
  "| $n$ | $t_{0.975}$ | half-width |\n|---|---|---|\n| 5 | 2.776 | 1.241 |\n| 30 | 2.045 | 0.373 |",
  "```python\nimport numpy as np\n\n\ndef ci(x):\n    return np.mean(x)\n```",
  "1. state the assumptions\n\n2. name the pivot\n\n   with a second paragraph, indented\n\n3. interpret the interval",
  "- a bullet\n- another **bold** one",
  "> a quote\ncontinued lazily",
  "> a second quote",
  "    indented code after a blank line",
  "Setext heading\n==============",
  "A paragraph with a cite [[1]](https://example.com/page \"Page\") and `code`.",
  "***",
  "Sources\n\n- [Example](https://example.com)\n- [Other](https://other.org)",
].join("\n\n");

const TAGS = "Before the card.\n\n<handoff>\nNext chat: do the thing.\n\nWith a blank line inside.\n</handoff>\n\nAfter it.\n\n<ask>\nWhich one?\n</ask>";
const REF = "See [the paper][p] for details.\n\nMore text.\n\n[p]: https://example.com/paper";

function everyPrefix(text: string, step: number, check: (prefix: string) => void): void {
  for (let n = 1; n <= text.length; n += step) check(text.slice(0, n));
  check(text);
}

describe("streamBlocks (item 830)", () => {
  for (const [name, text] of [["stats reply", STATS], ["handoff and ask tags", TAGS], ["reference link", REF]] as const) {
    it(`draws what the whole render drew at every delta: ${name}`, () => {
      everyPrefix(text, 7, (p) => expect(renderStreamingReply(p)).toBe(renderReply(streamingTail(p))));
    });
    it(`the phone's live reply too: ${name}`, () => {
      const opts = { breaks: true, localImagesAsText: true };
      everyPrefix(text, 13, (p) => expect(renderStreamingMarkdown(p, opts)).toBe(renderMarkdown(streamingTail(p), opts)));
    });
  }

  it("cuts a long reply into finished blocks, leaving only the last open one to render per delta", () => {
    const { blocks, tail } = settledBlocks(STATS);
    expect(blocks.join("") + tail).toBe(STATS);
    expect(blocks.length).toBeGreaterThan(8);
    expect(tail.length).toBeLessThan(200);
  });

  it("never cuts inside a fence or display maths, before a list item, or after raw HTML or a link definition", () => {
    for (const b of settledBlocks(STATS).blocks) {
      expect((b.match(/^```/gm) ?? []).length % 2).toBe(0);
      expect((b.match(/\$\$/g) ?? []).length % 2).toBe(0);
    }
    expect(settledBlocks(STATS).blocks.some((b) => /^\d+\. /.test(b) && !b.startsWith("1."))).toBe(false);
    expect(settledBlocks(TAGS).blocks.join("")).toBe("Before the card.\n\n");
    expect(settledBlocks(REF).blocks).toEqual([]);
  });

  it("the last line, still arriving, never starts a block of its own", () => {
    expect(settledBlocks("Para one.\n\n1").blocks).toEqual([]);
    expect(settledBlocks("Para one.\n\n1. item\n").blocks).toEqual([]);
  });
});
