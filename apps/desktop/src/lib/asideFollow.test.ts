import { describe, expect, it } from "vitest";
import { ThreadFollow } from "./asideFollow.svelte";

// Item 485: the aside tab's follow decisions (468's rule; the tab had none).
describe("ThreadFollow", () => {
  it("a Send from within one screen of the foot holds the view at the foot", () => {
    const f = new ThreadFollow();
    expect(f.turnsNow(1, 2, false)).toBe(true); // first look
    f.scrolled(300); // he is 300 px up in a 600 px view
    expect(f.pinned).toBe(false);
    f.before(300, 600);
    expect(f.turnsNow(1, 3, true)).toBe(false);
    expect(f.pinned).toBe(true);
  });
  it("a Send from further up keeps the place", () => {
    const f = new ThreadFollow();
    f.turnsNow(1, 2, false);
    f.scrolled(1800);
    f.before(1800, 600);
    f.turnsNow(1, 3, true);
    expect(f.pinned).toBe(false);
  });
  it("only a Send jumps: not several turns back at once, nor an answered one", () => {
    const f = new ThreadFollow();
    f.turnsNow(1, 2, false);
    f.scrolled(100);
    f.before(100, 600);
    f.turnsNow(1, 4, true); // a rewind's undo
    expect(f.pinned).toBe(false);
    f.before(100, 600);
    f.turnsNow(1, 5, false); // not being asked
    expect(f.pinned).toBe(false);
  });
  it("another thread in the same view is a first look, not a Send", () => {
    const f = new ThreadFollow();
    f.turnsNow(1, 2, false);
    f.scrolled(100);
    f.before(100, 600);
    expect(f.turnsNow(2, 3, true)).toBe(true);
    expect(f.pinned).toBe(false);
  });
  it("his own scroll releases and the foot holds again", () => {
    const f = new ThreadFollow();
    f.scrolled(0);
    expect(f.pinned).toBe(true);
    f.scrolled(40);
    expect(f.pinned).toBe(false);
    f.scrolled(2);
    expect(f.pinned).toBe(true);
  });
});
