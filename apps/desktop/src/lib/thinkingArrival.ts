/**
 * The thinking block's arrival (nightshift backlog 389, his ask 2026-10-18:
 * "the thinking section kinda jus like pops out of thin air"). A live
 * thinking row — the first appearance of one, nothing else — comes in with
 * a motion instead of spawning. Three looks; the app plays the one he picked
 * in Settings → Appearance → Animations (backlog 395: A or B; C stays in
 * code, not offered), stored as `nightloom.thinkingArrival`, default A.
 *
 *   A, the thrown line (his idea, built): a thin accent streak shoots in
 *      from the composer's top edge along the send flight's own bowed
 *      path (sendMotion's curves: y easeOutQuart, x easeOutCubic — it rises
 *      first, then drifts across), lands on the block's top-left corner, widens along the
 *      block's top edge, and the block drops in under it from that line with
 *      a small settle.
 *      The times below are the base timeline; the app plays it ×1.3
 *      (`A_SCALE`, backlog 395, his ask 2026-10-19: "happens just a little
 *      bit too fast"), so every one of them stretches together.
 *        0–220 ms   the streak's head flies (the tail follows 70 ms behind
 *                   and collapses into the landing point by 290)
 *        170–340    the line widens along the top edge; fades 330–460
 *        200–440    the block: opacity 200–320, revealed top-down 200–380,
 *                   dropping −6 px → 0 through a 0.9 px overshoot
 *      480 ms base, 624 ms played (streak 286), shorter than the send's 760; the block's contents are
 *      never held back — they are in the DOM from the first frame and show
 *      as the block does.
 *   B, spark and unfold: a dot of light at the block's top edge stretches
 *      into a line, which opens down into the block; one shimmer sweep.
 *   C, settle: the block rises 6 px and un-blurs in; one shimmer sweep.
 *
 * Under `prefers-reduced-motion: reduce`, all three are a plain 180 ms fade.
 *
 * Only the first appearance plays: the action keys on the thinking
 * segment's `at` (the clock it was created with, state.svelte.ts) and plays
 * only for a live segment created under `FRESH_MS` ago, once. A row in
 * history (not live), a chat opened on a turn already thinking (stale), a
 * scroll back or a re-render (already played) stays still. A node that
 * remounts mid-motion — the empty "thinking …" row turning into the button
 * once words arrive — picks the motion up where the old node left it.
 *
 * The timeline is `frameAt(style, ms)`, pure, so the tests can read it and
 * the harness can hold any instant (`window.__thinkingArrivalHold = ms`;
 * `window.__thinkingArrival = "B"` overrides the style for the demo).
 */

import { FLIGHT_MS, easeOutCubic, easeOutQuart, reducedMotion } from "./sendMotion";

export type ArrivalStyle = "A" | "B" | "C";
/** The default look, when he has not picked one in Settings. */
export const ARRIVAL_STYLE: ArrivalStyle = "A";
/** The looks Settings offers (backlog 395). C is kept in code, not offered. */
export const OFFERED_STYLES: { id: ArrivalStyle; name: string; blurb: string }[] = [
  { id: "A", name: "Shooting line", blurb: "A streak of light flies up from the composer, lands on the block's corner and draws its top edge; the block drops in under it." },
  { id: "B", name: "Spark and unfold", blurb: "A spark at the block's top edge stretches into a line, which opens down into the block; one shimmer crosses it." },
];
const STYLE_KEY = "nightloom.thinkingArrival";

/** The look he picked, from localStorage; A when unset, unreadable or not offered. */
export function chosenArrival(): ArrivalStyle {
  try {
    const raw = localStorage.getItem(STYLE_KEY);
    if (raw && OFFERED_STYLES.some((s) => s.id === raw)) return raw as ArrivalStyle;
  } catch {
    // A malformed preference costs the preference, not the feature.
  }
  return ARRIVAL_STYLE;
}

