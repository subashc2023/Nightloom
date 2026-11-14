import { describe, expect, it } from "vitest";
import { gearTarget, GRACE_S, LIGHT_S, newDrive, stepDrive, WIND_S, type Drive, type DriveInput } from "./dialDrive";
import dialSrc from "./ContextDial.svelte?raw";
import motionSrc from "./DialMotion.svelte?raw";
import railSrc from "./RightRail.svelte?raw";
import topSrc from "./TopBar.svelte?raw";
import classicRail from "./RightRailClassic.svelte?raw";
import classicTop from "./TopBarClassic.svelte?raw";

// Item 654 (his pick B3, blocker 1962): the column's dial moves with a reply.

const W = 1_000_000;
const base = (o: Partial<DriveInput> = {}): DriveInput => ({ exact: 184_000, estimate: 0, limit: W, streaming: false, ticks: 50, reduce: false, ...o });
/** Run `secs` of frames at 60 fps; returns the last result. */
function run(d: Drive, secs: number, inp: DriveInput) {
  let r = stepDrive(d, 0, inp);
  for (let i = 0; i < Math.round(secs * 60); i++) r = stepDrive(d, 1 / 60, inp);
  return r;
}

describe("the gears count the tokens", () => {
  it("gear A gains one drawn 15° tooth per 1k (6 turnA-degrees; drawn at ×2.5)", () => {
    expect(gearTarget(1000) * 2.5).toBeCloseTo(15);
    expect(gearTarget(15_000) * 2.5).toBeCloseTo(225);
    expect(gearTarget(-5)).toBe(0);
  });
  it("starts at the token position, then follows the live reading while a reply streams", () => {
    const d = newDrive();
    const r0 = stepDrive(d, 0, base());
    expect(r0.gear.tok).toBeCloseTo(gearTarget(184_000));
    const r1 = run(d, 2, base({ streaming: true, estimate: 6_000 }));
    expect(r1.gear.tok).toBeCloseTo(gearTarget(190_000), 1);
    // The rate is up while tokens pour in, and with it the radar and the ring.
    const d2 = newDrive();
    stepDrive(d2, 0, base());
    let r = stepDrive(d2, 0, base({ streaming: true }));
    for (let i = 1; i <= 60; i++) r = stepDrive(d2, 1 / 60, base({ streaming: true, estimate: i * 50 }));
    expect(r.gear.surge).not.toBeNull();
    expect(r.gear.surge!).toBeGreaterThan(0.2);
    expect(r.gear.radar).toBeGreaterThan(0);
    expect(r.gear.glow).toBeGreaterThan(1);
  });
  it("winds back when the real figure is lower than the estimate, overshooting past it on the way", () => {
    const d = newDrive();
    stepDrive(d, 0, base({ exact: 199_400 }));
    run(d, 3, base({ exact: 205_000, estimate: 6_000, streaming: true }));
    const before = d.tok;
    expect(before).toBeCloseTo(gearTarget(211_000), 1);
    // The reply ends: the logged figure, 206.8k, is below the ~211k estimate.
    const lows: number[] = [];
    let r = stepDrive(d, 1 / 60, base({ exact: 206_800 }));
    for (let i = 0; i < Math.round(WIND_S * 60) + 2; i++) {
      r = stepDrive(d, 1 / 60, base({ exact: 206_800 }));
      lows.push(r.gear.tok);
    }
    expect(r.gear.tok).toBeCloseTo(gearTarget(206_800));
    expect(Math.min(...lows)).toBeLessThan(gearTarget(206_800)); // easeBack overshoots below, then settles
    expect(r.gear.tok).toBeLessThan(before);
  });
  it("winds forward when the real figure is higher", () => {
    const d = newDrive();
    stepDrive(d, 0, base());
    run(d, 3, base({ exact: 188_900, estimate: 5_000, streaming: true }));
    const before = d.tok;
    const r = run(d, WIND_S + 0.1, base({ exact: 199_400 }));
    expect(r.gear.tok).toBeCloseTo(gearTarget(199_400));
    expect(r.gear.tok).toBeGreaterThan(before);
  });
});

