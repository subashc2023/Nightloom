// The full-size picture viewer's zoom (item 885): a click ON the picture
// zooms in on the spot clicked (a second click goes back to fit); a click
// outside it, Esc or Close leaves; a two-finger pinch zooms in and out
// around the fingers; a drag or a two-finger scroll pans while zoomed.
// This module is the pure part — the transform maths and the click/key
// verdicts — which the suite pins; `zoomable` (pictureZoomAction.ts) wires it
// to the DOM, and every over-the-window viewer uses that one action.
//
// Coordinates: the stage is the box the picture is centred in; `fit` is the
// picture's laid-out rect in the stage's coordinates (its size at fit, before
// any transform). The picture is drawn with `translate(x, y) scale(s)` about
// its own top-left corner, so at fit the state is { s: 1, x: 0, y: 0 }.

export interface Zoom {
  s: number;
  x: number;
  y: number;
}
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Pt {
  x: number;
  y: number;
}

export const FIT: Zoom = { s: 1, x: 0, y: 0 };
/** How far a click zooms in (times the fit size). */
export const CLICK_SCALE = 2.5;
/** The furthest a pinch goes (times the fit size). */
export const MAX_SCALE = 8;
/** Pointer travel (px) past which a press is a drag, and its click is not a click. */
export const DRAG_SLOP = 4;

export const isZoomed = (z: Zoom): boolean => z.s > 1.001;

/**
 * Keep the picture usable: the scale within [1, MAX_SCALE]; at fit, exactly
 * fit; on each axis, a picture narrower than the stage is centred in it, and
 * one wider never leaves a gap at either edge.
 */
export function clamp(z: Zoom, fit: Box, stage: { width: number; height: number }): Zoom {
  const s = Math.min(MAX_SCALE, Math.max(1, Number.isFinite(z.s) ? z.s : 1));
  if (s <= 1.001) return { ...FIT };
  const axis = (off: number, fitStart: number, fitLen: number, stageLen: number): number => {
    const len = fitLen * s;
    if (len <= stageLen) return (stageLen - len) / 2 - fitStart;
    // Displayed start = fitStart + off, within [stageLen - len, 0].
    return Math.min(-fitStart, Math.max(stageLen - len - fitStart, off));
  };
  return { s, x: axis(z.x, fit.left, fit.width, stage.width), y: axis(z.y, fit.top, fit.height, stage.height) };
}

/** Scale to `s2` keeping the picture point under `p` (stage coordinates) where it is — a pinch, a ctrl-wheel. */
export function zoomAt(z: Zoom, p: Pt, fit: Box, s2: number): Zoom {
  const qx = p.x - fit.left;
  const qy = p.y - fit.top;
  return { s: s2, x: qx - ((qx - z.x) * s2) / z.s, y: qy - ((qy - z.y) * s2) / z.s };
}

/**
 * A two-finger pinch measured from where it started: the picture point that
 * was under the fingers' midpoint `from` at `start` follows the midpoint to
 * `to`, at `start.s × ratio` — so it zooms and pans at once, as on a phone.
 */
export function pinch(start: Zoom, from: Pt, to: Pt, ratio: number, fit: Box): Zoom {
  const s2 = start.s * ratio;
  const ux = (from.x - fit.left - start.x) / start.s;
  const uy = (from.y - fit.top - start.y) / start.s;
  return { s: s2, x: to.x - fit.left - s2 * ux, y: to.y - fit.top - s2 * uy };
}

/**
 * A click on the picture: at fit, zoom to CLICK_SCALE with the clicked spot
 * brought to the stage's centre (clamped, so a corner click shows that
 * corner at the edge); zoomed, back to fit (a toggle, as Preview and Quick Look do).
 */
export function clickZoom(z: Zoom, p: Pt, fit: Box, stage: { width: number; height: number }): Zoom {
  if (isZoomed(z)) return { ...FIT };
  const s2 = CLICK_SCALE;
  const ux = (p.x - fit.left - z.x) / z.s;
  const uy = (p.y - fit.top - z.y) / z.s;
  return clamp({ s: s2, x: stage.width / 2 - fit.left - s2 * ux, y: stage.height / 2 - fit.top - s2 * uy }, fit, stage);
}

/** The ctrl-wheel (a trackpad pinch in Chrome and WebKit) as a scale factor. */
export const wheelFactor = (deltaY: number): number => Math.exp(-deltaY / 100);

/** The CSS transform for a state. */
export const zoomCss = (z: Zoom): string => (isZoomed(z) ? `translate(${z.x}px, ${z.y}px) scale(${z.s})` : "");

/** What a click in the viewer does: on the picture it zooms, outside it closes; the click that ends a drag or a pinch does nothing. */
export function clickVerdict(p: Pt, picture: Box, dragged: boolean): "zoom" | "close" | "ignore" {
  if (dragged) return "ignore";
  const inside = p.x >= picture.left && p.x <= picture.left + picture.width && p.y >= picture.top && p.y <= picture.top + picture.height;
  return inside ? "zoom" : "close";
}

/** Esc closes the viewer; nothing else on the keyboard does. */
export const keyCloses = (key: string): boolean => key === "Escape";
