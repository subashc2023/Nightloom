/**
 * The send motion (nightshift backlog 194, 2026-09-25): a sent message
 * travels from where it was typed into its place in the thread, trailing a
 * thin accent thread — the loom's shuttle carrying the weft across.
 *
 * One module for every composer. The composer calls `launch(channel, el)`
 * at the moment its box clears, naming where the words were; the thread's
 * new bubble carries `use:arrive={{ channel }}`, and when it mounts (or its
 * `active` turns true) it takes the pending launch and flies:
 *
 *   0–340 ms   a ghost of the bubble — a copy with the bubble's computed
 *              look, fixed over the page, so no scroll box clips it — lifts
 *              from the box to the bubble's place. It rises fast and drifts
 *              across later (y eased harder than x), so the path bows; its
 *              tint fills in over the first 45 %: the typed text becomes a
 *              bubble on the way. The thread runs from the launch point to
 *              the ghost's foot, brightest near the ghost, fading out.
 *   340–520    the real turn fades in under the ghost (seamless: the ghost
 *              sits exactly over the bubble), then the ghost goes.
 *   340–760    a soft accent ring settles out from the landed bubble.
 *
 * Only transforms and a fixed overlay move; the real node keeps its box
 * throughout (opacity only), so nothing in the transcript shifts. The
 * target is re-measured every frame, so the transcript's own scroll to the
 * foot does not fight it. No launch pending, the target out of view, or
 * `prefers-reduced-motion: reduce` → no flight (the transcript keeps its
 * short rise for a turn with no launch, and nothing when motion is reduced).
 *
 * The whole timeline is `frameAt(ms)`, a pure function, so the harness can
 * hold any instant (`window.__sendMotionHold = ms`) and the tests can read it.
 */

export const FLIGHT_MS = 340;
export const REVEAL_MS = 180;
export const SETTLE_MS = 420;
export const TOTAL_MS = FLIGHT_MS + SETTLE_MS;
/** A launch not taken within this long is stale (the send failed, or went to the queue). */
export const LAUNCH_TTL_MS = 1500;

export interface Launch {
  channel: string;
  at: number;
  /** Where the words were: the box's rect, inset by its padding. */
  x: number;
  y: number;
  w: number;
  h: number;
}

let pending: Launch | null = null;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Record where a message left from. `el` is the box (or the queue row); null records nothing. */
export function launch(channel: string, el: Element | null | undefined, at: number = now()): void {
  if (!el || typeof getComputedStyle === "undefined") return;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const pl = parseFloat(cs.paddingLeft) || 0;
  const pt = parseFloat(cs.paddingTop) || 0;
  pending = { channel, at, x: r.left + pl, y: r.top + pt, w: Math.max(0, r.width - 2 * pl), h: r.height };
}

/** For tests and callers that measured already. */
export function launchAt(l: Launch): void {
  pending = l;
}

/** Take the pending launch if it is this channel's and fresh; it is consumed either way it matches. */
export function takeLaunch(channel: string, at: number = now()): Launch | null {
  const l = pending;
  if (!l || l.channel !== channel) return null;
  pending = null;
  return at - l.at <= LAUNCH_TTL_MS ? l : null;
}

