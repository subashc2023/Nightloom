import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import { isProseBlock, proseBlocks, readsAsProse } from "./proseBlock";
import { extractStartPrompt } from "./handoff.svelte";
import mdSrc from "./markdown.ts?raw";

// The shape of his report (item 463): the wrap-up's start prompt, one long line.
const HANDOFF =
  "Read .agents/threads/club-research/thread.md, then mini-projects/00-README.md and the newest STATE section of HANDOFF.md; the club list is half done, so finish the scoring table first and then draft the email to the three clubs that answered.";

const render = (src: string) => {
  const m = new Marked();
  m.use(proseBlocks);
  return m.parse(src, { async: false, gfm: true }) as string;
};

describe("463: a fenced prompt wraps like a paragraph", () => {
  it("a hand-off's start-prompt block is prose, whatever else shares its fence line", () => {
    expect(isProseBlock(HANDOFF, "start-prompt")).toBe(true);
    expect(isProseBlock("short", "md start-prompt")).toBe(true);
    expect(render("```start-prompt\n" + HANDOFF + "\n```")).toMatch(/^<pre class="prose-block"><code class="language-start-prompt">Read \.agents/);
  });
  it("a ```text or ```markdown paragraph is prose", () => {
    expect(isProseBlock(HANDOFF, "text")).toBe(true);
    expect(isProseBlock(HANDOFF, "markdown")).toBe(true);
    expect(render("```text\n" + HANDOFF + "\n```")).toContain('<pre class="prose-block">');
  });
  it("code stays code: a language tag, or a text block laid out in columns or boxes", () => {
    expect(isProseBlock("const a = 1; // and then we read the next eight words here", "ts")).toBe(false);
    expect(isProseBlock(HANDOFF, "bash")).toBe(false);
    expect(render("```rust\nfn main() {}\n```")).toBe('<pre><code class="language-rust">fn main() {}\n</code></pre>\n');
    expect(readsAsProse("src/\n├── lib/\n│   └── main.ts\n└── app.css")).toBe(false);
    expect(readsAsProse("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(false);
    expect(readsAsProse("name      size   when\nfoo.txt   12 KB  today")).toBe(false);
    expect(readsAsProse("ls -la && npm run build -- --watch")).toBe(false);
  });
  it("a block with no language keeps item 384's rule (wraps), drawn as before unless it reads as prose", () => {
    expect(render("```\nx = 1\n```")).toBe("<pre><code>x = 1\n</code></pre>\n");
  });
  it("the hand-off card still reads the start prompt from its fence", () => {
    expect(extractStartPrompt("Done.\n\n```start-prompt\n" + HANDOFF + "\n```\n")).toBe(HANDOFF);
  });
  it("replies use it (app.css's `pre.prose-block` wrap and the Copy button are measured in WebKit: nightshift-code notes/runner-design/452-453-harness #prose)", () => {
    expect(mdSrc).toContain("replyMarked.use(proseBlocks);");
  });
});
