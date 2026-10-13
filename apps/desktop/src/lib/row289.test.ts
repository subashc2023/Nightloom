import { describe, expect, it } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import welcomeSrc from "./Welcome.svelte?raw";
import { firstFit } from "./fold";

/**
 * Item 289 (2026-10-02): the composer's controls split into two lopsided
 * rows on the new-chat page at his zoom. The row now has six fold levels
 * before its floor, and the new-chat column is the chat composer's width.
 * Layout is measured in the shots (`283-shots/289-*`); this pins the
 * order of the steps the markup and CSS carry.
 */
describe("the composer's row folds before it splits (289)", () => {
  it("has six levels, the floor last", () => {
    expect(composerSrc).toMatch(/const ROW_FOLD_MAX = 6;/);
    expect(composerSrc).toMatch(/\.row\[data-fold="6"\]::after/);
    expect(composerSrc).not.toMatch(/\.row\[data-fold="4"\]::after/);
  });
  it("hides the token estimate at 2 and turns Council to its icon at 3, before the floor", () => {
    expect(composerSrc).toMatch(/\[data-fold="2"\][^{]*\.draft-tokens \{\s*display: none;/);
    expect(composerSrc).toMatch(/\[data-fold="3"\][^{]*\.council-ico \{\s*display: inline-flex;/);
    expect(composerSrc).toMatch(/class="council-word">Council</);
  });
  it("at the floor the actions go to row two (pickers stay left on row one)", () => {
    expect(composerSrc).toMatch(/\.row\[data-fold="6"\] > \.act \{\s*order: 2;/);
  });
  it("stops at the first level that fits", () => {
    const tried: number[] = [];
    expect(firstFit((l) => (tried.push(l), l >= 3), 6)).toBe(3);
    expect(tried).toEqual([0, 1, 2, 3]);
  });
  it("the new-chat column is the chat composer's width, not the ring's", () => {
    expect(welcomeSrc).toMatch(/const colMax = \$derived\(Math\.max\(320, Math\.min\(760, w - 40\)\)\);/);
  });
});
