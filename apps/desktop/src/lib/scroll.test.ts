import { beforeEach, describe, expect, it } from "vitest";
import {
  NEW_SCROLL_KEY,
  forgetScroll,
  moveScroll,
  recallScroll,
  rememberScroll,
  resetScroll,
  scrollKey,
} from "./scroll.svelte";

// Per-chat scroll (nightshift backlog 065): the transcript writes an entry
// as it scrolls and reads it back on a switch; a chat with none starts at
// the bottom, which is what `null` means to the transcript.

beforeEach(() => resetScroll());

describe("scroll positions", () => {
  it("keys by chat id, 'new' while none is open", () => {
    expect(scrollKey("s1")).toBe("s1");
    expect(scrollKey(null)).toBe(NEW_SCROLL_KEY);
  });

  it("restores what was remembered, per chat", () => {
    rememberScroll("a", 1200, false);
    rememberScroll("b", 0, true);
    expect(recallScroll("a")).toEqual({ top: 1200, pinned: false });
    expect(recallScroll("b")).toEqual({ top: 0, pinned: true });
  });

  it("defaults to nothing — the bottom — for a chat never scrolled", () => {
    expect(recallScroll("never")).toBeNull();
  });

  it("clamps a negative top and overwrites on a second write", () => {
    rememberScroll("a", -40, false);
    expect(recallScroll("a")?.top).toBe(0);
    rememberScroll("a", 80, true);
    expect(recallScroll("a")).toEqual({ top: 80, pinned: true });
  });

  it("forgets and moves", () => {
    rememberScroll("a", 10, false);
    forgetScroll("a");
    expect(recallScroll("a")).toBeNull();
    rememberScroll(NEW_SCROLL_KEY, 300, false);
    moveScroll(NEW_SCROLL_KEY, "s1");
    expect(recallScroll(NEW_SCROLL_KEY)).toBeNull();
    expect(recallScroll("s1")).toEqual({ top: 300, pinned: false });
  });
});
