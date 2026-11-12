// Item 632 (his words: "the very background of the screen is still just like
// the kind of stationary dots ... something more interesting in the
// background, like an animation or something more visual and clear"): the
// new-chat page's ground as a choice of looks, Settings → Animations →
// "New-chat background". `dots` is today's static CSS tile, untouched; the
// others draw on one canvas behind the page.
//
// Cheap by construction: no per-dot DOM. The dot grid is drawn once into an
// offscreen canvas and blitted each frame; what moves is drawn on top in a
// handful of batched paths. Slow looks run at 30 frames a second. The loop
// stops while the window is hidden, under Reduce motion, and wherever the
// lit dot ground is off (`--ground-dots: none`: Calm, the classic palettes);
// Classic's page is WelcomeClassic and never mounts this.
import { reducedMotion } from "./sendMotion";

// Item 640: Horizon and Radar are WebGL looks (`newChatShader.ts`, their own
// canvas over the CSS dot tile); this module's canvas stays off for them.
export type GroundStyle = "dots" | "ripple" | "weft" | "drift" | "aurora" | "horizon" | "radar";

export const GROUND_STYLES: { id: GroundStyle; name: string; note: string }[] = [
  { id: "horizon", name: "Horizon", note: "The wheel is a sun on a horizon: a wireframe sea rolls toward you, warm light-rays and a dawn glow rise behind the dial." },
  { id: "radar", name: "Radar", note: "The wheel is a radar: a polar grid, a turning sweep with its afterglow, pings radiating out, blips flaring as it passes." },
  { id: "weft", name: "Weft", note: "Lights run along rows of the dots like shuttles on a loom, each leaving a short fading thread." },
  { id: "ripple", name: "Ripple", note: "Every few seconds a soft ring of light leaves the wheel and passes out through the dots." },
  { id: "drift", name: "Drift", note: "A slow constellation: points drift over the dots, faint lines joining the ones near each other." },
  { id: "aurora", name: "Aurora", note: "Three wide, faint glows in the theme's colours wander slowly behind the dots." },
  { id: "dots", name: "Dots — today's", note: "The still dot grid, as before." },
];

/**
 * Item 640 (his pick, 2026-11-11: "keep horizon and radar and default (no
 * background, jus like the lines we have rn nothing else) as the options in
 * settings"): what Settings offers. Default is today's page, Weft (blocker
 * 1945). The other looks stay drawable so a stored pick never breaks.
 */
export const GROUND_MENU: { id: GroundStyle; name: string; note: string }[] = [
  { id: "horizon", name: "Horizon", note: "The wheel as a sun on a horizon: a wireframe sea rolls toward you, warm light-rays and a dawn glow rise behind the dial." },
  { id: "radar", name: "Radar", note: "The wheel as a radar: a polar grid, a turning sweep with its afterglow, pings radiating out, blips flaring as it passes." },
  { id: "weft", name: "Default", note: "Today's page: the dot ground, lights running along its rows like shuttles, each leaving a short fading thread." },
];

/** The CSS tile's size on `.welcome` (`background-size: 22px 22px`). */
export const GROUND_STEP = 22;
/** Between the gradient's 1.35 px solid core and its 1.55 px edge (item 655; was 1.1 for 1 / 1.2 px). */
export const GROUND_DOT_R = 1.45;

export type Rgb = [number, number, number];
export interface GroundColours {
  /** The dot's own colour as CSS (the `--ground-dot-ink` mix, resolved). */
  dot: string;
  ink: Rgb;
  signal: Rgb;
  accent: Rgb;
}
export interface GroundView {
  /** CSS px. */
  w: number;
  h: number;
  dpr: number;
  /** Where the wheel's centre is (CSS px, in the canvas's box). */
  origin: { x: number; y: number };
  colours: GroundColours;
}

/** A small seeded random (mulberry32), so a scene and its shots repeat. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The bump a lit dot gets at `u` (−1..1 across a band): 1 at the centre, 0 with zero slope at the edges. */
export function bump(u: number): number {
  if (u <= -1 || u >= 1) return 0;
  const f = 1 - u * u;
  return f * f;
}

