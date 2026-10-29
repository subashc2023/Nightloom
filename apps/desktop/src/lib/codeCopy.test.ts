import msgSrc from "./AssistantMessage.svelte?raw";
import { describe, expect, it } from "vitest";
import { marked } from "marked";
const renderReply = (src: string) => marked.parse(src, { async: false, gfm: true }) as string;

describe("384: reply code blocks wrap when they are prose, and carry Copy", () => {
  it("a fence with no language has no language class (so it wraps); one with a language keeps it", () => {
    expect(renderReply("```\nICS 51. Read these in order: HANDOFF.md, AGENTS.md\n```")).toMatch(/<pre><code>ICS 51/);
    expect(renderReply("```rust\nfn main() {}\n```")).toContain('class="language-rust"');
  });
  it("replies run the Copy action", () => {
    // app.css's wrap and Copy rules: vitest empties CSS imports, so they are
    // measured in WebKit instead (nightshift-code notes/runner-design/384-snap-700.png: 638/638 wrapped).
    const msg = msgSrc;
    // Item 452: the HTML is patched in place by liveHtml rather than {@html}.
    expect(msg).toContain("use:liveHtml={renderReply(g.seg.text)} use:memoryRefs={{ hits: memHits, text: g.seg.text }} use:codeCopy>");
  });
});
