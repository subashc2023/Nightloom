// Item 443: a tab grows in and shrinks out of the strip.
import { describe, expect, it } from "vitest";
import { TAB_IN_MS, TAB_OUT_MS, tabFrame } from "./tabMotion";

describe("tabFrame (item 443)", () => {
  it("is nothing at rest, so the last frame is the tab that stays", () => {
    expect(tabFrame(1, 98.8, 10, 8)).toBe("");
  });

  it("starts closed and invisible", () => {
    const f = tabFrame(0, 98.8, 10, 8);
    expect(f).toContain("flex:0 0 0.00px");
    expect(f).toContain("padding-left:0.00px");
    expect(f).toContain("opacity:0.000");
    expect(f).toContain("overflow:hidden");
  });

  it("grows its width and padding with t and fades in over the last two thirds", () => {
    const half = tabFrame(0.5, 100, 10, 8);
    expect(half).toContain("flex:0 0 50.00px");
    expect(half).toContain("padding-left:5.00px");
    expect(half).toContain("padding-right:4.00px");
    expect(half).toContain(`opacity:${(0.2 / 0.7).toFixed(3)}`);
    expect(tabFrame(0.2, 100, 10, 8)).toContain("opacity:0.000");
  });

  it("keeps both inside his 150 ms", () => {
    expect(TAB_IN_MS).toBeLessThanOrEqual(150);
    expect(TAB_OUT_MS).toBeLessThanOrEqual(150);
  });
});