/** Remember his pick. Only an offered look is stored. */
export function setChosenArrival(style: ArrivalStyle): void {
  if (!OFFERED_STYLES.some((s) => s.id === style)) return;
  try {
    localStorage.setItem(STYLE_KEY, style);
  } catch {
    // best-effort
  }
}
/** A live segment older than this when its row mounts is not arriving — the chat was opened on it. */
export const FRESH_MS = 1200;

/** A plays its base timeline this much slower (backlog 395: 480 → 624 ms). */
export const A_SCALE = 1.3;
/** The streak's flight in A's base timeline: the send flight's own pace, a little quicker (220). */
const STREAK_BASE = Math.round(FLIGHT_MS * (220 / 340));
/** The streak's flight as played (286 ms). */
export const STREAK_MS = Math.round(STREAK_BASE * A_SCALE);
export const DURATION: Record<ArrivalStyle | "fade", number> = { A: Math.round(480 * A_SCALE), B: 620, C: 560, fade: 180 };

// ---- the timeline, pure -----------------------------------------------------

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, t: number) => {
  const u = clamp01((t - a) / (b - a));
  return u * u * (3 - 2 * u);
};
/** Ease-out with a small overshoot past 1 (the settle). */
export const easeOutBack = (t: number, c = 2.2) => {
  const u = clamp01(t) - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};

export interface ArrivalFrame {
  /** The block's own look. */
  opacity: number;
  /** px, + is down. */
  dy: number;
  /** px of blur. */
  blur: number;
  /** 0..1 of the block's height shown, from its top; 1 = no clip. */
  reveal: number;
  /** The thrown streak along the flight path, as path parameters 0..1 (tail, head); null = not drawn. */
  streak: { tail: number; head: number; opacity: number } | null;
  /** The dot of light (B) at the landing point: radius px. */
  dot: { r: number; opacity: number } | null;
  /** The line along the block's top edge: 0..1 of its width drawn out from the landing point. */
  line: { k: number; opacity: number } | null;
  /** 0..1 progress of one shimmer sweep across the block; null = none. */
  shimmer: number | null;
  done: boolean;
}

const still: Omit<ArrivalFrame, "done"> = {
  opacity: 1,
  dy: 0,
  blur: 0,
  reveal: 1,
  streak: null,
  dot: null,
  line: null,
  shimmer: null,
};

export function frameAt(style: ArrivalStyle | "fade", ms: number): ArrivalFrame {
  const done = ms >= DURATION[style];
  if (done) return { ...still, done };
  if (style === "fade") return { ...still, opacity: easeOutCubic(ms / DURATION.fade), done };
  if (style === "A") {
    // The base timeline (480 ms), read at t: every time in it stretches by A_SCALE.
    const t = ms / A_SCALE;
    const head = clamp01(t / STREAK_BASE);
    const tail = clamp01((t - 70) / STREAK_BASE);
    const streak = t >= 0 && tail < 1 ? { tail, head, opacity: 0.95 * smooth(0, 30, t) } : null;
    const line = t >= 170 && t < 460 ? { k: easeOutCubic((t - 170) / 170), opacity: 0.9 * (1 - smooth(330, 460, t)) } : null;
    const u = (t - 200) / 240;
    return {
      ...still,
      opacity: smooth(200, 320, t),
      dy: t < 200 ? -6 : -6 * (1 - easeOutBack(u)),
      reveal: easeOutCubic((t - 200) / 180),
      streak,
      line,
      done,
    };
  }
  if (style === "B") {
    const dot = ms < 180 ? { r: 3 * easeOutCubic(ms / 100), opacity: 1 - smooth(100, 180, ms) } : null;
    const line = ms >= 100 && ms < 560 ? { k: easeOutCubic((ms - 100) / 180), opacity: 0.9 * (1 - smooth(380, 560, ms)) } : null;
    return {
      ...still,
      opacity: smooth(240, 360, ms),
      reveal: easeOutCubic((ms - 260) / 180),
      dot,
      line,
      shimmer: ms >= 360 ? clamp01((ms - 360) / 260) : null,
      done,
    };
  }
  // C
  const u = easeOutCubic(ms / 300);
  return {
    ...still,
    opacity: smooth(0, 220, ms),
    dy: 6 * (1 - u),
    blur: 4 * (1 - easeOutCubic(ms / 260)),
    shimmer: ms >= 220 ? clamp01((ms - 220) / 340) : null,
    done,
  };
}

