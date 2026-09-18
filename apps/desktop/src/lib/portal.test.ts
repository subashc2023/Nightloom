import { describe, expect, it } from "vitest";
import { anchorBelow } from "./portal";

describe("anchorBelow (backlog 163)", () => {
  it("right-aligns the card with the chip and sits it just under", () => {
    expect(anchorBelow({ left: 900, right: 1000, bottom: 40 }, 340, 1400)).toEqual({ top: 44, left: 660 });
  });
  it("clamps inside the right edge", () => {
    expect(anchorBelow({ left: 1300, right: 1398, bottom: 40 }, 340, 1400).left).toBe(1052);
  });
  it("clamps inside the left edge when the chip is at the left or the window is narrow", () => {
    expect(anchorBelow({ left: 10, right: 100, bottom: 40 }, 340, 1400).left).toBe(8);
    expect(anchorBelow({ left: 10, right: 100, bottom: 40 }, 340, 300).left).toBe(8);
  });
});
