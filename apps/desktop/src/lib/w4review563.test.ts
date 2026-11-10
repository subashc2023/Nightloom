import { describe, expect, it } from "vitest";
import welcomeSrc from "./Welcome.svelte?raw";
import { columnWithoutRow, dialSize, readoutsFit } from "./newChatPage";

// The w4 review of item 563: lit hides the calm row while the read-outs
// show, so a choice made on the measured column could flip every frame.
// The page's loop, modelled: the column measures with the row unless the
// read-outs show; the choice is then made again from that measure.
const PAD = 26;
const FRAME = 58 + PAD * 2;
const C = 300; // the column without the row
const R = 44; // the row
const GAP = 10;

function settle(w: number, h: number, decide: (colH: number, rowH: number) => boolean): boolean[] {
  let wide = false;
  const seen: boolean[] = [];
  for (let i = 0; i < 6; i++) {
    const rowH = wide ? 0 : R; // lit: hidden while wide
    const colH = wide ? C : C + R + GAP;
    wide = decide(colH, rowH);
    seen.push(wide);
  }
  return seen;
}

const old = (w: number, h: number) => (colH: number) => {
  const size = dialSize(h, colH + FRAME);
  return size > 0 && readoutsFit(w, size);
};
const fixed = (w: number, h: number) => (colH: number, rowH: number) => {
  const size = dialSize(h, colH + FRAME);
  const bare = dialSize(h, columnWithoutRow(colH, rowH) + FRAME);
  return size > 0 && bare > 0 && readoutsFit(w, bare);
};

describe("563 read-outs choice (w4 review)", () => {
  // A pane where the dial is height-bound: 320 px without the row, 266 with it.
  const h = C + FRAME + 320;
  const w = 320 + 540 - 20; // fits the smaller dial, not the larger

  it("the old rule flips every frame in the band", () => {
    const s = settle(w, h, old(w, h));
    expect(s.slice(2)).toEqual([true, false, true, false]);
  });

  it("deciding on the column without the row settles", () => {
    const s = settle(w, h, fixed(w, h));
    expect(new Set(s.slice(1)).size).toBe(1);
  });

  it("a hidden or absent row subtracts nothing", () => {
    expect(columnWithoutRow(300, 0)).toBe(300);
    expect(columnWithoutRow(354, 44)).toBe(300);
  });

  it("Welcome decides on the bare dial and measures the row", () => {
    expect(welcomeSrc).toMatch(/readoutsFit\(w, bareSize\)/);
    expect(welcomeSrc).toMatch(/class="ready"[^>]*bind:clientHeight=\{rowH\}/);
  });
});