/** A point on the send flight's path from `o` to `l` at parameter u (sendMotion's curves). */
export function pathPoint(o: { x: number; y: number }, l: { x: number; y: number }, u: number) {
  return { x: lerp(o.x, l.x, easeOutCubic(u)), y: lerp(o.y, l.y, easeOutQuart(u)) };
}

/**
 * Whether a mounting node plays, and from where. `played` maps a segment's
 * `at` to when its motion began (Date.now ms). Pure but for `played`.
 */
export function decide(
  played: Map<number, number>,
  at: number | undefined,
  live: boolean,
  now: number,
  total: number,
): { play: boolean; from: number } {
  if (!live || at == null) return { play: false, from: 0 };
  for (const [k, t] of played) if (now - t > 10_000) played.delete(k);
  const began = played.get(at);
  if (began !== undefined) {
    const from = now - began;
    return from < total ? { play: true, from } : { play: false, from: 0 };
  }
  if (now - at > FRESH_MS) return { play: false, from: 0 };
  played.set(at, now);
  return { play: true, from: 0 };
}

// ---- the DOM side -----------------------------------------------------------

const SVG = "http://www.w3.org/2000/svg";
const ACCENT = "var(--accent, #e0a458)";
let seq = 0;

/**
 * Where the streak leaves from: the middle of the composer's top edge under
 * the block (else the view's foot). Not the box's left, where the send flight
 * starts: the block sits at the column's left too, and a streak from there
 * rose straight up with no bow (the harness's first frames, 2026-10-18).
 */
function originOf(node: HTMLElement, view: { top: number; bottom: number }, from?: HTMLElement | null): { x: number; y: number } {
  if (from) {
    const fr = from.getBoundingClientRect();
    return { x: fr.left + fr.width / 2, y: fr.top };
  }
  const r = node.getBoundingClientRect();
  let best: DOMRect | null = null;
  document.querySelectorAll<HTMLElement>(".composer").forEach((c) => {
    const cr = c.getBoundingClientRect();
    if (cr.width === 0 || cr.top < r.top || cr.right < r.left || cr.left > r.right) return;
    if (!best || cr.top < best.top) best = cr;
  });
  const b = best as DOMRect | null;
  return b ? { x: b.left + b.width / 2, y: b.top } : { x: r.left + r.width / 2, y: view.bottom - 12 };
}

function viewOf(el: HTMLElement): { top: number; bottom: number } {
  let p = el.parentElement;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll") {
      const r = p.getBoundingClientRect();
      return { top: Math.max(0, r.top), bottom: Math.min(innerHeight, r.bottom) };
    }
    p = p.parentElement;
  }
  return { top: 0, bottom: innerHeight };
}

