import { describe, expect, it } from "vitest";
import transcriptSrc from "./Transcript.svelte?raw";
import {
  DOT_STEP,
  GLOW_LEVELS,
  HOME_K,
  PUSH_CLAMP,
  PUSH_MAX,
  PUSH_RADIUS,
  SCATTER,
  type Dot,
  advanceDot,
  deviceStep,
  dotCentre,
  dotRandoms,
  dotsIn,
  fieldWanted,
  glowFills,
  glowLevel,
  parseColour,
  pushOffset,
  scatterOf,
  stepDot,
} from "./dotField";

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
  it("reaches Scatter's 300 px with a 40 px typical push, never past the 58 px clamp (655)", () => {
    expect(PUSH_RADIUS).toBe(300);
    expect(PUSH_MAX).toBe(40);
    expect(Math.hypot(pushOffset(1, 0).x, pushOffset(1, 0).y)).toBeCloseTo(40, 1);
    const heavy = { weight: 3, angle: 0, ret: 1 };
    expect(Math.hypot(pushOffset(1, 0, heavy).x, pushOffset(1, 0, heavy).y)).toBeCloseTo(PUSH_CLAMP, 6);
  });
  it("scales by a dot's weight and turns by its off-angle", () => {
    const s = { weight: 1.2, angle: 0.3, ret: 1 };
    const p = pushOffset(50, 0, s);
    const q = pushOffset(50, 0);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(Math.hypot(q.x, q.y) * 1.2, 6);
    expect(Math.atan2(p.y, p.x)).toBeCloseTo(0.3, 6);
    expect(pushOffset(PUSH_RADIUS, 0, s)).toEqual({ x: 0, y: 0 });
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
  it("shoves out with next to no overshoot (0.95 of critical)", () => {
    const d: Dot = { i: 0, j: 0, px: 0, py: 0, vx: 0, vy: 0 };
    let peak = 0;
    let n = 0;
    for (let k = 0; k < 200; k++) {
      stepDot(d, 30, 0, 1 / 60);
      peak = Math.max(peak, d.px);
      if (d.px < 27) n = k + 1;
    }
    expect(peak).toBeLessThan(30.3);
    expect(n).toBeLessThan(20); // 90 % of the way in a third of a second
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

describe("each dot's seeded randomness (655)", () => {
  const all = (amount = SCATTER) => {
    const out = [];
    for (let i = 0; i < 80; i++) for (let j = 0; j < 60; j++) out.push(scatterOf(i, j, amount));
    return out;
  };
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  it("is the same for the same dot on every call", () => {
    expect(scatterOf(3, 17)).toEqual(scatterOf(3, 17));
    expect(dotRandoms(40, 2)).toEqual(dotRandoms(40, 2));
    expect(scatterOf(3, 17)).not.toEqual(scatterOf(17, 3));
    for (const u of dotRandoms(9, 9)) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });
  it("is 0.6 of round 2's: off-angle within ±19°, weight 0.65–1.25, return speed 0.55–1.87", () => {
    expect(SCATTER).toBe(0.6);
    const s = all();
    const ang = s.map((x) => (x.angle * 180) / Math.PI);
    expect(Math.max(...ang.map(Math.abs))).toBeLessThanOrEqual(0.6 * 31.52 + 1e-9);
    expect(Math.max(...ang)).toBeGreaterThan(18); // the range is used, not just bounded
    expect(Math.min(...ang)).toBeLessThan(-18);
    const w = s.map((x) => x.weight);
    expect(Math.min(...w)).toBeGreaterThanOrEqual(0.65 - 1e-9);
    expect(Math.max(...w)).toBeLessThanOrEqual(1.25 + 1e-9);
    const r = s.map((x) => x.ret);
    expect(Math.min(...r)).toBeGreaterThanOrEqual(0.554);
    expect(Math.max(...r)).toBeLessThanOrEqual(1.874);
  });
  it("narrows each spread about its median, so the typical dot is unchanged", () => {
    const a = all(SCATTER);
    const b = all(1);
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    expect(spread(a.map((x) => x.weight)) / spread(b.map((x) => x.weight))).toBeCloseTo(0.6, 6);
    expect(spread(a.map((x) => x.angle)) / spread(b.map((x) => x.angle))).toBeCloseTo(0.6, 6);
    expect(spread(a.map((x) => x.ret)) / spread(b.map((x) => x.ret))).toBeCloseTo(0.6, 6);
    expect(median(a.map((x) => x.weight))).toBeCloseTo(0.95, 1);
    expect(median(a.map((x) => x.ret))).toBeCloseTo(0.86, 1);
    expect(Math.abs(median(a.map((x) => x.angle)))).toBeLessThan(0.02);
    // round 2's own ranges at 1
    const w1 = b.map((x) => x.weight);
    expect(Math.min(...w1)).toBeGreaterThanOrEqual(0.45);
    expect(Math.max(...w1)).toBeLessThanOrEqual(1.45);
  });
  it("gives no randomness at 0: every dot straight out, weight 1-ish, one return speed", () => {
    const s = scatterOf(5, 5, 0);
    expect(s.angle).toBe(0);
    expect(s.weight).toBeCloseTo(0.95, 9);
  });
});

describe("the push and the return home (655)", () => {
  it("shoves dots out fast, then every dot drifts back to exactly home after the pointer leaves", () => {
    const dots: Dot[] = [];
    for (let i = 0; i < 25; i++) for (let j = 0; j < 25; j++) dots.push({ i, j, px: 0, py: 0, vx: 0, vy: 0 });
    const ptr = { x: 12 * 24 + 5, y: 12 * 24 + 7 };
    const dt = 1 / 60;
    for (let f = 0; f < 30; f++) for (const d of dots) advanceDot(d, { x: d.i * 24 - ptr.x, y: d.j * 24 - ptr.y }, dt);
    const offs = dots.map((d) => Math.hypot(d.px, d.py)).filter((v) => v > 1);
    expect(offs.length).toBeGreaterThan(200);
    expect(Math.max(...offs)).toBeLessThanOrEqual(PUSH_CLAMP + 1e-9);
    // neighbours at the same distance fly different distances
    expect(new Set(offs.map((v) => Math.round(v))).size).toBeGreaterThan(20);
    let frames = 0;
    let halfAt = 0;
    const start = Math.max(...offs);
    while (frames < 60 * 30) {
      let busy = false;
      let most = 0;
      for (const d of dots) {
        if (!advanceDot(d, null, dt)) busy = true;
        most = Math.max(most, Math.hypot(d.px, d.py));
      }
      frames++;
      if (!halfAt && most < start / 2) halfAt = frames;
      if (!busy) break;
    }
    for (const d of dots) expect([d.px, d.py, d.vx, d.vy]).toEqual([0, 0, 0, 0]);
    expect(halfAt / 60).toBeGreaterThan(0.4); // slow: not today's snap
    expect(frames / 60).toBeLessThan(12);
  });
  it("brings slow-return dots home slower than fast ones", () => {
    const pick = (fast: boolean) => {
      let best = { i: 0, j: 0, r: fast ? 0 : 9 };
      for (let i = 0; i < 40; i++)
        for (let j = 0; j < 40; j++) {
          const r = scatterOf(i, j).ret;
          if (fast ? r > best.r : r < best.r) best = { i, j, r };
        }
      return best;
    };
    const home = (p: { i: number; j: number }) => {
      const d: Dot = { i: p.i, j: p.j, px: 30, py: 0, vx: 0, vy: 0 };
      let n = 0;
      while (!advanceDot(d, null, 1 / 60) && n < 6000) n++;
      return n;
    };
    expect(home(pick(false))).toBeGreaterThan(home(pick(true)) * 1.5);
    expect(HOME_K).toBe(5);
  });
});

describe("the brighter, lit dots (655)", () => {
  it("parses what WebKit computes for a color-mix and lifts displaced dots toward the signal", () => {
    expect(parseColour("color(srgb 0.913725 0.929412 0.94902 / 0.16)")).toEqual([
      expect.closeTo(233, 0),
      expect.closeTo(237, 0),
      expect.closeTo(242, 0),
      0.16,
    ]);
    expect(parseColour("rgb(134, 216, 247)")).toEqual([134, 216, 247, 1]);
    const f = glowFills("rgba(233, 237, 242, 0.16)", "rgb(134, 216, 247)");
    expect(f).toHaveLength(GLOW_LEVELS);
    expect(f[0]).toBe("rgba(233, 237, 242, 0.16)");
    expect(f[GLOW_LEVELS - 1]).toBe("rgba(218, 234, 243, 0.300)");
    expect(glowFills("nonsense", "rgb(1, 2, 3)").every((x) => x === "nonsense")).toBe(true);
    expect(glowLevel(0, 0)).toBe(0);
    expect(glowLevel(PUSH_MAX, 0)).toBe(GLOW_LEVELS - 1);
  });
});
