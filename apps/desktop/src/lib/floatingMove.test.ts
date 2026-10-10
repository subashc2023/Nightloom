import { describe, expect, it } from "vitest";
import { EDGE_REACH, EDGE_W, STRIP_REACH, clampPos, outcome, zoneArming, zoneAt, zoneLabel } from "./floatingMove";
import type { Layout } from "./floatingMove";

// Two panes side by side under a 36-px title bar, a 240-px sidebar on the
// left: pane a from 240 to 720, pane b from 720 to 1200. Each strip is
// 34 px tall at the top of its pane; pane a has two tabs, b one.
const LAYOUT: Layout = {
  panes: [
    { id: "a", rect: { left: 240, top: 36, width: 480, height: 764 } },
    { id: "b", rect: { left: 720, top: 36, width: 480, height: 764 } },
  ],
  strips: [
    { pane: "a", rect: { left: 240, top: 36, width: 480, height: 34 }, tabs: [{ left: 244, right: 400 }, { left: 402, right: 560 }] },
    { pane: "b", rect: { left: 720, top: 36, width: 480, height: 34 }, tabs: [{ left: 724, right: 880 }] },
  ],
};
const ASIDE = { left: "beside", right: "panel" } as const;

describe("zoneAt — where a zone lights", () => {
  it("is free space in the middle of a pane", () => {
    expect(zoneAt({ x: 480, y: 400 }, LAYOUT, ASIDE)).toBeNull();
    expect(zoneAt({ x: 960, y: 300 }, LAYOUT, ASIDE)).toBeNull();
  });

  it("lights a strip on it, and within its reach below but not past it", () => {
    const on = zoneAt({ x: 300, y: 50 }, LAYOUT, ASIDE);
    expect(on).toMatchObject({ kind: "strip", pane: "a", index: 0 });
    const below = 36 + 34 + STRIP_REACH;
    expect(zoneAt({ x: 300, y: below }, LAYOUT, ASIDE)).toMatchObject({ kind: "strip", pane: "a" });
    expect(zoneAt({ x: 300, y: below + 1 }, LAYOUT, ASIDE)).toBeNull();
  });

  it("puts the slot at the tab whose middle the pointer has not passed", () => {
    expect(zoneAt({ x: 330, y: 50 }, LAYOUT, ASIDE)).toMatchObject({ index: 1, marker: 402 });
    expect(zoneAt({ x: 500, y: 50 }, LAYOUT, ASIDE)).toMatchObject({ index: 2, marker: 560 });
    expect(zoneAt({ x: 700, y: 50 }, LAYOUT, ASIDE)).toMatchObject({ index: 2 });
    expect(zoneAt({ x: 1000, y: 60 }, LAYOUT, ASIDE)).toMatchObject({ pane: "b", index: 1, marker: 880 });
  });

  it("lights the right edge within its reach and past it, as the aside's panel", () => {
    expect(zoneAt({ x: 1200 - EDGE_REACH, y: 400 }, LAYOUT, ASIDE)).toMatchObject({
      kind: "edge",
      side: "right",
      use: "panel",
      rect: { left: 1200 - EDGE_W, width: EDGE_W },
    });
    expect(zoneAt({ x: 1260, y: 400 }, LAYOUT, ASIDE)).toMatchObject({ side: "right" });
    expect(zoneAt({ x: 1200 - EDGE_REACH - 1, y: 400 }, LAYOUT, ASIDE)).toBeNull();
  });

  it("lights the left edge over the sidebar too, beside the first pane", () => {
    expect(zoneAt({ x: 100, y: 400 }, LAYOUT, ASIDE)).toMatchObject({ kind: "edge", side: "left", use: "beside", pane: "a" });
    expect(zoneAt({ x: 240 + EDGE_REACH + 1, y: 400 }, LAYOUT, ASIDE)).toBeNull();
  });

  it("an edge the card has no use for never lights", () => {
    expect(zoneAt({ x: 100, y: 400 }, LAYOUT, { left: null, right: "panel" })).toBeNull();
  });

  it("a strip wins in the corner it shares with an edge", () => {
    expect(zoneAt({ x: 1190, y: 50 }, LAYOUT, ASIDE)).toMatchObject({ kind: "strip", pane: "b" });
  });

  it("nothing lights above the panes (the title bar)", () => {
    expect(zoneAt({ x: 1190, y: 10 - STRIP_REACH }, LAYOUT, ASIDE)).toBeNull();
  });

  it("with no panes measured, nothing lights", () => {
    expect(zoneAt({ x: 5, y: 5 }, { panes: [], strips: [] }, ASIDE)).toBeNull();
  });
});