/** Ripple: a ring's radius at phase `p` (0..1), easing out a little so it slows as it spreads. */
export function ringRadius(p: number, rMax: number): number {
  const q = Math.min(Math.max(p, 0), 1);
  return rMax * (1 - (1 - q) * (1 - q) * 0.35 - 0.65 * (1 - q));
}

/** Frames per second a look draws at (slow looks need no more). */
export function fpsFor(style: GroundStyle): number {
  return style === "drift" || style === "aurora" ? 30 : 60;
}

const rgba = (c: Rgb, a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${Math.max(0, Math.min(1, a)).toFixed(3)})`;

/** How many of each lit level a frame batches into one path. */
const LEVELS = 6;

type Ctx = CanvasRenderingContext2D;

/** One look, ready to draw frames into a context already scaled to CSS px. */
export interface Scene {
  frame(ctx: Ctx, tMs: number): void;
}

/** The still dot grid, drawn once (device pixels) for each frame to start from. */
function baseGrid(view: GroundView): HTMLCanvasElement | OffscreenCanvas | null {
  const W = Math.max(1, Math.round(view.w * view.dpr));
  const H = Math.max(1, Math.round(view.h * view.dpr));
  let c: HTMLCanvasElement | OffscreenCanvas | null = null;
  if (typeof OffscreenCanvas !== "undefined") c = new OffscreenCanvas(W, H);
  else if (typeof document !== "undefined") {
    c = document.createElement("canvas");
    c.width = W;
    c.height = H;
  }
  if (!c) return null;
  const g = c.getContext("2d") as Ctx | null;
  if (!g) return null;
  g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  g.fillStyle = view.colours.dot;
  g.beginPath();
  const s = GROUND_STEP;
  for (let x = s / 2; x < view.w; x += s)
    for (let y = s / 2; y < view.h; y += s) {
      g.moveTo(x + GROUND_DOT_R, y);
      g.arc(x, y, GROUND_DOT_R, 0, Math.PI * 2);
    }
  g.fill();
  return c;
}

function blit(ctx: Ctx, base: CanvasImageSource | null) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  if (base) ctx.drawImage(base, 0, 0);
  ctx.restore();
}

/** Lit dots, batched: `lit[level]` holds x, y pairs; each level is one path. */
class LitDots {
  lit: number[][] = Array.from({ length: LEVELS }, () => []);
  add(x: number, y: number, k: number) {
    if (k <= 0.02) return;
    const l = Math.min(LEVELS - 1, Math.floor(k * LEVELS));
    this.lit[l].push(x, y);
  }
  draw(ctx: Ctx, colour: Rgb, peakAlpha: number, grow: number) {
    for (let l = 0; l < LEVELS; l++) {
      const pts = this.lit[l];
      if (!pts.length) continue;
      const k = (l + 0.5) / LEVELS;
      const r = GROUND_DOT_R + grow * k;
      ctx.fillStyle = rgba(colour, peakAlpha * k);
      ctx.beginPath();
      for (let n = 0; n < pts.length; n += 2) {
        ctx.moveTo(pts[n] + r, pts[n + 1]);
        ctx.arc(pts[n], pts[n + 1], r, 0, Math.PI * 2);
      }
      ctx.fill();
      pts.length = 0;
    }
  }
}

function ripple(view: GroundView): Scene {
  const base = baseGrid(view);
  const lit = new LitDots();
  const PERIOD = 7000;
  const BAND = 70;
  return {
    frame(ctx, t) {
      blit(ctx, base);
      const { x: ox, y: oy } = view.origin;
      const rMax = Math.hypot(Math.max(ox, view.w - ox), Math.max(oy, view.h - oy)) + BAND;
      // Two rings half a period apart; each fades as it spreads.
      const rings = [0, 0.5].map((off) => {
        const p = ((t / PERIOD + off) % 1 + 1) % 1;
        return { r: ringRadius(p, rMax), a: (1 - p) * (1 - p) * Math.min(1, p * 12) };
      });
      const s = GROUND_STEP;
      for (let x = s / 2; x < view.w; x += s)
        for (let y = s / 2; y < view.h; y += s) {
          const d = Math.hypot(x - ox, y - oy);
          let k = 0;
          for (const g of rings) k = Math.max(k, bump((d - g.r) / BAND) * g.a);
          lit.add(x, y, k);
        }
      lit.draw(ctx, view.colours.signal, 0.75, 1.0);
    },
  };
}

interface Shuttle {
  row: number;
  dir: 1 | -1;
  speed: number;
  /** When it set off (ms) and how far it goes before it is done. */
  t0: number;
  amber: boolean;
}

function weft(view: GroundView, seed = 632): Scene {
  const base = baseGrid(view);
  const lit = new LitDots();
  const rand = seeded(seed);
  const s = GROUND_STEP;
  const rows = Math.max(1, Math.floor((view.h - s / 2) / s) + 1);
  const TRAIL = 300;
  const COUNT = Math.max(3, Math.min(9, Math.round(view.h / 110)));
  const shuttles: Shuttle[] = [];
  const pick = (t: number, spread: number): Shuttle => {
    const used = new Set(shuttles.map((q) => q.row));
    let row = Math.floor(rand() * rows);
    for (let n = 0; n < 8 && used.has(row); n++) row = Math.floor(rand() * rows);
    return { row, dir: rand() < 0.5 ? 1 : -1, speed: 90 + rand() * 110, t0: t + rand() * spread, amber: rand() < 0.2 };
  };
  for (let n = 0; n < COUNT; n++) {
    const q = pick(0, 0);
    // Start spread across their run, so the first frame already has threads.
    q.t0 = -rand() * ((view.w + TRAIL) / q.speed) * 1000;
    shuttles.push(q);
  }
  const amberLit = new LitDots();
  // Only the shuttles' rows change, so a frame redraws only their strips
  // (this frame's and the last's) from the base grid: a few thin bands
  // instead of the whole window.
  const HALF = 7;
  let drawn = new Set<number>();
  let first = true;
  const restore = (ctx: Ctx, row: number) => {
    const d = view.dpr;
    const y0 = Math.max(0, Math.floor((s / 2 + row * s - HALF) * d));
    const y1 = Math.min(ctx.canvas.height, Math.ceil((s / 2 + row * s + HALF) * d));
    if (y1 <= y0) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, y0, ctx.canvas.width, y1 - y0);
    if (base) ctx.drawImage(base, 0, y0, ctx.canvas.width, y1 - y0, 0, y0, ctx.canvas.width, y1 - y0);
    ctx.restore();
  };
  return {
    frame(ctx, t) {
      if (first) {
        // The clock is the page's (rAF time); the shuttles' starts were set against 0.
        for (const q of shuttles) q.t0 += t;
        blit(ctx, base);
        first = false;
      }
      const now = new Set<number>();
      for (const q of shuttles) now.add(q.row);
      for (const r of drawn) restore(ctx, r);
      for (const r of now) if (!drawn.has(r)) restore(ctx, r);
      for (let n = 0; n < shuttles.length; n++) {
        let q = shuttles[n];
        const run = (view.w + TRAIL * 2) / q.speed;
        if ((t - q.t0) / 1000 > run) {
          q = shuttles[n] = pick(t, 1800);
        }
        const el = (t - q.t0) / 1000;
        if (el < 0) continue;
        const travelled = el * q.speed - TRAIL;
        const head = q.dir === 1 ? travelled : view.w - travelled;
        // Row `row` of the tile, which is anchored at the page's top-left.
        const yy = s / 2 + q.row * s;
        const colour = q.amber ? view.colours.accent : view.colours.signal;
        // The thread: a hairline from the tail to the head, fading toward the tail.
        const tail = head - q.dir * TRAIL;
        const grad = ctx.createLinearGradient(tail, yy, head, yy);
        grad.addColorStop(0, rgba(colour, 0));
        grad.addColorStop(1, rgba(colour, 0.3));
        ctx.fillStyle = grad;
        ctx.fillRect(Math.min(tail, head), yy - 0.5, TRAIL, 1);
        // The dots on the row light behind the head.
        const target = q.amber ? amberLit : lit;
        const i0 = Math.max(0, Math.floor((Math.min(tail, head) - s / 2) / s));
        const i1 = Math.min(Math.floor((view.w - s / 2) / s), Math.ceil((Math.max(tail, head) - s / 2) / s));
        for (let i = i0; i <= i1; i++) {
          const x = s / 2 + i * s;
          const behind = (head - x) * q.dir; // 0 at the head, TRAIL at the tail
          if (behind < -s || behind > TRAIL) continue;
          const k = behind < 0 ? Math.max(0, 1 + behind / s) : Math.pow(1 - behind / TRAIL, 1.6);
          target.add(x, yy, k);
        }
        // The head's own glow.
        ctx.fillStyle = rgba(colour, 0.16);
        ctx.beginPath();
        ctx.arc(head, yy, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      lit.draw(ctx, view.colours.signal, 0.85, 0.9);
      amberLit.draw(ctx, view.colours.accent, 0.85, 0.9);
      drawn = new Set(shuttles.map((q) => q.row));
      for (const r of now) drawn.add(r);
    },
  };
}

function drift(view: GroundView, seed = 6320): Scene {
  const base = baseGrid(view);
  const rand = seeded(seed);
  const N = Math.max(8, Math.round(((view.w * view.h) / (1440 * 900)) * 70));
  const LINK = 140;
  const pts = Array.from({ length: N }, () => {
    const a = rand() * Math.PI * 2;
    const v = 5 + rand() * 9;
    return { x: rand() * view.w, y: rand() * view.h, vx: Math.cos(a) * v, vy: Math.sin(a) * v, lit: rand() < 0.12 };
  });
  let last = -1;
  const lines: number[][] = Array.from({ length: 4 }, () => []);
  return {
    frame(ctx, t) {
      blit(ctx, base);
      const dt = last < 0 ? 0 : Math.min(0.1, Math.max(0, (t - last) / 1000));
      last = t;
      const m = 20;
      for (const p of pts) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.x < -m) p.x += view.w + 2 * m;
        if (p.x > view.w + m) p.x -= view.w + 2 * m;
        if (p.y < -m) p.y += view.h + 2 * m;
        if (p.y > view.h + m) p.y -= view.h + 2 * m;
      }
      for (let a = 0; a < N; a++)
        for (let b = a + 1; b < N; b++) {
          const dx = pts[a].x - pts[b].x;
          const dy = pts[a].y - pts[b].y;
          const d2 = dx * dx + dy * dy;
          if (d2 > LINK * LINK) continue;
          const k = 1 - Math.sqrt(d2) / LINK;
          const l = Math.min(3, Math.floor(k * k * 4));
          lines[l].push(pts[a].x, pts[a].y, pts[b].x, pts[b].y);
        }
      ctx.lineWidth = 1;
      for (let l = 0; l < 4; l++) {
        const L = lines[l];
        if (!L.length) continue;
        ctx.strokeStyle = rgba(view.colours.ink, 0.05 + 0.05 * l);
        ctx.beginPath();
        for (let n = 0; n < L.length; n += 4) {
          ctx.moveTo(L[n], L[n + 1]);
          ctx.lineTo(L[n + 2], L[n + 3]);
        }
        ctx.stroke();
        L.length = 0;
      }
      for (const lit of [false, true]) {
        ctx.fillStyle = lit ? rgba(view.colours.signal, 0.7) : rgba(view.colours.ink, 0.32);
        ctx.beginPath();
        for (const p of pts) {
          if (p.lit !== lit) continue;
          ctx.moveTo(p.x + 1.5, p.y);
          ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    },
  };
}

function aurora(view: GroundView): Scene {
  const base = baseGrid(view);
  // The glows draw into a canvas an eighth the size; the blit's smoothing blurs them for free.
  const SCALE = 8;
  const lw = Math.max(2, Math.ceil(view.w / SCALE));
  const lh = Math.max(2, Math.ceil(view.h / SCALE));
  let lo: HTMLCanvasElement | OffscreenCanvas | null = null;
  if (typeof OffscreenCanvas !== "undefined") lo = new OffscreenCanvas(lw, lh);
  else if (typeof document !== "undefined") {
    lo = document.createElement("canvas");
    lo.width = lw;
    lo.height = lh;
  }
  const g = (lo?.getContext("2d") as Ctx | null) ?? null;
  const blobs = [
    { c: view.colours.signal, a: 0.13, px: 47, py: 61, ph: 0.0, r: 0.55 },
    { c: view.colours.accent, a: 0.07, px: 71, py: 53, ph: 2.1, r: 0.45 },
    { c: view.colours.signal, a: 0.08, px: 59, py: 83, ph: 4.2, r: 0.5 },
  ];
  return {
    frame(ctx, t) {
      if (g && lo) {
        g.clearRect(0, 0, lw, lh);
        const s = t / 1000;
        for (const b of blobs) {
          const x = lw * (0.5 + 0.38 * Math.sin((s / b.px) * Math.PI * 2 + b.ph));
          const y = lh * (0.5 + 0.34 * Math.sin((s / b.py) * Math.PI * 2 + b.ph * 1.3));
          const r = Math.max(lw, lh) * b.r;
          const breathe = 0.75 + 0.25 * Math.sin((s / 11) * Math.PI * 2 + b.ph);
          const gr = g.createRadialGradient(x, y, 0, x, y, r);
          gr.addColorStop(0, rgba(b.c, b.a * breathe));
          gr.addColorStop(1, rgba(b.c, 0));
          g.fillStyle = gr;
          g.fillRect(0, 0, lw, lh);
        }
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      if (lo) ctx.drawImage(lo, 0, 0, ctx.canvas.width, ctx.canvas.height);
      if (base) ctx.drawImage(base, 0, 0);
      ctx.restore();
    },
  };
}

/** The look's scene for a view; null for `dots` (the CSS tile, no canvas). */
export function makeScene(style: GroundStyle, view: GroundView): Scene | null {
  switch (style) {
    case "ripple":
      return ripple(view);
    case "weft":
      return weft(view);
    case "drift":
      return drift(view);
    case "aurora":
      return aurora(view);
    default:
      return null;
  }
}

/** Whether the canvas runs: a moving look, the lit dot ground on, motion allowed. */
export function groundWanted(style: GroundStyle, groundToken: string, reduce: boolean): boolean {
  const g = groundToken.trim();
  return style !== "dots" && style !== "horizon" && style !== "radar" && !reduce && g !== "" && g !== "none";
}

/** Frame timings a harness reads (`window.__groundStats = { frames: 0, totalMs: 0, maxMs: 0 }`). */
export interface GroundStats {
  frames: number;
  totalMs: number;
  maxMs: number;
}

/** "#rrggbb" or "rgb(a)(r, g, b…)" → [r, g, b]; anything else → the fallback. */
export function parseRgb(css: string, fallback: Rgb): Rgb {
  const s = css.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(s);
  if (m) return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
  return fallback;
}

type Win = Window & { __groundStats?: GroundStats; __groundT?: number };

/**
 * Wire the canvas: it covers `host` (absolutely, inset 0); while a moving
 * look runs, `host` carries `ground-live`, whose CSS drops the dot tile
 * (the canvas draws the same dots). `originOf` gives the wheel's centre in
 * `host`'s box, or null for the box's centre.
 */
export function newChatGround(
  canvas: HTMLCanvasElement,
  host: HTMLElement,
  originOf: () => { x: number; y: number } | null,
): { set(style: GroundStyle): void; destroy(): void } {
  const w = window as Win;
  const ctx = canvas.getContext("2d");
  let style: GroundStyle = "dots";
  let scene: Scene | null = null;
  let on = false;
  let raf = 0;
  let lastDraw = -Infinity;
  let frames = 0;
  const view: GroundView = {
    w: 0,
    h: 0,
    dpr: 1,
    origin: { x: 0, y: 0 },
    colours: { dot: "rgba(233, 237, 242, 0.08)", ink: [233, 237, 242], signal: [134, 216, 247], accent: [255, 180, 84] },
  };

  const read = (v: string) => {
    canvas.style.color = v;
    return getComputedStyle(canvas).color;
  };
  function readColours() {
    view.colours = {
      dot: read("var(--ground-dot-ink)") || view.colours.dot,
      ink: parseRgb(read("var(--ink)"), view.colours.ink),
      signal: parseRgb(read("var(--signal)"), view.colours.signal),
      accent: parseRgb(read("var(--accent)"), view.colours.accent),
    };
  }
  function readOrigin() {
    const o = originOf();
    view.origin = o ?? { x: view.w / 2, y: view.h / 2 };
  }
  function rebuild() {
    view.w = host.clientWidth;
    view.h = host.clientHeight;
    view.dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${view.w}px`;
    canvas.style.height = `${view.h}px`;
    canvas.width = Math.max(1, Math.round(view.w * view.dpr));
    canvas.height = Math.max(1, Math.round(view.h * view.dpr));
    readColours();
    readOrigin();
    scene = on ? makeScene(style, view) : null;
    // Draw at once: the tile is gone while `ground-live` is on, so the dots
    // must be there even if the window is hidden and the loop waits.
    if (scene && ctx) {
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      scene.frame(ctx, typeof w.__groundT === "number" ? w.__groundT : performance.now());
    }
  }
  function frame(t: number) {
    raf = 0;
    if (!on || !ctx || !scene) return;
    if (document.hidden) return; // visibilitychange restarts it
    const minGap = 1000 / fpsFor(style) - 2;
    if (t - lastDraw >= minGap) {
      lastDraw = t;
      const t0 = performance.now();
      if (++frames % 30 === 0) readOrigin();
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      scene.frame(ctx, typeof w.__groundT === "number" ? w.__groundT : t);
      const s = w.__groundStats;
      if (s) {
        const ms = performance.now() - t0;
        s.frames++;
        s.totalMs += ms;
        if (ms > s.maxMs) s.maxMs = ms;
      }
    }
    raf = requestAnimationFrame(frame);
  }
  function decide() {
    const ground = getComputedStyle(document.documentElement).getPropertyValue("--ground-dots");
    const want = !!ctx && groundWanted(style, ground, reducedMotion());
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    on = want;
    if (on) {
      canvas.style.display = "block";
      host.classList.add("ground-live");
      rebuild();
      raf = requestAnimationFrame(frame);
    } else {
      scene = null;
      host.classList.remove("ground-live");
      canvas.style.display = "none";
    }
  }
  const ro = new ResizeObserver(() => {
    if (on) rebuild();
  });
  ro.observe(host);
  const mo = new MutationObserver(() => decide());
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-light", "data-palette", "data-layout", "data-accent", "style", "class"] });
  let mq: MediaQueryList | null = null;
  try {
    mq = matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", decide);
  } catch {
    mq = null;
  }
  const onVis = () => {
    if (on && !document.hidden && !raf) raf = requestAnimationFrame(frame);
  };
  document.addEventListener("visibilitychange", onVis);
  decide();
  return {
    set(next: GroundStyle) {
      if (next === style) return;
      style = next;
      decide();
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      ro.disconnect();
      mo.disconnect();
      mq?.removeEventListener("change", decide);
      document.removeEventListener("visibilitychange", onVis);
      host.classList.remove("ground-live");
    },
  };
}
