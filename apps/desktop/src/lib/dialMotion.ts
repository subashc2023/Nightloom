/**
 * Item 581 ("missing the animative quality that makes it like jarvis … the
 * turning of the gears … a minute clock that ticks … a vibrating circle for
 * the music"): the pure parts of the new-chat dial's motion layer
 * (`DialMotion.svelte`). Everything here is a function of time, so a frame
 * can be drawn at any instant (the harness draws held frames with it) and
 * the loop keeps no state but a list of impulses.
 *
 * Impulses: a typed key, a layer switch or a project switch adds an impulse
 * `{ at, size }` that decays as exp(−(t − at)/τ). Its level at t and its
 * integral up to t are closed-form, so the gears' extra turn from a spin-up
 * is exact at any t, not summed frame by frame.
 */

export interface Impulse {
  /** Seconds, on the motion clock. */
  at: number;
  size: number;
}

/** A decaying sum of impulses. `settled` holds the integral of the ones that have died out. */
export interface Drive {
  tau: number;
  list: Impulse[];
  settled: number;
}

export function drive(tau: number): Drive {
  return { tau, list: [], settled: 0 };
}

export function kick(d: Drive, at: number, size: number): void {
  d.list.push({ at, size });
}

/** The level at t: Σ size · e^(−(t − at)/τ), for impulses at or before t. */
export function level(d: Drive, t: number): number {
  let s = 0;
  for (const p of d.list) if (t >= p.at) s += p.size * Math.exp(-(t - p.at) / d.tau);
  return s;
}

/** ∫ level from −∞ to t: Σ size · τ · (1 − e^(−(t − at)/τ)), plus the settled ones. */
export function integral(d: Drive, t: number): number {
  let s = d.settled;
  for (const p of d.list) if (t >= p.at) s += p.size * d.tau * (1 - Math.exp(-(t - p.at) / d.tau));
  return s;
}

/** Fold impulses older than 8 τ into `settled` (their level is < 0.04 %). */
export function prune(d: Drive, t: number): void {
  const keep: Impulse[] = [];
  for (const p of d.list) {
    if (t - p.at > 8 * d.tau) d.settled += p.size * d.tau;
    else keep.push(p);
  }
  d.list = keep;
}

/** An overshoot-and-settle step (easeOutBack): 0 → ~1.1 → 1. */
export function easeBack(x: number, s = 2.2): number {
  const t = Math.min(1, Math.max(0, x)) - 1;
  return 1 + (s + 1) * t * t * t + s * t * t;
}

/**
 * The clock hand: 6° per second, stepping once a second with an overshoot
 * that settles in `stepMs`. `ms` is wall-clock milliseconds; the hand reads
 * the real seconds of the minute.
 */
export function secondsAngle(ms: number, stepMs = 260): number {
  const inMinute = ((ms % 60_000) + 60_000) % 60_000;
  const s = Math.floor(inMinute / 1000);
  const frac = (inMinute - s * 1000) / stepMs;
  return (s - 1 + easeBack(frac)) * 6;
}

/**
 * The escapement: gear B steps one tooth (`toothDeg`) each time one of gear
 * A's teeth (`driverToothDeg` apart) passes 12 o'clock, easing with an
 * overshoot over the first `ease` share of the driver's tooth period.
 * `driverDeg` is gear A's total turn, in degrees.
 */
export function escapement(driverDeg: number, driverToothDeg: number, toothDeg: number, ease = 0.35): number {
  const n = driverDeg / driverToothDeg;
  const whole = Math.floor(n);
  return (whole - 1 + easeBack((n - whole) / ease)) * toothDeg;
}

/**
 * The audio ring's spoke at angle θ (radians) and time t (seconds): a length
 * share 0..1. Idle is three slow travelling waves — a gentle breath round
 * the ring; `surge` (0..~1.6) adds a fast, high-frequency shiver and
 * lifts the whole ring, as a level meter does when the music plays.
 */
export function spoke(theta: number, t: number, surge: number): number {
  const idle =
    0.5 +
    0.5 * (0.5 * Math.sin(3 * theta + 1.7 * t) + 0.3 * Math.sin(7 * theta - 2.3 * t) + 0.2 * Math.sin(13 * theta + 3.1 * t));
  if (surge <= 0) return idle * 0.32;
  const s = Math.min(1.6, surge);
  const shiver = 0.5 + 0.5 * Math.sin(23 * theta + 11 * t) * Math.sin(5 * theta - 7.3 * t + 1.1);
  return Math.min(1, idle * 0.32 + s * (0.25 + 0.45 * shiver) * (0.55 + 0.45 * idle));
}

