/**
 * Item 667 (his ask 2026-11-11: "they start too fast … the first 5 seconds
 * all the movements starts from like nothing to slowly speeding up until it
 * gets there"): a running step's motion eases in. When a running step's row
 * appears, every looping animation inside it — the whole stepMotion family
 * (Combo, Sweep, Reticle; every kind: the thread, the bar's head, the mark,
 * the brackets, the edge light, the bus) — plays at `RAMP_START`× and speeds
 * up on an ease-in curve to 1× (today's pace) at `RAMP_MS`.
 *
 * How: Web Animations. Each frame of the ramp the row's own
 * `getAnimations({ subtree: true })` is read and every looping one
 * (iterations Infinity — an arrival, a Svelte transition or any other
 * one-shot is left alone) gets `updatePlaybackRate(rate)`, which keeps the
 * loop's position, so nothing jumps; an animation that joins the row later
 * (a mark swapped in, a motion switched in Settings) is caught the next frame
 * at the ramp's rate then. At the end every one is set to 1× and the row is
 * dropped from the loop.
 *
 * The ramp is the step's, not the node's: it is keyed (a thinking block by
 * its clock, a call by its id) so the empty "Thinking" row turning into the
 * button once words arrive goes on where it was. A step already running when
 * the chat opens (not fresh at first sight) starts at 1×. Reduce motion: the
 * motion CSS sits under `no-preference`, so there is nothing to ramp; the
 * action does nothing.
 *
 * The comparison page: nightshift `notes/runner-design/667-designs/`. A
 * wrapper's `data-ramp-start` overrides the start rate (that page and the
 * Settings preview's own use only).
 */
import { reducedMotion } from "./sendMotion";

/** The rate a running step's motion starts at (1 = today's pace). */
export const RAMP_START = 0.2;
/** How long the motion takes to reach today's pace. */
export const RAMP_MS = 5000;

/** Ease-in (quadratic): slow to gather, quickest at the end. */
const easeIn = (u: number) => u * u;

/** The playback rate `ms` into a step's ramp: `start` at 0, 1 at RAMP_MS and after. */
export function rampRate(ms: number, start: number = RAMP_START, dur: number = RAMP_MS): number {
  if (!(ms > 0)) return start;
  if (ms >= dur) return 1;
  return start + (1 - start) * easeIn(ms / dur);
}

/**
 * Where a step's ramp starts, decided once at its first sight: `now` when the
 * step is fresh (it began in view), else null (already running when the chat
 * opened: 1× from the first frame). Later sights (a remount) read the same
 * origin.
 */
export function rampOrigin(book: Map<string, number | null>, key: string, fresh: boolean, now: number): number | null {
  if (book.has(key)) return book.get(key)!;
  // Kept small: the oldest sights go first (a step seen that long ago is long past its ramp).
  if (book.size >= 400) for (const k of [...book.keys()].slice(0, 200)) book.delete(k);
  const o = fresh ? now : null;
  book.set(key, o);
  return o;
}

const book = new Map<string, number | null>();

interface Live {
  node: HTMLElement;
  origin: number;
  start: number;
}
const live = new Set<Live>();
let raf = 0;

function looping(a: Animation): boolean {
  try {
    return (a.effect?.getTiming().iterations ?? 1) === Infinity;
  } catch {
    return false;
  }
}

function setRate(node: HTMLElement, rate: number): void {
  if (typeof node.getAnimations !== "function") return;
  for (const a of node.getAnimations({ subtree: true })) {
    if (!looping(a)) continue;
    if (Math.abs(a.playbackRate - rate) < 0.002) continue;
    if (typeof a.updatePlaybackRate === "function") a.updatePlaybackRate(rate);
    else a.playbackRate = rate;
  }
}

function frame(): void {
  raf = 0;
  const now = Date.now();
  for (const l of live) {
    const ms = now - l.origin;
    setRate(l.node, rampRate(ms, l.start));
    if (ms >= RAMP_MS) live.delete(l);
  }
  if (live.size && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(frame);
}

export interface RampParams {
  /** The step's own key: `think:<its clock>`, `tool:<call id>`. */
  key: string;
  /** The step began in view (not already under way when the chat opened). */
  fresh: boolean;
  /** The row is running (its motion is drawn). */
  live: boolean;
}

/** `use:stepRamp` on a running step's row. */
export function stepRamp(node: HTMLElement, p: RampParams) {
  let mine: Live | null = null;
  let decided = false;
  const stop = () => {
    if (!mine) return;
    live.delete(mine);
    setRate(node, 1);
    mine = null;
  };
  const begin = (q: RampParams) => {
    if (!q.live || decided || reducedMotion()) return;
    decided = true;
    const origin = rampOrigin(book, q.key, q.fresh, Date.now());
    if (origin === null || Date.now() - origin >= RAMP_MS) return;
    const attr = (node.closest("[data-ramp-start]") as HTMLElement | null)?.dataset.rampStart;
    const start = attr !== undefined && attr !== "" && Number.isFinite(Number(attr)) ? Number(attr) : RAMP_START;
    mine = { node, origin, start };
    live.add(mine);
    setRate(node, rampRate(Date.now() - origin, start));
    if (!raf && typeof requestAnimationFrame === "function") raf = requestAnimationFrame(frame);
  };
  begin(p);
  return {
    update(q: RampParams) {
      if (!q.live) stop();
      else begin(q);
    },
    destroy: stop,
  };
}
