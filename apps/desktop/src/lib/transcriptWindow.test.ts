import { describe, expect, it } from "vitest";
import { FIRST_ITEMS, GROW_ITEMS, cardWaits, firstWindow, grown, wantsMore, windowFor } from "./transcriptWindow.svelte";
import { recallScroll, rememberScroll, resetScroll } from "./scroll.svelte";
import { displayTexts } from "./edit";
import type { SessionEvent } from "./types";

// Item 482: the transcript draws its last messages first and grows upward.
describe("the render window", () => {
  it("draws the last FIRST_ITEMS of a chat opened fresh or left at the foot", () => {
    expect(firstWindow(600, null)).toBe(600 - FIRST_ITEMS);
    expect(firstWindow(600, { pinned: true, from: 12 })).toBe(600 - FIRST_ITEMS);
  });
  it("draws a short chat whole", () => {
    expect(firstWindow(3, null)).toBe(0);
    expect(firstWindow(0, null)).toBe(0);
  });
  it("draws what it drew when left scrolled up, so the saved offset lands on the same line", () => {
    expect(firstWindow(600, { pinned: false, from: 420 })).toBe(420);
  });
  it("draws everything for an entry from before windows (no from)", () => {
    expect(firstWindow(600, { pinned: false })).toBe(0);
  });
  it("clamps a stale entry to the chat it now is", () => {
    expect(firstWindow(10, { pinned: false, from: 420 })).toBe(9);
  });
  it("grows by a batch, never below 0", () => {
    expect(grown(100)).toBe(100 - GROW_ITEMS);
    expect(grown(2)).toBe(0);
    expect(grown(5, 0)).toBe(4);
  });
  it("wants more only while messages are undrawn and too little is drawn above the view", () => {
    expect(wantsMore(10, 100, 900, 2)).toBe(true);
    expect(wantsMore(10, 1900, 900, 2)).toBe(false);
    expect(wantsMore(0, 0, 900, 2)).toBe(false);
  });
  it("reaches a target above the window with a margin, and never shrinks", () => {
    expect(windowFor(300, 120)).toBe(118);
    expect(windowFor(300, 1)).toBe(0);
    expect(windowFor(100, 250)).toBe(100);
    expect(windowFor(100, -1)).toBe(100);
  });
});

describe("the scroll entry carries the window", () => {
  it("keeps from when given, and the old shape when not", () => {
    resetScroll();
    rememberScroll("a", 500, false, 120);
    rememberScroll("b", 40, false);
    expect(recallScroll("a")).toEqual({ top: 500, pinned: false, from: 120 });
    expect(recallScroll("b")).toEqual({ top: 40, pinned: false });
  });
});

describe("displayTexts (item 482: linear now)", () => {
  it("still reads each reply's edited text", () => {
    const evs = [
      { event: "user_message", text: "hi", at: "" },
      { event: "assistant_message", model: "m", blocks: [{ type: "text", text: "old" }], at: "" },
      { event: "edit", target: 1, text: "new", at: "" },
    ] as unknown as SessionEvent[];
    expect(displayTexts(evs)[1]).toBe("new");
    expect(displayTexts(evs)[0]).toBe(null);
  });
});

describe("an aside card on an undrawn turn (item 484)", () => {
  const drawn = (t: number) => t >= 500;
  it("waits for its turn instead of stacking above the composer", () => {
    expect(cardWaits({ anchor: { turn: 22 } }, drawn)).toBe(true);
  });
  it("shows once its turn is drawn", () => {
    expect(cardWaits({ anchor: { turn: 522 } }, drawn)).toBe(false);
  });
  it("never waits for a composer aside or a card he moved", () => {
    expect(cardWaits({ anchor: null }, drawn)).toBe(false);
    expect(cardWaits({ anchor: { turn: 22 }, moved: { left: 1, top: 1, width: 300 } }, drawn)).toBe(false);
  });
});
