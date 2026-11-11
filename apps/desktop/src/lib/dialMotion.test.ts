import { describe, expect, it } from "vitest";
import motionSrc from "./DialMotion.svelte?raw";
import welcomeSrc from "./Welcome.svelte?raw";
import classicSrc from "./WelcomeClassic.svelte?raw";
import dialSrc from "./ContextDial.svelte?raw";
import {
  drive,
  easeBack,
  escapement,
  integral,
  inSpan,
  kick,
  leftWords,
  level,
  prune,
  secondsAngle,
  spoke,
  windowElapsed,
  windowTip,
} from "./dialMotion";

// Item 581: the new-chat dial's motion layer — gears, a ticking hand, the
// 5-hour window's slow hand and an audio-style ring, reacting to him.

describe("impulses (typing, a layer switch, a project switch)", () => {
  it("decay, and integrate in closed form so a spin-up is exact at any t", () => {
    const d = drive(0.5);
    kick(d, 1, 2);
    expect(level(d, 0.5)).toBe(0);
    expect(level(d, 1)).toBeCloseTo(2);
    expect(level(d, 1.5)).toBeCloseTo(2 * Math.exp(-1));
    expect(integral(d, 1)).toBeCloseTo(0);
    expect(integral(d, 100)).toBeCloseTo(1); // size × τ
    // Numerical check of the integral over [1, 2].
    let s = 0;
    for (let t = 1; t < 2; t += 0.0001) s += level(d, t) * 0.0001;
    expect(integral(d, 2)).toBeCloseTo(s, 3);
  });
  it("prune folds dead impulses in without moving the gears", () => {
    const d = drive(0.4);
    kick(d, 0, 300);
    kick(d, 9, 300);
    const before = integral(d, 10);
    prune(d, 10);
    expect(d.list.length).toBe(1);
    expect(integral(d, 10)).toBeCloseTo(before, 6);
  });
});

describe("the clock hand and the escapement", () => {
  it("steps once a second with an overshoot that settles", () => {
    expect(easeBack(0)).toBeCloseTo(0);
    expect(easeBack(1)).toBeCloseTo(1);
    const peak = Math.max(...Array.from({ length: 100 }, (_, i) => easeBack(i / 100)));
    expect(peak).toBeGreaterThan(1.05);
    expect(peak).toBeLessThan(1.25);
    // 12:00:07.000 → the hand is just leaving 36°; settled at 42° by .3 s; a lap a minute.
    const at = (s: number, ms: number) => secondsAngle(Date.UTC(2026, 10, 10, 12, 0, s, ms));
    expect(at(7, 0)).toBeCloseTo(36);
    expect(at(7, 300)).toBeCloseTo(42);
    expect(at(7, 900)).toBeCloseTo(42);
    expect(at(7, 120)).toBeGreaterThan(42); // the overshoot
    expect(at(59, 900)).toBeCloseTo(354);
  });
  it("gear B steps one tooth each time a gear A tooth passes, and holds between", () => {
    expect(escapement(6, 6, 9)).toBeCloseTo(0);
    expect(escapement(6 * 1.5, 6, 9)).toBeCloseTo(9);
    expect(escapement(6 * 1.9, 6, 9)).toBeCloseTo(9);
    expect(escapement(6 * 5.9, 6, 9)).toBeCloseTo(45);
    expect(escapement(6 * 2.1, 6, 9)).toBeGreaterThan(9);
  });
});

describe("the audio ring", () => {
  it("idles gently and surges", () => {
    const idle = Array.from({ length: 180 }, (_, i) => spoke((i * Math.PI) / 90, 3, 0));
    const loud = Array.from({ length: 180 }, (_, i) => spoke((i * Math.PI) / 90, 3, 1.2));
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(Math.max(...idle)).toBeLessThanOrEqual(0.32);
    expect(mean(loud)).toBeGreaterThan(mean(idle) * 2);
    for (const v of loud) expect(v).toBeLessThanOrEqual(1);
    // It moves: the same spoke differs a fifth of a second later.
    expect(spoke(1, 3, 0)).not.toBeCloseTo(spoke(1, 3.2, 0), 3);
  });
});

