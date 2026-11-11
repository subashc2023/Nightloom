import { describe, expect, it } from "vitest";
import { ZOOM_KEY, ZOOM_LEVEL_KEY, ZOOM_STEPS, loadZoom, migrateZoom, parseZoom, stepZoom, zoomChord, zoomFactor, zoomLabel } from "./zoom";

// Whole-app zoom (nightshift backlog 108): Chrome's steps, the label, the
// stored factor, and which chords are the key handler's on each platform.

describe("stepZoom", () => {
  it("walks Chrome's presets up and down and stops at the ends", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(0.5, -1)).toBe(0.5);
  });

  it("moves an off-scale factor to the preset beside it", () => {
    expect(stepZoom(1.3, 1)).toBe(1.5);
    expect(stepZoom(1.3, -1)).toBe(1.1);
  });

  it("has 1 as a step, so reset lands on the scale", () => {
    expect((ZOOM_STEPS as readonly number[]).includes(1)).toBe(true);
  });
});

describe("zoomLabel", () => {
  it("is Chrome's bubble", () => {
    expect(zoomLabel(1)).toBe("100%");
    expect(zoomLabel(1.1)).toBe("110%");
    expect(zoomLabel(0.67)).toBe("67%");
    expect(zoomLabel(2)).toBe("200%");
  });
});

describe("parseZoom", () => {
  it("reads a stored preset back and falls to 1 for anything else", () => {
    expect(parseZoom(null)).toBe(1);
    expect(parseZoom("1.25")).toBe(1.25);
    expect(parseZoom("0.67")).toBe(0.67);
    expect(parseZoom("3")).toBe(1);
    expect(parseZoom("nonsense")).toBe(1);
    expect(parseZoom("")).toBe(1);
  });
});

describe("item 619: 110 % is the new 100 %", () => {
  it("draws each level at 1.1 × its label — 100 % is the old 110 %", () => {
    expect(zoomFactor(1)).toBe(1.1);
    expect(zoomFactor(1.25)).toBe(1.375);
    expect(zoomFactor(0.9)).toBe(0.99);
    expect(zoomFactor(2)).toBe(2.2);
  });

  it("migrates his saved 110 % to 100 % at the same factor", () => {
    const level = migrateZoom(null, "1.1", true);
    expect(level).toBe(1);
    expect(zoomFactor(level)).toBe(1.1);
  });

  it("keeps every old factor on screen: old ÷ 1.1, snapped only within 0.5 %", () => {
    for (const old of ZOOM_STEPS) {
      const level = migrateZoom(null, String(old), true);
      expect(Math.abs(zoomFactor(level) - old) / old).toBeLessThan(0.005);
    }
    expect(migrateZoom(null, "1.25", true)).toBe(1.1364);
    expect(zoomFactor(migrateZoom(null, "1.25", true))).toBe(1.25);
    expect(zoomLabel(migrateZoom(null, "1.25", true))).toBe("114%");
  });

  it("an install at the old 100 % stays where it was; a fresh one starts at the new 100 %", () => {
    expect(zoomFactor(migrateZoom(null, null, true))).toBe(1);
    expect(zoomLabel(migrateZoom(null, null, true))).toBe("91%");
    expect(migrateZoom(null, null, false)).toBe(1);
    expect(migrateZoom(null, "garbage", false)).toBe(1);
  });

  it("runs once: a stored level wins over the old key", () => {
    expect(migrateZoom("1.25", "1.1", true)).toBe(1.25);
    expect(migrateZoom("1", "2", true)).toBe(1);
  });

  it("loadZoom migrates the store once and keeps the old key for an older build", () => {
    localStorage.clear();
    localStorage.setItem(ZOOM_KEY, "1.1");
    localStorage.setItem("nightloom.transcript", "{}");
    expect(loadZoom()).toBe(1);
    expect(localStorage.getItem(ZOOM_LEVEL_KEY)).toBe("1");
    expect(localStorage.getItem(ZOOM_KEY)).toBe("1.1");
    localStorage.setItem(ZOOM_KEY, "2"); // an older build moved it; the level is the truth now
    expect(loadZoom()).toBe(1);
    localStorage.clear();
    localStorage.setItem("nightloom.transcript", "{}"); // ran before, never zoomed: the old 100 %
    expect(loadZoom()).toBe(0.9091);
    localStorage.clear(); // a fresh install
    expect(loadZoom()).toBe(1);
    localStorage.clear();
  });

  it("reads back a migrated level between presets, not one off the scale", () => {
    expect(parseZoom("0.9091")).toBe(0.9091);
    expect(parseZoom("1.1364")).toBe(1.1364);
    expect(parseZoom("0.3")).toBe(1);
    expect(parseZoom("2.5")).toBe(1);
  });
});

describe("zoomChord", () => {
  const key = (code: string, shiftKey = false, altKey = false) => ({
    code,
    shiftKey,
    altKey,
  });

  it("takes only the shifted = on macOS, where the rest are menu items", () => {
    expect(zoomChord(key("Equal", true), true, true)).toBe("zoom_in");
    expect(zoomChord(key("Equal"), true, true)).toBeNull();
    expect(zoomChord(key("Minus"), true, true)).toBeNull();
    expect(zoomChord(key("Digit0"), true, true)).toBeNull();
  });

  it("takes all of them elsewhere, the numpad included", () => {
    expect(zoomChord(key("Equal"), true, false)).toBe("zoom_in");
    expect(zoomChord(key("Equal", true), true, false)).toBe("zoom_in");
    expect(zoomChord(key("NumpadAdd"), true, false)).toBe("zoom_in");
    expect(zoomChord(key("Minus"), true, false)).toBe("zoom_out");
    expect(zoomChord(key("NumpadSubtract"), true, false)).toBe("zoom_out");
    expect(zoomChord(key("Digit0"), true, false)).toBe("zoom_reset");
    expect(zoomChord(key("Digit0", true), true, false)).toBeNull();
  });

  it("needs the primary modifier and no Alt", () => {
    expect(zoomChord(key("Equal"), false, false)).toBeNull();
    expect(zoomChord(key("Equal", false, true), true, false)).toBeNull();
  });
});
