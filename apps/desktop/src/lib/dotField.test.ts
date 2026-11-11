import { describe, expect, it } from "vitest";
import transcriptSrc from "./Transcript.svelte?raw";
import { DOT_STEP, PUSH_MAX, PUSH_RADIUS, type Dot, deviceStep, dotCentre, dotsIn, fieldWanted, pushOffset, stepDot } from "./dotField";

describe("the dot grid matches the CSS tile (item 621)", () => {
  it("puts dot (0, 0) at the tile centre at the foot-left corner", () => {
    expect(dotCentre(0, 0, 600)).toEqual({ x: 12, y: 588 });
    expect(dotCentre(2, 1, 600)).toEqual({ x: 12 + 48, y: 588 - 24 });
  });
  it("finds exactly the dots whose centres are in a box", () => {
    const h = 600;
    const r = dotsIn(0, 0, 100, h, 100, h);
    // x centres 12, 36, 60, 84 fit in 100.
    expect([r.i0, r.i1]).toEqual([0, 3]);
    const top = dotCentre(0, r.j1, h).y;
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top - DOT_STEP).toBeLessThan(0);
    const s = dotsIn(30, 560, 40, 590, 100, h);
    expect([s.i0, s.i1, s.j0, s.j1]).toEqual([1, 1, 0, 1]);
  });
  it("steps by whole device pixels, as WebKit draws the tile (53 at 110 %)", () => {
    expect(deviceStep(1)).toBe(24);
    expect(deviceStep(2)).toBe(24);
    expect(deviceStep(2.2) * 2.2).toBeCloseTo(53, 9);
    expect(dotCentre(1, 0, 600, deviceStep(2.2)).x * 2.2).toBeCloseTo(53 * 1.5, 9);
  });
  it("clamps to the box", () => {
    const r = dotsIn(-500, -500, 5000, 5000, 240, 240);
    expect([r.i0, r.i1, r.j0, r.j1]).toEqual([0, 9, 0, 9]);
  });
});

describe("the push", () => {
  it("is away from the pointer, strongest near it, none at the radius", () => {
    const near = pushOffset(10, 0);
    expect(near.x).toBeGreaterThan(0);
    expect(near.y).toBe(0);
    expect(near.x).toBeLessThanOrEqual(PUSH_MAX);
    const mid = pushOffset(0, -PUSH_RADIUS / 2);
    expect(mid.y).toBeLessThan(0);
    expect(Math.abs(mid.y)).toBeLessThan(near.x);
    expect(pushOffset(PUSH_RADIUS, 0)).toEqual({ x: 0, y: 0 });
    expect(pushOffset(0, 0)).toEqual({ x: 0, y: 0 });
  });
  it("never moves a dot half a grid step (rows never cross)", () => {
    expect(PUSH_MAX).toBeLessThan(DOT_STEP / 2);
  });
});

describe("the spring", () => {
  it("reaches the push and settles back to rest", () => {
    const d: Dot = { i: 0, j: 0, px: 0, py: 0, vx: 0, vy: 0 };
    let n = 0;
    while (!stepDot(d, 6, -3, 1 / 60) && n < 600) n++;
    expect(n).toBeLessThan(120); // under two seconds at 60 fps
    expect([d.px, d.py]).toEqual([6, -3]);
    n = 0;
    while (!stepDot(d, 0, 0, 1 / 60) && n < 600) n++;
    expect(n).toBeLessThan(120);
    expect([d.px, d.py, d.vx, d.vy]).toEqual([0, 0, 0, 0]);
  });
  it("overshoots only a hair", () => {
    const d: Dot = { i: 0, j: 0, px: 0, py: 0, vx: 0, vy: 0 };
    let peak = 0;
    for (let k = 0; k < 200; k++) {
      stepDot(d, 8, 0, 1 / 60);
      peak = Math.max(peak, d.px);
    }
    expect(peak).toBeGreaterThan(8);
    expect(peak).toBeLessThan(8.5);
  });
});

describe("when it runs", () => {
  it("runs on the lit ground only, and never under Reduce motion", () => {
    expect(fieldWanted(" radial-gradient(circle, red 1px, transparent 1.2px)", false, false)).toBe(true);
    expect(fieldWanted("none", false, false)).toBe(false); // Calm and the classic palettes
    expect(fieldWanted("", false, false)).toBe(false);
    expect(fieldWanted("radial-gradient(red, blue)", true, false)).toBe(false);
    expect(fieldWanted("radial-gradient(red, blue)", false, true)).toBe(false);
  });
  it("is wired behind the transcript's scroller, which drops its tile while it runs", () => {
    // app.css's 5.5 % token is measured in WebKit (vitest empties CSS imports): notes/runner-design/621-report-2026-11-11.md.
    expect(transcriptSrc).toContain('<canvas class="dot-field" aria-hidden="true" bind:this={dotCanvas}></canvas>');
    expect(transcriptSrc).toContain("const f = dotField(dotCanvas, viewport);");
    expect(transcriptSrc).toMatch(/\.transcript:global\(\.dotfield\) \{\s*background: none;/);
  });
});
