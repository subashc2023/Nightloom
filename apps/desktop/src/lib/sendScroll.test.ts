import { describe, expect, it } from "vitest";
import { restDistance, SEND_JUMP_SCREENS, sendJumps } from "./sendScroll";

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

describe("restDistance (313 review: a tall paste)", () => {
  it("a box grown by 250 px: half a screen up reads 504 in a 257 view at Send, 254 in a 507 view at rest", () => {
    expect(sendJumps(504, 257)).toBe(false);
    const r = restDistance(504, 257, 507);
    expect(r).toEqual({ distance: 254, viewport: 507 });
    expect(sendJumps(r.distance, r.viewport)).toBe(true);
  });
  it("three screens up stays far after the box shrinks", () => {
    const r = restDistance(1521 + 250, 257, 507);
    expect(sendJumps(r.distance, r.viewport)).toBe(false);
  });
  it("a view that did not grow is unchanged", () => {
    expect(restDistance(300, 507, 507)).toEqual({ distance: 300, viewport: 507 });
  });
  it("never below zero", () => {
    expect(restDistance(100, 257, 507).distance).toBe(0);
  });
});
