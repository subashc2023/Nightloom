import { afterEach, describe, expect, it, vi } from "vitest";
import { NUDGE_FRAMES, NUDGE_MS, NUDGE_PX, nudgeDone } from "./doneNudge";

const w = globalThis as unknown as { window?: { __sendMotionReduce?: boolean } };

afterEach(() => {
  delete w.window;
});

describe("nudgeDone (item 497)", () => {
  it("dips a few px and ends where it started", () => {
    expect(NUDGE_PX).toBeGreaterThan(0);
    expect(NUDGE_PX).toBeLessThanOrEqual(6);
    expect(NUDGE_FRAMES[0].transform).toBe("translateY(0)");
    expect(NUDGE_FRAMES.at(-1)?.transform).toBe("translateY(0)");
    expect(NUDGE_FRAMES.some((f) => f.transform === `translateY(${NUDGE_PX}px)`)).toBe(true);
  });

  it("plays once on the element", () => {
    w.window = {};
    const animate = vi.fn(() => ({}) as Animation);
    const el = { animate } as unknown as HTMLElement;
    expect(nudgeDone(el)).not.toBeNull();
    expect(animate).toHaveBeenCalledWith(NUDGE_FRAMES, { duration: NUDGE_MS });
  });

  it("does nothing when motion is reduced", () => {
    w.window = { __sendMotionReduce: true };
    const animate = vi.fn();
    expect(nudgeDone({ animate } as unknown as HTMLElement)).toBeNull();
    expect(animate).not.toHaveBeenCalled();
  });

  it("does nothing without an element", () => {
    expect(nudgeDone(null)).toBeNull();
  });
});
