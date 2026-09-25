import { afterEach, describe, expect, it, vi } from "vitest";
import { FLIGHT_MS, LAUNCH_TTL_MS, REVEAL_MS, SETTLE_MS, TOTAL_MS, arrive, frameAt, launchAt, takeLaunch } from "./sendMotion";

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

// The 194 fix pass (2026-09-25): in the app the new bubble mounts below the
// view and the transcript scrolls to it only after `tick()`. The flight must
// measure after that scroll — a frame later — or a plain chat gets none.
describe("arrive — measures after the thread's scroll, not at the mount", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("flies a bubble that mounts below the view and is scrolled into it by the next frame", () => {
    let top = 900; // at the mount: under the 800 px window, as the walk's plain chat was
    const rect = () => ({ top, bottom: top + 40, left: 300, right: 500, width: 200, height: 40 });
    const style: Record<string, string> = {};
    const mkEl = (): Record<string, unknown> => {
      const el: Record<string, unknown> = {
        style: {} as Record<string, string>,
        setAttribute: () => {},
        removeAttribute: () => {},
        appendChild: () => {},
        remove: () => {},
        querySelectorAll: () => [],
        classList: { add: () => {} },
        offsetHeight: 40,
        offsetWidth: 200,
      };
      el.cloneNode = () => mkEl();
      return el;
    };
    const node = {
      style,
      parentElement: null,
      querySelector: () => null,
      getBoundingClientRect: rect,
      cloneNode: () => mkEl(),
    } as unknown as HTMLElement;
    const appended: unknown[] = [];
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("window", {});
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.stubGlobal("getComputedStyle", () => ({ overflowY: "visible", backgroundColor: "rgb(1, 2, 3)" }));
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("document", {
      body: { appendChild: (e: unknown) => appended.push(e) },
      createElementNS: () => mkEl(),
    });

    launchAt({ channel: "chat", at: performance.now(), x: 40, y: 760, w: 600, h: 24 });
    arrive(node, { channel: "chat" });
    expect(style.opacity).toBe("0"); // hidden for the frame, not flashed in place
    expect(appended).toHaveLength(0); // nothing measured yet
    top = 600; // the follow-the-bottom scroll has run
    frames.shift()!(0);
    expect(appended.length).toBe(2); // the thread and the ghost: it flies
  });
});
