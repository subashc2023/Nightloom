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
//
// Item 655 (his pick, blocker 1974: "More like scatter, except it's a little
// too random. that but slightly less random"): round 2's Scatter with Wake's
// brighter dots. Every dot has its own seeded weight (how far it flies), its
// own off-angle and its own return speed; it is shoved out fast and drifts
// home slowly. How random that is, is one number: SCATTER.
import { reducedMotion } from "./sendMotion";

/** The CSS tile's size (`background-size: 24px 24px` on `.transcript`). */
export const DOT_STEP = 24;
/** Between the gradient's 1.35 px solid core and its 1.55 px edge (app.css `--ground-dots`; was 1.1 for 1 / 1.2 px). */
export const DOT_R = 1.45;
/** How far from the pointer a dot feels it (CSS px). 655: 160 → 300 (Scatter's reach). */
export const PUSH_RADIUS = 300;
/** A weight-1 dot's push at the pointer (CSS px). 655: 11 → 40; rows now cross near the pointer, which is the scatter he picked. */
export const PUSH_MAX = 40;
/** No dot ever moves farther than this (CSS px), whatever its weight. */
export const PUSH_CLAMP = 58;
/**
 * How random each dot is, as a share of round 2's Scatter (1 = round 2:
 * off-angle ±32°, weight 0.45–1.45, return speed 0.35–2.55 × the base).
 * 0.6 (his "slightly less random"): ±19°, 0.65–1.25, 0.55–1.87. Each spread
 * narrows about its median, so the typical push and return stay as they were.
 */
export const SCATTER = 0.6;
/** Round 2's spreads, before SCATTER: the weight's and return speed's medians and full ranges, the off-angle's half-range (radians). */
export const WEIGHT_MID = 0.95;
export const WEIGHT_LO = 0.45;
export const WEIGHT_HI = 1.45;
export const ANGLE_HALF = 0.55;
export const RETURN_MID = 0.862;
export const RETURN_LO = 0.35;
export const RETURN_HI = 2.55;
/** The out spring: stiffness (1/s²) and damping (1/s), just under critical — a dot is shoved aside in a few frames. */
export const SPRING_K = 240;
export const SPRING_C = 2 * Math.sqrt(SPRING_K) * 0.95;
/** The home spring, before each dot's own return speed: soft and critically damped, so dots drift back over seconds. */
export const HOME_K = 5;
export const HOME_ZETA = 1.0;
/** Below this (px and px/s) a dot is at its target. */
export const REST_EPS = 0.04;
/** Displaced dots brighten and tint toward the signal colour (Wake's look): full lift at this share of PUSH_MAX. */
export const GLOW_ALPHA = 0.14;
export const GLOW_TINT = 0.15;
export const GLOW_AT = 0.7;
export const GLOW_LEVELS = 8;

/** A dot's three seeded numbers: weight (× the push), off-angle (radians), return speed (× HOME_K). */
export interface Scatter {
  weight: number;
  angle: number;
  ret: number;
}

/** Three uniforms in [0, 1) from dot (i, j): an integer hash, the same every run and every window size. */
export function dotRandoms(i: number, j: number): [number, number, number] {
  let h = (Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ 0x9e3779b9) >>> 0;
  const next = () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return [next(), next(), next()];
}

/**
 * Dot (i, j)'s weight, off-angle and return speed: round 2's draws (weight
 * uniform, angle uniform, return speed skewed slow-heavy as round 2 drew it),
 * each pulled toward its median by `amount` (SCATTER).
 */
export function scatterOf(i: number, j: number, amount: number = SCATTER): Scatter {
  const [a, b, c] = dotRandoms(i, j);
  const [d, e] = dotRandoms(i + 7919, j - 104729);
  const w = WEIGHT_LO + (WEIGHT_HI - WEIGHT_LO) * a;
  const ang = (b * 2 - 1) * ANGLE_HALF;
  const r = RETURN_LO + 1.9 * c * d + 0.3 * e;
  return {
    weight: WEIGHT_MID + amount * (w - WEIGHT_MID),
    angle: amount * ang,
    ret: RETURN_MID + amount * (r - RETURN_MID),
  };
}

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
 * With a dot's `s` (655), the push is scaled by its weight and turned by its
 * off-angle, and never longer than PUSH_CLAMP.
 */
export function pushOffset(dx: number, dy: number, s?: Scatter): { x: number; y: number } {
  const d = Math.hypot(dx, dy);
  if (d >= PUSH_RADIUS || d < 0.01) return { x: 0, y: 0 };
  // His report 2026-11-11 ("the dots also barely move"): (1 − u²)² keeps
  // the zero-slope edge but holds more push across the radius (half-way:
  // 0.56 of the peak, was 0.25).
  const u = d / PUSH_RADIUS;
  const f = 1 - u * u;
  const m = Math.min(PUSH_CLAMP, PUSH_MAX * f * f * (s ? s.weight : 1));
  if (!s || s.angle === 0) return { x: (dx / d) * m, y: (dy / d) * m };
  const a = Math.atan2(dy, dx) + s.angle;
  return { x: Math.cos(a) * m, y: Math.sin(a) * m };
}

/** A dot's home spring: HOME_K × its return speed, critically damped. */
export function homeSpring(s: Scatter): { k: number; c: number } {
  const k = HOME_K * s.ret;
  return { k, c: 2 * Math.sqrt(k) * HOME_ZETA };
}

/** How lit a displaced dot is: level 0 (the tile's own colour) to GLOW_LEVELS − 1. */
export function glowLevel(px: number, py: number): number {
  const m = Math.min(1, Math.hypot(px, py) / (PUSH_MAX * GLOW_AT));
  return Math.round(m * (GLOW_LEVELS - 1));
}

