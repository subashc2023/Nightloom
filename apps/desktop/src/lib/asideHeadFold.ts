/**
 * Item 685 (2026-11-13, his words in backlog/685): the aside tab's header
 * card (item 673's C1 Twin) folds to a one-line strip once he has scrolled
 * down the aside's thread, and grows back to the full card near the top.
 *
 * Two thresholds, so a scroll resting at the edge never flickers: it folds
 * past `FOLD_AT` px and unfolds only under `UNFOLD_AT` px. Between the two
 * it keeps whatever it was.
 */
export const FOLD_AT = 48;
export const UNFOLD_AT = 16;

/** The fold after the thread's scroller reads `top`, given it was `was`. */
export function nextFold(was: boolean, top: number): boolean {
  if (was) return top >= UNFOLD_AT;
  return top > FOLD_AT;
}

/**
 * Whether a change of fold animates: never under Reduce motion, and only
 * when his own input moved the thread (a wheel, a touch, a key, a held
 * pointer on the scrollbar, within `INPUT_MS`). A place put back on coming
 * to the tab (or another thread shown) swaps at once.
 */
export const INPUT_MS = 450;
export function foldAnimates(reduced: boolean, held: boolean, sinceInputMs: number): boolean {
  return !reduced && (held || sinceInputMs < INPUT_MS);
}
