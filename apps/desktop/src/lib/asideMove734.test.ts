import { beforeEach, describe, expect, it } from "vitest";
import { landMoved, placeMoved, cleanMoved, MOVED_HEAD } from "./asideMove";
import { ASIDES_KEY, loadAsides, saveAsides } from "./asides";
import { app, switchAside } from "./state.svelte";
import type { Aside } from "./state.svelte";
import cardSrc from "./AsideCard.svelte?raw";
import layerSrc from "./AsideLayer.svelte?raw";

/**
 * Item 734 (2026-11-16, his "if you try to relocate them on screen,
 * suddenly they become absolute on their new location"): a dragged aside
 * card was kept in window px and drawn `position: fixed`, so it stayed put
 * while the chat scrolled. It is kept in the chat column's px now and drawn
 * in the column, so it scrolls with the text as an unmoved card does.
 */

// The chat column (`inner`) as the window sees it: 760 wide, centred in a
// 1440 window, scrolled 400 px (its top is 400 above the viewport's).
const view = { top: 80, bottom: 900 };
const frameAt = (scroll: number) => ({ left: 340, top: view.top - scroll, width: 760, height: 5000 });

/** Where a kept card is on screen, for a column scrolled by `scroll`. */
function onScreen(m: ReturnType<typeof landMoved>, scroll: number, passageTop: number | null) {
  const f = frameAt(scroll);
  const p = placeMoved(m, f.width, passageTop)!;
  return { left: f.left + p.left, top: f.top + p.top };
}