/** `rgb(…)`, `rgba(…)` or `color(srgb …)` (what WebKit computes for a color-mix) as 0–255 channels and 0–1 alpha; null if neither. */
export function parseColour(css: string): [number, number, number, number] | null {
  const s = css.trim();
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) return [+m[1], +m[2], +m[3], alphaOf(m[4])];
  m = /^color\(srgb\s+([\d.e+-]+)\s+([\d.e+-]+)\s+([\d.e+-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255, alphaOf(m[4])];
  return null;
}
function alphaOf(a: string | undefined): number {
  if (a === undefined) return 1;
  return a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a);
}

/** The fill for each glow level: level 0 is `base` exactly; level L lifts alpha by GLOW_ALPHA and tints toward `signal` by GLOW_TINT, in proportion. */
export function glowFills(base: string, signal: string): string[] {
  const b = parseColour(base);
  const g = parseColour(signal);
  const out = [base];
  for (let L = 1; L < GLOW_LEVELS; L++) {
    if (!b || !g) {
      out.push(base);
      continue;
    }
    const m = L / (GLOW_LEVELS - 1);
    const c = [0, 1, 2].map((k) => Math.round(b[k] + (g[k] - b[k]) * GLOW_TINT * m));
    out.push(`rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.min(1, b[3] + GLOW_ALPHA * m).toFixed(3)})`);
  }
  return out;
}

export interface Dot {
  i: number;
  j: number;
  /** Offset from rest (px) and its velocity (px/s). */
  px: number;
  py: number;
  vx: number;
  vy: number;
  /** Its seeded weight, off-angle and return speed (655). */
  s?: Scatter;
}

/** One spring step toward `(tx, ty)` (semi-implicit Euler) on spring `k`, `c` (the out spring unless given); true when the dot has arrived and stopped. */
export function stepDot(d: Dot, tx: number, ty: number, dt: number, k: number = SPRING_K, c: number = SPRING_C): boolean {
  d.vx += (k * (tx - d.px) - c * d.vx) * dt;
  d.vy += (k * (ty - d.py) - c * d.vy) * dt;
  d.px += d.vx * dt;
  d.py += d.vy * dt;
  const m2 = d.px * d.px + d.py * d.py;
  if (m2 > PUSH_CLAMP * PUSH_CLAMP) {
    const q = PUSH_CLAMP / Math.sqrt(m2);
    d.px *= q;
    d.py *= q;
    d.vx *= 0.5;
    d.vy *= 0.5;
  }
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
 * One frame for one dot (655): toward its scattered push on the out spring
 * while the push is growing, home (or to a smaller push) on its own slow
 * home spring otherwise. `push` is the dot's rest centre minus the pointer,
 * or null with no pointer. True when it has arrived and stopped.
 */
export function advanceDot(d: Dot, push: { x: number; y: number } | null, dt: number): boolean {
  const s = d.s ?? (d.s = scatterOf(d.i, d.j));
  const t = push ? pushOffset(push.x, push.y, s) : { x: 0, y: 0 };
  if (d.px === t.x && d.py === t.y && d.vx === 0 && d.vy === 0) return true;
  const out = t.x * t.x + t.y * t.y > d.px * d.px + d.py * d.py - 0.01;
  if (out) return stepDot(d, t.x, t.y, dt);
  const h = homeSpring(s);
  return stepDot(d, t.x, t.y, dt, h.k, h.c);
}

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
  let colour = "rgba(233, 237, 242, 0.16)";
  let fills: string[] = [colour];
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
    canvas.style.color = "var(--signal)";
    fills = glowFills(colour, getComputedStyle(canvas).color || "rgb(134, 216, 247)");
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

  // Lit dots by level (655): level 0 goes in the one path in the tile's own
  // colour; displaced dots are batched per level and filled after it.
  const lit: number[][] = Array.from({ length: GLOW_LEVELS }, () => []);
  function drawDots(i0: number, i1: number, j0: number, j1: number) {
    for (const l of lit) l.length = 0;
    ctx!.fillStyle = colour;
    ctx!.beginPath();
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const c = dotCentre(i, j, ch, step);
        const d = active.get(key(i, j));
        const x = c.x + (d ? d.px : 0);
        const y = c.y + (d ? d.py : 0);
        const L = d ? glowLevel(d.px, d.py) : 0;
        if (L > 0) {
          lit[L].push(x, y);
          continue;
        }
        ctx!.moveTo(x + DOT_R, y);
        ctx!.arc(x, y, DOT_R, 0, Math.PI * 2);
      }
    }
    ctx!.fill();
    for (let L = 1; L < GLOW_LEVELS; L++) {
      const pts = lit[L];
      if (!pts.length) continue;
      ctx!.fillStyle = fills[L] ?? colour;
      ctx!.beginPath();
      for (let n = 0; n < pts.length; n += 2) {
        ctx!.moveTo(pts[n] + DOT_R, pts[n + 1]);
        ctx!.arc(pts[n], pts[n + 1], DOT_R, 0, Math.PI * 2);
      }
      ctx!.fill();
    }
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
    const m = PUSH_CLAMP + DOT_R + 1;
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
      const push = pointer ? { x: c.x - pointer.x, y: c.y - pointer.y } : null;
      const done = advanceDot(d, push, dt);
      const atHome = d.px === 0 && d.py === 0;
      grow(c.x + d.px, c.y + d.py);
      if (done && atHome) active.delete(k);
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
