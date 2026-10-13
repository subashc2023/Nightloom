import { describe, expect, it } from "vitest";
import { growHeight, linesHeight, overflows, roomForBox } from "./boxGrow";

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

/**
 * Backlog 233: the box inside a card with a height limit takes no more than
 * the limit leaves once the head, the padding and the button row are paid
 * for — the numbers are the card's as measured in the dev app (a 160px
 * card at `MIN_CARD_HEIGHT`, a 43px head and borders, 10px top padding,
 * 8px gap + 23px row + 12px bottom padding under the box).
 */
describe("roomForBox (backlog 233)", () => {
  const one = linesHeight(LINE, 1, CHROME);
  it("leaves the buttons their room in a short card", () => {
    const room = roomForBox(160, 43, 10, 43, one);
    expect(room).toBe(64);
    // Four lines would ask for 95px; the box takes 64 and scrolls.
    const need4 = need(4);
    expect(Math.min(growHeight(need4, one, linesHeight(LINE, 4, CHROME)), room)).toBe(64);
    expect(overflows(need4, 64)).toBe(true);
  });
  it("is no limit to a four-line box in a card with room", () => {
    const room = roomForBox(700, 43, 10, 43, one);
    expect(room).toBeGreaterThan(linesHeight(LINE, 4, CHROME));
  });
  it("never goes under one line", () => {
    expect(roomForBox(60, 43, 10, 43, one)).toBe(one);
  });
  it("caps a dragged height too", () => {
    const dragged = 400;
    const room = roomForBox(450, 43, 10, 43, one);
    expect(Math.min(growHeight(need(2), dragged, dragged), room)).toBe(354);
  });
});
