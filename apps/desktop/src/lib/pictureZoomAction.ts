// Item 885: the zoom of a full-size picture, as a Svelte action on the stage
// the picture is centred in (its one <img> child). The maths and the
// verdicts are pictureZoom.ts; this file is only the DOM wiring:
//  - click on the picture → zoom in on that spot / back to fit;
//    click on the stage outside it → `onoutside` (the viewer closes);
//    the click that ends a drag or a pinch → nothing;
//  - two-finger pinch: ctrl-wheel (Chrome, WebKit on a trackpad), WebKit's
//    gesture* events, and two touch pointers (the phone) — around the fingers;
//  - zoomed: a drag or a plain two-finger scroll pans;
//  - a resize keeps the zoom, clamped to the new size; a new mount is fit,
//    or a tab's kept zoom (`initial`/`onchange`, item 495's kept state).
import { FIT, DRAG_SLOP, MAX_SCALE, clamp, clickVerdict, clickZoom, isZoomed, loadZoom, pinch, saveZoom, wheelFactor, zoomAt, zoomCss, type Box, type Pt, type Zoom } from "./pictureZoom";

export interface ZoomableOptions {
  /** A click on the stage outside the picture. Absent: such a click does nothing. */
  onoutside?: () => void;
  /** A tab's kept zoom (`saveZoom`'s string; "" = fit), applied once the picture has its size. */
  initial?: string;
  /** Each change of zoom or pan, as `saveZoom`'s string — for a tab to keep (item 495). */
  onchange?: (saved: string) => void;
}

