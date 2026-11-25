// @vitest-environment happy-dom
/*
 * Item 947 (views slice): every view on Home's stage keeps its place. A view is drawn afresh at each tab switch, each
 * return to Home and each start of the app; `keepPlace` records where each of its scrolling boxes was and puts it back
 * — also when the box's content arrives a moment after the view is drawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keepPlace, named, placeOf, putBack, type Place } from "./keepScroll";

/** A scrolling box with a given content height (happy-dom does no layout). */
function box(cls: string, client: number, content: number): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  el.style.overflowY = "auto";
  let top = 0;
  const h = { content };
  Object.defineProperty(el, "clientHeight", { get: () => client, configurable: true });
  Object.defineProperty(el, "scrollHeight", { get: () => h.content, configurable: true });
  Object.defineProperty(el, "scrollTop", { get: () => top, set: (v: number) => (top = Math.max(0, Math.min(v, h.content - client))), configurable: true });
  (el as unknown as { grow: (n: number) => void }).grow = (n: number) => (h.content = n);
  return el;
}

describe("947: the place of a view's scrolling boxes", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("names boxes by class and their place among boxes of that class", () => {
    const v = document.createElement("div");
    v.append(box("h9-pb", 100, 400), box("h9-pb", 100, 400), box("r-log", 100, 400));
    document.body.append(v);
    expect(named(v).map(([k]) => k)).toEqual(["h9-pb#0", "h9-pb#1", "r-log#0"]);
  });

  it("a box he left at its end goes back to its (new) end; any other to the same top", () => {
    const a = box("a", 100, 400);
    a.scrollTop = 290;
    expect(placeOf(a)).toEqual({ top: 290, end: true });
    const b = box("b", 100, 400);
    b.scrollTop = 140;
    expect(placeOf(b)).toEqual({ top: 140, end: false });
    expect(placeOf(box("c", 100, 400))).toEqual({ top: 0, end: false });
    // A box with little to scroll, halfway down, is not at its end (Run's panels at 960 x 600).
    const little = box("e", 100, 147);
    little.scrollTop = 24;
    expect(placeOf(little)).toEqual({ top: 24, end: false });
    (a as unknown as { grow: (n: number) => void }).grow(600);
    a.scrollTop = 0;
    expect(putBack(a, { top: 290, end: true })).toBe(true);
    expect(a.scrollTop).toBe(500);
    // Not there yet: nothing moves, it is tried again.
    const short = box("d", 100, 150);
    expect(putBack(short, { top: 140, end: false })).toBe(false);
    expect(short.scrollTop).toBe(0);
  });

  it("scrolled, left, drawn again: the box is put back, also when its content comes late", () => {
    const place: Place = {};
    const v = document.createElement("div");
    const p = box("h9-pb", 100, 400);
    v.append(p);
    document.body.append(v);
    const first = keepPlace(v, place);
    vi.advanceTimersByTime(8100);
    p.dispatchEvent(new Event("wheel"));
    p.scrollTop = 140;
    p.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(200);
    expect(place["h9-pb#0"]).toEqual({ top: 140, end: false });
    first.destroy?.();
    v.remove();

    // Drawn again: its content is short at first (its data is read again), then arrives.
    const v2 = document.createElement("div");
    const p2 = box("h9-pb", 100, 120);
    v2.append(p2);
    document.body.append(v2);
    keepPlace(v2, place);
    vi.advanceTimersByTime(100);
    expect(p2.scrollTop).toBe(0);
    (p2 as unknown as { grow: (n: number) => void }).grow(400);
    vi.advanceTimersByTime(200);
    expect(p2.scrollTop).toBe(140);
  });

  it("stops putting it back once he scrolls himself", () => {
    const place: Place = { "h9-pb#0": { top: 140, end: false } };
    const v = document.createElement("div");
    const p = box("h9-pb", 100, 400);
    v.append(p);
    document.body.append(v);
    keepPlace(v, place);
    vi.advanceTimersByTime(0);
    expect(p.scrollTop).toBe(140);
    p.dispatchEvent(new Event("wheel"));
    p.scrollTop = 10;
    p.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(1000);
    expect(p.scrollTop).toBe(10);
    expect(place["h9-pb#0"]).toEqual({ top: 10, end: false });
  });

  it("a box already taken out of the page does not overwrite the place with its top", () => {
    const place: Place = {};
    const v = document.createElement("div");
    const p = box("h9-pb", 100, 400);
    v.append(p);
    document.body.append(v);
    const k = keepPlace(v, place);
    vi.advanceTimersByTime(8100);
    p.dispatchEvent(new Event("wheel"));
    p.scrollTop = 140;
    p.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(200);
    v.remove();
    p.scrollTop = 0;
    k.destroy?.();
    expect(place["h9-pb#0"]).toEqual({ top: 140, end: false });
  });
});
