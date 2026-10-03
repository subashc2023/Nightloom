/**
 * Moving a floating card by its head (nightshift backlog 156, 2026-09-22):
 * the Ask-aside card and the floating attachment tab share it.
 *
 * His words: the card should move "fully freely", and only "near the top"
 * or "really banking to the sides" clip on to somewhere; a nudge of a few
 * pixels is just a move. So this is pointer events, not native drag and
 * drop — a native drag has only drop targets, and dropped anywhere else it
 * snaps back. The card follows the pointer; a **zone** lights only when the
 * pointer comes near one:
 *
 * - **a tab strip** — within `STRIP_REACH` px of a pane's strip, above,
 *   on or below it: "open as a tab", at the slot the pointer is over (the
 *   strip's own accent marker).
 * - **a side edge** — within `EDGE_REACH` px of the panes' left or right
 *   edge, or past it (over the sidebar or the rail): what it means is the
 *   caller's — the aside's right edge is its side panel (141 pass 2), and
 *   an edge otherwise opens the content beside, as the pane halves did for
 *   a native drop (140 pass 2).
 *
 * Released in a zone, the caller does what the native drop did; released
 * anywhere else, the card stays where it was let go. Escape during a move
 * puts it back where it was when the move began.
 *
 * The geometry (`zoneAt`, `clampPos`, `outcome`) is pure and tested; the
 * page is read once, when a move starts (`measureLayout`), because nothing
 * under the pointer moves while it drags.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}

/** A pane's tab strip: where it is, and its tabs' left and right edges. */
export interface StripGeom {
  pane: string;
  rect: Rect;
  tabs: { left: number; right: number }[];
}
export interface PaneGeom {
  id: string;
  rect: Rect;
}
export interface Layout {
  strips: StripGeom[];
  /** Left to right, as the panes are drawn. */
  panes: PaneGeom[];
}

/** What a side edge does for this card; null for nothing. */
export type EdgeUse = "panel" | "beside" | null;
export interface EdgeUses {
  left: EdgeUse;
  right: EdgeUse;
}

export type Zone =
  | { kind: "strip"; pane: string; index: number; rect: Rect; marker: number }
  | { kind: "edge"; side: "left" | "right"; use: "panel" | "beside"; pane: string; rect: Rect };

/** How near a strip the pointer must be for it to light. */
export const STRIP_REACH = 40;
/** How near the panes' side edges. */
export const EDGE_REACH = 48;
/** The lit edge band's width — 141's `aside-edge`. */
export const EDGE_W = 64;
/** Travel before a press becomes a move, so a click (or the double-click
 *  that sends the card home) never shifts it. */
export const MOVE_SLOP = 2;

/**
 * The zone under the pointer, or null for free space. A strip wins over an
 * edge: the top band is the more deliberate target, and the corners belong
 * to both.
 */
export function zoneAt(p: Point, layout: Layout, edges: EdgeUses): Zone | null {
  for (const s of layout.strips) {
    const r = s.rect;
    if (p.x < r.left || p.x > r.left + r.width) continue;
    if (p.y < r.top - STRIP_REACH || p.y > r.top + r.height + STRIP_REACH) continue;
    let index = 0;
    while (index < s.tabs.length && p.x > (s.tabs[index].left + s.tabs[index].right) / 2) index++;
    const marker =
      index < s.tabs.length ? s.tabs[index].left : (s.tabs[s.tabs.length - 1]?.right ?? r.left + 8);
    return { kind: "strip", pane: s.pane, index, rect: r, marker };
  }
  const first = layout.panes[0];
  const last = layout.panes[layout.panes.length - 1];
  if (!first || !last) return null;
  const top = Math.min(...layout.panes.map((q) => q.rect.top));
  const bottom = Math.max(...layout.panes.map((q) => q.rect.top + q.rect.height));
  if (p.y < top || p.y > bottom) return null;
  const right = last.rect.left + last.rect.width;
  if (edges.right && p.x >= right - EDGE_REACH) {
    return {
      kind: "edge",
      side: "right",
      use: edges.right,
      pane: last.id,
      rect: { left: right - EDGE_W, top, width: EDGE_W, height: bottom - top },
    };
  }
  if (edges.left && p.x <= first.rect.left + EDGE_REACH) {
    return {
      kind: "edge",
      side: "left",
      use: edges.left,
      pane: first.id,
      rect: { left: first.rect.left, top, width: EDGE_W, height: bottom - top },
    };
  }
  return null;
}

/** What a release does: the zone's action, or stay where let go. */
export type Outcome =
  | { kind: "tab"; pane: string; index: number }
  | { kind: "panel" }
  | { kind: "beside"; pane: string; side: "left" | "right" }
  | { kind: "stay" };

export function outcome(zone: Zone | null): Outcome {
  if (!zone) return { kind: "stay" };
  if (zone.kind === "strip") return { kind: "tab", pane: zone.pane, index: zone.index };
  if (zone.use === "panel") return { kind: "panel" };
  return { kind: "beside", pane: zone.pane, side: zone.side };
}

