import { describe, expect, it } from "vitest";
import { FLIGHT_MS, TOTAL_MS } from "./sendMotion";
import {
  DELETE_STYLE,
  DURATION,
  MOTION_KEY,
  OFFERED_MOTIONS,
  REWIND_STYLE,
  chosenMotion,
  deleteFrame,
  flightPoint,
  prepareDelete,
  prepareRewind,
  rewindFrame,
  rewindRow,
  setChosenMotion,
} from "./messageMotion";

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

describe("the delete motion (backlog 397)", () => {
  it("builds A, and every look stays short", () => {
    expect(DELETE_STYLE).toBe("A");
    for (const s of STYLES) expect(DURATION.delete[s]).toBeLessThanOrEqual(600);
  });

  it("every look starts on the old bubble, whole, and ends on the placeholder alone", () => {
    for (const s of STYLES) {
      const f0 = deleteFrame(s, 0);
      expect(f0.ghost.opacity).toBe(1);
      expect(f0.node).toBe(0);
      const end = deleteFrame(s, DURATION.delete[s]);
      expect(end.done).toBe(true);
      expect(end.ghost.opacity).toBe(0);
      expect(end.node).toBe(1);
      expect(end.shift).toBe(1);
    }
  });

  it("A: the strike draws across first, then the struck bubble lifts away and the placeholder fades in", () => {
    expect(deleteFrame("A", 80).strike!.k).toBeGreaterThan(0.5);
    expect(deleteFrame("A", 160).strike!.k).toBe(1);
    expect(deleteFrame("A", 160).ghost.opacity).toBe(1);
    expect(deleteFrame("A", 380).ghost.opacity).toBe(0);
    expect(deleteFrame("A", 380).ghost.dy).toBe(-10);
    expect(deleteFrame("A", 260).node).toBe(0);
    expect(deleteFrame("A", 459).node).toBeGreaterThan(0.99);
  });

  it("B morphs onto the placeholder; C blurs out", () => {
    expect(deleteFrame("B", 0).morph).toBe(0);
    expect(deleteFrame("B", 320).morph).toBe(1);
    expect(deleteFrame("C", 300).ghost.blur).toBe(6);
  });

  it("reduced motion is a plain cross-fade", () => {
    for (let ms = 0; ms < DURATION.delete.fade; ms += 10) {
      const f = deleteFrame("fade", ms);
      expect(f.ghost.dy).toBe(0);
      expect(f.ghost.scale).toBe(1);
      expect(f.ghost.blur).toBe(0);
      expect(f.strike).toBeNull();
      expect(f.morph).toBeNull();
      expect(f.shift).toBe(1);
      expect(f.ghost.opacity + f.node).toBeCloseTo(1);
    }
  });
});

describe("with no DOM to draw on", () => {
  it("prepare returns null and the caller goes on with the plain state change", () => {
    expect(prepareRewind(null, 3)).toBeNull();
    expect(prepareDelete(undefined, 3)).toBeNull();
  });
});

describe("the picks in Settings → Appearance → Animations (396 + 397, pass 2)", () => {
  it("offers A, B and C for both, under these keys", () => {
    expect(OFFERED_MOTIONS.rewind.map((s) => s.id)).toEqual(["A", "B", "C"]);
    expect(OFFERED_MOTIONS.delete.map((s) => s.id)).toEqual(["A", "B", "C"]);
    expect(MOTION_KEY).toEqual({ rewind: "nightloom.rewindMotion", delete: "nightloom.deleteMotion" });
  });
  it("defaults to A for both, remembers each pick on its own, and reads junk as the default", () => {
    for (const k of ["rewind", "delete"] as const) localStorage.removeItem(MOTION_KEY[k]);
    expect(chosenMotion("rewind")).toBe("A");
    expect(chosenMotion("delete")).toBe("A");
    setChosenMotion("rewind", "C");
    setChosenMotion("delete", "B");
    expect(localStorage.getItem("nightloom.rewindMotion")).toBe("C");
    expect(chosenMotion("rewind")).toBe("C");
    expect(chosenMotion("delete")).toBe("B");
    setChosenMotion("delete", "Z" as never);
    expect(chosenMotion("delete")).toBe("B");
    localStorage.setItem("nightloom.deleteMotion", "junk");
    expect(chosenMotion("delete")).toBe("A");
    for (const k of ["rewind", "delete"] as const) localStorage.removeItem(MOTION_KEY[k]);
  });
});
