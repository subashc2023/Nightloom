import { describe, expect, it } from "vitest";
import { firstFit, onOneLine, type Box } from "./fold";

const box = (top: number, height: number, right: number, width = 40): Box => ({
  top,
  bottom: top + height,
  right,
  width,
  height,
});

describe("onOneLine (backlog 183)", () => {
  it("holds for boxes of different heights centred on one line", () => {
    expect(onOneLine([box(10, 24, 100), box(14, 16, 200), box(8, 28, 300)], 320)).toBe(true);
  });
  it("fails once a box wraps to a second line", () => {
    expect(onOneLine([box(10, 24, 100), box(40, 24, 80)], 320)).toBe(false);
  });
  it("fails when a box runs past the right edge", () => {
    expect(onOneLine([box(10, 24, 100), box(10, 24, 330)], 320)).toBe(false);
  });
  it("ignores folded (zero-size) boxes and holds when nothing shows", () => {
    expect(onOneLine([box(10, 24, 100), { top: 90, bottom: 90, right: 999, width: 0, height: 0 }], 320)).toBe(true);
    expect(onOneLine([], 320)).toBe(true);
  });
});

describe("firstFit (backlog 183)", () => {
  it("stops at the first level that fits, trying levels in rising order", () => {
    const tried: number[] = [];
    expect(firstFit((l) => (tried.push(l), l >= 2), 3)).toBe(2);
    expect(tried).toEqual([0, 1, 2]);
  });
  it("lands on the last level, applied, when none fits (the wrap is the floor)", () => {
    const tried: number[] = [];
    expect(firstFit((l) => (tried.push(l), false), 3)).toBe(3);
    expect(tried).toEqual([0, 1, 2, 3]);
  });
  it("is level 0 when everything fits", () => {
    expect(firstFit(() => true, 3)).toBe(0);
  });
});
