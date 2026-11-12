/**
 * Item 654 (his "nothing about the actual clock thing is moving"; his pick
 * B3, blocker 1962): the right column's context dial moves with a reply.
 * The pure part — a state stepped by `stepDrive(d, dt, input)` — so the
 * suite pins the motion and the runner (`contextDrive.svelte.ts`) only
 * calls it once a frame. Round 2's page (`654-designs/round2`, B3) is the
 * reference; every constant here is that page's.
 *
 * While a reply streams:
 * - the arc's exact part and the estimated tail follow the live reading
 *   (τ 0.12 s and 0.25 s); the tail is a marching dashed edge; the figure
 *   counts with it, dimmed;
 * - the tick scale lights: the ticks already used are tinted, the next one
 *   fills toward its 20k; the head beats once per 1k and harder per tool
 *   result; the track breathes faintly;
 * - the gears count the tokens: gear A turns one 15° tooth per 1k (its
 *   drawn angle is `turnA · 2.5`, so 6 turnA-degrees per 1k), gear B
 *   ratchets with it, gear C at 0.6×; the audio ring's surge and the radar's
 *   speed follow the token rate.
 * When it ends, one event: a light runs from 12 o'clock along the arc to
 * the real figure (0.8 s), lighting each tick it passes; the gears wind to
 * the real figure with an overshoot (0.9 s) — backward when it is lower;
 * on landing the head ripples, the notch flares, gear A's index teeth glow
 * and the audio ring swells.
 * At rest nothing here moves: the arc follows a change in 300 ms-like
 * easing (τ 0.1 s, as the CSS transition did), the gears hold the token
 * position, the ticks are untinted (blocker 1972).
 * Reduce motion: every reading is drawn at once — the tail plain, the gears
 * still at the token position, the used and next ticks shown as readings
 * while the reply runs; no march, beat, breath, flare, light or ripple.
 */
import { easeBack } from "./dialMotion";

export interface DriveInput {
  /** Tokens known exactly (the last step, or the logged figure at rest). */
  exact: number;
  /** Tokens estimated on top of `exact` while streaming (0 at rest). */
  estimate: number;
  /** The window, tokens; null or 0: no shares (everything reads 0). */
  limit: number | null;
  /** A reply is running. */
  streaming: boolean;
  /** Minor tick count (ContextDial's `minor`), for the lit scale. */
  ticks: number;
  /** prefers-reduced-motion. */
  reduce: boolean;
}

/** What ContextDial draws (shares of the window, 0..1). */
export interface DialView {
  solid: number;
  tailFrom: number;
  tailTo: number;
  tailAlpha: number;
  /** The tail marches (motion) or is the plain lighter tone (reduce motion). */
  march: boolean;
  marchOff: number;
  head: number;
  headScale: number;
  ripple: number;
  rippleScale: number;
  rippleAt: number;
  light: number;
  lightAlpha: number;
  wash: number;
  /** One opacity per minor tick. */
  ticks: number[];
  notchFlare: number;
  innerSwell: number;
  /** The figure, tokens, and whether it is still an estimate. */
  figure: number;
  estimating: boolean;
}

/** What DialMotion reads each frame. */
export interface GearView {
  /** Gear A's extra turn from the tokens, in turnA degrees (6 per 1k). */
  tok: number;
  /** The radar's extra turn, degrees. */
  radar: number;
  /** The audio ring's surge while streaming; null: DialMotion's own. */
  surge: number | null;
  /** Gear A's index teeth, brightness multiplier (≥ 1). */
  glow: number;
  /** Bumped at each landing (the audio ring swells). */
  landings: number;
}

export interface Drive {
  init: boolean;
  streaming: boolean;
  exact: number;
  estimate: number;
  clock: number;
  solid: number;
  tail: number;
  num: number;
  settle: { p: number; s0: number; t0: number; n0: number; prevL: number } | null;
  rip: number;
  march: number;
  flare: number[];
  tint: number;
  beat: number;
  lastWhole: number | null;
  notch: number;
  click: number;
  innerSwell: number;
  tok: number;
  tokSettle: { p: number; from: number } | null;
  rate: number;
  prevNum: number;
  radar: number;
  landings: number;
  endedAt: number;
}

export function newDrive(): Drive {
  return {
    init: false,
    streaming: false,
    exact: 0,
    estimate: 0,
    clock: 0,
    solid: 0,
    tail: 0,
    num: 0,
    settle: null,
    rip: -1,
    march: 0,
    flare: [],
    tint: 0,
    beat: 0,
    lastWhole: null,
    notch: 0,
    click: 0,
    innerSwell: 0,
    tok: 0,
    tokSettle: null,
    rate: 0,
    prevNum: 0,
    radar: 0,
    landings: 0,
    endedAt: -Infinity,
  };
}

/** Gear A's turn (turnA degrees) for a reading: one 15° drawn tooth per 1k. */
export function gearTarget(tokens: number): number {
  return (6 * Math.max(0, tokens)) / 1000;
}

