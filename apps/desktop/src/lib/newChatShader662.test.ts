import { describe, expect, it } from "vitest";
import { SEA_GRID, seaTyping, shaderSource } from "./newChatShader";

// Item 662: typing on the new-chat page moves the Horizon sea (his pick B1 Roll, round 4).
// Types `secs` at `rate` keys/s from rest, then idles; samples every 1/120 s.
function run(secs: number, rate: number, idle = 4) {
  const s = seaTyping();
  const dt = 1 / 120;
  const pts: [number, number][] = [];
  let t = 0;
  let nk = 0;
  let last = 0;
  while (t < secs + idle) {
    if (t < secs - 1e-9 && t >= nk / rate) {
      s.key();
      nk++;
      last = t;
    }
    s.tick(dt);
    t += dt;
    pts.push([t, s.e]);
  }
  const at = (x: number) => (pts.find(([tt]) => tt >= x - 1e-9) ?? pts[pts.length - 1])[1];
  return { s, pts, at, last };
}

describe("item 662: typing moves the sea", () => {
  it("rises smoothly over about a second of typing", () => {
    const { at } = run(3, 5);
    expect(at(1)).toBeGreaterThan(0.6);
    expect(at(1)).toBeLessThan(0.76);
    expect(at(2)).toBeGreaterThan(0.9);
    expect(at(0.2)).toBeLessThan(0.1); // no key moves it by itself
  });

  it("falls under 10% within 1.5 s of the last key", () => {
    for (const rate of [3, 5, 8]) {
      const { pts, last } = run(3, rate);
      const under = pts.find(([t, e]) => t > last && e < 0.1);
      expect(under).toBeDefined();
      expect(under![0] - last).toBeLessThan(1.5);
    }
  });

  it("never steps more than 3% of its range between two 60 Hz frames", () => {
    for (const rate of [3, 5, 8, 12]) {
      const { pts } = run(3, rate);
      let max = 0;
      for (let i = 2; i < pts.length; i += 2) max = Math.max(max, Math.abs(pts[i][1] - pts[i - 2][1]));
      expect(max).toBeLessThan(0.03);
    }
  });

  it("barely answers one stray key, and holds through steady slow typing", () => {
    const one = run(0.01, 5);
    expect(Math.max(...one.pts.map(([, e]) => e))).toBeLessThan(0.2);
    expect(run(3, 3).at(3)).toBeGreaterThan(0.95);
  });

  it("rolls the grid further while typing, kept within one grid period", () => {
    const { s } = run(3, 5, 0);
    expect(s.roll).toBeGreaterThan(0);
    expect(s.roll).toBeLessThan(SEA_GRID);
  });

  it("resets to rest (Reduce motion)", () => {
    const { s } = run(2, 5, 0);
    s.reset();
    expect(s.e).toBe(0);
    s.tick(1 / 60);
    expect(s.e).toBe(0);
  });

  it("lights and rolls only the sea; Radar has no typing response", () => {
    const h = shaderSource("horizon");
    expect(h).toContain("uniform float seaTypingE; uniform float seaTypingRoll;");
    expect(h).toContain("t * 40.0 - seaTypingRoll");
    const sky = h.slice(h.indexOf("} else {"));
    expect(sky).not.toContain("seaTyping");
    expect(shaderSource("radar")).not.toContain("seaTyping");
  });
});
