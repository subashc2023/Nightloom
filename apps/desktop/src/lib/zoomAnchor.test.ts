// Item 672: ⌘+ / ⌘− keep the reader's place. The suite runs in node, so views are plain fakes.
import { describe, expect, it } from "vitest";
import { anchorOf, restore, type Anchor } from "./zoomAnchor";

function rect(top: number, height: number): DOMRect {
  return { top, height, bottom: top + height, left: 0, right: 600, width: 600, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

const doc = { scrollingElement: null } as unknown as Document;

function view(scrollTop: number, scrollHeight: number, clientHeight: number) {
  let st = scrollTop;
  return {
    isConnected: true,
    get scrollTop() {
      return st;
    },
    set scrollTop(v: number) {
      st = Math.max(0, Math.min(v, scrollHeight - clientHeight));
    },
    scrollHeight,
    clientHeight,
    getBoundingClientRect: () => rect(100, clientHeight),
  } as unknown as Element;
}

describe("zoomAnchor (item 672)", () => {
  it("a view at its bottom stays at its bottom", () => {
    const v = view(1500, 2000, 500);
    const a = anchorOf(v, doc);
    expect(a?.kind).toBe("bottom");
    restore(a as Anchor, doc);
    expect(v.scrollTop).toBe(1500);
  });

  it("an element anchor is scrolled back to the same fraction at the top edge", () => {
    const v = view(800, 4000, 500);
    // Before: the page's top 50 px above the view's top (100), 200 px tall → a quarter down it.
    const a: Anchor = { kind: "box", el: v, target: { isConnected: true } as Element, frac: (100 - 50) / 200 };
    // After the zoom it drew larger and lower: top 400, 300 tall → its quarter mark at 475; it moves with the scroll.
    (a.target as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
      rect(400 - (v.scrollTop - 800), 300);
    restore(a, doc);
    expect(v.scrollTop).toBe(1175); // 475 − 100 = 375 px further down
    restore(a, doc); // idempotent: the late re-tries move nothing
    expect(v.scrollTop).toBe(1175);
  });

  it("a detached anchor is left alone", () => {
    const v = view(800, 4000, 500);
    restore({ kind: "box", el: v, target: { isConnected: false } as Element, frac: 0.5 }, doc);
    expect(v.scrollTop).toBe(800);
  });
});
