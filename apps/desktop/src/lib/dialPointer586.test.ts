import { describe, expect, it } from "vitest";
import motionSrc from "./DialMotion.svelte?raw";
import { angleGap, easePresence, pointerAngle, pointerNear, pointerPull, pointerSpoke, spoke, stirKick } from "./dialMotion";

// Item 586: the new-chat dial's audio ring leans toward the pointer.
describe("the pointer's pull on the audio ring (586)", () => {
  const R = 165;
  it("faces the pointer: 12 o'clock is up, angles run clockwise", () => {
    expect(pointerAngle(0, -100)).toBeCloseTo(0);
    expect(pointerAngle(100, 0)).toBeCloseTo(Math.PI / 2);
    expect(angleGap(0.1, 2 * Math.PI - 0.1)).toBeCloseTo(0.2);
  });
  it("is strongest on the facing spoke and falls off with angle", () => {
    const right = (th: number) => pointerPull(th, 300, 0, R);
    const face = right(Math.PI / 2);
    expect(face).toBeGreaterThan(right(Math.PI / 2 + 0.5));
    expect(right(Math.PI / 2 + 0.5)).toBeGreaterThan(right(Math.PI / 2 + 1.2));
    expect(right(-Math.PI / 2)).toBeLessThan(0.001);
  });
  it("falls off with the pointer's distance past the rim, and is full on the dial", () => {
    expect(pointerNear(0, -R, R)).toBe(1);
    expect(pointerNear(0, -(R + 4 * R), R)).toBeCloseTo(Math.exp(-1));
    expect(pointerPull(Math.PI / 2, R + 100, 0, R)).toBeGreaterThan(pointerPull(Math.PI / 2, R + 600, 0, R));
  });
  it("at the centre faces no side: an even half all round", () => {
    expect(pointerPull(0, 0, 0, R)).toBeCloseTo(0.5);
    expect(pointerPull(2, 0, 0, R)).toBeCloseTo(0.5);
  });
  it("a pulled spoke reaches further than the ring's own, and no pull is the ring exactly", () => {
    let more = 0;
    for (let i = 0; i < 36; i++) {
      const th = (i / 36) * 2 * Math.PI;
      expect(pointerSpoke(th, 1.3, 0, 0)).toBe(spoke(th, 1.3, 0));
      more += pointerSpoke(th, 1.3, 0, 1.2) - spoke(th, 1.3, 0);
    }
    expect(more / 36).toBeGreaterThan(0.25);
  });
  it("a moving pointer's surge is capped at a key's kick", () => {
    expect(stirKick(0)).toBe(0);
    expect(stirKick(60)).toBeCloseTo(0.15);
    expect(stirKick(5000)).toBe(0.3);
  });
  it("eases back to idle when the pointer leaves", () => {
    expect(easePresence(1, 0, 0)).toBe(1);
    expect(easePresence(1, 0, 0.35)).toBeCloseTo(Math.exp(-1));
    expect(easePresence(1, 0, 3)).toBeLessThan(0.001);
  });
  it("the events only record; the loop reads; the still frame ignores the pointer", () => {
    expect(motionSrc).toMatch(/const onMove = \(e: PointerEvent\) => \{\s*pointer = \{ x: e\.clientX, y: e\.clientY, on: true \};\s*\};/);
    expect(motionSrc).toContain("const p = still ? null : aim();");
  });
});