const follow = (cur: number, tgt: number, dt: number, tau: number) => tgt + (cur - tgt) * Math.exp(-dt / tau);
const decay = (x: number, dt: number, tau: number) => x * Math.exp(-dt / tau);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const easeOutCubic = (k: number) => 1 - Math.pow(1 - k, 3);
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

/** The light's run and the gears' wind, seconds. */
export const LIGHT_S = 0.8;
export const WIND_S = 0.9;
/** After a landing, a late logged figure is followed (not snapped) for this long. */
export const GRACE_S = 3;

/**
 * Advance the drive by dt seconds to `inp`; returns what to draw. `active`
 * is false once nothing would change on the next frame (the runner stops).
 */
export function stepDrive(d: Drive, dt: number, inp: DriveInput): { view: DialView; gear: GearView; active: boolean } {
  const rm = inp.reduce;
  dt = Math.max(0, Math.min(0.1, dt));
  d.clock += dt;
  const W = inp.limit && inp.limit > 0 ? inp.limit : null;
  const reading = Math.max(0, inp.exact + Math.max(0, inp.estimate));
  const x = W ? clamp01(inp.exact / W) : 0;
  const e = W ? clamp01(reading / W) : 0;

  const final = d.init && d.streaming && !inp.streaming;
  const started = d.init && !d.streaming && inp.streaming;
  const stepped = d.init && d.streaming && inp.streaming && inp.exact !== d.exact;
  const bump = d.init && d.streaming && inp.streaming && !stepped && inp.estimate - d.estimate > 800;

  const n = inp.ticks > 0 ? Math.round(inp.ticks) : 0;
  if (d.flare.length !== n) d.flare = new Array(n).fill(0);

  // ---- the arc, the head and the figure
  let tailFrom: number;
  let tailTo: number;
  let tailAlpha = 1;
  let head: number;
  let light = 0;
  let lightAlpha = 0;
  let passed: [number, number] | null = null;
  let landed = false;
  let estimating = inp.streaming && inp.estimate > 0;
  if (!d.init || rm) {
    d.solid = x;
    d.tail = e;
    d.num = reading;
    d.settle = null;
    d.rip = -1;
  } else if (final) {
    d.settle = { p: 0, s0: d.solid, t0: d.tail, n0: d.num, prevL: 0 };
  }
  if (d.settle) {
    const s = d.settle;
    s.p += dt / LIGHT_S;
    const p = Math.min(1, s.p);
    const k = easeInOut(p);
    const R = x; // live: a late logged figure retargets the run
    const L = k * R;
    passed = [s.prevL, L];
    s.prevL = L;
    d.solid = Math.max(s.s0, Math.min(L, R));
    d.num = lerp(s.n0, reading, k);
    if (R >= s.t0) {
      tailFrom = d.solid;
      tailTo = Math.max(d.solid, s.t0);
      head = tailTo;
    } else {
      d.solid = Math.min(d.solid, R);
      tailFrom = R;
      tailTo = s.t0;
      tailAlpha = 1 - k;
      head = lerp(s.t0, R, k);
    }
    light = L;
    lightAlpha = p < 0.08 ? p / 0.08 : p > 0.92 ? (1 - p) / 0.08 : 1;
    estimating = true;
    if (s.p >= 1) {
      d.settle = null;
      d.tail = R;
      d.solid = R;
      d.num = reading;
      d.rip = 0;
      landed = true;
      d.landings++;
      d.endedAt = d.clock;
      estimating = false;
      tailFrom = tailTo = R;
      head = R;
      lightAlpha = 0;
    }
  } else {
    if (rm) {
      // already snapped
    } else if (inp.streaming) {
      d.solid = follow(d.solid, x, dt, 0.12);
      d.tail = follow(d.tail, e, dt, 0.25);
      d.num = follow(d.num, reading, dt, 0.25);
    } else {
      // At rest: today's 300 ms ease, as a follow.
      d.solid = follow(d.solid, x, dt, 0.1);
      d.tail = d.solid;
      d.num = follow(d.num, reading, dt, 0.1);
      if (Math.abs(d.solid - x) < 1e-5) d.solid = d.tail = x;
      if (Math.abs(d.num - reading) < 0.5) d.num = reading;
    }
    tailFrom = d.solid;
    tailTo = Math.max(d.solid, d.tail);
    head = tailTo;
  }
  if (inp.streaming || d.settle) d.march += rm ? 0 : dt * 9;

  let ripple = 0;
  let rippleScale = 1;
  if (d.rip >= 0 && !rm) {
    d.rip += dt / 0.6;
    const p = Math.min(1, d.rip);
    ripple = 0.85 * (1 - p);
    rippleScale = 1 + 2.4 * easeOutCubic(p);
    if (d.rip >= 1) d.rip = -1;
  } else d.rip = -1;

  // ---- the tick scale
  const busy = inp.streaming || !!d.settle;
  d.tint = rm ? (inp.streaming ? 1 : 0) : follow(d.tint, busy ? 1 : 0, dt, busy ? 0.25 : 0.6);
  if (!busy && d.tint < 0.004) d.tint = 0;
  const ticks = new Array<number>(n).fill(0);
  if (n > 0) {
    const pos = clamp01(head) * n;
    const nextI = (Math.floor(pos) + 1) % n;
    const frac = pos - Math.floor(pos);
    for (let i = 0; i < n; i++) {
      d.flare[i] = rm ? 0 : decay(d.flare[i], dt, 0.45);
      if (d.flare[i] < 0.004) d.flare[i] = 0;
      const used = i > 0 && i <= pos ? 0.42 * d.tint : 0;
      let nxt = 0;
      if (i === nextI && inp.streaming) nxt = rm ? 0.35 + 0.5 * frac : (0.25 + 0.6 * frac) * (0.8 + 0.2 * Math.sin(d.clock * 6));
      ticks[i] = Math.min(1, Math.max(used, nxt, d.flare[i]));
    }
    if (passed && !rm) {
      const [a, b] = passed;
      for (let i = 0; i < n; i++) {
        const at = i / n;
        if (at > a && at <= b) d.flare[i] = 1;
      }
      if (a === 0 && b > 0) d.flare[0] = 1;
    }
  }

  // ---- the head's beat, the track's breath, the notch, the cache ring
  const whole = Math.floor(reading / 1000);
  if (!rm && inp.streaming && d.lastWhole != null && whole !== d.lastWhole) d.beat = Math.max(d.beat, 1);
  if (!rm && bump) d.beat = 1.4;
  d.lastWhole = whole;
  d.beat = rm ? 0 : decay(d.beat, dt, 0.16);
  if (d.beat < 0.004) d.beat = 0;
  const wash = inp.streaming && !rm ? 0.07 + 0.05 * Math.sin((d.clock * 2 * Math.PI) / 1.6) : 0;
  if (landed && !rm) d.notch = 1;
  d.notch = rm ? 0 : decay(d.notch, dt, 0.5);
  if (d.notch < 0.004) d.notch = 0;
  if (!rm && (started || stepped)) d.innerSwell = 1.2;
  d.innerSwell = rm ? 0 : decay(d.innerSwell, dt, 0.3);
  if (d.innerSwell < 0.004) d.innerSwell = 0;

  // ---- the gears
  const target = gearTarget(reading);
  if (!d.init || rm) {
    d.tok = target;
    d.tokSettle = null;
  } else {
    if (final) d.tokSettle = { p: 0, from: d.tok };
    if (d.tokSettle) {
      const s = d.tokSettle;
      s.p += dt / WIND_S;
      d.tok = lerp(s.from, target, easeBack(Math.min(1, s.p), 1.6));
      if (s.p >= 1) {
        d.tokSettle = null;
        d.tok = target;
      }
    } else if (inp.streaming) d.tok = follow(d.tok, target, dt, 0.22);
    else if (d.clock - d.endedAt < GRACE_S) {
      d.tok = follow(d.tok, target, dt, 0.3);
      if (Math.abs(d.tok - target) < 0.01) d.tok = target;
    } else d.tok = target;
  }
  if (landed && !rm) d.click = 1;
  d.click = rm ? 0 : decay(d.click, dt, 0.25);
  if (d.click < 0.004) d.click = 0;
  // The token rate, k/s, from the smoothed figure (readings arrive in jumps).
  const dn = d.num - d.prevNum;
  d.prevNum = d.num;
  d.rate = rm || !d.init ? 0 : follow(d.rate, dt > 0 && inp.streaming ? Math.max(0, dn) / 1000 / dt : 0, dt, 0.35);
  if (!inp.streaming && d.rate < 0.004) d.rate = 0;
  d.radar += rm ? 0 : dt * 72 * Math.min(2.5, d.rate * 1.4);
  const glow = 1 + 0.8 * d.click + (rm ? 0 : Math.min(0.6, d.rate * 0.3));
  const surge = inp.streaming && !rm ? Math.min(1.4, 0.2 + d.rate * 0.55) : null;

  d.init = true;
  d.streaming = inp.streaming;
  d.exact = inp.exact;
  d.estimate = inp.estimate;

  const view: DialView = {
    solid: d.solid,
    tailFrom,
    tailTo,
    tailAlpha,
    march: !rm,
    marchOff: d.march,
    head,
    headScale: 1 + 0.32 * Math.min(1.4, d.beat),
    ripple,
    rippleScale,
    rippleAt: x,
    light,
    lightAlpha,
    wash,
    ticks,
    notchFlare: d.notch,
    innerSwell: d.innerSwell,
    figure: d.num,
    estimating,
  };
  const gear: GearView = { tok: d.tok, radar: d.radar, surge, glow, landings: d.landings };
  const active =
    !rm &&
    (inp.streaming ||
      !!d.settle ||
      !!d.tokSettle ||
      d.rip >= 0 ||
      d.tint > 0 ||
      d.beat > 0 ||
      d.notch > 0 ||
      d.click > 0 ||
      d.innerSwell > 0 ||
      d.rate > 0 ||
      d.flare.some((f) => f > 0) ||
      d.solid !== x ||
      d.num !== reading ||
      d.tok !== target);
  return { view, gear, active };
}
