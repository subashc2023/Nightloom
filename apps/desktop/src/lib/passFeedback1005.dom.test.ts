// @vitest-environment happy-dom
/*
 * Item 1005, drawn and read back from the DOM (item 980's rule): the running toast's clock ticks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import ToastClock from "./ToastClock.svelte";

let root: ReturnType<typeof mount> | null = null;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  if (root) unmount(root);
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("1005: the running toast's clock", () => {
  it("shows the time since the pass started and ticks each second", () => {
    vi.setSystemTime(Date.parse("2026-11-26T09:30:00Z"));
    root = mount(ToastClock, { target: document.body, props: { since: Date.now() - 125_000 } });
    flushSync();
    const clock = document.querySelector(".toast-clock")!;
    expect(clock.textContent).toBe("2:05");
    expect(clock.getAttribute("role")).toBe("timer");
    vi.advanceTimersByTime(1000);
    flushSync();
    expect(clock.textContent).toBe("2:06");
    vi.advanceTimersByTime(60 * 60_000);
    flushSync();
    expect(clock.textContent).toBe("1:02:06");
  });
});
