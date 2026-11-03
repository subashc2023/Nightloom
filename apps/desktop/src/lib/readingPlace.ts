/*
 * The reader's place across a reply's end (item 493). At the turn's end the
 * live reply (its ghost, backlog 131) is swapped for the recorded one, and
 * WebKit clamps the scroll position as the ghost leaves — to the foot of his
 * own question, measured — so the transcript must put the view back by an
 * element it can find on both sides of the swap. The thinking and tool rows
 * are relabelled when recorded ("thought for 1 s" → "thought · summary") and
 * a word still in the streaming motion's span has no twin, so the place is
 * held by the reply's prose blocks in view: their text is the same either
 * side. None found: the scroll position from before the swap, never the
 * clamp. Pure over a minimal element shape so the suite can pin it.
 */

/** A top-level block of a reply's markdown, or a list's items. */
export const PROSE_BLOCKS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "blockquote",
  "table",
  "figure",
  "div",
]
  .map((t) => `.markdown > ${t}`)
  .concat([".markdown > ul > li", ".markdown > ol > li"])
  .join(", ");

/** The thinking / tool rows' block: folded, relabelled at the turn's end. */
export const UNSTABLE = ".activity";

/** How much of a block's text identifies it. */
export const HOLD_TEXT = 160;

export interface Hold {
  tag: string;
  text: string;
  /** Its top edge (client px) before the swap. */
  top: number;
}

export interface BlockEl {
  tagName: string;
  textContent: string | null;
  getBoundingClientRect(): { top: number; bottom: number; height: number };
  closest(selector: string): unknown;
}

export interface ViewBox {
  top: number;
  bottom: number;
  height: number;
}

export function holdText(el: { textContent: string | null }): string {
  return (el.textContent ?? "").trim().slice(0, HOLD_TEXT);
}

/**
 * The prose blocks in view, in document order (the first is the one under
 * the top edge, or straddling it), at most `max`. When any `preferred` block
 * (the live reply's) starts in the view's top half, only those: with the
 * reply's first lines under a half-visible bubble it is the reply's lines he
 * holds, not the bubble (backlog 131).
 */
export function proseHolds(
  blocks: Iterable<BlockEl>,
  view: ViewBox,
  preferred: (el: BlockEl) => boolean,
  max = 4,
): Hold[] {
  const seen: (Hold & { pref: boolean })[] = [];
  for (const el of blocks) {
    if (el.closest(UNSTABLE)) continue;
    const text = holdText(el);
    if (!text) continue;
    const r = el.getBoundingClientRect();
    if (r.height <= 0 || r.bottom <= view.top || r.top >= view.bottom) continue;
    seen.push({ tag: el.tagName, text, top: r.top, pref: preferred(el) });
  }
  const live = seen.some((s) => s.pref && s.top < view.top + view.height / 2);
  return (live ? seen.filter((s) => s.pref) : seen).slice(0, max).map(({ tag, text, top }) => ({ tag, text, top }));
}

/** How far the hold's element moved: the nearest same-tag element with the
 *  same text start (a paragraph can be repeated), or null when none. */
export function nearestDelta(hold: Hold, els: Iterable<BlockEl>): number | null {
  let best: number | null = null;
  for (const el of els) {
    if (el.tagName !== hold.tag || holdText(el) !== hold.text) continue;
    const delta = el.getBoundingClientRect().top - hold.top;
    if (best === null || Math.abs(delta) < Math.abs(best)) best = delta;
  }
  return best;
}

/**
 * Where the view goes after the swap, from `now` (the clamped position):
 * by the first hold found again, or back to the position before the swap
 * when none is; null when it is already there (within a pixel).
 */
export function settledTop(
  holds: Hold[],
  before: number,
  now: number,
  deltaOf: (h: Hold) => number | null,
): number | null {
  for (const h of holds) {
    const d = deltaOf(h);
    if (d === null) continue;
    return Math.abs(d) < 1 ? null : now + d;
  }
  return Math.abs(now - before) < 1 ? null : before;
}
