import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUT_BACK_MS, holdWhileDrawing } from "./scroll.svelte";

/** Item 883: the place put back on a switch back is held while what is above it draws. */
describe("holdWhileDrawing (item 883)", () => {
  const winListeners = new Map<string, () => void>();
  beforeEach(() => {
    vi.useFakeTimers();
    winListeners.clear();
    vi.stubGlobal("window", {
      addEventListener: (ev: string, f: () => void) => winListeners.set(ev, f),
      removeEventListener: (ev: string) => winListeners.delete(ev),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const view = () => {
    const ls = new Map<string, () => void>();
    return {
      children: [],
      addEventListener: (ev: string, f: () => void) => ls.set(ev, f),
      removeEventListener: (ev: string) => ls.delete(ev),
      fire: (ev: string) => ls.get(ev)?.(),
    };
  };

  it("re-holds on its timers and on a picture's load, then stops by itself", () => {
    const el = view();
    const again = vi.fn();
    holdWhileDrawing(el as unknown as HTMLElement, again);
    vi.advanceTimersByTime(0);
    expect(again).toHaveBeenCalled();
    const n = again.mock.calls.length;
    el.fire("load");
    expect(again.mock.calls.length).toBe(n + 1);
    vi.advanceTimersByTime(PUT_BACK_MS + 10);
    const done = again.mock.calls.length;
    el.fire("load");
    vi.advanceTimersByTime(5000);
    expect(again.mock.calls.length).toBe(done);
    expect(winListeners.size).toBe(0);
  });

  it("stops the moment he scrolls, clicks or types, and on its stop", () => {
    for (const ev of ["wheel", "pointerdown", "keydown", "touchstart"]) {
      const el = view();
      const again = vi.fn();
      holdWhileDrawing(el as unknown as HTMLElement, again);
      winListeners.get(ev)?.();
      again.mockClear();
      el.fire("load");
      vi.advanceTimersByTime(PUT_BACK_MS + 10);
      expect(again).not.toHaveBeenCalled();
    }
    const el = view();
    const again = vi.fn();
    const stop = holdWhileDrawing(el as unknown as HTMLElement, again);
    stop();
    vi.advanceTimersByTime(PUT_BACK_MS + 10);
    expect(again).not.toHaveBeenCalled();
  });
});