function overlay() {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("think-arrival");
  svg.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147482999;overflow:visible";
  const id = `think-streak-${++seq}`;
  const defs = document.createElementNS(SVG, "defs");
  const grad = document.createElementNS(SVG, "linearGradient");
  grad.setAttribute("id", id);
  grad.setAttribute("gradientUnits", "userSpaceOnUse");
  for (const [off, op] of [
    ["0", "0"],
    ["0.6", "0.4"],
    ["1", "1"],
  ]) {
    const stop = document.createElementNS(SVG, "stop");
    stop.setAttribute("offset", off);
    stop.style.stopColor = ACCENT;
    stop.setAttribute("stop-opacity", op);
    grad.appendChild(stop);
  }
  defs.appendChild(grad);
  svg.appendChild(defs);
  const streak = document.createElementNS(SVG, "path");
  streak.setAttribute("fill", "none");
  streak.setAttribute("stroke", `url(#${id})`);
  streak.setAttribute("stroke-width", "1.5");
  streak.setAttribute("stroke-linecap", "round");
  const head = document.createElementNS(SVG, "circle");
  head.style.fill = ACCENT;
  head.style.filter = `drop-shadow(0 0 4px ${ACCENT})`;
  const line = document.createElementNS(SVG, "line");
  line.style.stroke = ACCENT;
  line.setAttribute("stroke-width", "1.5");
  line.setAttribute("stroke-linecap", "round");
  line.style.filter = `drop-shadow(0 0 3px ${ACCENT})`;
  svg.append(streak, line, head);
  const shine = document.createElement("div");
  shine.setAttribute("aria-hidden", "true");
  shine.style.cssText =
    "position:fixed;left:0;top:0;pointer-events:none;z-index:2147482999;overflow:hidden;display:none;" +
    "border-radius:8px";
  const band = document.createElement("div");
  band.style.cssText = `position:absolute;top:0;bottom:0;width:40%;background:linear-gradient(90deg,transparent,color-mix(in srgb, ${ACCENT} 22%, transparent),transparent)`;
  shine.appendChild(band);
  return { svg, grad, streak, head, line, shine, band };
}

const PROPS = ["opacity", "transform", "filter", "clipPath", "willChange"] as const;

/**
 * Play `style` on `node` from `from` ms in. `hold` freezes it at that many
 * ms (the harness's still frames; held frames are never cleaned up).
 * `origin`, when given, is the element A's streak leaves from (the top
 * middle of it) instead of the nearest composer — Settings' preview card.
 * Returns a cancel that puts the node back at once.
 */