class Mem {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

const answered = (id: number, over: Partial<Aside> = {}): Aside => ({
  id,
  uid: `uid-${id}`,
  quote: { text: "the passage", role: "assistant", ordinal: 2 },
  draft: false,
  turns: [{ seq: id, question: "why", partial: "because", answer: "because", error: null, cancelled: false, cacheRead: 0 }],
  anchor: { turn: 3, block: 0, start: 12, end: 40, side: "below" },
  ...over,
});

describe("734: a dropped card is kept in the chat column's px", () => {
  it("a drop over a passage keeps its offset from the passage, not the window", () => {
    // Passage at 1200 in the column; the card let go at window (500, 300).
    const m = landMoved({ left: 500, top: 300 }, 360, frameAt(400), view, 1200);
    expect(m).toEqual({ left: 160, top: 300 - (view.top - 400) - 1200, width: 360, from: "passage" });
    // The column's top is at -320 in the window: the card sits 620 px down
    // the column, 580 above the passage.
    expect(m.top).toBe(-580);
  });

  it("a composer card (no passage) is kept from the column's content top", () => {
    const m = landMoved({ left: 500, top: 300 }, 360, frameAt(400), view, null);
    expect(m).toEqual({ left: 160, top: 620, width: 360, from: "column" });
  });

  it("scrolling moves it with the content: on screen it shifts by exactly the scroll delta", () => {
    for (const passageTop of [1200, null]) {
      const m = landMoved({ left: 500, top: 300 }, 360, frameAt(400), view, passageTop);
      const before = onScreen(m, 400, passageTop);
      // Just after the drop it is where it was let go.
      expect(before).toEqual({ left: 500, top: 300 });
      for (const delta of [120, -250, 1000]) {
        const after = onScreen(m, 400 + delta, passageTop);
        expect(after.top - before.top).toBe(-delta);
        expect(after.left).toBe(before.left);
      }
    }
  });

  it("follows its passage when the text above reflows", () => {
    const m = landMoved({ left: 500, top: 300 }, 360, frameAt(0), view, 1200);
    const p1 = placeMoved(m, 760, 1200)!;
    const p2 = placeMoved(m, 760, 1350)!; // a narrower window: 150 px more text above
    expect(p2.top - p1.top).toBe(150);
  });

  it("stays inside the column across when let go, and its head inside the viewport", () => {
    // Over the sidebar, left of the column, and below the viewport's foot.
    const m = landMoved({ left: 40, top: 2000 }, 360, frameAt(0), view, null);
    expect(m.left).toBe(0);
    expect(m.top).toBe(view.bottom - MOVED_HEAD - view.top);
    // Past the right edge.
    const r = landMoved({ left: 1400, top: 100 }, 360, frameAt(0), view, null);
    expect(r.left).toBe(760 - 360);
    // Above the viewport (over the tab strip, no zone lit).
    const t = landMoved({ left: 500, top: 10 }, 360, frameAt(0), view, null);
    expect(t.top).toBe(0);
  });

  it("a narrower window never strands it off the column's side", () => {
    const m = landMoved({ left: 1000, top: 300 }, 360, frameAt(0), view, null);
    expect(m.left).toBe(400);
    const narrow = placeMoved(m, 358, null)!; // 390 wide window: a 358 px column
    expect(narrow.width).toBe(358);
    expect(narrow.left).toBe(0);
    const mid = placeMoved(m, 600, null)!;
    expect(mid.left + mid.width).toBeLessThanOrEqual(600);
  });

  it("goes home while its passage cannot be found", () => {
    const m = landMoved({ left: 500, top: 300 }, 360, frameAt(0), view, 1200);
    expect(placeMoved(m, 760, null)).toBeNull();
  });
});

describe("734: the kept place survives a chat switch and a relaunch", () => {
  beforeEach(() => {
    switchAside(null);
    app.activeSessionId = null;
  });

  it("is written with the thread and read back the same", () => {
    const moved = { left: 160, top: -580, width: 360, from: "passage" as const };
    const col = { left: 12, top: 620, width: 340, from: "column" as const };
    const s = new Mem();
    saveAsides(new Map([["c1", [answered(1, { moved }), answered(2, { anchor: null, moved: col }), answered(3)]]]), s);
    const back = loadAsides(s).get("c1")!;
    expect(back[0]!.moved).toEqual(moved);
    expect(back[1]!.moved).toEqual(col);
    expect(back[2]!.moved).toBeUndefined();
  });

  it("a malformed or old window-px entry is dropped, never drawn somewhere odd", () => {
    expect(cleanMoved({ left: 1, top: 1, width: 300 })).toBeNull(); // pre-734 shape
    expect(cleanMoved({ left: "1", top: 1, width: 300, from: "column" })).toBeNull();
    expect(cleanMoved({ left: 1, top: 1, width: 0, from: "column" })).toBeNull();
    // Kept from a passage but the thread has none: dropped on read.
    const s = new Mem();
    s.setItem(
      ASIDES_KEY,
      JSON.stringify({ c1: [{ quote: null, turns: [{ question: "q", answer: "a", error: null, cancelled: false }], moved: { left: 1, top: 2, width: 300, from: "passage" } }] }),
    );
    const back = loadAsides(s).get("c1");
    if (back) expect(back[0]!.moved).toBeUndefined();
  });

  it("a remount (leaving the chat and coming back) keeps it", () => {
    const moved = { left: 160, top: -580, width: 360, from: "passage" as const };
    app.activeSessionId = "c1";
    app.asides = [answered(1, { moved })];
    switchAside("c2");
    app.activeSessionId = "c2";
    expect(app.asides).toHaveLength(0);
    switchAside("c1");
    app.activeSessionId = "c1";
    expect(app.asides[0]!.moved).toEqual(moved);
  });
});

describe("734: the card is drawn in the column, fixed only while held", () => {
  it("a moved card is absolute in the column; only a held one is fixed", () => {
    const css = cardSrc.slice(cardSrc.indexOf(".aside-card.moved {"));
    expect(css.slice(0, css.indexOf("}"))).toMatch(/position:\s*absolute/);
    expect(cardSrc).toMatch(/\.aside-card\.moved\.holding\s*\{\s*position:\s*fixed/);
  });
  it("the layer hands each card its column and its passage's top", () => {
    expect(layerSrc).toMatch(/frame=\{inner\}/);
    expect(layerSrc).toMatch(/passageTop=\{passageTops\[a\.id\]/);
  });
});
