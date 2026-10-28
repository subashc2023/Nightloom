import { describe, expect, it } from "vitest";
import cardSrc from "./AsideCard.svelte?raw";
import viewSrc from "./AsideView.svelte?raw";
import { fmtTokens } from "./tokens";

/**
 * Nightshift backlog 358 (2026-10-13, his screenshots): once an aside's
 * answer completed, the composer's line under the box swapped "Answering —"
 * for "Answers from ‹chat›", and an untitled chat is named by its whole first
 * prompt — fifteen lines that took the card's room from the answer. The head
 * gained "188,342 read from cache", drawn as "1…". The tab printed the prompt
 * twice and sat left of the chat's centred column. The suite runs in node, so
 * the layout rules are pinned by reading the component source; the numbers
 * are in notes/runner-design/357-358-report.md (WebKit harness
 * `harness/aside358.html`).
 */
describe("358: the aside after its answer completes", () => {
  for (const [name, src, scope] of [
    ["card", cardSrc, ".aside-card"],
    ["tab", viewSrc, ".aside-view"],
  ] as const) {
    it(`${name}: the composer's line is one line, cut, and the format chip never gives way`, () => {
      const rule = (sel: string) => {
        const i = src.indexOf(`${scope} :global(${sel}) {`);
        expect(i, sel).toBeGreaterThan(-1);
        return src.slice(i, src.indexOf("}", i));
      };
      const line = rule(".composer.aside .aside-line");
      expect(line).toContain("white-space: nowrap");
      expect(line).toContain("text-overflow: ellipsis");
      expect(line).toContain("min-width: 0");
      // A 0 basis split the row with the spacer and cut the name whole.
      expect(line).toContain("flex: 1 1 auto");
      expect(rule(".composer.aside .aside-line em")).toContain("max-width");
      expect(rule(".composer.aside .bottom-toggle")).toContain("flex-shrink: 0");
    });
    it(`${name}: the cache chip is short and keeps its room; the full count is its tip`, () => {
      expect(src).not.toContain("read from cache</span>");
      expect(src).toMatch(/class="ns-chip mono aside-cache"[^>]*tokens read from cache/);
      expect(src).toContain("{fmtTokens(last.cacheRead)} cached");
    });
  }

  it("the short count reads as the gauge does", () => {
    expect(fmtTokens(188_342)).toBe("188k");
    expect(fmtTokens(41_230)).toBe("41k");
    expect(fmtTokens(1_234)).toBe("1.2k");
  });

  it("card: the cache chip is among the head's things that never shrink", () => {
    expect(cardSrc).toMatch(/\.aside-card-head > \.ns-btn,\s*\.aside-card-head > \.aside-cache \{\s*flex-shrink: 0;/);
  });

  it("tab: the chat's centred 760 px column for the thread and the composer", () => {
    expect(viewSrc).toMatch(/\.aside-view-col \{\s*max-width: 760px;\s*margin: 0 auto;/);
    expect(viewSrc).toMatch(/\.aside-view-foot-inner \{\s*max-width: 760px;\s*margin: 0 auto;/);
    // The transcript's own padding (Transcript.svelte `.transcript`).
    expect(viewSrc).toMatch(/\.aside-view-scroll \{[^}]*padding: 28px 20px 20px;/);
    // Title, head, quote and turns all sit inside the column.
    const open = viewSrc.indexOf('<div class="aside-view-col">');
    expect(open).toBeGreaterThan(-1);
    for (const piece of ['class="aside-view-title"', 'class="aside-view-head"', 'class="aside-view-turns"'])
      expect(viewSrc.indexOf(piece)).toBeGreaterThan(open);
  });

  it("tab: the head is one row and the chat's name gives way, so the prompt is not printed in full", () => {
    expect(viewSrc).toMatch(/\.aside-view-head \{[^}]*flex-wrap: nowrap;/);
    expect(viewSrc).toMatch(/\.aside-view-of \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis;/);
  });
});
