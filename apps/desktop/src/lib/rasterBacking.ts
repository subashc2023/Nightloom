// Item 879 (his report of 2:54 PM, 2026-11-19): a PNG with a transparent background and black lines
// (hw5-q1-alu-boxes.png) drew its lines black on the dark card — the picture strip's slate well and the
// file tab's near-black. The SVG half of the item puts such a drawing on white paper (`svgBacking`); this is
// the same rule for raster pictures (PNG, GIF, WebP, …): look at the pixels once, and if the picture lets the
// background through and its ink is dark, it gets the `nl-paper` class (a white backing, `rasterBacking.css`).
// An opaque picture, and a transparent one drawn in light ink, are left exactly as they were.
//
// One helper for every surface: the reply's picture strip and its full-size view (the Mac and the phone share
// `ReplyMedia`), the file tab (`FileView`), a note's pictures (the note editor's image widget, `NoteMedia`).
// Item 875's inline reply pictures call `paperIfDarkInk` on their `<img>` too.
import "./rasterBacking.css";

export type RasterBacking = "paper" | "none";

/** The class a dark-ink transparent picture gets: a white backing with a little padding. */
export const PAPER_CLASS = "nl-paper";

/**
 * What a picture's RGBA pixels (4 bytes each, as `ImageData.data`) should be drawn on. Paper when at least 2%
 * of the picture is see-through (alpha < 200) and at least 5% of its ink (alpha ≥ 64) is dark (luminance
 * < 0.3); otherwise none. Ink is weighed by its alpha, so a thin line thinned by scaling still counts.
 */
export function rasterBackingOf(px: ArrayLike<number>): RasterBacking {
  const n = Math.floor(px.length / 4);
  if (n === 0) return "none";
  let clear = 0;
  let ink = 0;
  let dark = 0;
  for (let i = 0; i < n * 4; i += 4) {
    const a = px[i + 3];
    if (a < 200) clear++;
    if (a < 64) continue;
    const w = a / 255;
    ink += w;
    const lum = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
    if (lum < 0.3) dark += w;
  }
  if (clear < n * 0.02 || ink === 0) return "none";
  return dark >= ink * 0.05 ? "paper" : "none";
}

/** Largest side the picture is scaled to before its pixels are read — enough to see thin lines, cheap to scan. */
const SAMPLE = 400;

/** An SVG is judged by its markup (`svgBacking`), never here: drawing one to a canvas can taint it. */
const isSvg = (src: string) => /^data:image\/svg\+xml/i.test(src) || /\.svg(?:[?#]|$)/i.test(src);

/** The backing of a loaded `<img>`; "none" when it is not loaded, is an SVG, or its pixels cannot be read. */
export function rasterBacking(img: HTMLImageElement): RasterBacking {
  const src = img.currentSrc || img.src;
  if (!src || isSvg(src) || !img.complete || !img.naturalWidth || !img.naturalHeight) return "none";
  try {
    const k = Math.min(1, SAMPLE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * k));
    const h = Math.max(1, Math.round(img.naturalHeight * k));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return "none";
    ctx.drawImage(img, 0, 0, w, h);
    return rasterBackingOf(ctx.getImageData(0, 0, w, h).data);
  } catch {
    // A picture from another origin taints the canvas; it is shown as it is.
    return "none";
  }
}

/**
 * Svelte action (and plain function: call it, keep `destroy`): on every load of `img`, put it on paper when
 * `rasterBacking` says so, and take the paper off when a new source does not need it.
 */
export function paperIfDarkInk(img: HTMLImageElement): { destroy: () => void } {
  const judge = () => img.classList.toggle(PAPER_CLASS, rasterBacking(img) === "paper");
  img.addEventListener("load", judge);
  if (img.complete && img.naturalWidth) judge();
  return { destroy: () => img.removeEventListener("load", judge) };
}