describe("the 5-hour window's slow hand", () => {
  const now = Date.UTC(2026, 10, 10, 17, 0);
  it("is how far through the window he is", () => {
    expect(windowElapsed(new Date(now + 5 * 3600_000).toISOString(), now)).toBeCloseTo(0);
    expect(windowElapsed(new Date(now + 3600_000).toISOString(), now)).toBeCloseTo(0.8);
    expect(windowElapsed(new Date(now - 1).toISOString(), now)).toBe(1);
    expect(windowElapsed(null, now)).toBeNull();
    expect(windowElapsed("not a date", now)).toBeNull();
  });
  it("names its time left on hover", () => {
    expect(leftWords(30_000)).toBe("under a minute");
    expect(leftWords(38 * 60_000)).toBe("38 min");
    expect(leftWords(134 * 60_000)).toBe("2 h 14 min");
    expect(leftWords(120 * 60_000)).toBe("2 h");
    const t = windowTip(26, new Date(now + 134 * 60_000).toISOString(), now, "9:40 PM");
    expect(t).toContain("5-hour window: 26% used · resets 9:40 PM (in 2 h 14 min)");
    expect(windowTip(26, new Date(now - 1).toISOString(), now, "x")).toContain("it has reset");
  });
  it("spans wrap round 12 o'clock", () => {
    expect(inSpan(0.1, 0, 0.1)).toBe(true);
    expect(inSpan(Math.PI, 0, 0.1)).toBe(false);
    expect(inSpan(0.05, 0.95, 0.1)).toBe(true);
  });
});

describe("the motion rules (581; 574b's rules for ContextDial stand unchanged)", () => {
  it("one requestAnimationFrame loop, stopped while hidden or under reduced motion, no CSS loops", () => {
    expect(motionSrc.match(/requestAnimationFrame\(/g)?.length).toBe(2); // start + the frame's own re-arm
    expect(motionSrc).toContain('document.addEventListener("visibilitychange", sync)');
    expect(motionSrc).toContain('if (running || reduce?.matches || document.visibilityState === "hidden") return;');
    expect(motionSrc).toMatch(/if \(reduce\?\.matches \|\| document\.visibilityState === "hidden"\) stop\(\);/);
    // The still form: time 0, no seconds tick.
    expect(motionSrc).toContain("draw(ctx, still ? 0 : clock(), still ? NaN : wall(), still);");
    expect(motionSrc).toContain("const surge = still ? 0 :");
    expect(motionSrc).toContain('if (shows("hand") && Number.isFinite(ms))');
    expect(motionSrc).not.toMatch(/@keyframes|animation:|setInterval\([^,]+,\s*\d{1,3}\)/);
    // Unmount stops it.
    expect(motionSrc).toMatch(/return \(\) => \{\s*stop\(\);/);
  });
  it("calm draws no glow; the canvas never takes the pointer", () => {
    // 585 adds the column's quiet form to the same guard.
    expect(motionSrc).toMatch(/if \(ink\.glow && !ink\.calm(?: && !quiet)?\) \{/);
    expect(motionSrc).toMatch(/\.dm \{\s*position: absolute;\s*pointer-events: none;/);
  });
  it("sits on the Filament IV page only — Classic and the shared dial are untouched", () => {
    expect(welcomeSrc).toMatch(/\{#if classic\(\)\}\s*<WelcomeClassic \/>\s*\{:else\}/);
    expect(welcomeSrc.indexOf("<DialMotion")).toBeGreaterThan(welcomeSrc.indexOf("{:else}"));
    expect(classicSrc).not.toContain("DialMotion");
    expect(dialSrc).not.toContain("DialMotion");
    // The big dial and the short pane's 84 px one.
    expect(welcomeSrc.match(/<DialMotion/g)?.length).toBe(2);
    // His keys reach it without touching the Composer: input events bubble to the slot.
    expect(welcomeSrc).toContain('<div class="composer-slot" oninput={() => typed++}>');
  });
});
