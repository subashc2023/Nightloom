// Item 885: the full-size picture viewer's zoom maths and its close rules.
import { describe, expect, it } from "vitest";
import { CLICK_SCALE, FIT, MAX_SCALE, clamp, clickVerdict, clickZoom, isZoomed, keyCloses, loadZoom, pinch, saveZoom, wheelFactor, zoomAt, zoomCss } from "./pictureZoom";

// A 1000×800 stage with a 600×800 picture centred in it at fit.
const stage = { width: 1000, height: 800 };
const fit = { left: 200, top: 0, width: 600, height: 800 };
/** Where the picture point (u, v) (fit coordinates) is drawn, in stage coordinates. */
const drawn = (z: { s: number; x: number; y: number }, u: number, v: number) => ({ x: fit.left + z.x + z.s * u, y: fit.top + z.y + z.s * v });

describe("click on the picture (885)", () => {
  it("zooms in centred on the clicked spot", () => {
    const z = clickZoom(FIT, { x: 500, y: 400 }, fit, stage); // the picture's centre
    expect(z.s).toBe(CLICK_SCALE);
    const c = drawn(z, 300, 400);
    expect(c.x).toBeCloseTo(500);
    expect(c.y).toBeCloseTo(400);
  });
  it("a click near a corner shows that corner, clamped to the edge (no gap)", () => {
    const z = clickZoom(FIT, { x: 205, y: 5 }, fit, stage); // top-left corner
    expect(z.s).toBe(CLICK_SCALE);
    const tl = drawn(z, 0, 0);
    expect(tl.x).toBeCloseTo(0);
    expect(tl.y).toBeCloseTo(0);
    // The clicked point is still on screen, in the top-left quarter.
    const p = drawn(z, 5, 5);
    expect(p.x).toBeLessThan(stage.width / 2);
    expect(p.y).toBeLessThan(stage.height / 2);
  });
  it("a second click goes back to fit", () => {
    const z = clickZoom(FIT, { x: 500, y: 400 }, fit, stage);
    expect(clickZoom(z, { x: 10, y: 10 }, fit, stage)).toEqual(FIT);
  });
});

describe("pinch (885)", () => {
  it("zoomAt keeps the point under the pointer still", () => {
    const p = { x: 650, y: 300 };
    const before = { u: (p.x - fit.left) / 1, v: p.y };
    const z = zoomAt(FIT, p, fit, 3);
    const d = drawn(z, before.u, before.v);
    expect(d.x).toBeCloseTo(p.x);
    expect(d.y).toBeCloseTo(p.y);
  });
  it("zoomAt from a zoomed state keeps the point still too", () => {
    const z1 = { s: 2, x: -300, y: -200 };
    const p = { x: 400, y: 500 };
    const u = (p.x - fit.left - z1.x) / z1.s;
    const v = (p.y - fit.top - z1.y) / z1.s;
    const z2 = zoomAt(z1, p, fit, 5);
    const d = drawn(z2, u, v);
    expect(d.x).toBeCloseTo(p.x);
    expect(d.y).toBeCloseTo(p.y);
  });
  it("a touch pinch follows the fingers' midpoint", () => {
    const z = pinch(FIT, { x: 500, y: 400 }, { x: 520, y: 380 }, 2, fit);
    expect(z.s).toBe(2);
    const d = drawn(z, 300, 400);
    expect(d.x).toBeCloseTo(520);
    expect(d.y).toBeCloseTo(380);
  });
  it("a ctrl-wheel up zooms in, down zooms out", () => {
    expect(wheelFactor(-10)).toBeGreaterThan(1);
    expect(wheelFactor(10)).toBeLessThan(1);
    expect(wheelFactor(0)).toBe(1);
  });
});

describe("clamp (885)", () => {
  it("never below fit, never past the most", () => {
    expect(clamp({ s: 0.3, x: 50, y: 50 }, fit, stage)).toEqual(FIT);
    expect(clamp({ s: 99, x: 0, y: 0 }, fit, stage).s).toBe(MAX_SCALE);
  });
  it("a picture wider than the stage leaves no gap at either edge", () => {
    const left = clamp({ s: 3, x: 5000, y: 0 }, fit, stage);
    expect(drawn(left, 0, 0).x).toBeCloseTo(0);
    const right = clamp({ s: 3, x: -5000, y: 0 }, fit, stage);
    expect(drawn(right, 600, 0).x).toBeCloseTo(stage.width);
  });
  it("an axis still narrower than the stage stays centred", () => {
    // A small picture (a tiny image smaller than the view): 100×50 at fit.
    const tiny = { left: 450, top: 375, width: 100, height: 50 };
    const z = clamp({ s: 2, x: 999, y: -999 }, tiny, stage);
    expect(tiny.left + z.x + (z.s * tiny.width) / 2).toBeCloseTo(500);
    expect(tiny.top + z.y + (z.s * tiny.height) / 2).toBeCloseTo(400);
  });
  it("fit draws no transform", () => {
    expect(zoomCss(FIT)).toBe("");
    expect(isZoomed(FIT)).toBe(false);
    expect(zoomCss({ s: 2, x: 1, y: 2 })).toBe("translate(1px, 2px) scale(2)");
  });
});

describe("close rules (885)", () => {
  const picture = { left: 200, top: 0, width: 600, height: 800 };
  it("a click on the picture does not close — it zooms", () => {
    expect(clickVerdict({ x: 500, y: 400 }, picture, false)).toBe("zoom");
    expect(clickVerdict({ x: 200, y: 0 }, picture, false)).toBe("zoom");
  });
  it("a click outside the picture closes", () => {
    expect(clickVerdict({ x: 100, y: 400 }, picture, false)).toBe("close");
    expect(clickVerdict({ x: 900, y: 400 }, picture, false)).toBe("close");
  });
  it("the click that ends a drag or a pinch does nothing, inside or out", () => {
    expect(clickVerdict({ x: 500, y: 400 }, picture, true)).toBe("ignore");
    expect(clickVerdict({ x: 100, y: 400 }, picture, true)).toBe("ignore");
  });
  it("Esc closes; other keys do not", () => {
    expect(keyCloses("Escape")).toBe(true);
    expect(keyCloses("Enter")).toBe(false);
    expect(keyCloses(" ")).toBe(false);
  });
});

describe("a tab keeps its zoom (885 over 495)", () => {
  it("fit saves as nothing, and nothing loads as fit", () => {
    expect(saveZoom(FIT, fit)).toBe("");
    expect(loadZoom("", fit)).toEqual(FIT);
    expect(loadZoom("junk", fit)).toEqual(FIT);
  });
  it("a zoom and pan round-trip", () => {
    const z = { s: 3, x: -600, y: -400 };
    expect(loadZoom(saveZoom(z, fit), fit)).toEqual(z);
  });
  it("the pan scales with a pane that changed size in between", () => {
    const saved = saveZoom({ s: 2, x: -300, y: -200 }, fit);
    const half = { left: 100, top: 0, width: 300, height: 400 };
    expect(loadZoom(saved, half)).toEqual({ s: 2, x: -150, y: -100 });
  });
});
