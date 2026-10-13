/*
 * Item 312: an attachment chip made from text (⌥⌘V, or "Make this an
 * attachment" on a long paste) fades in, and Undo fades it out. Only
 * those chips: an image or a file dropped or picked appears as it always
 * did, and a chip that mounts because the chat changed never fades.
 *
 * The mark is transient (never saved with the draft): the chip's name is
 * marked before the chip exists (its id is minted inside `accept`), its id
 * is marked for the fade out just before Undo removes it. Each mark is
 * used once.
 */

/** The fade's length; under the item's ~300 ms. */
export const CHIP_FADE_MS = 180;

export type ChipMotion = { duration: number; easing?: (t: number) => number; css?: (t: number) => string };

/** The transition a chip gets: a fade when marked and motion is allowed,
 *  otherwise none (it simply appears or disappears). */
export function chipMotion(marked: boolean, reducedMotion: boolean): ChipMotion {
  if (!marked || reducedMotion) return { duration: 0 };
  // The easing is on the progress, so both ways move quickly at first:
  // the chip is soon readable coming in, soon gone going out.
  return { duration: CHIP_FADE_MS, easing: easeOut, css: (t) => `opacity: ${t}` };
}

/** Cubic ease-out: quick to show, gentle at the end. */
export function easeOut(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/** One-shot marks: `take` answers whether the key was marked and clears it. */
export class Marks<K> {
  private set = new Set<K>();
  mark(k: K): void {
    this.set.add(k);
  }
  unmark(k: K): void {
    this.set.delete(k);
  }
  take(k: K): boolean {
    return this.set.delete(k);
  }
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
