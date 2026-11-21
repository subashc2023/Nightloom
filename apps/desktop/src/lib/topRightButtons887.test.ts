import { describe, expect, it } from "vitest";
import { CORNER_GAP, pillPlace } from "./topRightButtons.svelte";

// Item 887: the asides pill and the chapters' Contents button overlapped.
describe("pillPlace (item 887)", () => {
  const vp = { top: 50, left: 300, right: 1400 };
  it("alone: the old spot, 26 px in from the scroller's right", () => {
    expect(pillPlace(vp, null, 110, 26, 1440)).toEqual({ top: 58, right: 66 });
  });
  it("with Contents: just left of it, centred on it, no overlap", () => {
    const c = { top: 60, left: 1290, right: 1380, bottom: 82, height: 22 };
    const p = pillPlace(vp, c, 110, 26, 1440);
    expect(p.right).toBe(1440 - 1290 + CORNER_GAP);
    expect(1440 - p.right).toBeLessThanOrEqual(c.left - CORNER_GAP);
    expect(p.top).toBe(58);
  });
  it("too narrow: stacked under Contents, right edges aligned", () => {
    const narrow = { top: 50, left: 1200, right: 1400 };
    const c = { top: 60, left: 1290, right: 1380, bottom: 82, height: 22 };
    expect(pillPlace(narrow, c, 110, 26, 1440)).toEqual({ top: 82 + CORNER_GAP, right: 60 });
  });
});
