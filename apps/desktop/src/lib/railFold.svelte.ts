/**
 * The right column's fold (nightshift item 599, his "a button to like close
 * and open the context menu situation on the right side", 2026-11-10): folded,
 * the column is a slim strip holding the button to open it again and the
 * context share, and the chat widens into the room. Kept past a chat switch
 * and a relaunch (item 495's viewState, persisted), so the choice is his until
 * he presses it again.
 */
import { viewGet, viewSet } from "./viewState";

export const RAIL_FOLD_KEY = "rail.folded";
/** How long the slide runs (App's `.split.rail-sliding`), in ms. */
export const RAIL_SLIDE_MS = 200;

export const railFold = $state({
  folded: viewGet(RAIL_FOLD_KEY, false),
  /** True for the slide's length after a press, so only his press animates
   *  the split's columns — never a pane drag or a window resize. */
  sliding: false,
});

let slideTimer: ReturnType<typeof setTimeout> | null = null;

export function toggleRailFold(): void {
  railFold.folded = !railFold.folded;
  viewSet(RAIL_FOLD_KEY, railFold.folded, false);
  railFold.sliding = true;
  if (slideTimer) clearTimeout(slideTimer);
  slideTimer = setTimeout(() => {
    railFold.sliding = false;
    slideTimer = null;
  }, RAIL_SLIDE_MS + 40);
}
