/**
 * Item 755: the one motion for a card minimizing to its one line and opening
 * back — an aside's card (AsideCard.svelte, item 735) and the hand-off card
 * (handoffButton.ts, item 756). Backlog 755, his words: "short animation of
 * the minimize aside, as well as handoff card minimize".
 *
 * A FLIP of the box alone: the card's size is read before the change and
 * after it, and the card is tweened from the old size to the new over
 * `FOLD_MS`, clipped, so whatever sits under it in the flow moves with it
 * frame by frame rather than jumping. Nothing is drawn twice and nothing
 * waits on the animation: the change is already made when it starts, so a
 * click during it acts on the new state, and a second fold cancels the
 * first from wherever it had got to. None under reduce motion (the app's
 * one switch, `sendMotion.reducedMotion`).
 */
import { reducedMotion } from "./sendMotion";

/** How long a fold or an unfold takes: short, under 755's 250 ms. */
export const FOLD_MS = 180;
/** Fast out of the gate, settling gently (the app's standard decelerate). */
export const FOLD_EASE = "cubic-bezier(0.2, 0, 0, 1)";
/** The animation's id, so a fold in flight can be found and cancelled. */
export const FOLD_ID = "fold-motion";

export interface FoldBox {
  width: number;
  height: number;
  /** Its corner radius as drawn (px, clamped to half the shorter side), when known. */
  radius?: number;
}

/** The corner radius a box draws: its CSS radius, clamped as the browser clamps it. */
export function drawnRadius(css: string, box: { width: number; height: number }): number {
  const r = parseFloat(css);
  return Number.isFinite(r) ? Math.max(0, Math.min(r, box.width / 2, box.height / 2)) : 0;
}

/**
 * The keyframes from one box to the other, or null when neither side moved
 * by half a pixel. The height is tweened in layout, so whatever sits under
 * the card in the flow moves with it frame by frame; the card's own min and
 * max sizes are lifted while it runs and its content is clipped.
 *
 * The width is tweened in layout only when it shrinks (a card folding to
 * its line: the line alone is drawn, nothing in it wraps). When it grows (the
 * line opening to the card) the card is laid out at its full width at once
 * and a clip opens it from the line's width instead: a tween of the width
 * there laid the card's content out narrow as it was drawn, and the aside's
 * box sized itself to that narrow width and stayed 23–53 px too tall
 * (measured in the harness, 2026-11-16).
 *
 * The corners are tweened from the radius drawn before to the one drawn
 * after: Jarvis's minimized line is a pill (999 px), which mid-fold drew the
 * shrinking card as an empty oval (harness, 2026-11-16).
 */
export function foldKeyframes(from: FoldBox, to: FoldBox): Keyframe[] | null {
  const dw = Math.abs(from.width - to.width) >= 0.5;
  const dh = Math.abs(from.height - to.height) >= 0.5;
  if (!dw && !dh) return null;
  const shrink = dw && to.width < from.width;
  const grow = dw && to.width > from.width;
  const dr = from.radius !== undefined && to.radius !== undefined && Math.abs(from.radius - to.radius) >= 0.5;
  const frame = (b: FoldBox, start: boolean): Keyframe => {
    const k: Keyframe = { overflow: "hidden", height: `${b.height}px`, minHeight: "0px", maxHeight: "none" };
    if (shrink) Object.assign(k, { width: `${b.width}px`, minWidth: "0px", maxWidth: "none" });
    const r = start ? from.radius : to.radius;
    if (dr && r !== undefined) k.borderRadius = `${r}px`;
    if (grow) k.clipPath = `inset(0px ${start ? to.width - from.width : 0}px 0px 0px round ${to.radius ?? 0}px)`;
    return k;
  };
  return [frame(from, true), frame(to, false)];
}

/**
 * Make `change` (which may await a render) and tween `el` from its size
 * before to its size after. Without an element, under reduce motion, or
 * where the page has no Web Animations, it only makes the change.
 */
export async function foldMotion(el: HTMLElement | null | undefined, change: () => void | Promise<void>): Promise<void> {
  if (!el || reducedMotion() || typeof el.animate !== "function") {
    await change();
    return;
  }
  // Read first, then cancel: a fold in flight starts the next from where it is.
  const r = el.getBoundingClientRect();
  const from: FoldBox = { width: r.width, height: r.height, radius: drawnRadius(getComputedStyle(el).borderTopLeftRadius, r) };
  for (const a of el.getAnimations?.() ?? []) if (a.id === FOLD_ID) a.cancel();
  await change();
  if (!el.isConnected) return;
  const n = el.getBoundingClientRect();
  const frames = foldKeyframes(from, { width: n.width, height: n.height, radius: drawnRadius(getComputedStyle(el).borderTopLeftRadius, n) });
  if (!frames) return;
  el.animate(frames, { duration: FOLD_MS, easing: FOLD_EASE, id: FOLD_ID });
}
