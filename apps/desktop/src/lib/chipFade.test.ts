import { describe, expect, it } from "vitest";
import { CHIP_FADE_MS, Marks, chipMotion, easeOut } from "./chipFade";

describe("chipMotion (item 312)", () => {
  it("fades a chip that came from text", () => {
    const m = chipMotion(true, false);
    expect(m.duration).toBe(CHIP_FADE_MS);
    expect(m.duration).toBeLessThan(300);
    expect(m.easing).toBe(easeOut);
    expect(m.css?.(0)).toBe("opacity: 0");
    expect(m.css?.(1)).toBe("opacity: 1");
  });
  it("leaves other chips alone", () => {
    expect(chipMotion(false, false)).toEqual({ duration: 0 });
  });
  it("does not animate under reduced motion", () => {
    expect(chipMotion(true, true)).toEqual({ duration: 0 });
  });
  it("eases out monotonically", () => {
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const v = easeOut(i / 10);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
  });
});

describe("Marks", () => {
  it("is used once", () => {
    const m = new Marks<string>();
    m.mark("Pasted text 2");
    expect(m.take("Pasted text")).toBe(false);
    expect(m.take("Pasted text 2")).toBe(true);
    expect(m.take("Pasted text 2")).toBe(false);
  });
  it("unmark drops a mark that was never used", () => {
    const m = new Marks<string>();
    m.mark("a");
    m.unmark("a");
    expect(m.take("a")).toBe(false);
  });
});
