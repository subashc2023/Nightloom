// A menu that opens from a button inside a scrolling column (nightshift
// backlog 210, 2026-09-25). The composer's model, effort and drafts menus
// and the Council popover were `position: absolute; bottom: calc(100% +
// 8px)` inside the composer; on the Welcome page the composer sits in
// `.ccol`, an `overflow-y: auto` column, so a menu opening upward was cut
// off at the column's top (the model menu lost its head and its opus and
// sonnet rows). Backlog 163 portalled the top bar's card for the same kind
// of fault (a stacking context) but never the composer's menus.
//
// `use:floatMenu={{ anchor, align }}` moves the menu to `document.body`
// (backlog 163's `portal`), fixes it to the viewport by the anchor's
// rectangle (`placeMenu`: above when it fits, else below, else the roomier
// side with a `max-height` for the room there), re-places it on resize,
// on any scroll and when the menu or its anchor changes size, and holds
// every tooltip that is not inside the menu while it is open (`holdTips`).

import { portal } from "./portal";
import { holdTips } from "./tip";

export interface MenuAnchor {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface MenuPlacement {
  top: number;
  left: number;
  /** The most the menu may be tall where it sits; it scrolls past this. */
  maxHeight: number;
  side: "above" | "below";
}

/**
 * Where a menu of natural size `w`×`h` goes for an anchor in a `vw`×`vh`
 * window: above the anchor, `gap` px clear, when all of it fits at least
 * `margin` px from the window's top; else below when all of it fits there;
 * else on the side with more room, its `maxHeight` that room (it scrolls).
 * Horizontally its left edge meets the anchor's (`align: "left"`) or its
 * right edge the anchor's (`"right"`), clamped `margin` px inside the
 * window (a menu wider than the window starts at the margin).
 */
export function placeMenu(
  anchor: MenuAnchor,
  w: number,
  h: number,
  vw: number,
  vh: number,
  align: "left" | "right" = "left",
  gap = 8,
  margin = 8,
): MenuPlacement {
  const roomAbove = Math.max(0, anchor.top - gap - margin);
  const roomBelow = Math.max(0, vh - margin - (anchor.bottom + gap));
  let side: "above" | "below";
  if (h <= roomAbove) side = "above";
  else if (h <= roomBelow) side = "below";
  else side = roomAbove >= roomBelow ? "above" : "below";
  const room = side === "above" ? roomAbove : roomBelow;
  const shown = Math.min(h, room);
  let top = side === "above" ? anchor.top - gap - shown : anchor.bottom + gap;
  // Inside the window whatever the anchor does (an anchor scrolled half
  // out of view still gets a whole menu).
  top = Math.max(margin, Math.min(top, vh - margin - shown));
  let left = align === "left" ? anchor.left : anchor.right - w;
  left = Math.min(left, vw - w - margin);
  left = Math.max(left, margin);
  return { top: Math.round(top), left: Math.round(left), maxHeight: Math.floor(room), side };
}

export interface FloatMenuArg {
  /** The button the menu opens from. */
  anchor: HTMLElement | null | undefined;
  align?: "left" | "right";
  /** The tallest the menu grows, as a share of the window's height. */
  maxVh?: number;
}

/** Svelte action: the menu escapes every clipping ancestor (see above). */
export function floatMenu(node: HTMLElement, arg: FloatMenuArg): { update(arg: FloatMenuArg): void; destroy(): void } {
  let current = arg;
  const moved = portal(node);
  const releaseTips = holdTips(node);
  node.style.position = "fixed";
  node.style.bottom = "auto";
  node.style.right = "auto";
  node.style.zIndex = "80";

  const place = () => {
    const a = current.anchor;
    if (!a || !a.isConnected) return;
    // Measured at its natural height at the window's origin (the last
    // max-height and spot would skew it), then placed before the paint.
    node.style.maxHeight = "none";
    node.style.top = "0px";
    node.style.left = "0px";
    // The menu's own cap (the old CSS `max-height: 60vh`) still holds.
    const h = Math.min(node.offsetHeight, Math.floor(window.innerHeight * (current.maxVh ?? 0.7)));
    const p = placeMenu(
      a.getBoundingClientRect(),
      node.offsetWidth,
      h,
      window.innerWidth,
      window.innerHeight,
      current.align ?? "left",
    );
    node.style.top = `${p.top}px`;
    node.style.left = `${p.left}px`;
    node.style.maxHeight = `${Math.min(p.maxHeight, h)}px`;
    node.dataset.side = p.side;
  };
  // A scroll inside the menu itself moves nothing.
  const onScroll = (e: Event) => {
    if (e.target instanceof Node && node.contains(e.target)) return;
    place();
  };
  let frame = 0;
  const later = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      place();
    });
  };
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(later) : null;
  const observe = () => {
    ro?.disconnect();
    ro?.observe(node);
    if (current.anchor) ro?.observe(current.anchor);
  };
  place();
  observe();
  window.addEventListener("resize", place);
  window.addEventListener("scroll", onScroll, true);

  return {
    update(next: FloatMenuArg) {
      current = next;
      observe();
      place();
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
      releaseTips();
      moved.destroy();
    },
  };
}
