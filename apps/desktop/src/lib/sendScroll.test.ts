import { describe, expect, it } from "vitest";
import { SEND_JUMP_SCREENS, sendJumps } from "./sendScroll";

// Item 313: a Send within one viewport height of the foot lands at the
// bottom; from further up it keeps the place.

describe("sendJumps", () => {
  const view = 600;
  const limit = SEND_JUMP_SCREENS * view;

  it("is one screen", () => {
    expect(SEND_JUMP_SCREENS).toBe(1);
  });

  it("jumps from the foot (a no-op: already pinned)", () => {
    expect(sendJumps(0, view)).toBe(true);
  });

  it("jumps from just inside the threshold", () => {
    expect(sendJumps(limit - 1, view)).toBe(true);
    expect(sendJumps(view / 2, view)).toBe(true);
  });

  it("jumps from exactly the threshold", () => {
    expect(sendJumps(limit, view)).toBe(true);
  });

  it("keeps the place just past the threshold", () => {
    expect(sendJumps(limit + 1, view)).toBe(false);
    expect(sendJumps(3 * view, view)).toBe(false);
  });

  it("treats a sub-pixel overshoot below the foot as the foot", () => {
    expect(sendJumps(-0.5, view)).toBe(true);
  });

  it("keeps the place when the view has no height or the numbers are bad", () => {
    expect(sendJumps(10, 0)).toBe(false);
    expect(sendJumps(Number.NaN, view)).toBe(false);
  });
});
