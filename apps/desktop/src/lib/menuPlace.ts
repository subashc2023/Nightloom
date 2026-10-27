/**
 * Where a pop-up menu and its flyout submenus go so they always fit the
 * window (nightshift item 425, his "this currently goes off the screen on
 * the bottom edge, which is bad"). Pure: rects in, a position out; the
 * sidebar's row menu measures itself and calls these.
 */

export interface Size {
  w: number;
  h: number;
}
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface Placed {
  left: number;
  top: number;
  /** Set only when the menu is taller than the window: it scrolls inside. */
  maxHeight?: number;
}

/** The gap kept between a menu and the window's edge. */
export const EDGE = 4;

/**
 * A menu opened at a point or under a button. `x` is its left edge (or its
 * right edge with `alignRight`); `below` is the top it takes when it drops
 * down, `above` the bottom it takes when it flips up. It drops below when it
 * fits, flips above when that fits instead, otherwise shifts up until its
 * foot meets the window's; taller than the window, it is pinned to the top
 * and capped.
 */
export function placeMenu(
  at: { x: number; below: number; above: number; alignRight?: boolean },
  size: Size,
  view: Size,
  edge = EDGE,
): Placed {
  const room = view.h - 2 * edge;
  let left = at.alignRight ? at.x - size.w : at.x;
  left = Math.max(edge, Math.min(left, view.w - edge - size.w));
  if (size.h > room) return { left, top: edge, maxHeight: room };
  if (at.below + size.h <= view.h - edge) return { left, top: Math.max(edge, at.below) };
  if (at.above - size.h >= edge) return { left, top: at.above - size.h };
  return { left, top: view.h - edge - size.h };
}

/**
 * A submenu flying out of `item` (the row that opens it) beside `menu` (the
 * parent's box): to the right of the parent, its first row level with the
 * item (`pad` is the submenu's own top padding); to the left when the right
 * has no room for it; shifted up near the window's foot; capped and
 * scrolling only when taller than the window.
 */
export function placeSubmenu(item: Rect, menu: Rect, size: Size, view: Size, pad = 4, edge = EDGE): Placed {
  const room = view.h - 2 * edge;
  let left = menu.right - 2;
  if (left + size.w > view.w - edge) {
    const flipped = menu.left - size.w + 2;
    left = flipped >= edge ? flipped : Math.max(edge, view.w - edge - size.w);
  }
  if (size.h > room) return { left, top: edge, maxHeight: room };
  const top = Math.max(edge, Math.min(item.top - pad, view.h - edge - size.h));
  return { left, top };
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Whether the pointer, moving from `from` to `to`, is heading into the
 * submenu `sub` (the "safe triangle": the triangle from `from` to the
 * submenu's two near corners). While it is, crossing the rows between the
 * item and the submenu must not close the submenu.
 */
export function aimsAt(from: Point, to: Point, sub: Rect): boolean {
  const rightward = sub.left >= from.x;
  const nearX = rightward ? sub.left : sub.right;
  // Moving away from the submenu's side is never aiming at it.
  if (rightward ? to.x < from.x : to.x > from.x) return false;
  const a = from;
  const b = { x: nearX, y: sub.top - 8 };
  const c = { x: nearX, y: sub.bottom + 8 };
  return inTriangle(to, a, b, c);
}

function cross(p: Point, q: Point, r: Point): number {
  return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
}

export function inTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}
