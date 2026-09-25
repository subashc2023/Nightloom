import { describe, expect, it } from "vitest";
import { FLIGHT_MS, LAUNCH_TTL_MS, REVEAL_MS, SETTLE_MS, TOTAL_MS, frameAt, launchAt, takeLaunch } from "./sendMotion";

const from = { x: 40, y: 600 };
const to = { x: 300, y: 200 };

describe("frameAt — the send motion's timeline (backlog 194)", () => {
  it("starts on the box, untinted, with the real turn hidden", () => {
    const f = frameAt(0, from, to);
    expect(f.x).toBe(40);
    expect(f.y).toBe(600);
    expect(f.tint).toBe(0);
    expect(f.node).toBe(0);
    expect(f.ghost).toBe(true);
    expect(f.ring).toBeNull();
  });

  it("lands exactly on the bubble at the end of the flight", () => {
    const f = frameAt(FLIGHT_MS, from, to);
    expect(f.x).toBeCloseTo(300);
    expect(f.y).toBeCloseTo(200);
    expect(f.tint).toBe(1);
    expect(f.ghostOpacity).toBe(1);
  });

  it("rises before it drifts across, so the path bows", () => {
    const f = frameAt(FLIGHT_MS * 0.25, from, to);
    const up = (from.y - f.y) / (from.y - to.y);
    const across = (f.x - from.x) / (to.x - from.x);
    expect(up).toBeGreaterThan(across);
  });

  it("moves monotonically toward the bubble", () => {
    let prev = frameAt(0, from, to);
    for (let ms = 10; ms <= FLIGHT_MS; ms += 10) {
      const f = frameAt(ms, from, to);
      expect(f.y).toBeLessThanOrEqual(prev.y);
      expect(f.x).toBeGreaterThanOrEqual(prev.x);
      prev = f;
    }
  });

  it("reveals the turn under the ghost, then drops the ghost, then the ring settles out", () => {
    const mid = frameAt(FLIGHT_MS + REVEAL_MS / 2, from, to);
    expect(mid.node).toBeCloseTo(0.5);
    expect(mid.ghost).toBe(true);
    const shown = frameAt(FLIGHT_MS + REVEAL_MS, from, to);
    expect(shown.node).toBe(1);
    expect(shown.ghost).toBe(false);
    expect(frameAt(FLIGHT_MS + 1, from, to).ring).toBeGreaterThan(0);
    expect(frameAt(FLIGHT_MS + SETTLE_MS, from, to).ring).toBeNull();
    expect(frameAt(TOTAL_MS, from, to).done).toBe(true);
    expect(frameAt(TOTAL_MS - 1, from, to).done).toBe(false);
  });

  it("draws the thread only in flight, gone by the reveal", () => {
    expect(frameAt(0, from, to).thread).toBe(0);
    expect(frameAt(FLIGHT_MS * 0.3, from, to).thread).toBeGreaterThan(0.5);
    expect(frameAt(FLIGHT_MS * 1.2, from, to).thread).toBe(0);
  });
});

describe("launch and take", () => {
  const l = { channel: "chat", at: 1000, x: 0, y: 0, w: 100, h: 20 };

  it("is taken once, by its own channel", () => {
    launchAt(l);
    expect(takeLaunch("aside", 1100)).toBeNull();
    expect(takeLaunch("chat", 1100)).toEqual(l);
    expect(takeLaunch("chat", 1100)).toBeNull();
  });

  it("goes stale when nothing arrives in time (a failed send, a queued one)", () => {
    launchAt(l);
    expect(takeLaunch("chat", 1000 + LAUNCH_TTL_MS + 1)).toBeNull();
    expect(takeLaunch("chat", 1000)).toBeNull();
  });
});
