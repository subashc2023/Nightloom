/**
 * The page fits the part of the screen the keyboard leaves (nightshift 300
 * A15). iOS Safari does not shrink the layout when the keyboard opens: it
 * pans the page up under it, and the header and the messages left the
 * screen. The visual viewport is the part he can see; the page is sized and
 * placed to it, so the header stays at the top and only the composer rides
 * up on the keys (the Claude app's behaviour, `inferred`).
 */

export interface Fit {
  /** The page's height, CSS px. */
  height: number;
  /** How far the visible part is panned down the layout, CSS px. */
  top: number;
  /** The keyboard (or another on-screen panel) is up. */
  keyboard: boolean;
}

/** A shrink of more than this is a keyboard, not Safari's bars moving. */
export const KEYBOARD_PX = 120;

/**
 * Where the page goes. `layout` is `innerHeight` (the layout viewport);
 * `vv` the visual viewport. A pinch zoom (scale ≠ 1) is left to the browser:
 * the page keeps its full height then, or zooming would shrink it.
 */
export function fitTo(layout: number, vv: { height: number; offsetTop: number; scale: number } | null): Fit | null {
  if (!vv || Math.abs(vv.scale - 1) > 0.01 || vv.height <= 0) return null;
  return {
    height: Math.round(vv.height),
    top: Math.max(0, Math.round(vv.offsetTop)),
    keyboard: layout - vv.height > KEYBOARD_PX,
  };
}

/** Keep `--vvh` / `--vvtop` and `data-kb` on <html> in step with the
 *  visual viewport; `onchange` hears each change (the page keeps the
 *  transcript's end in view). Returns the cleanup. */
export function trackViewport(onchange: (fit: Fit | null, was: Fit | null) => void = () => {}): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const root = document.documentElement;
  let last: Fit | null = null;
  const apply = () => {
    const fit = fitTo(window.innerHeight, vv);
    if (fit) {
      root.style.setProperty("--vvh", `${fit.height}px`);
      root.style.setProperty("--vvtop", `${fit.top}px`);
      if (fit.keyboard) root.dataset.kb = "";
      else delete root.dataset.kb;
    } else {
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--vvtop");
      delete root.dataset.kb;
    }
    const was = last;
    last = fit;
    if (!was || !fit || was.height !== fit.height || was.top !== fit.top) onchange(fit, was);
  };
  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  return () => {
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
  };
}