describe("the landing", () => {
  it("a light runs the arc to the real figure, lighting the ticks it passes; then the head ripples and the notch flares", () => {
    const d = newDrive();
    stepDrive(d, 0, base());
    run(d, 3, base({ exact: 188_900, estimate: 5_000, streaming: true }));
    let r = stepDrive(d, 1 / 60, base({ exact: 199_400 }));
    const lit = new Set<number>();
    let sawLight = false;
    for (let i = 0; i < Math.round(LIGHT_S * 60) - 4; i++) {
      r = stepDrive(d, 1 / 60, base({ exact: 199_400 }));
      if (r.view.lightAlpha > 0.5) sawLight = true;
      r.view.ticks.forEach((x, i) => x > 0.9 && lit.add(i));
      expect(r.view.estimating).toBe(true);
    }
    expect(sawLight).toBe(true);
    expect(lit.size).toBeGreaterThan(7); // 199.4k of 1M passes ticks at 20k, 40k, …, 180k
    r = run(d, 0.15, base({ exact: 199_400 }));
    expect(r.view.solid).toBeCloseTo(0.1994);
    expect(r.view.head).toBeCloseTo(0.1994);
    expect(r.view.estimating).toBe(false);
    expect(r.view.notchFlare).toBeGreaterThan(0.5);
    expect(r.view.ripple).toBeGreaterThan(0);
    expect(r.gear.landings).toBe(1);
  });
  it("follows a logged figure that arrives late (within the grace) instead of snapping", () => {
    const d = newDrive();
    stepDrive(d, 0, base());
    run(d, 1, base({ estimate: 3_000, streaming: true }));
    run(d, WIND_S + 0.2, base({ exact: 184_000 }));
    const r = stepDrive(d, 1 / 60, base({ exact: 190_000 }));
    expect(GRACE_S).toBeGreaterThan(1);
    expect(r.gear.tok).toBeGreaterThan(gearTarget(184_000));
    expect(r.gear.tok).toBeLessThan(gearTarget(190_000));
  });
});

describe("still at rest", () => {
  it("nothing moves once a reading has landed: the same view every frame, and the runner stops", () => {
    const d = newDrive();
    stepDrive(d, 0, base());
    run(d, 3, base({ exact: 188_900, estimate: 5_000, streaming: true }));
    const settled = run(d, 6, base({ exact: 199_400 }));
    expect(settled.active).toBe(false);
    const a = stepDrive(d, 1 / 60, base({ exact: 199_400 }));
    const b = stepDrive(d, 1 / 60, base({ exact: 199_400 }));
    expect(b.active).toBe(false);
    expect(b.view).toEqual(a.view);
    expect(b.gear).toEqual(a.gear);
    // At rest the dial is as before: no tail, no lit ticks, no light, no beat.
    expect(b.view.tailTo).toBe(b.view.solid);
    expect(b.view.ticks.every((x) => x === 0)).toBe(true);
    expect(b.view.lightAlpha).toBe(0);
    expect(b.view.headScale).toBe(1);
    expect(b.view.wash).toBe(0);
    expect(b.gear.surge).toBeNull();
  });
  it("a chat switch at rest snaps the gears to the new position (no wind) and eases the arc", () => {
    const d = newDrive();
    run(d, GRACE_S + 1, base());
    const r = stepDrive(d, 1 / 60, base({ exact: 20_000 }));
    expect(r.gear.tok).toBeCloseTo(gearTarget(20_000));
    expect(r.view.solid).toBeGreaterThan(0.02);
    expect(run(d, 1, base({ exact: 20_000 })).view.solid).toBeCloseTo(0.02);
  });
});

describe("reduce motion", () => {
  it("draws every reading at once: the gears still at the token position, the tail plain, no light, flare or beat", () => {
    const d = newDrive();
    stepDrive(d, 0, base({ reduce: true }));
    const s = stepDrive(d, 0, base({ reduce: true, streaming: true, estimate: 9_000 }));
    expect(s.gear.tok).toBeCloseTo(gearTarget(193_000));
    expect(s.view.march).toBe(false);
    expect(s.view.tailTo).toBeCloseTo(0.193);
    expect(s.view.solid).toBeCloseTo(0.184);
    expect(s.active).toBe(false);
    // The used ticks and the next one are readings: shown, still, during the reply.
    expect(s.view.ticks.filter((x) => x > 0).length).toBeGreaterThan(5);
    const e = stepDrive(d, 0, base({ reduce: true, exact: 199_400 }));
    expect(e.view.solid).toBeCloseTo(0.1994);
    expect(e.view.lightAlpha).toBe(0);
    expect(e.view.ripple).toBe(0);
    expect(e.view.notchFlare).toBe(0);
    expect(e.view.headScale).toBe(1);
    expect(e.gear.tok).toBeCloseTo(gearTarget(199_400));
    expect(e.view.ticks.every((x) => x === 0)).toBe(true);
  });
});

describe("wiring", () => {
  it("the column (chat and aside) drives ContextDial's layer and DialMotion's gears", () => {
    expect(railSrc).toContain("const drive = new ContextDrive();");
    expect(railSrc).toMatch(/streaming: live,/);
    expect(railSrc).toMatch(/gear=\{dv \? drive\.gear : null\} gearKey=\{drive\.n\}/);
    expect(railSrc).toMatch(/drive=\{dv\}/);
    expect(dialSrc).toContain("drive = null,");
    expect(motionSrc).toContain("gear = null, gearKey = 0");
    expect(motionSrc).toMatch(/\+ tok;/);
  });
  it("the top bar chip reads the live figure, dims an estimate and flashes once on landing", () => {
    expect(topSrc).toMatch(/liveCtx \? liveTokens\(liveCtx\) : contextUsed\(\)/);
    expect(topSrc).toMatch(/class:dimmed=\{liveEst\} class:landed=\{landFlash\}/);
  });
  it("Classic is untouched", () => {
    for (const src of [classicRail, classicTop]) {
      expect(src).not.toMatch(/ContextDrive|dialDrive|landFlash/);
    }
  });
});
