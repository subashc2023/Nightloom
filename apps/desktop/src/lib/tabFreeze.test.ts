import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabFreeze } from "./tabFreeze";

describe("TabFreeze (item 603)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds the first close's width through a run of closes", () => {
    const seen: (number | null)[] = [];
    const f = new TabFreeze((w) => seen.push(w), 3000);
    f.closed(180);
    f.closed(240); // a later close never re-measures
    f.closed(240);
    expect(f.width).toBe(180);
    expect(seen).toEqual([180]);
  });

  it("re-fits when the pointer leaves", () => {
    const seen: (number | null)[] = [];
    const f = new TabFreeze((w) => seen.push(w), 3000);
    f.closed(150);
    f.thaw();
    expect(f.width).toBeNull();
    expect(seen).toEqual([150, null]);
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([150, null]);
  });

  it("re-fits after the pointer rests, and a move or a close restarts the wait", () => {
    const f = new TabFreeze(() => {}, 3000);
    f.closed(150);
    vi.advanceTimersByTime(2000);
    f.moved();
    vi.advanceTimersByTime(2000);
    f.closed(150);
    vi.advanceTimersByTime(2999);
    expect(f.width).toBe(150);
    vi.advanceTimersByTime(1);
    expect(f.width).toBeNull();
  });

  it("a move over a strip that is not frozen does nothing", () => {
    const seen: (number | null)[] = [];
    const f = new TabFreeze((w) => seen.push(w), 3000);
    f.moved();
    f.thaw();
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([]);
  });
});
