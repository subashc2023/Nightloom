/**
 * A moved aside card's place (nightshift item 734, 2026-11-16 — his "if you
 * try to relocate them on screen, suddenly they become absolute on their
 * new location"). Until 734 a dropped card was stored in window px and
 * drawn `position: fixed`, so it stayed on the screen while the chat
 * scrolled under it. Now the drop is turned into the chat column's own px
 * (`landMoved`) and the card is drawn `position: absolute` in the column,
 * as an unmoved card is (`placeMoved`), so it scrolls with the text.
 *
 * A card about a passage keeps its `top` as an offset from the passage's
 * top, so it follows its passage when the text reflows (a narrower window)
 * or turns are drawn above it; a composer card, or one whose passage could
 * not be found, keeps it from the column's content top. `left` is from the
 * column's left edge, clamped into the column when it is let go and each
 * time it is drawn, so a narrower window never strands it off the side.
 *
 * Pure; `AsideCard.svelte` and `AsideLayer.svelte` call it, `asides.ts`
 * writes the result with the thread.
 */
import type { AsideMoved } from "./state/asides.svelte";

/** The card's head row: kept inside the viewport when it is let go. */
export const MOVED_HEAD = 36;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(lo, hi), Math.max(lo, v));

/**
 * Where a card let go at `pos` (window px, its top-left) is kept.
 * `frame` is the chat column's rect in the window (it moves with the
 * scroll, so it is the content's frame), `view` the scrolled viewport's,
 * `passageTop` the passage's top in the column's px (null for none). The
 * card stays inside the column across, and its head inside the viewport
 * down, where he can reach it.
 */
export function landMoved(
  pos: { left: number; top: number },
  width: number,
  frame: Box,
  view: { top: number; bottom: number },
  passageTop: number | null,
): AsideMoved {
  const w = Math.round(Math.min(width, frame.width));
  const left = Math.round(clamp(pos.left - frame.left, 0, frame.width - w));
  const topInView = clamp(pos.top, view.top, view.bottom - MOVED_HEAD);
  const top = Math.round(Math.max(0, topInView - frame.top));
  if (passageTop !== null) return { left, top: Math.round(top - passageTop), width: w, from: "passage" };
  return { left, top, width: w, from: "column" };
}

/**
 * Where a moved card is drawn, in the column's px: null when it is about a
 * passage that cannot be found now (the card then goes to its home, the
 * stack above the composer, as an unmoved card does; `moved` is kept for
 * when the passage is back).
 */
export function placeMoved(
  m: AsideMoved,
  frameWidth: number,
  passageTop: number | null,
): { left: number; top: number; width: number } | null {
  if (m.from === "passage" && passageTop === null) return null;
  const width = Math.round(Math.min(m.width, frameWidth));
  const left = Math.round(clamp(m.left, 0, frameWidth - width));
  const top = Math.round(Math.max(0, (m.from === "passage" ? passageTop! : 0) + m.top));
  return { left, top, width };
}

/** A stored `moved`, checked (`asides.ts` reads one back). */
export function cleanMoved(v: unknown): AsideMoved | null {
  if (v === null || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  if (!num(m.left) || !num(m.top) || !num(m.width) || (m.width as number) <= 0) return null;
  if (m.from !== "passage" && m.from !== "column") return null;
  return { left: m.left as number, top: m.top as number, width: m.width as number, from: m.from };
}
