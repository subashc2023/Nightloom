import { describe, expect, it } from "vitest";
import { growHeight, linesHeight, overflows } from "./boxGrow";

/**
 * The aside box's grow rule (backlog 226, his "three or four lines max
 * before it becomes scrollable"): the arithmetic `AsideBox.svelte` runs on
 * every keystroke, with the card's own metrics — 14px text at a 1.4 line
 * height (19.6px a line), 7px padding top and bottom, a 1px border.
 */
const LINE = 19.6;
const CHROME = 7 + 7 + 1 + 1;
const need = (lines: number) => LINE * lines + CHROME; // scrollHeight + border
const floor = linesHeight(LINE, 1, CHROME);
const cap = linesHeight(LINE, 4, CHROME);

describe("the aside box grows to four lines, then scrolls (backlog 226)", () => {
  it("an empty or one-line box is one line tall, with no scroll bar", () => {
    const h = growHeight(need(1), floor, cap);
    expect(h).toBe(floor);
    expect(overflows(need(1), h)).toBe(false);
  });

  it("two and four lines grow the box to fit, still with no scroll bar", () => {
    for (const n of [2, 3, 4]) {
      const h = growHeight(need(n), floor, cap);
      expect(h).toBeCloseTo(need(n), 5);
      expect(overflows(need(n), h)).toBe(false);
    }
  });

  it("past four lines the box stops at four and scrolls", () => {
    const h = growHeight(need(6), floor, cap);
    expect(h).toBe(cap);
    expect(cap).toBe(Math.ceil(LINE * 4 + CHROME));
    expect(overflows(need(6), h)).toBe(true);
  });

  it("a dragged height is the box's height, text and all (floor = cap)", () => {
    expect(growHeight(need(1), 200, 200)).toBe(200);
    expect(overflows(need(1), 200)).toBe(false);
    expect(growHeight(need(20), 200, 200)).toBe(200);
    expect(overflows(need(20), 200)).toBe(true);
  });

  it("a cap under the floor reads as the floor; a pixel of rounding is not overflow", () => {
    expect(growHeight(10, 50, 30)).toBe(50);
    expect(overflows(36.5, 36)).toBe(false);
  });
});
