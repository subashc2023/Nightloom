import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asideScrollKey, putBack, recallScroll, rememberScroll, resetScroll, restoreTop, scrollKey } from "./scroll.svelte";

/** Backlog 237: an aside tab keeps its place, apart from its chat's. */
describe("aside tab scroll (backlog 237)", () => {
  beforeEach(() => resetScroll());

  it("keys a thread apart from its chat and from its sibling threads", () => {
    const a = asideScrollKey("chat-1", 3);
    expect(a).not.toBe(scrollKey("chat-1"));
    expect(a).not.toBe(asideScrollKey("chat-1", 4));
    rememberScroll(scrollKey("chat-1"), 900, false);
    rememberScroll(a, 420, false);
    expect(recallScroll(a)).toEqual({ top: 420, pinned: false });
    expect(recallScroll(scrollKey("chat-1"))).toEqual({ top: 900, pinned: false });
    expect(recallScroll(asideScrollKey("chat-1", 4))).toBeNull();
  });

  it("puts the view back where it was, at the foot if it was held there", () => {
    expect(restoreTop(null, 2000, 600)).toBeNull();
    expect(restoreTop({ top: 420, pinned: false }, 2000, 600)).toBe(420);
    // Held at the foot, and the answer grew meanwhile: the new foot.
    expect(restoreTop({ top: 800, pinned: true }, 2600, 600)).toBe(2000);
    // Content shorter than it was: never past its end.
    expect(restoreTop({ top: 1400, pinned: false }, 1200, 600)).toBe(600);
    expect(restoreTop({ top: 50, pinned: false }, 300, 600)).toBe(0);
  });
});

/** Item 502: put back while the thread draws, not once on mount. */
describe("putBack (item 502)", () => {
  function fakeView(scrollHeight: number) {
    const listeners = new Map<string, () => void>();
    return {
      scrollTop: 0,
      scrollHeight,
      clientHeight: 600,
      addEventListener: (ev: string, f: () => void) => listeners.set(ev, f),
      removeEventListener: (ev: string) => listeners.delete(ev),
      fire: (ev: string) => listeners.get(ev)?.(),
    };
  }
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for room rather than cutting his place to the top", () => {
    const el = fakeView(300);
    const p = putBack(el as unknown as HTMLElement, { top: 800, pinned: false });
    expect(el.scrollTop).toBe(0);
    expect(p.busy()).toBe(true);
    el.scrollHeight = 2400;
    vi.advanceTimersByTime(60);
    expect(el.scrollTop).toBe(800);
    vi.advanceTimersByTime(2000);
    expect(p.busy()).toBe(false);
  });

  it("stops the moment he scrolls himself", () => {
    const el = fakeView(300);
    const p = putBack(el as unknown as HTMLElement, { top: 800, pinned: false });
    el.fire("wheel");
    expect(p.busy()).toBe(false);
    el.scrollHeight = 2400;
    vi.advanceTimersByTime(2000);
    expect(el.scrollTop).toBe(0);
  });

  it("a view held at its foot goes to the foot; no entry, nothing", () => {
    const el = fakeView(2400);
    putBack(el as unknown as HTMLElement, { top: 10, pinned: true });
    expect(el.scrollTop).toBe(1800);
    expect(putBack(fakeView(2400) as unknown as HTMLElement, null).busy()).toBe(false);
  });

  it("content that never grows gets the clamped place at the end", () => {
    const el = fakeView(1000);
    putBack(el as unknown as HTMLElement, { top: 800, pinned: false });
    expect(el.scrollTop).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(el.scrollTop).toBe(400);
  });
});
