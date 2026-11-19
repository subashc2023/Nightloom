/*
 * Item 858 (his bug, 2026-11-18: a file held near the bottom of the Notes
 * list "didn't actually" scroll it, so lower folders could not be reached
 * mid-drag) — any scrolling box that takes drops scrolls while something
 * dragged is held near its edge: faster nearer the edge, stopping when the
 * drag leaves, drops, ends, or stops sending `dragover`.
 *
 * Works for a drag from another app (Finder) and one inside Nightloom (a
 * note row, a chat, a tab) alike: it reads only where the pointer is.
 * `use:dragScroll` on the scroller; `use:dragScroll={{ axis: "x" }}` for a
 * strip that scrolls sideways.
 */

/** How deep the edge zone is, px; at most a quarter of the box. */
export const EDGE_PX = 56;
/** Top speed at the very edge (and past it), px per frame (~60 fps). */
export const MAX_STEP = 18;
/** The slowest a held drag in the zone moves the list, px per frame. */
export const MIN_STEP = 2;
/** No `dragover` for this long: the drag is gone (WebKit sends one every
 *  ~50 ms while held, even standing still). */
export const STALE_MS = 250;

/**
 * Pixels to scroll this frame for a pointer at `pos` in a box from `start`
 * to `end` (same axis, client coordinates): negative toward the start,
 * positive toward the end, 0 outside the zones. Speed rises with the square
 * of the depth into the zone, so the zone's inner part is gentle.
 */
export function edgeStep(pos: number, start: number, end: number, zone = EDGE_PX, max = MAX_STEP): number {
  const size = end - start;
  if (size <= 0) return 0;
  const z = Math.min(zone, size / 4);
  if (z <= 0) return 0;
  const speed = (dist: number) => {
    const depth = Math.min(1, Math.max(0, (z - dist) / z));
    return depth === 0 ? 0 : Math.max(MIN_STEP, Math.round(max * depth * depth));
  };
  const toStart = pos - start;
  const toEnd = end - pos;
  if (toStart < z && toStart <= toEnd) return -speed(toStart);
  if (toEnd < z) return speed(toEnd);
  return 0;
}

/** The held drag's state, clock in: what to scroll each frame, and when to
 *  stop. Pure, so the stopping is testable without a browser. */
export class EdgeScroller {
  private step = 0;
  private last = -Infinity;
  constructor(private staleMs = STALE_MS) {}
  /** A `dragover` at `pos` in a box from `start` to `end`. */
  over(pos: number, start: number, end: number, now: number): void {
    this.step = edgeStep(pos, start, end);
    this.last = now;
  }
  /** The drag left the box, dropped or ended. */
  stop(): void {
    this.step = 0;
    this.last = -Infinity;
  }
  /** Pixels to scroll at `now`; 0 once stopped or stale. */
  at(now: number): number {
    if (now - this.last > this.staleMs) this.step = 0;
    return this.step;
  }
  get running(): boolean {
    return this.step !== 0;
  }
}

/** The action. Listens in the capture phase, so a child's handler that
 *  stops the event cannot hide it. */
export function dragScroll(node: HTMLElement, opts: { axis?: "x" | "y" } = {}) {
  let axis = opts.axis ?? "y";
  const s = new EdgeScroller();
  let frame: number | null = null;
  const loop = () => {
    frame = null;
    const d = s.at(performance.now());
    if (d === 0) return;
    if (axis === "y") node.scrollTop += d;
    else node.scrollLeft += d;
    frame = requestAnimationFrame(loop);
  };
  const over = (e: DragEvent) => {
    const r = node.getBoundingClientRect();
    if (axis === "y") s.over(e.clientY, r.top, r.bottom, performance.now());
    else s.over(e.clientX, r.left, r.right, performance.now());
    if (s.running && frame === null) frame = requestAnimationFrame(loop);
  };
  const leave = (e: DragEvent) => {
    const to = e.relatedTarget;
    if (to instanceof Node && node.contains(to)) return;
    s.stop();
  };
  const end = () => s.stop();
  node.addEventListener("dragover", over, true);
  node.addEventListener("dragleave", leave, true);
  node.addEventListener("drop", end, true);
  window.addEventListener("dragend", end, true);
  window.addEventListener("drop", end, true);
  return {
    update(o: { axis?: "x" | "y" } = {}) {
      axis = o.axis ?? "y";
    },
    destroy() {
      s.stop();
      if (frame !== null) cancelAnimationFrame(frame);
      node.removeEventListener("dragover", over, true);
      node.removeEventListener("dragleave", leave, true);
      node.removeEventListener("drop", end, true);
      window.removeEventListener("dragend", end, true);
      window.removeEventListener("drop", end, true);
    },
  };
}