export function reducedMotion(): boolean {
  const w = typeof window !== "undefined" ? (window as unknown as { __sendMotionReduce?: boolean }) : null;
  if (w?.__sendMotionReduce) return true;
  try {
    return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// ---- the timeline, pure -----------------------------------------------------

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeOutQuart = (t: number) => 1 - Math.pow(1 - clamp01(t), 4);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);
const smooth = (a: number, b: number, t: number) => {
  const u = clamp01((t - a) / (b - a));
  return u * u * (3 - 2 * u);
};

export interface Box {
  x: number;
  y: number;
}

export interface Frame {
  /** The ghost's top-left. */
  x: number;
  y: number;
  /** 0..1: how much of the bubble's tint the ghost carries. */
  tint: number;
  ghostOpacity: number;
  /** The accent thread's opacity; 0 = not drawn. */
  thread: number;
  /** The real node's opacity. */
  node: number;
  /** 0..1 progress of the settle ring; null = no ring. */
  ring: number | null;
  /** The ghost is still on the page. */
  ghost: boolean;
  done: boolean;
}

/** The whole motion at `ms` after it starts, from `from` (the box) to `to` (the bubble, now). */
export function frameAt(ms: number, from: Box, to: Box): Frame {
  const t = clamp01(ms / FLIGHT_MS);
  // y leads x: the bubble lifts off the box first, then drifts across — a
  // bowed path rather than a diagonal slide.
  const x = lerp(from.x, to.x, easeOutCubic(t));
  const y = lerp(from.y, to.y, easeOutQuart(t));
  const after = ms - FLIGHT_MS;
  const node = after <= 0 ? 0 : clamp01(after / REVEAL_MS);
  const threadUp = smooth(0, 0.2, t);
  const threadDown = 1 - smooth(0.55, 1.15, ms / FLIGHT_MS);
  return {
    x,
    y,
    tint: smooth(0, 0.45, t),
    ghostOpacity: 0.55 + 0.45 * smooth(0, 0.3, t),
    thread: 0.9 * threadUp * threadDown,
    node,
    ring: after < 0 ? null : after >= SETTLE_MS ? null : after / SETTLE_MS,
    ghost: after < REVEAL_MS,
    done: ms >= TOTAL_MS,
  };
}

// ---- the DOM side -----------------------------------------------------------

const COPIED = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "color",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
  "textAlign",
] as const;

function ghostOf(bubble: HTMLElement): { el: HTMLElement; bg: string } {
  const cs = getComputedStyle(bubble);
  const el = bubble.cloneNode(true) as HTMLElement;
  el.removeAttribute("id");
  el.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
  el.setAttribute("aria-hidden", "true");
  el.classList.add("send-ghost");
  const s = el.style;
  for (const k of COPIED) s[k] = cs[k];
  s.position = "fixed";
  s.left = "0";
  s.top = "0";
  s.margin = "0";
  s.boxSizing = "border-box";
  s.width = `${bubble.getBoundingClientRect().width}px`;
  s.maxWidth = "none";
  s.border = "1px solid transparent";
  s.pointerEvents = "none";
  s.zIndex = "2147483000";
  s.willChange = "transform, opacity";
  return { el, bg: cs.backgroundColor };
}

const SVG = "http://www.w3.org/2000/svg";
let threadSeq = 0;

function threadOf(): { svg: SVGSVGElement; path: SVGPathElement; grad: SVGLinearGradientElement } {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147482999;overflow:visible";
  const id = `send-thread-${++threadSeq}`;
  const defs = document.createElementNS(SVG, "defs");
  const grad = document.createElementNS(SVG, "linearGradient");
  grad.setAttribute("id", id);
  grad.setAttribute("gradientUnits", "userSpaceOnUse");
  for (const [off, op] of [
    ["0", "0"],
    ["0.55", "0.35"],
    ["1", "1"],
  ]) {
    const stop = document.createElementNS(SVG, "stop");
    stop.setAttribute("offset", off);
    stop.setAttribute("stop-color", "var(--accent, #e0a458)");
    stop.style.stopColor = "var(--accent, #e0a458)";
    stop.setAttribute("stop-opacity", op);
    grad.appendChild(stop);
  }
  defs.appendChild(grad);
  svg.appendChild(defs);
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", `url(#${id})`);
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  svg.appendChild(path);
  return { svg, path, grad };
}

/** The nearest scrolling ancestor's visible rect, or the window's. */
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

/**
 * Fly `bubble` (inside `node`) in from `l`. Returns a cancel that puts
 * everything back at once. `hold` freezes the motion at that many ms (the
 * harness's still frames); held frames are never cleaned up.
 */
