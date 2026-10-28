import { describe, expect, it } from "vitest";
import { FLIGHT_MS, frameAt as flightAt } from "./sendMotion";
import {
  ARRIVAL_STYLE,
  A_SCALE,
  DURATION,
  FRESH_MS,
  OFFERED_STYLES,
  STREAK_MS,
  chosenArrival,
  decide,
  frameAt,
  pathPoint,
  setChosenArrival,
} from "./thinkingArrival";

/** A base-timeline time (the 480 ms one the comments describe) as played, ×1.3 (backlog 395). */
const a = (base: number) => base * A_SCALE;

describe("the thinking block's arrival (backlog 389)", () => {
  it("builds A, his idea, and keeps it shorter than the send flight", () => {
    expect(ARRIVAL_STYLE).toBe("A");
    expect(DURATION.A).toBeLessThan(FLIGHT_MS + 420);
    expect(STREAK_MS).toBeLessThanOrEqual(FLIGHT_MS);
  });

  it("A plays 1.3x slower than 389 built it (backlog 395): 480 -> 624 ms, the streak 220 -> 286", () => {
    expect(A_SCALE).toBe(1.3);
    expect(DURATION.A).toBe(624);
    expect(DURATION.A).toBeGreaterThan(480);
    expect(STREAK_MS).toBe(286);
    // every time stretches together: the base frame at t is the played frame at 1.3t
    expect(frameAt("A", a(250))).toEqual(frameAt("A", 250 * 1.3));
    expect(frameAt("A", 479).done).toBe(false);
    expect(frameAt("A", 623).done).toBe(false);
    expect(frameAt("A", 624).done).toBe(true);
  });

  it("A: the streak flies first with the block hidden, then the block drops in under the line", () => {
    const f0 = frameAt("A", 0);
    expect(f0.opacity).toBe(0);
    expect(f0.streak).not.toBeNull();
    const mid = frameAt("A", a(120));
    expect(mid.streak!.head).toBeGreaterThan(mid.streak!.tail);
    expect(mid.opacity).toBe(0);
    const landed = frameAt("A", STREAK_MS);
    expect(landed.streak!.head).toBe(1);
    expect(landed.line).not.toBeNull();
    expect(frameAt("A", a(300)).streak).toBeNull(); // the tail has collapsed into the landing point
    expect(frameAt("A", a(340)).line!.k).toBeCloseTo(1);
    expect(frameAt("A", a(320)).opacity).toBe(1);
    expect(frameAt("A", a(380)).reveal).toBeCloseTo(1);
  });

  it("A: the drop settles from −6 px with at most a pixel of overshoot, and ends still", () => {
    let low = 0;
    let high = -Infinity;
    for (let ms = 0; ms < DURATION.A; ms += 4) {
      const f = frameAt("A", ms);
      low = Math.min(low, f.dy);
      high = Math.max(high, f.dy);
    }
    expect(low).toBe(-6);
    expect(high).toBeGreaterThan(0);
    expect(high).toBeLessThanOrEqual(1);
    const end = frameAt("A", DURATION.A);
    expect(end).toMatchObject({ opacity: 1, dy: 0, blur: 0, reveal: 1, streak: null, line: null, shimmer: null, done: true });
  });

  it("A's streak follows the send flight's own curve", () => {
    const o = { x: 40, y: 600 };
    const l = { x: 300, y: 200 };
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      const p = pathPoint(o, l, u);
      const g = flightAt(u * FLIGHT_MS, o, l);
      expect(p.x).toBeCloseTo(g.x);
      expect(p.y).toBeCloseTo(g.y);
    }
  });

  it("B: a dot, then the line, then the block opens down, then one shimmer", () => {
    expect(frameAt("B", 50).dot!.r).toBeGreaterThan(0);
    expect(frameAt("B", 50).opacity).toBe(0);
    expect(frameAt("B", 200).line!.k).toBeGreaterThan(0);
    expect(frameAt("B", 440).reveal).toBeCloseTo(1);
    expect(frameAt("B", 400).shimmer).toBeGreaterThan(0);
    expect(frameAt("B", DURATION.B).done).toBe(true);
  });

  it("C: rises 6 px and un-blurs, then one shimmer", () => {
    expect(frameAt("C", 0)).toMatchObject({ opacity: 0, dy: 6, blur: 4 });
    expect(frameAt("C", 300).dy).toBeCloseTo(0);
    expect(frameAt("C", 260).blur).toBeCloseTo(0);
    expect(frameAt("C", 400).shimmer).toBeGreaterThan(0);
  });

  it("reduced motion is a plain fade: nothing drawn, nothing moves", () => {
    for (let ms = 0; ms <= DURATION.fade; ms += 20) {
      const f = frameAt("fade", ms);
      expect(f).toMatchObject({ dy: 0, blur: 0, reveal: 1, streak: null, dot: null, line: null, shimmer: null });
    }
    expect(frameAt("fade", 0).opacity).toBe(0);
    expect(frameAt("fade", 90).opacity).toBeGreaterThan(0.5);
  });
});

describe("the pick in Settings → Appearance → Animations (backlog 395)", () => {
  it("offers A and B, not C", () => {
    expect(OFFERED_STYLES.map((s) => s.id)).toEqual(["A", "B"]);
  });
  it("defaults to A, remembers B, and never stores or reads C", () => {
    localStorage.removeItem("nightloom.thinkingArrival");
    expect(chosenArrival()).toBe("A");
    setChosenArrival("B");
    expect(localStorage.getItem("nightloom.thinkingArrival")).toBe("B");
    expect(chosenArrival()).toBe("B");
    setChosenArrival("C");
    expect(chosenArrival()).toBe("B");
    localStorage.setItem("nightloom.thinkingArrival", "C");
    expect(chosenArrival()).toBe("A");
    localStorage.setItem("nightloom.thinkingArrival", "junk");
    expect(chosenArrival()).toBe("A");
    localStorage.removeItem("nightloom.thinkingArrival");
  });
});

describe("decide — only the first appearance of a live thinking row plays", () => {
  const T = 1_000_000;
  it("plays a fresh live segment once", () => {
    const m = new Map<number, number>();
    expect(decide(m, T, true, T + 30, DURATION.A)).toEqual({ play: true, from: 0 });
    // a re-render after the motion ended stays still
    expect(decide(m, T, true, T + 30 + DURATION.A + 5, DURATION.A).play).toBe(false);
  });
  it("never plays a row in history, or one with no clock", () => {
    const m = new Map<number, number>();
    expect(decide(m, T, false, T + 10, DURATION.A).play).toBe(false);
    expect(decide(m, undefined, true, T + 10, DURATION.A).play).toBe(false);
  });
  it("never plays a live row that was already thinking when the chat opened", () => {
    const m = new Map<number, number>();
    expect(decide(m, T, true, T + FRESH_MS + 1, DURATION.A).play).toBe(false);
  });
  it("a node remounted mid-motion picks it up where it was", () => {
    const m = new Map<number, number>();
    decide(m, T, true, T + 20, DURATION.A);
    expect(decide(m, T, true, T + 20 + 150, DURATION.A)).toEqual({ play: true, from: 150 });
  });
  it("two segments play independently", () => {
    const m = new Map<number, number>();
    expect(decide(m, T, true, T + 5, DURATION.A).play).toBe(true);
    expect(decide(m, T + 4000, true, T + 4005, DURATION.A)).toEqual({ play: true, from: 0 });
  });
});
