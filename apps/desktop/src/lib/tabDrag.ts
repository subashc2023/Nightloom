/**
 * Dragging a tab (nightshift backlog 195, 2026-09-25): pointer events, not
 * WebKit's native HTML5 drag.
 *
 * His report (2026-09-23): the open tab could not be picked up, a tab
 * dragged and put back where it was switched to it, and "oftentimes
 * dragging it just doesn't even do anything". The native drag had no
 * threshold, no visible failure and no way to tell a click from a drag,
 * and a drop in the tab's own slot went through `move` and `activateTab`
 * like a real move. So the tab follows the pointer the way the aside card
 * does (backlog 156, `floatingMove.ts`):
 *
 * - Nothing happens until the pointer has travelled `DRAG_SLOP` px; a
 *   press that never does is the click it always was (it activates).
 * - A drag past the threshold draws a ghost under the pointer and a marker
 *   at the slot it would land in — or the pane half it would split to.
 * - Released, it either does something — a reorder (the active tab stays
 *   the active tab), a move into the other pane (the focus follows it,
 *   guess pass 2026-09-25 q10), a split — or it **snaps back**: the ghost
 *   flies home, so a drag that does nothing is seen to do nothing.
 * - Escape during the drag snaps back too; the click the release raises
 *   is swallowed, so a drag never reads as a click.
 *
 * The geometry (`targetAt`) and the decision (`plan`) are pure and tested;
 * the page is read once when a drag starts, since nothing under the
 * pointer moves while it drags.
 */
import { measureLayout, type Layout, type Point, type Rect } from "./floatingMove";
import { MAX_PANES, isOwnSlot, paneOf, type Workspace } from "./tabs";

/** Travel before a press becomes a drag. A tab is small and clicked
 *  often: a little more than the aside card's 2px. */
export const DRAG_SLOP = 4;
/** How far above or below a strip the pointer still counts as on it. */
export const STRIP_REACH_Y = 14;

export type TabDropTarget =
  | { kind: "strip"; pane: string; index: number; marker: number }
  | { kind: "half"; pane: string; side: "left" | "right"; rect: Rect };

/** What a release does. `snap` names why nothing happens. */
export type TabDropPlan =
  | { kind: "reorder"; index: number }
  | { kind: "move"; pane: string; index: number }
  | { kind: "split"; side: "left" | "right" }
  | { kind: "snap"; why: "nowhere" | "own-slot" | "only-tab" | "own-pane" };

/**
 * The target under the pointer: a slot in a strip (the strip's own band
 * and `STRIP_REACH_Y` above and below it), else the half of the pane the
 * pointer is over, else nothing.
 */
export function targetAt(p: Point, layout: Layout): TabDropTarget | null {
  for (const s of layout.strips) {
    const r = s.rect;
    if (p.x < r.left || p.x > r.left + r.width) continue;
    if (p.y < r.top - STRIP_REACH_Y || p.y > r.top + r.height + STRIP_REACH_Y) continue;
    let index = 0;
    while (index < s.tabs.length && p.x > (s.tabs[index].left + s.tabs[index].right) / 2) index++;
    const marker =
      index < s.tabs.length ? s.tabs[index].left : (s.tabs[s.tabs.length - 1]?.right ?? r.left + 8);
    return { kind: "strip", pane: s.pane, index, marker };
  }
  for (const q of layout.panes) {
    const r = q.rect;
    if (p.x < r.left || p.x > r.left + r.width || p.y < r.top || p.y > r.top + r.height) continue;
    const side = p.x < r.left + r.width / 2 ? "left" : "right";
    const half = { left: side === "left" ? r.left : r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height };
    return { kind: "half", pane: q.id, side, rect: half };
  }
  return null;
}

/** What releasing `tabId` over `target` does in `ws`. */
export function plan(ws: Workspace, tabId: string, target: TabDropTarget | null): TabDropPlan {
  const from = paneOf(ws, tabId);
  if (!target || !from) return { kind: "snap", why: "nowhere" };
  if (target.kind === "strip") {
    if (target.pane === from.id) {
      return isOwnSlot(ws, tabId, from.id, target.index)
        ? { kind: "snap", why: "own-slot" }
        : { kind: "reorder", index: target.index };
    }
    return { kind: "move", pane: target.pane, index: target.index };
  }
  if (ws.panes.length < MAX_PANES) {
    return from.tabs.length < 2 ? { kind: "snap", why: "only-tab" } : { kind: "split", side: target.side };
  }
  if (target.pane === from.id) return { kind: "snap", why: "own-pane" };
  const to = ws.panes.find((p) => p.id === target.pane);
  return { kind: "move", pane: target.pane, index: to ? to.tabs.length : 0 };
}

/** The label a pane half shows for a tab drag, as `App.svelte` words it. */
export function halfLabel(p: TabDropPlan): string | null {
  if (p.kind === "split") return "open beside";
  if (p.kind === "move") return "move here";
  return null;
}

export interface TabDragHandlers {
  /** The drag began (the pointer passed the threshold). */
  onStart(): void;
  /** Each pointer move during the drag. */
  onMove(pos: Point, target: TabDropTarget | null): void;
  /** Released during the drag, over `target` (null: nowhere). */
  onDrop(target: TabDropTarget | null): void;
  /** Escape, or the pointer cancelled by the system. */
  onCancel(): void;
}

/**
 * Start watching a press on a tab. Nothing happens until the pointer has
 * travelled `DRAG_SLOP` px; the click then follows as usual. Listens on the
 * window until the release, so the drag survives the pointer leaving the
 * strip. `measure` is for the tests.
 */
export function startTabDrag(e: PointerEvent, h: TabDragHandlers, measure: () => Layout = measureLayout): void {
  if (e.button !== 0) return;
  const start = { x: e.clientX, y: e.clientY };
  let layout: Layout | null = null;
  let dragging = false;
  let target: TabDropTarget | null = null;
  const prevSelect = document.body.style.userSelect;

  function move(ev: PointerEvent) {
    if (!dragging) {
      if (Math.abs(ev.clientX - start.x) < DRAG_SLOP && Math.abs(ev.clientY - start.y) < DRAG_SLOP) return;
      dragging = true;
      layout = measure();
      document.body.style.userSelect = "none";
      h.onStart();
    }
    ev.preventDefault();
    const p = { x: ev.clientX, y: ev.clientY };
    target = layout ? targetAt(p, layout) : null;
    h.onMove(p, target);
  }
  function up(ev: PointerEvent) {
    const was = dragging;
    stop();
    if (!was) return;
    ev.preventDefault();
    // The release raises a click on the tab (or whatever is common to it
    // and the spot let go of): a drag is not a click — swallow it, once.
    const swallow = (c: MouseEvent) => {
      c.preventDefault();
      c.stopImmediatePropagation();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    h.onDrop(target);
  }
  function key(ev: KeyboardEvent) {
    if (ev.key !== "Escape" || !dragging) return;
    // Ours while dragging: it must not reach the window (macOS leaves full
    // screen on it) or close anything under the drag.
    ev.preventDefault();
    ev.stopImmediatePropagation();
    stop();
    h.onCancel();
  }
  function cancel() {
    const was = dragging;
    stop();
    if (was) h.onCancel();
  }
  function stop() {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    document.body.style.userSelect = prevSelect;
  }
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
}
