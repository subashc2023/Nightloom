import { describe, expect, it } from "vitest";
import { placeMenu } from "./floatMenu";
import { holdTips, tipAllowed } from "./tip";

// A composer button near the bottom of a 1200×800 window.
const btn = { top: 700, bottom: 724, left: 300, right: 420 };

describe("placeMenu (backlog 210)", () => {
  it("opens above the button when the whole menu fits there", () => {
    expect(placeMenu(btn, 260, 300, 1200, 800)).toEqual({ top: 392, left: 300, maxHeight: 684, side: "above" });
  });
  it("opens below when it does not fit above but does below", () => {
    const high = { top: 60, bottom: 84, left: 300, right: 420 };
    const p = placeMenu(high, 260, 300, 1200, 800);
    expect(p.side).toBe("below");
    expect(p.top).toBe(92);
    expect(p.maxHeight).toBe(700);
  });
  it("in a short window takes the roomier side and caps its height to the room, top inside the window", () => {
    // ~700 px window, button 560 px down: 544 above, 120 below; menu 620.
    const b = { top: 560, bottom: 584, left: 40, right: 160 };
    const p = placeMenu(b, 260, 620, 1000, 700, "left");
    expect(p.side).toBe("above");
    expect(p.maxHeight).toBe(544);
    expect(p.top).toBe(8);
    expect(p.top + Math.min(620, p.maxHeight)).toBe(552);
  });
  it("never puts the top above the window's margin, even for an anchor scrolled half out of view", () => {
    const b = { top: -10, bottom: 14, left: 40, right: 160 };
    const p = placeMenu(b, 260, 200, 1000, 700);
    expect(p.side).toBe("below");
    expect(p.top).toBeGreaterThanOrEqual(8);
  });
  it("right-aligns with the button when asked, clamped inside both edges", () => {
    expect(placeMenu(btn, 400, 300, 1200, 800, "right").left).toBe(20);
    expect(placeMenu({ ...btn, left: 1100, right: 1190 }, 260, 300, 1200, 800, "left").left).toBe(932);
    expect(placeMenu(btn, 400, 300, 300, 800, "left").left).toBe(8);
  });
  it("a zero-room side gives maxHeight 0, never negative", () => {
    const b = { top: 2, bottom: 798, left: 0, right: 10 };
    expect(placeMenu(b, 100, 100, 800, 800).maxHeight).toBe(0);
  });
});

describe("holdTips (backlog 210)", () => {
  const inside = {} as Node;
  const outside = {} as Node;
  const menu = { contains: (n: Node) => n === inside } as unknown as Element;
  it("allows every tip with no menu open", () => {
    expect(tipAllowed(outside)).toBe(true);
  });
  it("while a menu is open, allows only tips inside it; release restores", () => {
    const release = holdTips(menu);
    expect(tipAllowed(outside)).toBe(false);
    expect(tipAllowed(inside)).toBe(true);
    release();
    expect(tipAllowed(outside)).toBe(true);
  });
});