export function fly(node: HTMLElement, bubble: HTMLElement, l: Launch, hold: number | null = null): () => void {
  const first = bubble.getBoundingClientRect();
  const view = viewOf(node);
  if (first.bottom < view.top || first.top > view.bottom || first.width === 0) return () => {};
  const { el: ghost, bg } = ghostOf(bubble);
  const { svg, path, grad } = threadOf();
  const from: Box = { x: l.x - (parseFloat(ghost.style.paddingLeft) || 0), y: l.y - (parseFloat(ghost.style.paddingTop) || 0) };
  // The thread is tied where the words were: the box's first line, left.
  const ax = l.x + 6;
  const ay = l.y + 8;
  node.style.opacity = "0";
  document.body.appendChild(svg);
  document.body.appendChild(ghost);
  let raf = 0;
  let over = false;
  const start = now();
  const cleanup = () => {
    if (over) return;
    over = true;
    cancelAnimationFrame(raf);
    ghost.remove();
    svg.remove();
    node.style.opacity = "";
    bubble.style.boxShadow = "";
  };
  const paint = (ms: number) => {
    const to = bubble.getBoundingClientRect();
    const f = frameAt(ms, from, { x: to.left, y: to.top });
    ghost.style.transform = `translate3d(${f.x}px, ${f.y}px, 0)`;
    ghost.style.opacity = String(f.ghostOpacity);
    ghost.style.backgroundColor = `color-mix(in srgb, ${bg} ${Math.round(f.tint * 100)}%, transparent)`;
    ghost.style.display = f.ghost ? "" : "none";
    node.style.opacity = f.node >= 1 ? "" : String(f.node);
    if (f.thread > 0.01) {
      const gh = ghost.offsetHeight;
      const bx = f.x + Math.min(ghost.offsetWidth / 2, 40);
      const by = f.y + gh;
      // Leaves the box straight up, then bends toward the ghost's foot.
      path.setAttribute("d", `M ${ax} ${ay} C ${ax} ${lerp(ay, by, 0.6)}, ${bx} ${lerp(ay, by, 0.5)}, ${bx} ${by}`);
      grad.setAttribute("x1", String(ax));
      grad.setAttribute("y1", String(ay));
      grad.setAttribute("x2", String(bx));
      grad.setAttribute("y2", String(by));
      path.style.opacity = String(f.thread);
      svg.style.display = "";
    } else svg.style.display = "none";
    bubble.style.boxShadow =
      f.ring === null
        ? ""
        : `0 0 0 ${(1 + 9 * easeOutCubic(f.ring)).toFixed(2)}px color-mix(in srgb, var(--accent, #e0a458) ${Math.round(38 * (1 - f.ring))}%, transparent)`;
    return f.done;
  };
  if (hold !== null) {
    paint(hold);
    return cleanup;
  }
  const tick = () => {
    if (over) return;
    if (paint(now() - start)) cleanup();
    else raf = requestAnimationFrame(tick);
  };
  tick();
  return cleanup;
}

/** The transcript's rise for a turn that arrives with no launch (backlog 095's motion). */
export function rise(node: HTMLElement): void {
  if (reducedMotion() || typeof node.animate !== "function") return;
  node.animate(
    [
      { opacity: 0, transform: "translateY(6px)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 180, easing: "ease-out", fill: "backwards" },
  );
}

export interface ArriveParams {
  channel: string;
  /** False until this node is the one just sent (the transcript's index floor); default true. */
  active?: boolean;
  /** The bubble inside the node, by selector; default the node itself. */
  bubble?: string;
  /** With no launch pending, rise gently instead of standing still. */
  riseWithout?: boolean;
}

/** A Svelte action on the thread's new bubble. Fires at most once per node. */
export function arrive(node: HTMLElement, params: ArriveParams) {
  let fired = false;
  let cancel: (() => void) | null = null;
  const check = (p: ArriveParams) => {
    if (fired || p.active === false) return;
    fired = true;
    const l = takeLaunch(p.channel);
    if (reducedMotion()) return;
    if (!l) {
      if (p.riseWithout) rise(node);
      return;
    }
    const bubble = (p.bubble ? node.querySelector<HTMLElement>(p.bubble) : null) ?? node;
    const w = window as unknown as { __sendMotionHold?: number };
    cancel = fly(node, bubble, l, typeof w.__sendMotionHold === "number" ? w.__sendMotionHold : null);
  };
  check(params);
  return {
    update: (p: ArriveParams) => check(p),
    destroy: () => cancel?.(),
  };
}