/** The 5-hour window: the share elapsed (0..1) at `nowMs`, or null without a reset time. */
export function windowElapsed(resetsAt: string | null | undefined, nowMs: number, windowMs = 5 * 3600_000): number | null {
  if (!resetsAt) return null;
  const end = new Date(resetsAt).getTime();
  if (!Number.isFinite(end)) return null;
  const left = end - nowMs;
  if (left <= 0) return 1;
  if (left >= windowMs) return 0;
  return 1 - left / windowMs;
}

/** "2 h 14 min", "38 min", "under a minute". */
export function leftWords(ms: number): string {
  if (ms < 60_000) return "under a minute";
  const min = Math.round(ms / 60_000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The hover on the 5-hour hand. */
export function windowTip(used: number | null, resetsAt: string, nowMs: number, clock: string | null): string {
  const left = new Date(resetsAt).getTime() - nowMs;
  const head = used != null ? `5-hour window: ${Math.round(used)}% used` : "5-hour window";
  if (!(left > 0)) return `${head} · it has reset`;
  return `${head} · resets${clock ? ` ${clock}` : ""} (in ${leftWords(left)})\nThe slow hand is how far through the window you are.`;
}

/** Is a world angle (radians, 0 at 12 o'clock, clockwise) inside a share span [from, from + share)? */
export function inSpan(theta: number, from: number, share: number): boolean {
  const u = (((theta / (2 * Math.PI)) % 1) + 1) % 1;
  const a = ((from % 1) + 1) % 1;
  const d = (((u - a) % 1) + 1) % 1;
  return d < share;
}

// ---- item 586: the audio ring reacts to the pointer -------------------------

/** The angle between two world angles (radians), 0..π. */
export function angleGap(a: number, b: number): number {
  const d = (((a - b) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return d > Math.PI ? 2 * Math.PI - d : d;
}

/** The world angle (0 at 12 o'clock, clockwise) of a point dx, dy (screen px, y down) from the centre. */
export function pointerAngle(dx: number, dy: number): number {
  return Math.atan2(dx, -dy);
}

/**
 * How near the pointer is to a dial of radius R, 0..1: 1 on or inside the
 * dial, falling off past its rim over about 4 R (the new-chat dial still
 * feels a pointer across the page; the column's small dial only one close by).
 */
export function pointerNear(dx: number, dy: number, R: number): number {
  const r = Math.hypot(dx, dy);
  return Math.exp(-Math.max(0, r - R) / (4 * R));
}

/**
 * The pointer's pull on the spoke at θ, 0..1: a lobe facing the pointer
 * (((1 + cos gap) / 2)^6 — full at the facing spoke, half at ~39°, a tenth at
 * ~69°), times `pointerNear`. A pointer near the centre faces no side, so
 * the lobe flattens to an even half all round.
 */
export function pointerPull(theta: number, dx: number, dy: number, R: number): number {
  const r = Math.hypot(dx, dy);
  const aim = Math.min(1, r / R);
  const lobe = ((1 + Math.cos(angleGap(theta, pointerAngle(dx, dy)))) / 2) ** 6;
  return pointerNear(dx, dy, R) * (aim * lobe + (1 - aim) * 0.5);
}

/** A pointer at rest on the dial stirs the facing spokes this much (a key's kick is 0.3; first shots at 0.5 and 0.9 read as no change). */
export const POINTER_HOVER = 1.2;
/** A moving pointer's surge per frame: its travel over this many px is one key's kick, capped at it. */
export const POINTER_STIR_PX = 120;
export function stirKick(movedPx: number): number {
  return Math.min(0.3, Math.max(0, movedPx) / POINTER_STIR_PX * 0.3);
}

/** Presence easing toward 1 (on the page) or 0 (gone) over dt seconds, τ 0.35 s. */
export function easePresence(current: number, target: number, dt: number, tau = 0.35): number {
  return target + (current - target) * Math.exp(-Math.max(0, dt) / tau);
}

/**
 * A spoke under the pointer's pull `local` (0..~1.6): the ring's own surge
 * there (taller, faster shiver), plus a fast buzz of its own so the facing
 * side visibly vibrates harder than the rest. `local` 0 is `spoke` exactly.
 */
export function pointerSpoke(theta: number, t: number, surge: number, local: number): number {
  if (local <= 0) return spoke(theta, t, surge);
  const l = Math.min(1.6, local);
  const buzz = 0.5 + 0.5 * Math.sin(31 * theta + 19 * t) * Math.sin(9 * theta - 13 * t);
  return Math.min(1, spoke(theta, t, surge + l) + 0.3 * l * buzz);
}

/**
 * A typed key's extra gear turn, in degrees spread over the spin drive's τ:
 * 25 at the new-chat page's 330 px dial, scaled down with the dial (floor
 * 40 %) so a small dial's gears do not race (his report 2026-11-11).
 */
export function keySpin(size: number): number {
  return 25 * Math.min(1, Math.max(0.4, size / 330));
}
