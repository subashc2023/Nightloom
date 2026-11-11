// Item 621 (his words: "whichever dots it's nearest to, kind of like spread
// out away, you know, as my cursor moves around the screen"): the chat's dot
// ground as a field the pointer pushes. One canvas behind the transcript
// draws the same grid the CSS `--ground-dots` tile draws (one dot per 24 px,
// anchored to the scroller's foot); the dots within PUSH_RADIUS of the
// pointer ease away from it on a spring and settle back when it leaves.
//
// Cheap by construction: no per-dot DOM; the whole grid is drawn once, then
// each frame clears and redraws only the box around the dots that moved;
// the loop stops as soon as every dot is at rest, so a still pointer — or a
// reply streaming with the pointer elsewhere — costs nothing. Off (the CSS
// tile stays, static) under Reduce motion, and wherever the token is
// `none` (Calm, the classic palettes).
import { reducedMotion } from "./sendMotion";

/** The CSS tile's size (`background-size: 24px 24px` on `.transcript`). */
export const DOT_STEP = 24;
/** Between the gradient's 1 px solid core and its 1.2 px edge. */
export const DOT_R = 1.1;
/** How far from the pointer a dot feels it (CSS px). */
export const PUSH_RADIUS = 110;
/** The most a dot moves (CSS px): under half the grid step, so rows never cross. */
export const PUSH_MAX = 9;
/** The spring: stiffness (1/s²) and damping (1/s); a little under critical, so a dot overshoots a hair and settles. */
export const SPRING_K = 170;
export const SPRING_C = 2 * Math.sqrt(SPRING_K) * 0.78;
/** Below this (px and px/s) a dot is at its target. */
export const REST_EPS = 0.04;

/** The centre of dot (i, j) — column i from the left, row j from the foot — in a box `h` tall, the tile anchored at its foot. */
export function dotCentre(i: number, j: number, h: number, step: number = DOT_STEP): { x: number; y: number } {
  return { x: step / 2 + step * i, y: h - step / 2 - step * j };
}

/**
 * The step WebKit actually draws the tile at: a whole number of device
 * pixels (measured at 110 %, device pixel ratio 2.2: the CSS tile repeats
 * every 53 device px, not 52.8), so the canvas's columns meet the
 * composer strip's CSS dots exactly. At 100 % and 200 % it is 24.
 */
export function deviceStep(dpr: number): number {
  return Math.round(DOT_STEP * dpr) / dpr;
}

/** The index ranges of the dots whose centres fall in [x0, x1] × [y0, y1], clamped to a w × h box. */
export function dotsIn(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
  h: number,
  step: number = DOT_STEP,
): { i0: number; i1: number; j0: number; j1: number } {
  const half = step / 2;
  const iMax = Math.floor((w - half) / step);
  const jMax = Math.floor((h - half) / step);
  const i0 = Math.max(0, Math.ceil((x0 - half) / step));
  const i1 = Math.min(iMax, Math.floor((x1 - half) / step));
  // y grows downward; row j sits at h - half - step·j.
  const j0 = Math.max(0, Math.ceil((h - half - y1) / step));
  const j1 = Math.min(jMax, Math.floor((h - half - y0) / step));
  return { i0, i1, j0, j1 };
}

/**
 * Where a dot at rest `(dx, dy)` from the pointer wants to be, as an offset:
 * straight away from the pointer, PUSH_MAX at the centre falling to 0 at
 * PUSH_RADIUS with zero slope there (so the field has no visible edge).
 */
export function pushOffset(dx: number, dy: number): { x: number; y: number } {
  const d = Math.hypot(dx, dy);
  if (d >= PUSH_RADIUS || d < 0.01) return { x: 0, y: 0 };
  const f = 1 - d / PUSH_RADIUS;
  const m = PUSH_MAX * f * f;
  return { x: (dx / d) * m, y: (dy / d) * m };
}

export interface Dot {
  i: number;
  j: number;
  /** Offset from rest (px) and its velocity (px/s). */
  px: number;
  py: number;
  vx: number;
  vy: number;
}

/** One spring step toward `(tx, ty)` (semi-implicit Euler); true when the dot has arrived and stopped. */
export function stepDot(d: Dot, tx: number, ty: number, dt: number): boolean {
  d.vx += (SPRING_K * (tx - d.px) - SPRING_C * d.vx) * dt;
  d.vy += (SPRING_K * (ty - d.py) - SPRING_C * d.vy) * dt;
  d.px += d.vx * dt;
  d.py += d.vy * dt;
  if (Math.abs(tx - d.px) < REST_EPS && Math.abs(ty - d.py) < REST_EPS && Math.abs(d.vx) < REST_EPS * 10 && Math.abs(d.vy) < REST_EPS * 10) {
    d.px = tx;
    d.py = ty;
    d.vx = 0;
    d.vy = 0;
    return true;
  }
  return false;
}

