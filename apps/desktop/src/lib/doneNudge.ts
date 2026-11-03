/**
 * The turn-done nudge (nightshift item 497, 2026-11-02; blocker 1629
 * answered "Yes to the nudge"). Item 493 holds his line still across a
 * reply's end (≤ 0.7 px), which took away the small jump he read as "the
 * turn is done". This gives it back on purpose: the transcript's text dips
 * `NUDGE_PX` and settles back over `NUDGE_MS`, once, when a reply ends.
 *
 * A transform on the transcript's inner column only: no layout, no
 * `scrollTop` change, so 493's hold and the pinned follow-the-foot are
 * untouched, and the line ends where it started. Off under
 * `prefers-reduced-motion: reduce` (and the harnesses' flag).
 */
import { reducedMotion } from "./sendMotion";

export const NUDGE_PX = 4;
export const NUDGE_MS = 340;

/** Down and back: a quick drop, a slower settle. */
export const NUDGE_FRAMES: Keyframe[] = [
  { transform: "translateY(0)", easing: "cubic-bezier(0.3, 0, 0.2, 1)" },
  { transform: `translateY(${NUDGE_PX}px)`, offset: 0.35, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
  { transform: "translateY(0)" },
];

/** Plays the nudge on `el`; null when motion is reduced or the element cannot animate. */
export function nudgeDone(el: HTMLElement | null | undefined): Animation | null {
  if (!el || typeof el.animate !== "function" || reducedMotion()) return null;
  return el.animate(NUDGE_FRAMES, { duration: NUDGE_MS });
}
