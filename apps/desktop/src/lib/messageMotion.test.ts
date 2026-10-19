import { describe, expect, it } from "vitest";
import { FLIGHT_MS, TOTAL_MS } from "./sendMotion";
import { DURATION, REWIND_STYLE, flightPoint, prepareRewind, rewindFrame, rewindRow } from "./messageMotion";

const STYLES = ["A", "B", "C", "fade"] as const;

describe("the rewind motion (backlog 396)", () => {
  it("builds A, and every look stays short (≤ 600 ms, under the send's)", () => {
    expect(REWIND_STYLE).toBe("A");
    for (const s of STYLES) {
      expect(DURATION.rewind[s]).toBeLessThanOrEqual(600);
      expect(DURATION.rewind[s]).toBeLessThan(TOTAL_MS);
    }
  });

  it("every look starts exactly as the thread was (the copy whole, opaque) and ends with nothing drawn", () => {
    for (const s of STYLES) {
      const f0 = rewindFrame(s, 0);
      expect(f0.bg).toBe(1);
      expect(f0.cover.opacity).toBe(1);
      expect(f0.cover.scaleY).toBe(1);
      expect(f0.cover.dy).toBe(0);
      const end = rewindFrame(s, DURATION.rewind[s]);
      expect(end.done).toBe(true);
      expect(end.cover.opacity).toBe(0);
      expect(end.bg).toBe(0);
      expect(end.shift).toBe(1);
      expect(end.flight).toBeNull();
      expect(end.ring).toBeNull();
    }
  });

  it("A: the bubble flies back on the send's path, reversed, landing in the box", () => {
    const bubble = { x: 400, y: 100 };
    const box = { x: 40, y: 500 };
    expect(flightPoint(bubble, box, 0)).toEqual(bubble);
    expect(flightPoint(bubble, box, 1)).toEqual(box);
    // Reversed send: it drifts across first (x moves more than y early on).
    const p = flightPoint(bubble, box, 0.3);
    expect(Math.abs(p.x - bubble.x) / 360).toBeGreaterThan(Math.abs(p.y - bubble.y) / 400);
    expect(rewindFrame("A", 60).flight!.s).toBe(0);
    expect(rewindFrame("A", 60 + FLIGHT_MS - 1).flight!.s).toBeGreaterThan(0.99);
    expect(rewindFrame("A", 60 + FLIGHT_MS - 1).flight!.opacity).toBeLessThan(0.01);
    // Its tint drains as it lands: a bubble going back to typed text.
    expect(rewindFrame("A", 60).flight!.tint).toBe(1);
    expect(rewindFrame("A", 60 + FLIGHT_MS - 1).flight!.tint).toBeLessThan(0.01);
    expect(rewindFrame("A", 60 + FLIGHT_MS).flight).toBeNull();
  });

  it("A: the rows leave the last one first, dropping toward the box, all gone by 400 ms", () => {
    const n = 5;
    const at = 120;
    const last = rewindRow("A", at, 0, n);
    const first = rewindRow("A", at, n - 1, n);
    expect(last.opacity).toBeLessThan(first.opacity);
    expect(last.dy).toBeGreaterThan(0);
    for (let k = 0; k < n; k++) expect(rewindRow("A", 400, k, n).opacity).toBe(0);
    // Many rows still all start within 200 ms.
    expect(rewindRow("A", 400, 39, 40).opacity).toBe(0);
    // B and C move the copy whole.
    expect(rewindRow("B", 200, 0, n)).toEqual({ opacity: 1, dy: 0 });
  });

  it("A: the paper hides the new state until the rows have mostly gone, the ring follows the landing", () => {
    expect(rewindFrame("A", 250).bg).toBe(1);
    expect(rewindFrame("A", 440).bg).toBe(0);
    expect(rewindFrame("A", 399).ring).toBeNull();
    expect(rewindFrame("A", 500).ring).toBeCloseTo(0.5);
  });

  it("B folds the copy up into a line at the top; C drains it down", () => {
    expect(rewindFrame("B", 300).cover.scaleY).toBe(0);
    expect(rewindFrame("B", 200).line!.k).toBe(1);
    expect(rewindFrame("B", 400).line!.k).toBeLessThan(1);
    expect(rewindFrame("C", 320).cover.dy).toBe(20);
    expect(rewindFrame("C", 320).cover.opacity).toBe(0);
  });

  it("reduced motion is a plain fade: nothing moves, no flight, no ring, rows jump to place", () => {
    for (let ms = 0; ms < DURATION.rewind.fade; ms += 10) {
      const f = rewindFrame("fade", ms);
      expect(f.cover.dy).toBe(0);
      expect(f.cover.scaleY).toBe(1);
      expect(f.cover.blur).toBe(0);
      expect(f.flight).toBeNull();
      expect(f.line).toBeNull();
      expect(f.ring).toBeNull();
      expect(f.shift).toBe(1);
      expect(rewindRow("fade", ms, 0, 3)).toEqual({ opacity: 1, dy: 0 });
    }
  });
});

describe("with no DOM to draw on", () => {
  it("prepare returns null and the caller goes on with the plain state change", () => {
    expect(prepareRewind(null, 3)).toBeNull();
  });
});
