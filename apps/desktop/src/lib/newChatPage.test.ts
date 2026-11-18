import { describe, expect, it } from "vitest";
// Item 839: typing (and attaching) never shrinks the dial.
import { columnAtRest as atRest, dialSize as dial } from "./newChatPage";
describe("columnAtRest (839)", () => {
  it("takes the box's growth past its least height out of the column", () => {
    expect(atRest(400, 230, 60)).toBe(230);
    expect(atRest(400, 60, 60)).toBe(400);
  });
  it("is the measured column before a measure or with no growth", () => {
    expect(atRest(400, 0, Infinity)).toBe(400);
    expect(atRest(400, 100, Infinity)).toBe(400);
    expect(atRest(400, 100, 200)).toBe(400);
  });
  it("keeps the dial's size from 1 line to a full box at 1440 × 900", () => {
    const pane = 736;
    const rest = 120; // the column with an empty box
    const sizes = [60, 83, 130, 222, 232].map((slot) => dial(pane, atRest(rest - 60 + slot, slot, 60) + 58 + 52));
    expect(new Set(sizes).size).toBe(1);
  });
});