/**
 * Keep a moved card findable: its head wholly inside the window
 * vertically, and at least `keep` px of it inside horizontally — it may
 * hang off a side, never vanish.
 */
export function clampPos(
  pos: { left: number; top: number },
  size: { width: number; height: number },
  win: { width: number; height: number },
  keep = 80,
  head = 36,
): { left: number; top: number } {
  const minLeft = Math.min(0, keep - size.width);
  const maxLeft = Math.max(minLeft, win.width - Math.min(keep, size.width));
  const maxTop = Math.max(0, win.height - head);
  return {
    left: Math.round(Math.min(maxLeft, Math.max(minLeft, pos.left))),
    top: Math.round(Math.min(maxTop, Math.max(0, pos.top))),
  };
}

/**
 * Zones light only once the pointer has been in free space during this
 * move. A card whose head already sits in a zone's reach — the fitted
 * attachment tab's head is always near the strips — would otherwise snap
 * on the smallest nudge, which is the one thing a nudge must not do. Feed
 * it each move's raw zone; it returns the zone to light.
 */
export function zoneArming(): (raw: Zone | null) => Zone | null {
  let on = false;
  return (raw) => {
    if (!raw) on = true;
    return on ? raw : null;
  };
}

/** The zone label, as the pane halves word it (App's `zoneLabel`). */
export function zoneLabel(zone: Zone, panes: number): string {
  if (zone.kind === "strip") return "open as a tab";
  if (zone.use === "panel") return "side panel";
  return panes > 1 ? "open here" : "open beside";
}

// ---- the page: read once per move ----

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** The panes and their strips as drawn now (`App.svelte`'s
 *  `section.pane[data-pane]`, `TabStrip`'s `.tab-strip` and `[data-tab]`). */
export function measureLayout(doc: Document = document): Layout {
  const panes: PaneGeom[] = [];
  const strips: StripGeom[] = [];
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("section.pane[data-pane]"))) {
    const id = el.dataset.pane ?? "";
    panes.push({ id, rect: rectOf(el) });
    const strip = el.querySelector(".tab-strip");
    if (!strip) continue;
    strips.push({
      pane: id,
      rect: rectOf(strip),
      tabs: Array.from(strip.querySelectorAll("[data-tab]")).map((t) => {
        const r = t.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
    });
  }
  panes.sort((a, b) => a.rect.left - b.rect.left);
  return { panes, strips };
}

export interface MoveHandlers {
  /** The card's top-left in the window when the press began. */
  origin: { left: number; top: number };
  size: { width: number; height: number };
  edges: EdgeUses;
  /** Each pointer move once the press is a move. */
  onMove(pos: { left: number; top: number }, zone: Zone | null): void;
  /** Released after a move: where, and over which zone. */
  onDrop(pos: { left: number; top: number }, zone: Zone | null): void;
  /** Escape during the move: the card goes back to `origin`. */
  onCancel(): void;
}

/**
 * Start a move from a `pointerdown` on the card's head. Nothing happens
 * until the pointer has travelled `MOVE_SLOP` px; a press that never does
 * is a click. Listens on the window until the release (or Escape), so the
 * move survives the pointer outrunning the card.
 */
export function startMove(e: PointerEvent, h: MoveHandlers): void {
  if (e.button !== 0) return;
  const start = { x: e.clientX, y: e.clientY };
  let layout: Layout | null = null;
  let moving = false;
  let pos = { ...h.origin };
  let zone: Zone | null = null;
  const win = () => ({ width: window.innerWidth, height: window.innerHeight });
  const prevSelect = document.body.style.userSelect;
  const armed = zoneArming();

  function move(ev: PointerEvent) {
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (!moving) {
      if (Math.abs(dx) < MOVE_SLOP && Math.abs(dy) < MOVE_SLOP) return;
      moving = true;
      layout = measureLayout();
      document.body.style.userSelect = "none";
    }
    ev.preventDefault();
    pos = clampPos({ left: h.origin.left + dx, top: h.origin.top + dy }, h.size, win());
    const raw = layout ? zoneAt({ x: ev.clientX, y: ev.clientY }, layout, h.edges) : null;
    zone = armed(raw);
    h.onMove(pos, zone);
  }
  function up(ev: PointerEvent) {
    const was = moving;
    stop();
    if (!was) return;
    ev.preventDefault();
    // The click this release raises lands on whatever is common to the
    // head and the spot let go of — the attachment's scrim, which closes
    // on a click. A move is not a click: swallow it, once.
    const swallow = (c: MouseEvent) => {
      c.preventDefault();
      c.stopImmediatePropagation();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    h.onDrop(pos, zone);
  }
  function key(ev: KeyboardEvent) {
    if (ev.key !== "Escape" || !moving) return;
    // Ours while a move is on: it must not also close the card, and must
    // never reach the window (macOS leaves full screen on it).
    ev.preventDefault();
    ev.stopImmediatePropagation();
    stop();
    h.onCancel();
  }
  function stop() {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    document.body.style.userSelect = prevSelect;
  }
  function cancel() {
    const was = moving;
    stop();
    if (was) h.onCancel();
  }
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
}
