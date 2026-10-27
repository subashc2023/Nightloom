import { afterEach, describe, expect, it, vi } from "vitest";
import { FLIGHT_MS, LAUNCH_TTL_MS, REVEAL_MS, SETTLE_MS, TOTAL_MS, arrive, fly, footHide, frameAt, ghostPlace, launchAt, takeLaunch, topCut } from "./sendMotion";

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

describe("a message taller than the view (item 417)", () => {
  it("cuts the ghost where it would rise above the transcript", () => {
    expect(topCut(80, -400)).toBe(480);
    expect(topCut(80, 79)).toBe(1);
  });
  it("cuts nothing while the ghost is wholly below the transcript's top", () => {
    expect(topCut(80, 80)).toBe(0);
    expect(topCut(80, 600)).toBe(0);
  });
});

describe("a message taller than the view flies as its foot (item 417)", () => {
  it("hides nothing of a bubble no taller than the view", () => {
    expect(footHide(40, 760)).toBe(0);
    expect(footHide(760, 760)).toBe(0);
    expect(footHide(2400, 760)).toBe(1640);
    expect(footHide(2400, 0)).toBe(0);
  });
  it("places the ghost so its visible window starts at the timeline's y, never above the view", () => {
    expect(ghostPlace(500, 0, 40)).toEqual({ y: 500, cut: 0 });
    expect(ghostPlace(500, 1640, 40)).toEqual({ y: -1140, cut: 1640 });
    expect(ghostPlace(20, 1640, 40)).toEqual({ y: -1620, cut: 1660 }); // visible top = -1620 + 1660 = 40
  });

  // A stand-in DOM: a transcript scroll box from 40 to 800, a bubble at `rect`.
  const run = (rect: { top: number; height: number }, hold: number) => {
    const mkEl = (): Record<string, unknown> => {
      const el: Record<string, unknown> = {
        style: {} as Record<string, string>,
        setAttribute: () => {},
        removeAttribute: () => {},
        appendChild: () => {},
        remove: () => {},
        querySelectorAll: () => [],
        classList: { add: () => {} },
        offsetHeight: rect.height,
        offsetWidth: 400,
      };
      el.cloneNode = () => mkEl();
      return el;
    };
    const scroller = { parentElement: null, getBoundingClientRect: () => ({ top: 40, bottom: 800 }), __scroll: true };
    const r = () => ({ top: rect.top, bottom: rect.top + rect.height, left: 300, right: 700, width: 400, height: rect.height });
    const bubble = { style: {}, parentElement: scroller, getBoundingClientRect: r, cloneNode: () => mkEl() } as unknown as HTMLElement;
    const node = { style: {}, parentElement: scroller, getBoundingClientRect: r } as unknown as HTMLElement;
    const appended: Record<string, unknown>[] = [];
    vi.stubGlobal("innerHeight", 900);
    vi.stubGlobal("getComputedStyle", (el: { __scroll?: boolean }) => ({ overflowY: el.__scroll ? "auto" : "visible", backgroundColor: "rgb(1, 2, 3)" }));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("document", { body: { appendChild: (e: Record<string, unknown>) => appended.push(e) }, createElementNS: () => mkEl() });
    fly(node, bubble, { channel: "chat", at: 0, x: 320, y: 820, w: 600, h: 260 }, hold);
    const ghost = appended[1].style as Record<string, string>;
    const y = Number(/translate3d\([-\d.]+px, ([-\d.]+)px/.exec(ghost.transform)![1]);
    const cut = Number(/inset\(([\d.]+)px/.exec(ghost.clipPath)?.[1] ?? 0);
    return { y, cut, clip: ghost.clipPath, transform: ghost.transform };
  };
  afterEach(() => vi.unstubAllGlobals());
  const HELD = [0, 40, 80, 120, 160, 240, 340, 420];

  it("keeps every held frame of a 3-view message at or below the transcript's top, landing on its foot", () => {
    const rect = { top: 780 - 2280, height: 2280 }; // scrolled to the foot: bottom at 780
    for (const ms of HELD) {
      const g = run(rect, ms);
      expect(g.y + g.cut).toBeGreaterThanOrEqual(40);
      expect(g.y + g.cut).toBeLessThanOrEqual(820);
      // It carries one view of text, not the whole message: its foot starts a view under the box, not three.
      expect(g.y + rect.height - (g.y + g.cut)).toBeLessThanOrEqual(760.5);
    }
    const end = run(rect, FLIGHT_MS);
    expect(end.y).toBeCloseTo(rect.top); // the ghost sits exactly over the bubble
    expect(end.y + end.cut).toBeCloseTo(40); // showing only what the view shows
  });

  it("flies a short message exactly as before: no clip, the timeline's y unchanged", () => {
    const rect = { top: 700, height: 46 };
    for (const ms of HELD) {
      const g = run(rect, ms);
      expect(g.clip).toBe("");
      const f = frameAt(ms, { x: 320 - 0, y: 820 }, { x: 300, y: 700 });
      expect(g.transform).toBe(`translate3d(${f.x}px, ${f.y}px, 0)`);
    }
  });
});
