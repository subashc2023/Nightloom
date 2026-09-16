import { describe, expect, it } from "vitest";
import { ZOOM_STEPS, parseZoom, stepZoom, zoomChord, zoomLabel } from "./zoom";

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
