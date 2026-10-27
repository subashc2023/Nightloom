import { describe, expect, it } from "vitest";
import { aimsAt, inTriangle, placeMenu, placeSubmenu } from "./menuPlace";

// His window (item 425): 1440 × 780.
const view = { w: 1440, h: 780 };

describe("placeMenu (item 425)", () => {
  it("drops below the click when it fits", () => {
    expect(placeMenu({ x: 100, below: 200, above: 200 }, { w: 220, h: 300 }, view)).toEqual({ left: 100, top: 200 });
  });
  it("flips above the click near the window's foot", () => {
    const p = placeMenu({ x: 100, below: 700, above: 700 }, { w: 220, h: 300 }, view);
    expect(p).toEqual({ left: 100, top: 400 });
    expect(p.top + 300).toBeLessThanOrEqual(776);
  });
  it("shifts up when neither below nor above fits", () => {
    const p = placeMenu({ x: 100, below: 500, above: 450 }, { w: 220, h: 600 }, view);
    expect(p).toEqual({ left: 100, top: 176 });
  });
  it("is pinned to the top and capped when taller than the window", () => {
    expect(placeMenu({ x: 100, below: 700, above: 700 }, { w: 220, h: 900 }, view)).toEqual({ left: 100, top: 4, maxHeight: 772 });
  });
  it("right-aligns under a button and stays inside the left and right edges", () => {
    expect(placeMenu({ x: 300, below: 50, above: 30, alignRight: true }, { w: 220, h: 100 }, view).left).toBe(80);
    expect(placeMenu({ x: 100, below: 50, above: 30, alignRight: true }, { w: 220, h: 100 }, view).left).toBe(4);
    expect(placeMenu({ x: 1400, below: 50, above: 30 }, { w: 220, h: 100 }, view).left).toBe(1216);
  });
  it("never puts the top above the edge", () => {
    expect(placeMenu({ x: 0, below: -20, above: -20 }, { w: 100, h: 100 }, view).top).toBe(4);
  });
});

describe("placeSubmenu (item 425)", () => {
  const menu = { left: 300, right: 520, top: 300, bottom: 700 };
  const item = { left: 304, right: 516, top: 500, bottom: 528 };
  it("flies out to the right, level with its item", () => {
    expect(placeSubmenu(item, menu, { w: 200, h: 120 }, view)).toEqual({ left: 518, top: 496 });
  });
  it("shifts up near the window's foot", () => {
    const p = placeSubmenu(item, menu, { w: 200, h: 400 }, view);
    expect(p.top + 400).toBe(776);
  });
  it("flips left when the right has no room", () => {
    const m = { left: 1100, right: 1320, top: 300, bottom: 700 };
    expect(placeSubmenu({ ...item, left: 1104, right: 1316 }, m, { w: 200, h: 120 }, view).left).toBe(902);
  });
  it("is capped and scrolls when taller than the window", () => {
    expect(placeSubmenu(item, menu, { w: 200, h: 1000 }, view)).toEqual({ left: 518, top: 4, maxHeight: 772 });
  });
});

describe("the safe triangle (item 425)", () => {
  const sub = { left: 520, right: 720, top: 400, bottom: 600 };
  it("a diagonal move toward the submenu is aiming", () => {
    expect(aimsAt({ x: 400, y: 380 }, { x: 430, y: 400 }, sub)).toBe(true);
  });
  it("a move straight down the menu is not", () => {
    expect(aimsAt({ x: 400, y: 380 }, { x: 400, y: 420 }, sub)).toBe(false);
  });
  it("a move away from the submenu is not", () => {
    expect(aimsAt({ x: 400, y: 380 }, { x: 380, y: 400 }, sub)).toBe(false);
  });
  it("inTriangle", () => {
    const a = { x: 0, y: 0 }, b = { x: 10, y: 0 }, c = { x: 0, y: 10 };
    expect(inTriangle({ x: 2, y: 2 }, a, b, c)).toBe(true);
    expect(inTriangle({ x: 9, y: 9 }, a, b, c)).toBe(false);
  });
});
