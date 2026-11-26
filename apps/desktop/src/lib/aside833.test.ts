import { describe, expect, it } from "vitest";
import cardSrc from "./AsideCard.svelte?raw";
import composerSrc from "./Composer.svelte?raw";
import foldSrc from "./AsideFoldPanel.svelte?raw";

/**
 * Item 833 (his shots, 2026-11-17): in a narrow aside card both pickers read
 * "chat's …", the line under the box was cut, the cache strip and the head's
 * copy and × ran past the card's right edge. The suite runs in node, so the
 * rules are pinned by source; the widths measured are in nightshift-code
 * notes/runner-design/833-report-2026-11-18.md (WebKit harness).
 */
describe("833: the aside box at narrow widths", () => {
  it("an aside's pickers swap to their value alone from fold 4, never cut", () => {
    expect(composerSrc).toMatch(/<span class="pick-name has-short"><span class="pick-long">\{asideModelLabel\}<\/span><span class="pick-short">\{asideModelShort\}<\/span>/);
    expect(composerSrc).toMatch(/<span class="pick-name has-short"><span class="pick-long">\{asideEffortLabel\}<\/span><span class="pick-short">\{asideEffortShort\}<\/span>/);
    expect(composerSrc).toMatch(/\.row:is\(\[data-fold="4"\], \[data-fold="5"\], \[data-fold="6"\]\) \.pick-name\.has-short \{\s*max-width: none;/);
    // The row refolds when the aside's labels change.
    expect(composerSrc).toMatch(/asideModelLabel,\s*asideEffortLabel,/);
  });

  it("the cache chip stays inside its row and wraps only at a ' · '", () => {
    expect(composerSrc).toMatch(/\.bottom-cache \{[^}]*max-width: 100%;[^}]*flex-wrap: wrap;/);
    expect(composerSrc).toContain('nextEst.line.split(" · ")');
    expect(composerSrc).toMatch(/\.next-part \{\s*white-space: nowrap;/);
    // The loss bar keeps one line.
    expect(composerSrc).toMatch(/\.bottom-cache\.losing \{[^}]*flex-wrap: nowrap;/);
  });

  it("a wrapped line of the cache chip never starts with '·' (merge round W)", () => {
    // Each part carries its separator in front at one width; the lines sit
    // that width left inside a clip, so each line's first separator is unseen.
    expect(composerSrc).toMatch(/\.cache-flow \{[^}]*overflow: hidden;/);
    expect(composerSrc).toMatch(/\.cache-lines \{[^}]*flex-wrap: wrap;[^}]*margin-left: calc\(-1 \* var\(--cache-sep\)\);/);
    expect(composerSrc).toMatch(/\.cache-sep \{[^}]*width: var\(--cache-sep\);/);
    expect(composerSrc).toContain('<span class="cache-part next-part"><span class="cache-sep">·</span>{part}</span>');
  });

  it("the card's head folds by measurement and wraps at its floor, never past the edge", () => {
    expect(cardSrc).toMatch(/bind:this=\{headEl\}\s*data-fold=\{headFold\}/);
    expect(cardSrc).toContain('<span class="head-word">{" "}cached</span>'); // item 1008: the space survives Svelte
    expect(cardSrc).toMatch(/\.aside-card-head\[data-fold="4"\] \{\s*flex-wrap: wrap;/);
    expect(foldSrc).toContain('aria-label="Fold into thread"');
    expect(foldSrc).toContain('<span class="fold-btn-word">');
  });
});