describe("outcome — the snap decision", () => {
  it("stays where let go outside every zone: a nudge is a move", () => {
    expect(outcome(null)).toEqual({ kind: "stay" });
  });
  it("opens a tab at the strip's slot", () => {
    expect(outcome(zoneAt({ x: 330, y: 50 }, LAYOUT, ASIDE))).toEqual({ kind: "tab", pane: "a", index: 1 });
  });
  it("makes the side panel at the aside's right edge", () => {
    expect(outcome(zoneAt({ x: 1190, y: 400 }, LAYOUT, ASIDE))).toEqual({ kind: "panel" });
  });
  it("opens beside at an edge whose use is beside", () => {
    expect(outcome(zoneAt({ x: 1190, y: 400 }, LAYOUT, { left: "beside", right: "beside" }))).toEqual({
      kind: "beside",
      pane: "b",
      side: "right",
    });
  });
});

describe("clampPos", () => {
  const win = { width: 1200, height: 800 };
  const size = { width: 440, height: 300 };
  it("leaves a position inside the window alone", () => {
    expect(clampPos({ left: 300, top: 200 }, size, win)).toEqual({ left: 300, top: 200 });
  });
  it("lets the card hang off a side but keeps 80 px of it in", () => {
    expect(clampPos({ left: 1190, top: 200 }, size, win)).toEqual({ left: 1120, top: 200 });
    expect(clampPos({ left: -1000, top: 200 }, size, win)).toEqual({ left: -360, top: 200 });
  });
  it("keeps the head inside top and bottom", () => {
    expect(clampPos({ left: 10, top: -40 }, size, win).top).toBe(0);
    expect(clampPos({ left: 10, top: 900 }, size, win).top).toBe(764);
  });
});

describe("zoneLabel", () => {
  it("says what a release will do", () => {
    const strip = zoneAt({ x: 300, y: 50 }, LAYOUT, ASIDE)!;
    const panel = zoneAt({ x: 1190, y: 400 }, LAYOUT, ASIDE)!;
    const beside = zoneAt({ x: 100, y: 400 }, LAYOUT, ASIDE)!;
    expect(zoneLabel(strip, 2)).toBe("open as a tab");
    expect(zoneLabel(panel, 2)).toBe("side panel");
    expect(zoneLabel(beside, 1)).toBe("open beside");
    expect(zoneLabel(beside, 2)).toBe("open here");
  });
});

describe("zoneArming — a move that starts in a zone's reach", () => {
  it("does not light the zone it starts in until the pointer has been in free space", () => {
    const arm = zoneArming();
    const strip = zoneAt({ x: 300, y: 50 }, LAYOUT, ASIDE);
    // The attachment's head sits under the strip: a nudge stays a nudge.
    expect(arm(strip)).toBeNull();
    expect(outcome(arm(strip))).toEqual({ kind: "stay" });
    // Out into the pane and back: now it lights.
    expect(arm(null)).toBeNull();
    expect(arm(strip)).toEqual(strip);
  });
  it("lights at once for a move that starts in free space", () => {
    const arm = zoneArming();
    expect(arm(null)).toBeNull();
    const edge = zoneAt({ x: 1190, y: 400 }, LAYOUT, ASIDE);
    expect(arm(edge)).toEqual(edge);
  });
});
