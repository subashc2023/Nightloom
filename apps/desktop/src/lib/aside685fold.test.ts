import { describe, expect, it } from "vitest";
import viewSrc from "./AsideView.svelte?raw";
import { FOLD_AT, INPUT_MS, UNFOLD_AT, foldAnimates, nextFold } from "./asideHeadFold";

/**
 * Item 685 (2026-11-13): the aside tab's header card (673 C1) folds to one
 * line — the title, Fold into thread, Close — once he scrolls down the
 * thread, and back to the full card near the top. The suite runs in node, so
 * the layout is pinned by reading the source; the geometry was measured in
 * WebKit (notes/runner-design/685-report-2026-11-13.md, nightshift-code).
 */
const rule = (sel: string): string => {
  const i = viewSrc.indexOf(`${sel} {`);
  expect(i, sel).toBeGreaterThan(-1);
  return viewSrc.slice(i, viewSrc.indexOf("}", i));
};

describe("685: the fold's thresholds", () => {
  it("folds past 48 px and unfolds only under 16 px, keeping its state between", () => {
    expect([FOLD_AT, UNFOLD_AT]).toEqual([48, 16]);
    expect(nextFold(false, 0)).toBe(false);
    expect(nextFold(false, 48)).toBe(false);
    expect(nextFold(false, 49)).toBe(true);
    // Between the two it stays as it was: no flicker at either edge.
    for (const top of [16, 30, 48]) {
      expect(nextFold(true, top)).toBe(true);
      expect(nextFold(false, top)).toBe(false);
    }
    expect(nextFold(true, 15)).toBe(false);
    expect(nextFold(true, 0)).toBe(false);
  });

  it("animates only his own scrolling, and never under Reduce motion", () => {
    expect(foldAnimates(false, false, 10)).toBe(true);
    expect(foldAnimates(false, true, 10_000)).toBe(true);
    expect(foldAnimates(false, false, INPUT_MS + 1)).toBe(false);
    expect(foldAnimates(true, true, 0)).toBe(false);
    expect(viewSrc).toMatch(/class:instant=\{!animate\}/);
    expect(viewSrc).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.aside-head\.twin::after,\s*\.twin \.aside-head-in,\s*\.aside-head-full,\s*\.aside-head-strip \{\s*transition: none;/);
  });
});

describe("685: the header card and its strip", () => {
  const head = viewSrc.slice(viewSrc.indexOf('<header class="aside-head twin"'), viewSrc.indexOf("</header>", viewSrc.indexOf('<header class="aside-head twin"')));

  it("Classic's Kicker strip has no fold", () => {
    const classicHead = viewSrc.slice(viewSrc.indexOf('<header class="aside-head">'), viewSrc.indexOf("</header>"));
    expect(classicHead).not.toMatch(/folded|aside-head-strip/);
  });

  it("the strip is the title, then Fold into thread and Close; each layer is inert while hidden", () => {
    expect(head).toMatch(/class:folded=\{showFolded\}/);
    expect(head).toMatch(/class="aside-head-full" bind:this=\{fullEl\} inert=\{showFolded\}/);
    const strip = head.slice(head.indexOf('<div class="aside-head-strip"'));
    expect(strip).toMatch(/inert=\{!showFolded\}/);
    expect(strip).toMatch(/class="aside-strip-title"[\s\S]*<AsideFoldPanel \{aside\} part="button" \{open\} twin \/>[\s\S]*class="ns-btn ghost small aside-view-close"/);
    expect(rule(".aside-strip-title")).toMatch(/text-overflow: ellipsis;/);
    // Renaming keeps the full card, where the field is.
    expect(viewSrc).toMatch(/const showFolded = \$derived\(folded && !naming\);/);
  });

  it("the band keeps the strip's height, so a fold moves nothing in the thread", () => {
    expect(rule(".aside-head.twin")).toMatch(/height: calc\(var\(--strip-h\) \+ 18px\);/);
    expect(rule(".twin .aside-head-in")).toMatch(/position: absolute;/);
    // The thread's head keeps the full card's room: the card's extra over the band, less the column's gap.
    expect(rule(".aside-head-room")).toMatch(/height: max\(0px, calc\(var\(--head-full\) - var\(--strip-h\) \+ 14px\)\);\s*margin-bottom: -26px;/);
    expect(viewSrc).toMatch(/lead=\{room\}/);
  });

  it("the fold reads the thread's own scroller, so a place put back brings its fold", () => {
    expect(viewSrc).toMatch(/onscrollcapture=\{bodyScrolled\}/);
    expect(viewSrc).toMatch(/t\.classList\.contains\("transcript"\)\) readFold\(t\.scrollTop\)/);
    expect(viewSrc).toMatch(/requestAnimationFrame\(\(\) => \{\s*const t = body\.querySelector<HTMLElement>\("\.transcript"\);/);
  });
});