export function zoomable(stage: HTMLElement, opts: ZoomableOptions = {}) {
  let options = opts;
  let z: Zoom = { ...FIT };
  const img = (): HTMLImageElement | null => stage.querySelector("img");
  if (getComputedStyle(stage).position === "static") stage.style.position = "relative";
  stage.style.touchAction = "none";

  const reduced = (): boolean => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const fitBox = (el: HTMLElement): Box => ({ left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
  const stageSize = () => ({ width: stage.clientWidth, height: stage.clientHeight });
  const local = (clientX: number, clientY: number): Pt => {
    const r = stage.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  function paint(glide: boolean): void {
    const el = img();
    if (!el) return;
    el.style.transformOrigin = "0 0";
    el.style.transition = glide && !reduced() ? "transform 160ms cubic-bezier(0.2, 0, 0, 1)" : "none";
    el.style.transform = zoomCss(z);
    el.style.cursor = drag?.moved ? "grabbing" : isZoomed(z) ? "zoom-out" : "zoom-in";
    stage.dataset.zoom = isZoomed(z) ? z.s.toFixed(2) : "fit";
  }
  function set(next: Zoom, glide = false): void {
    const el = img();
    if (!el) return;
    const fit = fitBox(el);
    z = clamp(next, fit, stageSize());
    paint(glide);
    const saved = saveZoom(z, fit);
    if (saved !== lastSaved) {
      lastSaved = saved;
      options.onchange?.(saved);
    }
  }
  /** The last state handed to `onchange` (or applied from `initial`). */
  let lastSaved = "";
  /** Apply a kept zoom once the picture is laid out (now, or at its load). */
  function restore(saved: string | undefined): void {
    const el = img();
    if (saved === undefined || !el) return;
    if (!el.complete || el.offsetWidth === 0) return; // the load listener does it
    lastSaved = saved;
    z = clamp(loadZoom(saved, fitBox(el)), fitBox(el), stageSize());
    paint(false);
  }
  function loaded(): void {
    // A tab's kept zoom; with none (the over-the-window viewer), a zoom already taken is re-fitted.
    if (options.initial !== undefined) restore(options.initial);
    else if (isZoomed(z)) set(z);
  }

  // Pointers: one = a press that may become a drag (pan); two touches = a pinch.
  const touches = new Map<number, Pt>();
  let drag: { id: number; start: Pt; at: Zoom; moved: boolean } | null = null;
  let pinchFrom: { start: Zoom; mid: Pt; dist: number } | null = null;
  /** Set by a drag or a pinch; the click that follows it is swallowed. */
  let swallowClick = false;

  const mid = (): { mid: Pt; dist: number } => {
    const [a, b] = [...touches.values()];
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };

  function down(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const p = local(e.clientX, e.clientY);
    swallowClick = false;
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, p);
      if (touches.size === 2) {
        const m = mid();
        pinchFrom = { start: z, mid: m.mid, dist: m.dist };
        drag = null;
        swallowClick = true;
        return;
      }
    }
    if (touches.size <= 1) drag = { id: e.pointerId, start: p, at: z, moved: false };
  }
  function move(e: PointerEvent): void {
    const p = local(e.clientX, e.clientY);
    if (touches.has(e.pointerId)) touches.set(e.pointerId, p);
    const el = img();
    if (!el) return;
    if (pinchFrom && touches.size >= 2) {
      const m = mid();
      set(pinch(pinchFrom.start, pinchFrom.mid, m.mid, m.dist / pinchFrom.dist, fitBox(el)));
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
    if (!drag.moved) {
      drag.moved = true;
      swallowClick = true;
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        /* a synthetic pointer */
      }
    }
    if (isZoomed(drag.at)) set({ ...drag.at, x: drag.at.x + dx, y: drag.at.y + dy });
  }
  function up(e: PointerEvent): void {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinchFrom = null;
    if (drag?.id === e.pointerId) {
      drag = null;
      paint(false);
    }
  }

  function click(e: MouseEvent): void {
    // The viewer's own handler (close on the backdrop) never sees a click on the stage.
    e.stopPropagation();
    const el = img();
    const dragged = swallowClick;
    swallowClick = false;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const verdict = clickVerdict({ x: e.clientX, y: e.clientY }, { left: r.left, top: r.top, width: r.width, height: r.height }, dragged);
    if (verdict === "zoom") set(clickZoom(z, local(e.clientX, e.clientY), fitBox(el), stageSize()), true);
    else if (verdict === "close") options.onoutside?.();
  }

  // WebKit's trackpad/touch pinch: gesturestart/change carry `scale` from the gesture's start.
  let gesture: { start: Zoom } | null = null;
  type GestureLike = Event & { scale?: number; clientX?: number; clientY?: number };
  function gstart(e: Event): void {
    e.preventDefault();
    if (touches.size >= 2) return; // the pointers already pinch (iOS sends both)
    gesture = { start: z };
  }
  function gchange(e: Event): void {
    e.preventDefault();
    const g = e as GestureLike;
    const el = img();
    if (!gesture || !el || touches.size >= 2 || typeof g.scale !== "number") return;
    const r = stage.getBoundingClientRect();
    const p = typeof g.clientX === "number" ? local(g.clientX, g.clientY ?? 0) : { x: r.width / 2, y: r.height / 2 };
    const s2 = Math.min(MAX_SCALE, Math.max(1, gesture.start.s * g.scale));
    // Measured from the gesture's start so rounding never drifts.
    set(zoomAt(gesture.start, p, fitBox(el), s2));
  }
  function gend(e: Event): void {
    e.preventDefault();
    gesture = null;
  }

  function wheel(e: WheelEvent): void {
    e.preventDefault();
    const el = img();
    if (!el || gesture) return;
    if (e.ctrlKey) {
      const s2 = Math.min(MAX_SCALE, Math.max(1, z.s * wheelFactor(e.deltaY)));
      set(zoomAt(z, local(e.clientX, e.clientY), fitBox(el), s2));
    } else if (isZoomed(z)) {
      set({ ...z, x: z.x - e.deltaX, y: z.y - e.deltaY });
    }
  }

  function resize(): void {
    if (isZoomed(z)) set(z);
  }
  function dragstart(e: Event): void {
    e.preventDefault(); // no ghost image when a drag starts on the picture
  }

  stage.addEventListener("pointerdown", down);
  stage.addEventListener("pointermove", move);
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
  stage.addEventListener("click", click);
  stage.addEventListener("wheel", wheel, { passive: false });
  stage.addEventListener("gesturestart", gstart);
  stage.addEventListener("gesturechange", gchange);
  stage.addEventListener("gestureend", gend);
  stage.addEventListener("dragstart", dragstart);
  stage.addEventListener("load", loaded, true); // the <img>'s load (does not bubble; caught on the way down)
  window.addEventListener("resize", resize);
  paint(false);
  restore(options.initial);

  return {
    update(next: ZoomableOptions = {}) {
      options = next;
      // Another tab's kept zoom (the same view drawing a different file).
      if (next.initial !== undefined && next.initial !== lastSaved) restore(next.initial);
    },
    destroy() {
      stage.removeEventListener("pointerdown", down);
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", up);
      stage.removeEventListener("pointercancel", up);
      stage.removeEventListener("click", click);
      stage.removeEventListener("wheel", wheel);
      stage.removeEventListener("gesturestart", gstart);
      stage.removeEventListener("gesturechange", gchange);
      stage.removeEventListener("gestureend", gend);
      stage.removeEventListener("dragstart", dragstart);
      stage.removeEventListener("load", loaded, true);
      window.removeEventListener("resize", resize);
    },
  };
}
