// The floating attachment tab's geometry (nightshift backlog 145,
// 2026-09-17): a click on an attached image or PDF in a user bubble
// opens it in front — a tab in the workspace's floating slot (`tabs.ts`),
// drawn over the panes by `AttachmentLayer.svelte`, zooming up from the
// thumbnail it was clicked on. This module is the pure part: where the
// card sits, and the transform that lays it over the thumbnail for the
// entrance to run from. The suite pins both; the layer measures and
// animates.

/** A rectangle in the viewport's coordinates, as `getBoundingClientRect`. */
export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Kept between the card and the viewport's edges. */
export const VIEW_MARGIN = 40;
/** The entrance's length; the same order as the top bar's fold. */
export const ZOOM_MS = 200;
/** The card's smallest useful size, so a tiny thumbnail still opens a
 *  card one can read a title on. */
export const MIN_CARD = 240;

/**
 * The card's rect: `natural` (the image's own size, or a PDF's page-ish
 * default) fit inside the viewport less the margin, never enlarged past
 * its natural size, never under `MIN_CARD` on either side unless the
 * viewport itself is smaller, and centred.
 */
export function fitRect(natural: { width: number; height: number }, vp: Rect): Rect {
  const availW = Math.max(1, vp.width - 2 * VIEW_MARGIN);
  const availH = Math.max(1, vp.height - 2 * VIEW_MARGIN);
  const scale = Math.min(1, availW / Math.max(1, natural.width), availH / Math.max(1, natural.height));
  let width = Math.max(1, natural.width) * scale;
  let height = Math.max(1, natural.height) * scale;
  width = Math.max(width, Math.min(MIN_CARD, availW));
  height = Math.max(height, Math.min(MIN_CARD, availH));
  return {
    left: vp.left + (vp.width - width) / 2,
    top: vp.top + (vp.height - height) / 2,
    width,
    height,
  };
}

/**
 * The transform that maps the card at `to` onto the thumbnail at `from`:
 * a translate of the top-left corners and a scale of the sides. Applied
 * to the card as its animation's first frame, then eased to none, the
 * card grows out of the thumbnail. Degenerate rects (a hidden thumbnail)
 * give a scale of 0, which is still a valid first frame.
 */
export function zoomTransform(from: Rect, to: Rect): { x: number; y: number; sx: number; sy: number } {
  return {
    x: from.left - to.left,
    y: from.top - to.top,
    sx: to.width > 0 ? from.width / to.width : 0,
    sy: to.height > 0 ? from.height / to.height : 0,
  };
}

/** The transform as CSS, with the origin at the card's top-left. */
export function zoomCss(t: { x: number; y: number; sx: number; sy: number }): string {
  return `translate(${t.x}px, ${t.y}px) scale(${t.sx}, ${t.sy})`;
}
