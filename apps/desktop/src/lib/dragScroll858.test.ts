// Item 858: a drag held near a scroller's edge scrolls it, faster nearer
// the edge, and stops on leave, drop, end, or when dragover stops coming.
import { describe, expect, it, vi } from "vitest";
import { EDGE_PX, EdgeScroller, MAX_STEP, MIN_STEP, STALE_MS, dragScroll, edgeStep } from "./dragScroll";

describe("item 858: edgeStep", () => {
  // A 600px list from y=100 to y=700.
  const at = (y: number) => edgeStep(y, 100, 700);

  it("is 0 in the middle and just outside the zones", () => {
    expect(at(400)).toBe(0);
    expect(at(100 + EDGE_PX)).toBe(0);
    expect(at(700 - EDGE_PX)).toBe(0);
  });

  it("scrolls up near the top and down near the bottom", () => {
    expect(at(110)).toBeLessThan(0);
    expect(at(690)).toBeGreaterThan(0);
  });

  it("speeds up toward the edge, top speed at and past it", () => {
    const steps = [650, 670, 690, 699].map(at);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]);
    expect(steps[3]).toBeGreaterThan(steps[0]);
    expect(at(700)).toBe(MAX_STEP);
    expect(at(720)).toBe(MAX_STEP);
    expect(at(100)).toBe(-MAX_STEP);
    expect(at(80)).toBe(-MAX_STEP);
  });

  it("never crawls slower than the minimum inside a zone", () => {
    expect(at(700 - EDGE_PX + 1)).toBe(MIN_STEP);
  });

  it("a short box's zones are at most a quarter of it each, so its middle is still", () => {
    expect(edgeStep(50, 0, 100)).toBe(0);
    expect(edgeStep(20, 0, 100)).toBeLessThan(0);
    expect(edgeStep(5, 0, 0)).toBe(0);
  });
});

describe("item 858: EdgeScroller stops", () => {
  it("runs while held near the edge, stops when the drag moves inward", () => {
    const s = new EdgeScroller();
    s.over(690, 100, 700, 0);
    expect(s.at(16)).toBeGreaterThan(0);
    s.over(400, 100, 700, 30);
    expect(s.at(46)).toBe(0);
  });

  it("stops on leave, drop or end", () => {
    const s = new EdgeScroller();
    s.over(110, 100, 700, 0);
    expect(s.at(10)).toBeLessThan(0);
    s.stop();
    expect(s.at(20)).toBe(0);
    expect(s.running).toBe(false);
  });

  it("stops when dragover stops coming, keeps going while it comes", () => {
    const s = new EdgeScroller();
    for (let t = 0; t <= 1000; t += 50) {
      s.over(690, 100, 700, t);
      expect(s.at(t + 16)).toBeGreaterThan(0);
    }
    expect(s.at(1000 + STALE_MS + 1)).toBe(0);
  });
});

describe("item 858: the action", () => {
  it("scrolls the node on dragover near its bottom, and drop stops it", async () => {
    // Node-only tests: a fake scroller, window and frame clock.
    const on: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 16) as unknown as number);
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    const node = {
      scrollTop: 0,
      scrollLeft: 0,
      getBoundingClientRect: () => ({ top: 100, bottom: 700, left: 0, right: 300 }),
      addEventListener: (t: string, f: (e: unknown) => void) => (on[t] = f),
      removeEventListener: (t: string) => delete on[t],
      contains: () => false,
    };
    const a = dragScroll(node as unknown as HTMLElement);
    on.dragover({ clientY: 695, clientX: 10 });
    await new Promise((r) => setTimeout(r, 120));
    expect(node.scrollTop).toBeGreaterThan(0);
    on.drop({});
    const after = node.scrollTop;
    await new Promise((r) => setTimeout(r, 120));
    expect(node.scrollTop).toBe(after);
    a.destroy();
    expect(Object.keys(on)).toEqual([]);
    vi.unstubAllGlobals();
  });
});