/** Whether the field runs: the lit dot ground is on (`--ground-dots` not `none`) and motion is allowed. */
export function fieldWanted(groundToken: string, reduce: boolean, forcedOff: boolean): boolean {
  const g = groundToken.trim();
  return !forcedOff && !reduce && g !== "" && g !== "none";
}

/** Frame timings the harness reads (item 621's measurement); kept small. */
export interface FieldStats {
  frames: number;
  totalMs: number;
  maxMs: number;
}

type Win = Window & { __dotFieldOff?: boolean; __dotFieldStats?: FieldStats };

/**
 * Wire the field: `canvas` sits just before `viewport` in the same
 * positioned parent (so the scroller, positioned after it, paints over it).
 * While it runs, `viewport` carries `dotfield`, whose CSS drops the tile.
 */
export function dotField(canvas: HTMLCanvasElement, viewport: HTMLElement): { destroy(): void } {
  const w = window as Win;
  const ctx = canvas.getContext("2d");
  if (!ctx) return { destroy() {} };
  let on = false;
  let cw = 0;
  let ch = 0;
  let dpr = 1;
  let step = DOT_STEP;
  let left = 0;
  let top = 0;
  let colour = "rgba(233, 237, 242, 0.055)";
  let pointer: { x: number; y: number } | null = null;
  let raw: { x: number; y: number } | null = null;
  const active = new Map<number, Dot>();
  let raf = 0;
  let last = 0;
  const key = (i: number, j: number) => i * 65536 + j;

  function readColour() {
    canvas.style.color = "var(--ground-dot-ink)";
    const c = getComputedStyle(canvas).color;
    if (c) colour = c;
  }

  function place() {
    // The canvas covers the scroller's padding box (the box its tile fills; no scrollbar).
    left = viewport.offsetLeft + viewport.clientLeft;
    top = viewport.offsetTop + viewport.clientTop;
    const nw = viewport.clientWidth;
    const nh = viewport.clientHeight;
    const nd = window.devicePixelRatio || 1;
    canvas.style.left = `${left}px`;
    canvas.style.top = `${top}px`;
    if (nw === cw && nh === ch && nd === dpr) return false;
    cw = nw;
    ch = nh;
    dpr = nd;
    step = deviceStep(dpr);
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    canvas.width = Math.max(1, Math.round(cw * dpr));
    canvas.height = Math.max(1, Math.round(ch * dpr));
    return true;
  }

  function drawDots(i0: number, i1: number, j0: number, j1: number) {
    ctx!.beginPath();
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const c = dotCentre(i, j, ch, step);
        const d = active.get(key(i, j));
        const x = c.x + (d ? d.px : 0);
        const y = c.y + (d ? d.py : 0);
        ctx!.moveTo(x + DOT_R, y);
        ctx!.arc(x, y, DOT_R, 0, Math.PI * 2);
      }
    }
    ctx!.fill();
  }

  function full() {
    if (!on) return;
    const sx = canvas.width / Math.max(1, cw);
    const sy = canvas.height / Math.max(1, ch);
    ctx!.setTransform(1, 0, 0, 1, 0, 0);
    ctx!.clearRect(0, 0, canvas.width, canvas.height);
    ctx!.setTransform(sx, 0, 0, sy, 0, 0);
    ctx!.fillStyle = colour;
    const r = dotsIn(0, 0, cw, ch, cw, ch, step);
    drawDots(r.i0, r.i1, r.j0, r.j1);
  }

  /** Clear and redraw only [x0,x1]×[y0,y1] (CSS px), snapped out to whole device pixels. */
  function region(x0: number, y0: number, x1: number, y1: number) {
    const sx = canvas.width / Math.max(1, cw);
    const sy = canvas.height / Math.max(1, ch);
    const dx0 = Math.max(0, Math.floor(x0 * sx));
    const dy0 = Math.max(0, Math.floor(y0 * sy));
    const dx1 = Math.min(canvas.width, Math.ceil(x1 * sx));
    const dy1 = Math.min(canvas.height, Math.ceil(y1 * sy));
    if (dx1 <= dx0 || dy1 <= dy0) return;
    ctx!.save();
    ctx!.setTransform(1, 0, 0, 1, 0, 0);
    ctx!.beginPath();
    ctx!.rect(dx0, dy0, dx1 - dx0, dy1 - dy0);
    ctx!.clip();
    ctx!.clearRect(dx0, dy0, dx1 - dx0, dy1 - dy0);
    ctx!.setTransform(sx, 0, 0, sy, 0, 0);
    ctx!.fillStyle = colour;
    // A displaced dot can reach PUSH_MAX into the box from outside it.
    const m = PUSH_MAX + DOT_R + 1;
    const r = dotsIn(dx0 / sx - m, dy0 / sy - m, dx1 / sx + m, dy1 / sy + m, cw, ch, step);
    drawDots(r.i0, r.i1, r.j0, r.j1);
    ctx!.restore();
  }

  function frame(t: number) {
    raf = 0;
    if (!on) return;
    const t0 = performance.now();
    const dt = last ? Math.min(Math.max((t - last) / 1000, 0), 1 / 30) : 1 / 60;
    last = t;
    pointer = raw ? { x: raw.x - left, y: raw.y - top } : null;
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    const grow = (x: number, y: number) => {
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    };
    if (pointer) {
      const r = dotsIn(pointer.x - PUSH_RADIUS, pointer.y - PUSH_RADIUS, pointer.x + PUSH_RADIUS, pointer.y + PUSH_RADIUS, cw, ch, step);
      for (let i = r.i0; i <= r.i1; i++)
        for (let j = r.j0; j <= r.j1; j++) {
          const k = key(i, j);
          if (!active.has(k)) active.set(k, { i, j, px: 0, py: 0, vx: 0, vy: 0 });
        }
    }
    let moving = false;
    for (const [k, d] of active) {
      const c = dotCentre(d.i, d.j, ch, step);
      grow(c.x + d.px, c.y + d.py);
      const off = pointer ? pushOffset(c.x - pointer.x, c.y - pointer.y) : { x: 0, y: 0 };
      const was = d.px === off.x && d.py === off.y && d.vx === 0 && d.vy === 0;
      const done = was || stepDot(d, off.x, off.y, dt);
      grow(c.x + d.px, c.y + d.py);
      if (done && off.x === 0 && off.y === 0) active.delete(k);
      else if (!done) moving = true;
    }
    if (bx1 >= bx0) {
      const m = DOT_R + 1;
      region(bx0 - m, by0 - m, bx1 + m, by1 + m);
    }
    const s = w.__dotFieldStats;
    if (s) {
      const ms = performance.now() - t0;
      s.frames++;
      s.totalMs += ms;
      if (ms > s.maxMs) s.maxMs = ms;
    }
    if (moving) schedule();
    else last = 0;
  }

  function schedule() {
    if (!raf && on) raf = requestAnimationFrame(frame);
  }

  function decide() {
    const ground = getComputedStyle(document.documentElement).getPropertyValue("--ground-dots");
    const want = fieldWanted(ground, reducedMotion(), !!w.__dotFieldOff);
    if (want === on) {
      if (on) {
        readColour();
        place();
        full();
      }
      return;
    }
    on = want;
    if (on) {
      canvas.style.display = "block";
      viewport.classList.add("dotfield");
      readColour();
      place();
      full();
    } else {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
      active.clear();
      viewport.classList.remove("dotfield");
      canvas.style.display = "none";
    }
  }

  const onMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    raw = { x: e.clientX - viewportBox().x, y: e.clientY - viewportBox().y };
    schedule();
  };
  const onLeave = () => {
    raw = null;
    schedule();
  };
  // The pointer arrives in the viewport's client box; the canvas is placed in
  // the parent's. Cached: read again on enter and on resize, never per move.
  let vb = { x: 0, y: 0 };
  let vbFresh = false;
  const viewportBox = () => {
    if (!vbFresh) {
      const r = (viewport.offsetParent as HTMLElement | null)?.getBoundingClientRect();
      vb = { x: r ? r.left : 0, y: r ? r.top : 0 };
      vbFresh = true;
    }
    return vb;
  };
  const onEnter = () => {
    vbFresh = false;
    if (on && place()) full();
  };

  const ro = new ResizeObserver(() => {
    vbFresh = false;
    if (!on) return;
    place();
    full();
  });
  ro.observe(viewport);
  const mo = new MutationObserver(() => decide());
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-light", "data-palette", "data-layout", "data-accent", "style", "class"] });
  let mq: MediaQueryList | null = null;
  try {
    mq = matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", decide);
  } catch {
    mq = null;
  }
  viewport.addEventListener("pointermove", onMove, { passive: true });
  viewport.addEventListener("pointerenter", onEnter, { passive: true });
  viewport.addEventListener("pointerleave", onLeave, { passive: true });
  decide();

  return {
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      mq?.removeEventListener("change", decide);
      viewport.removeEventListener("pointermove", onMove);
      viewport.removeEventListener("pointerenter", onEnter);
      viewport.removeEventListener("pointerleave", onLeave);
      viewport.classList.remove("dotfield");
    },
  };
}