export function play(
  node: HTMLElement,
  style: ArrivalStyle | "fade",
  from = 0,
  hold: number | null = null,
  origin: HTMLElement | null = null,
): () => void {
  const saved = PROPS.map((k) => node.style[k]);
  const radius = getComputedStyle(node).borderTopLeftRadius || "0px";
  const o = style === "fade" ? null : overlay();
  if (o) document.body.append(o.svg, o.shine);
  let raf = 0;
  let over = false;
  const start = (typeof performance !== "undefined" ? performance.now() : Date.now()) - from;
  const cleanup = () => {
    if (over) return;
    over = true;
    if (raf) cancelAnimationFrame(raf);
    o?.svg.remove();
    o?.shine.remove();
    PROPS.forEach((k, j) => (node.style[k] = saved[j]));
  };
  const paint = (ms: number) => {
    const f = frameAt(style, ms);
    if (f.done) return true;
    node.style.willChange = "opacity, transform";
    node.style.opacity = String(f.opacity);
    node.style.transform = f.dy ? `translateY(${f.dy.toFixed(2)}px)` : "";
    node.style.filter = f.blur > 0.05 ? `blur(${f.blur.toFixed(2)}px)` : "";
    node.style.clipPath = f.reveal < 1 ? `inset(0 0 ${((1 - f.reveal) * 100).toFixed(1)}% 0 round ${radius})` : "";
    if (!o) return false;
    // The block's rect as laid out: undo the drop we applied ourselves.
    const b = node.getBoundingClientRect();
    const r = { left: b.left, right: b.right, top: b.top - f.dy, bottom: b.bottom - f.dy, width: b.width, height: b.height };
    const view = viewOf(node);
    const inView = r.bottom >= view.top && r.top <= view.bottom && r.width > 0;
    const land = style === "B" ? { x: r.left + r.width / 2, y: r.top + 0.5 } : { x: r.left + 14, y: r.top + 0.5 };
    if (inView && f.streak && f.streak.head > 0) {
      const og = originOf(node, view, origin);
      const pts: string[] = [];
      for (let s = 0; s <= 12; s++) {
        const p = pathPoint(og, land, lerp(f.streak.tail, f.streak.head, s / 12));
        pts.push(`${s ? "L" : "M"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`);
      }
      const t = pathPoint(og, land, f.streak.tail);
      const h = pathPoint(og, land, f.streak.head);
      o.streak.setAttribute("d", pts.join(" "));
      o.grad.setAttribute("x1", String(t.x));
      o.grad.setAttribute("y1", String(t.y));
      o.grad.setAttribute("x2", String(h.x));
      o.grad.setAttribute("y2", String(h.y));
      o.streak.style.opacity = String(f.streak.opacity);
      o.head.setAttribute("cx", String(h.x));
      o.head.setAttribute("cy", String(h.y));
      o.head.setAttribute("r", f.streak.head < 1 ? "2.2" : "0");
      o.head.style.opacity = String(f.streak.opacity);
      o.streak.style.display = "";
      o.head.style.display = "";
    } else if (inView && f.dot) {
      o.streak.style.display = "none";
      o.head.setAttribute("cx", String(land.x));
      o.head.setAttribute("cy", String(land.y));
      o.head.setAttribute("r", f.dot.r.toFixed(2));
      o.head.style.opacity = String(f.dot.opacity);
      o.head.style.display = "";
    } else {
      o.streak.style.display = "none";
      o.head.style.display = "none";
    }
    if (inView && f.line && f.line.k > 0) {
      const x0 = lerp(land.x, r.left + 6, f.line.k);
      const x1 = lerp(land.x, r.right - 6, f.line.k);
      o.line.setAttribute("x1", x0.toFixed(1));
      o.line.setAttribute("x2", x1.toFixed(1));
      o.line.setAttribute("y1", land.y.toFixed(1));
      o.line.setAttribute("y2", land.y.toFixed(1));
      o.line.style.opacity = String(f.line.opacity);
      o.line.style.display = "";
    } else o.line.style.display = "none";
    if (inView && f.shimmer !== null && f.shimmer < 1) {
      o.shine.style.display = "";
      o.shine.style.transform = `translate(${r.left}px, ${r.top}px)`;
      o.shine.style.width = `${r.width}px`;
      o.shine.style.height = `${Math.min(r.height, 64)}px`;
      o.band.style.left = `${lerp(-40, 100, easeOutCubic(f.shimmer)).toFixed(1)}%`;
    } else o.shine.style.display = "none";
    return false;
  };
  if (hold !== null) {
    paint(hold);
    return cleanup;
  }
  const tick = () => {
    raf = 0;
    if (over) return;
    if (paint((typeof performance !== "undefined" ? performance.now() : Date.now()) - start)) cleanup();
    else raf = requestAnimationFrame(tick);
  };
  tick();
  return cleanup;
}

const played = new Map<number, number>();

export interface ArrivalParams {
  /** The thinking segment's creation clock (`seg.at`). */
  at?: number;
  /** The row is live: the reply streams and this thinking is not done. */
  live: boolean;
}

/** The Svelte action on the block (or row) a live thinking segment brings. Decides once, at mount. */
export function thinkingArrival(node: HTMLElement, p: ArrivalParams) {
  const w = typeof window !== "undefined" ? (window as unknown as { __thinkingArrival?: ArrivalStyle; __thinkingArrivalHold?: number }) : {};
  const style: ArrivalStyle | "fade" = reducedMotion() ? "fade" : (w.__thinkingArrival ?? chosenArrival());
  if (typeof document === "undefined") return {};
  const d = decide(played, p.at, p.live, Date.now(), DURATION[style]);
  if (!d.play) return {};
  const cancel = play(node, style, d.from, typeof w.__thinkingArrivalHold === "number" ? w.__thinkingArrivalHold : null);
  return { destroy: cancel };
}
