import { describe, expect, it } from "vitest";
import { MIN_CARD, VIEW_MARGIN, fitRect, zoomCss, zoomTransform, type Rect } from "./attachmentView";

// The floating attachment tab's geometry (nightshift backlog 145): the
// card fit and centred in the viewport, and the zoom's origin — the
// transform that lays the card over the thumbnail it opened from.

const vp: Rect = { top: 0, left: 0, width: 1200, height: 800 };

describe("fitRect", () => {
  it("fits a large image inside the viewport less the margin, centred, keeping its shape", () => {
    const r = fitRect({ width: 4000, height: 2000 }, vp);
    expect(r.width).toBe(1200 - 2 * VIEW_MARGIN);
    expect(r.height).toBe(r.width / 2);
    expect(r.left).toBe((1200 - r.width) / 2);
    expect(r.top).toBe((800 - r.height) / 2);
  });

  it("never enlarges a small image past its natural size, but gives the card a floor", () => {
    const r = fitRect({ width: 100, height: 60 }, vp);
    expect(r.width).toBe(MIN_CARD);
    expect(r.height).toBe(MIN_CARD);
    const m = fitRect({ width: 600, height: 300 }, vp);
    expect(m.width).toBe(600);
    expect(m.height).toBe(300);
  });

  it("a tall image is bound by the height", () => {
    const r = fitRect({ width: 1000, height: 3000 }, vp);
    expect(r.height).toBe(800 - 2 * VIEW_MARGIN);
    expect(r.width).toBe(r.height / 3);
  });

  it("is placed in the viewport's own frame", () => {
    const off: Rect = { top: 100, left: 260, width: 940, height: 600 };
    const r = fitRect({ width: 400, height: 400 }, off);
    expect(r.left).toBe(260 + (940 - 400) / 2);
    expect(r.top).toBe(100 + (600 - 400) / 2);
  });
});

describe("zoomTransform", () => {
  it("maps the card onto the thumbnail: translate the corners, scale the sides", () => {
    const thumb: Rect = { top: 500, left: 300, width: 192, height: 96 };
    const card: Rect = { top: 100, left: 200, width: 800, height: 400 };
    const t = zoomTransform(thumb, card);
    expect(t).toEqual({ x: 100, y: 400, sx: 0.24, sy: 0.24 });
    expect(zoomCss(t)).toBe("translate(100px, 400px) scale(0.24, 0.24)");
  });

  it("a hidden thumbnail (no size) still gives a first frame", () => {
    const t = zoomTransform({ top: 0, left: 0, width: 0, height: 0 }, { top: 10, left: 10, width: 100, height: 100 });
    expect(t.sx).toBe(0);
    expect(t.sy).toBe(0);
  });
});
