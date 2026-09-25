import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Layout } from "./floatingMove";
import { DRAG_SLOP, plan, startTabDrag, targetAt, type TabDropTarget } from "./tabDrag";
import { emptyWorkspace, makeTab, split, type TabContent, type Workspace } from "./tabs";

const chat = (session: string): TabContent => ({ kind: "chat", session });

function ws(...names: string[]): Workspace {
  const w = emptyWorkspace();
  const pane = w.panes[0];
  pane.tabs = names.map((n) => makeTab(chat(n)));
  pane.active = pane.tabs[0].id;
  return w;
}

/** One pane 800×600 at (0,0): a strip 36px tall with three 100px tabs. */
const one: Layout = {
  panes: [{ id: "p", rect: { left: 0, top: 0, width: 800, height: 600 } }],
  strips: [
    {
      pane: "p",
      rect: { left: 0, top: 0, width: 800, height: 36 },
      tabs: [
        { left: 8, right: 108 },
        { left: 110, right: 210 },
        { left: 212, right: 312 },
      ],
    },
  ],
};

describe("targetAt", () => {
  it("a strip slot by the tabs' midpoints, with the marker at the slot's left edge", () => {
    expect(targetAt({ x: 20, y: 18 }, one)).toMatchObject({ kind: "strip", pane: "p", index: 0, marker: 8 });
    expect(targetAt({ x: 170, y: 18 }, one)).toMatchObject({ kind: "strip", index: 2, marker: 212 });
    expect(targetAt({ x: 700, y: 18 }, one)).toMatchObject({ kind: "strip", index: 3, marker: 312 });
  });

  it("the strip reaches a little above and below its band", () => {
    expect(targetAt({ x: 170, y: 45 }, one)?.kind).toBe("strip");
    expect(targetAt({ x: 170, y: 60 }, one)?.kind).toBe("half");
  });

  it("below the strip, the pane half under the pointer", () => {
    expect(targetAt({ x: 100, y: 300 }, one)).toMatchObject({ kind: "half", pane: "p", side: "left" });
    expect(targetAt({ x: 700, y: 300 }, one)).toMatchObject({
      kind: "half",
      side: "right",
      rect: { left: 400, width: 400 },
    });
  });

  it("outside every pane, nothing", () => {
    expect(targetAt({ x: 900, y: 300 }, one)).toBeNull();
    expect(targetAt({ x: 100, y: 700 }, one)).toBeNull();
  });
});

describe("plan", () => {
  const strip = (pane: string, index: number): TabDropTarget => ({ kind: "strip", pane, index, marker: 0 });
  const half = (pane: string, side: "left" | "right"): TabDropTarget => ({
    kind: "half",
    pane,
    side,
    rect: { left: 0, top: 0, width: 1, height: 1 },
  });

  it("nowhere, or its own slot, snaps back — the drag that ends where it began is nothing", () => {
    const w = ws("a", "b", "c");
    const p = w.panes[0];
    const b = p.tabs[1].id;
    expect(plan(w, b, null)).toEqual({ kind: "snap", why: "nowhere" });
    expect(plan(w, b, strip(p.id, 1))).toEqual({ kind: "snap", why: "own-slot" });
    expect(plan(w, b, strip(p.id, 2))).toEqual({ kind: "snap", why: "own-slot" });
  });

  it("another slot in its own strip reorders — the open tab included", () => {
    const w = ws("a", "b", "c");
    const p = w.panes[0];
    expect(plan(w, p.tabs[0].id, strip(p.id, 3))).toEqual({ kind: "reorder", index: 3 });
    expect(plan(w, p.tabs[2].id, strip(p.id, 0))).toEqual({ kind: "reorder", index: 0 });
  });

  it("one pane: a half splits, unless the tab is the pane's only one", () => {
    const w = ws("a", "b");
    const p = w.panes[0];
    expect(plan(w, p.tabs[1].id, half(p.id, "left"))).toEqual({ kind: "split", side: "left" });
    const lone = ws("a");
    expect(plan(lone, lone.panes[0].tabs[0].id, half(lone.panes[0].id, "right"))).toEqual({
      kind: "snap",
      why: "only-tab",
    });
  });

  it("two panes: the other strip or the other pane's content moves; its own pane's content snaps", () => {
    const w = ws("a", "b", "c");
    split(w, w.panes[0].tabs[2].id, "right");
    const [left, right] = w.panes;
    const a = left.tabs[0].id;
    expect(plan(w, a, strip(right.id, 0))).toEqual({ kind: "move", pane: right.id, index: 0 });
    expect(plan(w, a, half(right.id, "left"))).toEqual({ kind: "move", pane: right.id, index: 1 });
    expect(plan(w, a, half(left.id, "right"))).toEqual({ kind: "snap", why: "own-pane" });
  });
});

