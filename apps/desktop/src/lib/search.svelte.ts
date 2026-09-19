/**
 * The search panel's column (nightshift backlog 138, 2026-09-17). The
 * panel used to take `max(380, the sidebar's width)` the frame it opened
 * — his words: "the left side of the screen kind of unceremoniously
 * widens". Now the column grows a little past the sidebar's own width,
 * eased over 160 ms (the top bar's fold uses the same duration, backlog
 * 129), and comes back the same way when the panel closes. The growth is
 * a tween the panel drives on mount and unmount; `sidebarColumn()` in
 * `state.svelte.ts` adds its current value to the sidebar's width.
 *
 * Blocker 202 holds the alternatives: no growth at all (the panel at the
 * sidebar's width) or the old full 380.
 */
import { Tween } from "svelte/motion";
import { cubicOut } from "svelte/easing";

/** How much wider the column grows for the panel, at most. */
export const SEARCH_GROWTH = 80;
/** The panel's column never grows past this (board 11a's width). */
export const SEARCH_COLUMN_MAX = 380;
export const SEARCH_GROW_MS = 160;

/** The growth the panel needs at a sidebar width: up to `SEARCH_GROWTH`,
 *  and never past `SEARCH_COLUMN_MAX`. Pure, for the suite. */
export function searchGrowthFor(sidebarWidth: number): number {
  return Math.max(0, Math.min(SEARCH_GROWTH, SEARCH_COLUMN_MAX - sidebarWidth));
}

/** The column's extra width right now, tweening toward its target. */
export const searchGrowth = new Tween(0, { duration: SEARCH_GROW_MS, easing: cubicOut });

/** The panel opened at this sidebar width: grow. */
export function growForSearch(sidebarWidth: number): void {
  searchGrowth.target = searchGrowthFor(sidebarWidth);
}

/** The panel closed: back to the sidebar's own width. */
export function shrinkAfterSearch(): void {
  searchGrowth.target = 0;
}
