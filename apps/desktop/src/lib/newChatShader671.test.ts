import { describe, expect, it } from "vitest";
import {
  BREAKER_LANES,
  BREAKER_LIFE,
  COMET_PERIOD,
  METEOR_SLOT,
  SATELLITE_PASS,
  SATELLITE_SLOT,
  SKY_LEVELS,
  breakerPeriod,
  cometVisibility,
  easeHour,
  localHour,
  meteorSlot,
  satelliteVisibility,
  shaderSource,
  skyPhases,
} from "./newChatShader";

// Item 671: Horizon's sky follows his clock, with night events.
describe("item 671: the sky of the hour", () => {
  it("phase weights sum to 1 at every minute and are each in 0..1", () => {
    for (let m = 0; m < 1440; m++) {
      const w = skyPhases(m / 60);
      const vals = [w.night, w.morning, w.day, w.evening];
      expect(vals.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      for (const v of vals) {
        expect(v).toBeGreaterThanOrEqual(-1e-9);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it("each phase is whole at its hours: 2 AM night, 8 AM morning, 1 PM day, 6:30 PM evening", () => {
    expect(skyPhases(2).night).toBeCloseTo(1);
    expect(skyPhases(8).morning).toBeCloseTo(1);
    expect(skyPhases(13).day).toBeCloseTo(1);
    expect(skyPhases(18.5).evening).toBeCloseTo(1);
    expect(skyPhases(23.5).night).toBeCloseTo(1);
  });

  it("no weight moves more than 1.1% of its swing in a minute (the round 2 smoothness)", () => {
    let worst = 0;
    for (let m = 0; m < 1440; m++) {
      const a = skyPhases(m / 60);
      const b = skyPhases(((m + 1) % 1440) / 60);
      for (const k of ["night", "morning", "day", "evening"] as const) worst = Math.max(worst, Math.abs(b[k] - a[k]));
    }
    expect(worst).toBeLessThan(0.011);
  });

  it("reads the local hour and eases toward it the short way round midnight", () => {
    expect(localHour(new Date(2026, 10, 12, 14, 30, 0))).toBeCloseTo(14.5);
    // 23:50 -> 00:10 goes forward through midnight, not back through the day
    const h = easeHour(23 + 50 / 60, 10 / 60, 0.5);
    expect(h > 23.8 || h < 0.2).toBe(true);
    let x = 3;
    for (let i = 0; i < 1200; i++) x = easeHour(x, 15, 1 / 60); // 20 s
    expect(x).toBeCloseTo(15, 1);
    expect(easeHour(5, 9, 0)).toBe(5); // a first frame does not snap
  });
});

describe("item 671: event schedules", () => {
  it("shooting stars: at most one at a time, each inside its own slot, about 3 a minute (Strong)", () => {
    let n = 0;
    const slots = 6000; // 1000 minutes
    for (let id = 0; id < slots; id++) {
      const s = meteorSlot(id);
      expect(s.start).toBeGreaterThanOrEqual(0);
      expect(s.start + s.dur).toBeLessThanOrEqual(METEOR_SLOT); // ends before the next slot can start one
      expect(s.dur).toBeLessThan(1.1);
      if (s.on) n++;
    }
    const perMin = n / (slots * METEOR_SLOT / 60);
    expect(perMin).toBeGreaterThan(2.5);
    expect(perMin).toBeLessThan(4);
  });

  it("the comet fades in and out and is gone for part of each pass", () => {
    expect(cometVisibility(0)).toBe(0);
    expect(cometVisibility(COMET_PERIOD * 0.45)).toBe(1);
    expect(cometVisibility(COMET_PERIOD * 0.95)).toBe(0);
    let worst = 0;
    for (let s = 0; s < COMET_PERIOD; s++) worst = Math.max(worst, Math.abs(cometVisibility(s + 1) - cometVisibility(s)));
    expect(worst).toBeLessThan(0.07); // no pop: a ~24 s fade, under 7% a second
  });

  it("the satellite: one pass at a time, fading in and out (no pop), about once every 2 minutes", () => {
    let worst = 0,
      passes = 0;
    const mins = 1000;
    for (let s = 0; s < mins * 60; s++) {
      const a = satelliteVisibility(s),
        b = satelliteVisibility(s + 1);
      worst = Math.max(worst, Math.abs(b - a));
      if (a === 0 && b > 0) passes++;
    }
    expect(worst).toBeLessThan(0.38); // a 4 s smoothstep fade: at most 0.375 of its brightness in a second, no pop
    expect(satelliteVisibility(SATELLITE_PASS + 1)).toBe(0); // gone for the rest of its slot
    const perMin = passes / mins;
    expect(perMin).toBeGreaterThan(60 / SATELLITE_SLOT / 2);
    expect(perMin).toBeLessThan(60 / SATELLITE_SLOT);
  });

  it("breakers: 6 lanes (Strong), and a lane's wave always ends before its next one", () => {
    expect(BREAKER_LANES).toBe(6);
    for (let i = 0; i < BREAKER_LANES; i++) {
      expect(breakerPeriod(i)).toBeGreaterThan(BREAKER_LIFE);
      expect(breakerPeriod(i)).toBeLessThanOrEqual(14);
    }
  });

  it("events are gated by ev (none under Reduce motion); Radar has none", () => {
    const h = shaderSource("horizon");
    expect(h).toContain("uniform float hr; uniform float te; uniform float ev;");
    expect(h).toContain("ev > 0.5) col += breakers(");
    expect(h).toContain("ev > 0.5) col += cometSky(");
    expect(h).toContain("if (ev > 0.5) col += meteors(");
    expect(h).toContain("ev > 0.5) col += satellite(");
    const r = shaderSource("radar");
    for (const k of ["uniform float hr", "meteors", "cometSky", "breakers", "satellite"]) expect(r).not.toContain(k);
  });
});

// His round 3 verdict (2026-11-12): every element at its max.
describe("item 671: every element at its strongest", () => {
  it("stars Vivid+, aurora Vivid+, every event Strong, at every hour", () => {
    expect(SKY_LEVELS).toEqual({ stars: 2, aurora: 2, events: 2 });
    const h = shaderSource("horizon");
    expect(h).toContain("starSky2(q, u, 2.0)");
    expect(h).toContain("auroraSky2(q.x, u, 2.0)");
    for (const k of ["cometSky(q, 2.0)", "meteors(q, 2.0)", "moonSky(q, 2.0)", "breakers(q, dy, 2.0)", "reflectSea(q, dy, 2.0)"])
      expect(h).toContain(k);
    // the levels are constants, not hour-gated: no level is read from hr
    expect(h).not.toMatch(/V\s*=\s*[^;]*hr/);
  });
});
