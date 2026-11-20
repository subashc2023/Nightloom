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

/**
 * Item 886 (his "asides … inconsistently save the position of where … I'm
 * scrolled … when I flip to another tab and go back"): the header card's
 * full height, kept per thread for the app's life. An aside tab unmounts
 * when another tab is shown; on its return the card's height was 0 until
 * measured, so the thread's room (`.aside-head-room`) was missing while the
 * transcript put its place back, and the room arriving a frame later pushed
 * the thread down by its height — 94 px measured at 1440×900 (scrollTop 300
 * left, 394 back). Starting from the kept height, the room is there before
 * the place is put back. A thread never measured takes the last height seen.
 */
const heads = new Map<string, number>();
let lastHead = 0;
export function keptHead(key: string): number {
  return heads.get(key) ?? lastHead;
}
export function keepHead(key: string, height: number): void {
  if (!(height > 0)) return;
  heads.set(key, height);
  lastHead = height;
}
