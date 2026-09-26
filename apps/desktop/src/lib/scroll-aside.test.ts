import { beforeEach, describe, expect, it } from "vitest";
import { asideScrollKey, recallScroll, rememberScroll, resetScroll, restoreTop, scrollKey } from "./scroll.svelte";

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