// ---- the pointer driver, over a stand-in window ----

type Listener = (e: unknown) => void;
let listeners: Map<string, Set<Listener>>;

function fire(type: string, e: Record<string, unknown>): Record<string, unknown> {
  const ev = { preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...e };
  for (const l of [...(listeners.get(type) ?? [])]) l(ev);
  return ev;
}

beforeEach(() => {
  listeners = new Map();
  vi.stubGlobal("window", {
    addEventListener: (t: string, l: Listener) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(l);
    },
    removeEventListener: (t: string, l: Listener) => listeners.get(t)?.delete(l),
  });
  vi.stubGlobal("document", { body: { style: { userSelect: "" } } });
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function handlers() {
  return { onStart: vi.fn(), onMove: vi.fn(), onDrop: vi.fn(), onCancel: vi.fn() };
}
const press = (x: number, y: number) => ({ button: 0, clientX: x, clientY: y }) as PointerEvent;

describe("startTabDrag", () => {
  it("under the threshold it is a click: no drag, no drop, and the click is not swallowed", () => {
    const h = handlers();
    startTabDrag(press(50, 18), h, () => one);
    fire("pointermove", { clientX: 50 + DRAG_SLOP - 1, clientY: 18 });
    fire("pointerup", { clientX: 50 + DRAG_SLOP - 1, clientY: 18 });
    expect(h.onStart).not.toHaveBeenCalled();
    expect(h.onDrop).not.toHaveBeenCalled();
    expect(listeners.get("click")?.size ?? 0).toBe(0);
    expect(listeners.get("pointermove")?.size).toBe(0);
  });

  it("past the threshold it drags, tracks the target and drops on it, swallowing the click once", () => {
    const h = handlers();
    startTabDrag(press(50, 18), h, () => one);
    fire("pointermove", { clientX: 170, clientY: 18 });
    expect(h.onStart).toHaveBeenCalledTimes(1);
    expect(h.onMove).toHaveBeenLastCalledWith({ x: 170, y: 18 }, expect.objectContaining({ kind: "strip", index: 2 }));
    fire("pointerup", { clientX: 170, clientY: 18 });
    expect(h.onDrop).toHaveBeenCalledWith(expect.objectContaining({ kind: "strip", index: 2 }));
    const click = fire("click", {});
    expect(click.stopImmediatePropagation).toHaveBeenCalled();
    vi.runAllTimers();
    expect(listeners.get("click")?.size ?? 0).toBe(0);
  });

  it("the open tab drags like any other — the driver does not know which is active", () => {
    // The strip starts the drag from any tab's press; nothing here reads
    // `pane.active`, which is the point (his defect 1).
    const h = handlers();
    startTabDrag(press(20, 18), h, () => one);
    fire("pointermove", { clientX: 280, clientY: 20 });
    fire("pointerup", { clientX: 280, clientY: 20 });
    expect(h.onDrop).toHaveBeenCalledWith(expect.objectContaining({ kind: "strip", index: 3 }));
  });

  it("Escape during a drag cancels it, and the release after does nothing", () => {
    const h = handlers();
    startTabDrag(press(50, 18), h, () => one);
    fire("pointermove", { clientX: 170, clientY: 18 });
    const esc = fire("keydown", { key: "Escape" });
    expect(esc.stopImmediatePropagation).toHaveBeenCalled();
    expect(h.onCancel).toHaveBeenCalledTimes(1);
    fire("pointerup", { clientX: 170, clientY: 18 });
    expect(h.onDrop).not.toHaveBeenCalled();
  });

  it("a release over nothing reports nothing — the strip snaps the ghost back", () => {
    const h = handlers();
    startTabDrag(press(50, 18), h, () => one);
    fire("pointermove", { clientX: 900, clientY: 300 });
    fire("pointerup", { clientX: 900, clientY: 300 });
    expect(h.onDrop).toHaveBeenCalledWith(null);
  });

  it("ignores any button but the first", () => {
    const h = handlers();
    startTabDrag({ button: 1, clientX: 0, clientY: 0 } as PointerEvent, h, () => one);
    expect(listeners.size).toBe(0);
  });
});
