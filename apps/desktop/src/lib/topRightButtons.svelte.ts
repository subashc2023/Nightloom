import { SvelteMap } from "svelte/reactivity";

/**
 * The transcript's top-right corner holds two buttons (item 887): the
 * chapters' Contents button (`ChapterContents`) and the asides pill
 * (`AsidesList`). Each was placed alone, so with both shown the pill sat on
 * top of Contents. Contents publishes its button here, keyed by the
 * transcript's scroller (a split pane has its own); the pill reads it and
 * sits just left of it, or under it when the transcript is too narrow.
 */
export const contentsButtons = new SvelteMap<HTMLElement, HTMLElement>();

/** Gap between the two buttons, px. */
export const CORNER_GAP = 6;

/**
 * Where the asides pill goes (fixed, viewport coordinates), given the
 * transcript scroller's rect, the Contents button's rect if shown, the
 * pill's own width and height, and the window's width.
 */
export function pillPlace(
  vp: { top: number; left: number; right: number },
  contents: { top: number; left: number; right: number; bottom: number; height: number } | null,
  pillW: number,
  pillH: number,
  winW: number,
): { top: number; right: number } {
  const alone = { top: vp.top + 8, right: Math.max(8, winW - vp.right + 26) };
  if (!contents) return alone;
  const right = winW - contents.left + CORNER_GAP;
  // Side by side while the pill clears the transcript's left edge.
  if (winW - right - pillW >= vp.left + 8) {
    return { top: contents.top + (contents.height - pillH) / 2, right };
  }
  // Too narrow: stack under Contents, right edges aligned.
  return { top: contents.bottom + CORNER_GAP, right: winW - contents.right };
}
