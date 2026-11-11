import { describe, expect, it } from "vitest";
import { GROUND_STYLES, bump, fpsFor, groundWanted, parseRgb, ringRadius, seeded } from "./newChatGround";
import { DEFAULT_GROUND, parseGround } from "./newChatGroundPick.svelte";

describe("item 632: the new-chat background", () => {
  it("offers today's dots and the default among the looks", () => {
    const ids = GROUND_STYLES.map((s) => s.id);
    expect(ids).toContain("dots");
    expect(ids).toContain(DEFAULT_GROUND);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("reads a stored pick back, anything unknown as the default", () => {
    expect(parseGround("ripple")).toBe("ripple");
    expect(parseGround("dots")).toBe("dots");
    expect(parseGround(null)).toBe(DEFAULT_GROUND);
    expect(parseGround("sparkles")).toBe(DEFAULT_GROUND);
  });
  it("runs only for a moving look, with the lit ground on and motion allowed", () => {
    const tile = "radial-gradient(circle, red 1px, transparent 1.2px)";
    expect(groundWanted("weft", tile, false)).toBe(true);
    expect(groundWanted("dots", tile, false)).toBe(false);
    expect(groundWanted("weft", tile, true)).toBe(false); // Reduce motion
    expect(groundWanted("weft", " none", false)).toBe(false); // Calm, the classic palettes
    expect(groundWanted("weft", "", false)).toBe(false);
  });
  it("bumps to 1 at the band's centre and 0 at its edges", () => {
    expect(bump(0)).toBe(1);
    expect(bump(1)).toBe(0);
    expect(bump(-1.5)).toBe(0);
    expect(bump(0.5)).toBeCloseTo(0.5625);
  });
  it("spreads a ring from 0 to the far corner, always outward", () => {
    expect(ringRadius(0, 800)).toBeCloseTo(0);
    expect(ringRadius(1, 800)).toBeCloseTo(800);
    let prev = -1;
    for (let p = 0; p <= 1; p += 0.05) {
      const r = ringRadius(p, 800);
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
  });
  it("repeats a seeded scene", () => {
    const a = seeded(632);
    const b = seeded(632);
    for (let n = 0; n < 5; n++) expect(a()).toBe(b());
  });
  it("parses the theme's colours as computed style gives them", () => {
    expect(parseRgb("#86d8f7", [0, 0, 0])).toEqual([134, 216, 247]);
    expect(parseRgb("rgb(255, 180, 84)", [0, 0, 0])).toEqual([255, 180, 84]);
    expect(parseRgb("color(srgb 1 0 0)", [1, 2, 3])).toEqual([1, 2, 3]);
  });
  it("draws slow looks at 30 frames a second", () => {
    expect(fpsFor("aurora")).toBe(30);
    expect(fpsFor("drift")).toBe(30);
    expect(fpsFor("weft")).toBe(60);
  });
});
