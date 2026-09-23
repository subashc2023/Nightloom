/**
 * Folding by measurement (nightshift backlog 183, 2026-09-22).
 *
 * ~~A container query per fold step~~ — in WebKit under page zoom (⌘+,
 * Tauri's `set_zoom` → `WKWebView.pageZoom`) a container whose width comes
 * from layout is queried at its width × the zoom: a 660 px bar at 150 %
 * matched `max-width: 1000px` but not `860px`, so every fold fired a zoom
 * step late and the bar wrapped instead (measured in the app's own TopBar
 * under real page zoom, notes/runner-design/175-pass2/). So a row now folds
 * by trying: apply a level, read the layout, and stop at the first level
 * whose items sit on one line. Layout is read in CSS px, which zoom does
 * not disturb.
 */

export interface Box {
  top: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

/** Whether the visible boxes sit on one line and inside `rightEdge`: every
 *  box's vertical middle within `tolerance` px of every other's. Boxes of
 *  zero size (hidden, folded) are ignored. */
export function onOneLine(boxes: Box[], rightEdge: number, tolerance = 10): boolean {
  const shown = boxes.filter((b) => b.width > 0 && b.height > 0);
  if (shown.length === 0) return true;
  const mids = shown.map((b) => b.top + b.height / 2);
  const spread = Math.max(...mids) - Math.min(...mids);
  if (spread > tolerance) return false;
  return shown.every((b) => b.right <= rightEdge + 0.5);
}

/** The first level in 0…`max` at which `fitsAt(level)` holds, else `max`
 *  (the wrap beneath is the floor). `fitsAt` applies the level and
 *  measures, so it is called in rising order and stops at the first fit. */
export function firstFit(fitsAt: (level: number) => boolean, max: number): number {
  for (let level = 0; level < max; level++) {
    if (fitsAt(level)) return level;
  }
  fitsAt(max);
  return max;
}

/**
 * Fold `row` to the first level at which `items()` sit on one line inside
 * it, writing the level to `row.dataset.fold` (the CSS reads it). Reading a
 * rectangle after writing the attribute forces a synchronous layout, so no
 * frame shows an intermediate level.
 */
export function foldToFit(row: HTMLElement, items: () => Element[], max: number): number {
  return firstFit((level) => {
    row.dataset.fold = String(level);
    const r = row.getBoundingClientRect();
    const padRight = parseFloat(getComputedStyle(row).paddingRight) || 0;
    const boxes = items().map((e) => e.getBoundingClientRect());
    return onOneLine(boxes, r.right - padRight);
  }, max);
}
