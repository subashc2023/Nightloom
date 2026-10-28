/**
 * The rewind and delete motions on his messages (nightshift backlog 396 and
 * 397, his asks 2026-10-19: "a small animation for clicking rewind on one of
 * my messages", and the same for delete). Until now a rewind cut the thread
 * back in one frame and a delete swapped the bubble for its placeholder in
 * one frame.
 *
 * The state change is never held back. Just before the call, `prepare…` lays
 * a copy of what is about to change exactly over it — nothing visibly moves.
 * When the call lands, the caller says `commit()`: on the next frame the real
 * thread has changed under the copy, and the copy plays out over it. If the
 * call failed or was refused (the thread did not change), the copy is simply
 * removed on that frame. Rows that shift because of the change (the scroll
 * clamping after a rewind shortens the thread; a long message becoming the
 * one-line placeholder) slide from where they were to where they are now.
 *
 * Rewind, three looks; the app plays the one he picked in Settings →
 * Appearance → Animations (backlog 396 + 397 pass 2, his "make the default
 * A for both", 2026-10-19), stored as `nightloom.rewindMotion`, default
 * `REWIND_STYLE`:
 *   A, reel back (built): the send played backwards. His bubble travels back
 *      along the send flight's own bowed path into the composer box, the
 *      accent thread trailing to the box, its tint draining so it becomes
 *      typed text again; the rows below it leave bottom-up, each dropping
 *      14 px and fading; then the paper under the copy fades to show the
 *      "N messages rewound" line, and a soft accent ring settles out from
 *      the box his words went back into.
 *        0–400 ms   rows leave, the last one first (40 ms apart at most)
 *        60–400     his bubble flies back (340 ms, the send's FLIGHT_MS), fading as it lands
 *        260–440    the copy's paper fades; the thread above slides into place 120–480
 *        400–600    the ring on the composer
 *   B, fold up: everything from his message down folds up into a thin
 *      accent line at his message's top edge, which then shrinks away.
 *   C, drain: the copy drops 20 px, blurs and fades as one; a ring on the box.
 *
 * Delete, three looks; the app plays his pick, `nightloom.deleteMotion`,
 * default `DELETE_STYLE`:
 *   A, struck and lifted (built): an accent line strikes through each line of the bubble
 *      left to right, then the struck bubble lifts 10 px and fades, and the
 *      greyed placeholder fades in where it was.
 *        0–160 ms   the strike draws
 *        160–380    the bubble lifts away; rows below slide 160–460
 *        260–460    the placeholder fades in
 *   B, shrink to the placeholder: the bubble's copy shrinks onto the
 *      placeholder's box while the two cross-fade.
 *   C, dissolve: the bubble blurs out; the placeholder fades in.
 *
 * Under `prefers-reduced-motion: reduce`, every look is a plain 180 ms fade
 * and nothing moves.
 *
 * The timelines are pure (`rewindFrame`, `rewindRow`, `deleteFrame`) so the
 * tests can read them and the harness can hold any instant
 * (`window.__messageMotionHold = ms`; `window.__messageMotion =
 * { rewind: "B", delete: "C" }` overrides the looks for the demo).
 */

import { FLIGHT_MS, easeOutCubic, easeOutQuart, reducedMotion } from "./sendMotion";

export type MotionStyle = "A" | "B" | "C";
/** The rewind look when he has not picked one in Settings (his default, 2026-10-19). */
export const REWIND_STYLE: MotionStyle = "A";
/** The delete look when he has not picked one in Settings (his default, 2026-10-19). */
export const DELETE_STYLE: MotionStyle = "A";

export type MotionKind = "rewind" | "delete";
/** The looks Settings → Appearance → Animations offers for each (all three, his yes 2026-10-19). */
export const OFFERED_MOTIONS: Record<MotionKind, { id: MotionStyle; name: string; blurb: string }[]> = {
  rewind: [
    { id: "A", name: "Reel back", blurb: "Your message flies back into the box along the send's path; the replies under it drop away." },
    { id: "B", name: "Fold up", blurb: "Everything from your message down folds up into a thin line, which shrinks away." },
    { id: "C", name: "Drain", blurb: "Your message and the replies under it sink, blur and fade as one." },
  ],
  delete: [
    { id: "A", name: "Struck and lifted", blurb: "A line strikes through your words, then the message lifts away and the placeholder fades in." },
    { id: "B", name: "Shrink", blurb: "The message shrinks onto the placeholder as the two cross-fade." },
    { id: "C", name: "Dissolve", blurb: "The message blurs out and the placeholder fades in." },
  ],
};
export const MOTION_KEY: Record<MotionKind, string> = { rewind: "nightloom.rewindMotion", delete: "nightloom.deleteMotion" };
const DEFAULT_MOTION: Record<MotionKind, MotionStyle> = { rewind: REWIND_STYLE, delete: DELETE_STYLE };

/** The look he picked for `kind`, from localStorage; the default when unset, unreadable or not offered. */
export function chosenMotion(kind: MotionKind): MotionStyle {
  try {
    const raw = localStorage.getItem(MOTION_KEY[kind]);
    if (raw && OFFERED_MOTIONS[kind].some((s) => s.id === raw)) return raw as MotionStyle;
  } catch {
    // A malformed preference costs the preference, not the feature.
  }
  return DEFAULT_MOTION[kind];
}

/** Remember his pick for `kind`. Only an offered look is stored. */
export function setChosenMotion(kind: MotionKind, style: MotionStyle): void {
  if (!OFFERED_MOTIONS[kind].some((s) => s.id === style)) return;
  try {
    localStorage.setItem(MOTION_KEY[kind], style);
  } catch {
    // best-effort
  }
}

/**
 * What Settings' preview passes to `prepare…`: the look to play (reduced
 * motion still makes it a fade) and the box a rewind's A flies into,
 * instead of the app's composer under the scroll box.
 */
export interface PrepareOptions {
  style?: MotionStyle;
  composer?: HTMLElement | null;
  /** The selector of his message's row, where it is not the transcript's
   *  `.user-turn[data-turn=…]` — an aside's thread (item 403), whose rows
   *  are `.aside-q[data-turn=…]` in the same column shape. */
  row?: string;
}

export const DURATION: Record<"rewind" | "delete", Record<MotionStyle | "fade", number>> = {
  rewind: { A: 600, B: 460, C: 400, fade: 180 },
  delete: { A: 460, B: 400, C: 380, fade: 180 },
};
/** A prepared copy whose call never lands lets go after this long. */
export const PENDING_TTL_MS = 2500;
/** Under the app's popovers and dialogs, over the transcript and the composer. */
const Z = "60";

// ---- the timelines, pure ---------------------------------------------------

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, t: number) => {
  const u = clamp01((t - a) / (b - a));
  return u * u * (3 - 2 * u);
};

export interface RewindFrame {
  /** Opacity of the paper behind the copy (it hides the new state until it fades). */
  bg: number;
  /** The whole copy: opacity, extra drop (px, + down), vertical scale from its top, blur px. */
  cover: { opacity: number; dy: number; scaleY: number; blur: number };
  /** B's fold line along his message's top edge: 0..1 of the width, centred. */
  line: { k: number; opacity: number } | null;
  /** A's flight back to the box: `s` 0..1 along the reversed send path. */
  flight: { s: number; opacity: number; tint: number; thread: number } | null;
  /** 0..1 progress of the ring on the composer; null = none. */
  ring: number | null;
  /** 0..1: how far the rows above have slid to their new place. */
  shift: number;
  done: boolean;
}

export function rewindFrame(style: MotionStyle | "fade", ms: number): RewindFrame {
  const done = ms >= DURATION.rewind[style];
  const rest: RewindFrame = {
    bg: 0,
    cover: { opacity: 0, dy: 0, scaleY: 1, blur: 0 },
    line: null,
    flight: null,
    ring: null,
    shift: 1,
    done: true,
  };
  if (done) return rest;
  const still = { opacity: 1, dy: 0, scaleY: 1, blur: 0 };
  if (style === "fade") {
    return {
      ...rest,
      bg: 1,
      cover: { ...still, opacity: 1 - easeOutCubic(ms / DURATION.rewind.fade) },
      done,
    };
  }
  if (style === "A") {
    const s = clamp01((ms - 60) / FLIGHT_MS);
    const land = 60 + FLIGHT_MS;
    // It fades out as it lands (gone at the box): its words wrap at the bubble's width, the box's at its own.
    const flight =
      ms < land
        ? {
            s,
            opacity: 1 - smooth(0.65, 1, s),
            tint: 1 - smooth(0.55, 1, s),
            thread: 0.9 * smooth(0, 0.25, s) * (1 - smooth(0.75, 1, s)),
          }
        : null;
    return {
      ...rest,
      bg: 1 - smooth(260, 440, ms),
      cover: still,
      flight,
      ring: ms >= 400 ? (ms - 400) / 200 : null,
      shift: easeOutCubic((ms - 120) / 360),
      done,
    };
  }
  if (style === "B") {
    const fold = smooth(0, 300, ms);
    return {
      ...rest,
      bg: 1,
      cover: {
        opacity: 1 - 0.7 * smooth(120, 300, ms),
        dy: 0,
        scaleY: Math.max(0, 1 - fold),
        blur: 0,
      },
      line: {
        k: 1 - easeOutCubic((ms - 300) / 160),
        opacity: 0.9 * smooth(0, 80, ms) * (1 - smooth(340, 460, ms)),
      },
      shift: easeOutCubic(ms / 360),
      done,
    };
  }
  // C
  const u = smooth(0, 320, ms);
  return {
    ...rest,
    bg: 1,
    cover: { opacity: 1 - u, dy: 20 * u, scaleY: 1, blur: 3 * u },
    ring: ms >= 220 ? (ms - 220) / 180 : null,
    shift: easeOutCubic(ms / 320),
    done,
  };
}

/**
 * One row of the rewind's copy (A only; B and C move the copy whole): `k`
 * counts from the bottom (0 = the last row), `n` rows in all. They leave
 * the last first, at most 40 ms apart and all started within 200 ms.
 */
export function rewindRow(style: MotionStyle | "fade", ms: number, k: number, n: number): { opacity: number; dy: number } {
  if (style !== "A") return { opacity: 1, dy: 0 };
  const gap = n > 1 ? Math.min(40, 200 / (n - 1)) : 0;
  const u = smooth(0, 1, (ms - gap * k) / 200);
  return { opacity: 1 - u, dy: 14 * u };
}

/** The send flight's path played backwards: at s = 0 on the bubble, at 1 in the box. */
export function flightPoint(bubble: { x: number; y: number }, box: { x: number; y: number }, s: number) {
  const t = 1 - clamp01(s);
  return {
    x: lerp(box.x, bubble.x, easeOutCubic(t)),
    y: lerp(box.y, bubble.y, easeOutQuart(t)),
  };
}

export interface DeleteFrame {
  /** The copy of his bubble as it was. */
  ghost: { opacity: number; dy: number; scale: number; blur: number };
  /** B: 0..1 of the way from the bubble's old box onto the placeholder's. */
  morph: number | null;
  /** A's strike through the bubble: 0..1 of its width, from the left. */
  strike: { k: number; opacity: number } | null;
  /** The placeholder, as a share of its own (greyed) opacity. */
  node: number;
  /** 0..1: how far shifted rows have slid to their new place. */
  shift: number;
  done: boolean;
}

export function deleteFrame(style: MotionStyle | "fade", ms: number): DeleteFrame {
  const done = ms >= DURATION.delete[style];
  const rest: DeleteFrame = {
    ghost: { opacity: 0, dy: 0, scale: 1, blur: 0 },
    morph: null,
    strike: null,
    node: 1,
    shift: 1,
    done: true,
  };
  if (done) return rest;
  if (style === "fade") {
    const e = easeOutCubic(ms / DURATION.delete.fade);
    return {
      ...rest,
      ghost: { opacity: 1 - e, dy: 0, scale: 1, blur: 0 },
      node: e,
      done,
    };
  }
  if (style === "A") {
    const u = smooth(160, 380, ms);
    return {
      ...rest,
      ghost: { opacity: 1 - u, dy: -10 * u, scale: 1 - 0.03 * u, blur: 0 },
      strike: { k: easeOutCubic(ms / 160), opacity: 0.9 * (1 - u) },
      node: smooth(260, 460, ms),
      shift: easeOutCubic((ms - 160) / 300),
      done,
    };
  }
  if (style === "B") {
    return {
      ...rest,
      ghost: { opacity: 1 - smooth(60, 300, ms), dy: 0, scale: 1, blur: 0 },
      morph: easeOutCubic(ms / 320),
      node: smooth(100, 400, ms),
      shift: easeOutCubic(ms / 320),
      done,
    };
  }
  // C
  const u = smooth(0, 300, ms);
  return {
    ...rest,
    ghost: { opacity: 1 - u, dy: 0, scale: 1, blur: 6 * u },
    node: smooth(120, 380, ms),
    shift: easeOutCubic(ms / 300),
    done,
  };
}

// ---- the DOM side ----------------------------------------------------------

type Win = {
  __messageMotion?: { rewind?: MotionStyle; delete?: MotionStyle };
  __messageMotionHold?: number;
};
const win = () => (typeof window !== "undefined" ? (window as unknown as Win) : ({} as Win));

function styleFor(kind: MotionKind, asked?: MotionStyle): MotionStyle | "fade" {
  if (reducedMotion()) return "fade";
  return asked ?? win().__messageMotion?.[kind] ?? chosenMotion(kind);
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

const ACCENT = "var(--accent, #e0a458)";

/** The scroll box's visible rect, inside the window. */
function viewOf(viewport: HTMLElement) {
  const r = viewport.getBoundingClientRect();
  return {
    left: Math.max(0, r.left),
    top: Math.max(0, r.top),
    right: Math.min(innerWidth, r.right),
    bottom: Math.min(innerHeight, r.bottom),
  };
}

/** The first solid background behind `el`: the copy's paper. */
function paperOf(el: HTMLElement): string {
  let p: HTMLElement | null = el;
  while (p) {
    const bg = getComputedStyle(p).backgroundColor;
    if (bg && bg !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(bg)) return bg;
    p = p.parentElement;
  }
  return "var(--paper, #111)";
}

function bare(el: HTMLElement): HTMLElement {
  const c = el.cloneNode(true) as HTMLElement;
  c.removeAttribute("id");
  c.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
  c.setAttribute("aria-hidden", "true");
  c.setAttribute("inert", "");
  return c;
}

const LOOK = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "color",
  "backgroundColor",
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
  "opacity",
] as const;

/** A fixed copy of `el` with its computed look, over its own box. */
function lookAlike(el: HTMLElement, r: DOMRect): HTMLElement {
  const cs = getComputedStyle(el);
  const c = bare(el);
  const s = c.style;
  for (const k of LOOK) s[k] = cs[k];
  s.position = "fixed";
  s.left = "0";
  s.top = "0";
  s.margin = "0";
  s.boxSizing = "border-box";
  s.width = `${r.width}px`;
  s.height = `${r.height}px`;
  s.maxWidth = "none";
  s.border = "1px solid transparent";
  s.pointerEvents = "none";
  s.zIndex = Z;
  s.transformOrigin = "0 0";
  s.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
  s.willChange = "transform, opacity";
  return c;
}

/** The lines of text in `el`, relative to its box `r`: where each line's words run, and its middle. At most 12. */
function linesOf(el: HTMLElement, r: DOMRect): { left: number; width: number; mid: number }[] {
  const out: { left: number; right: number; top: number; bottom: number }[] = [];
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    for (const q of Array.from(range.getClientRects())) {
      if (q.width < 1 || q.height < 1) continue;
      const same = out.find((l) => Math.abs(l.top - q.top) < 3);
      if (same) {
        same.left = Math.min(same.left, q.left);
        same.right = Math.max(same.right, q.right);
        same.bottom = Math.max(same.bottom, q.bottom);
      } else
        out.push({
          left: q.left,
          right: q.right,
          top: q.top,
          bottom: q.bottom,
        });
    }
  } catch {
    // no ranges: the fallback below
  }
  const lines = out.slice(0, 12).map((l) => ({
    left: l.left - r.left,
    width: l.right - l.left,
    mid: (l.top + l.bottom) / 2 - r.top,
  }));
  return lines.length ? lines : [{ left: 12, width: Math.max(0, r.width - 24), mid: r.height / 2 }];
}

/** Rows that might shift, with where they are now. */
function rowsNear(inner: Element, view: { top: number; bottom: number }, skip: (el: HTMLElement) => boolean) {
  const out: { el: HTMLElement; top: number; transform: string }[] = [];
  for (const c of Array.from(inner.children)) {
    const el = c as HTMLElement;
    if (skip(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.bottom < view.top - 400 || r.top > view.bottom + 400) continue;
    out.push({ el, top: r.top, transform: el.style.transform });
  }
  return out;
}

/** The composer under the transcript: the box his words go back into. */
function composerOf(viewport: HTMLElement): HTMLElement | null {
  const v = viewport.getBoundingClientRect();
  let best: HTMLElement | null = null;
  let bestTop = Infinity;
  document.querySelectorAll<HTMLElement>(".composer").forEach((c) => {
    const r = c.getBoundingClientRect();
    if (r.width === 0 || r.top < v.bottom - 60 || r.right < v.left || r.left > v.right) return;
    if (r.top < bestTop) {
      best = c;
      bestTop = r.top;
    }
  });
  return best;
}

/** Where the typed text starts in the composer. */
function landingOf(composer: HTMLElement): { x: number; y: number } {
  const box = composer.querySelector<HTMLElement>("textarea, [contenteditable]") ?? composer;
  const r = box.getBoundingClientRect();
  const cs = getComputedStyle(box);
  return {
    x: r.left + (parseFloat(cs.paddingLeft) || 0),
    y: r.top + (parseFloat(cs.paddingTop) || 0),
  };
}

const SVG = "http://www.w3.org/2000/svg";
let seq = 0;

function threadOf(): {
  svg: SVGSVGElement;
  path: SVGPathElement;
  grad: SVGLinearGradientElement;
} {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("msg-motion");
  svg.style.cssText = `position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:${Z};overflow:visible`;
  const id = `msg-thread-${++seq}`;
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
    stop.setAttribute("stop-color", ACCENT);
    stop.style.stopColor = ACCENT;
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

const ring = (p: number) =>
  `0 0 0 ${(1 + 9 * easeOutCubic(p)).toFixed(2)}px color-mix(in srgb, ${ACCENT} ${Math.round(38 * (1 - p))}%, transparent)`;

export interface Prepared {
  /** The call landed: play over the changed thread (or let go, if it did not change). */
  commit: () => void;
  /** The call failed: take the copy away now. */
  cancel: () => void;
}

/** On the next frame, once the state change has drawn; a held instant (the harness's still frames) at once. */
function nextFrame(go: () => void): void {
  if (typeof win().__messageMotionHold === "number") go();
  else requestAnimationFrame(go);
}

/** Drive `paint(ms)` until it says done, then `cleanup`; a held instant paints once and stays. */
function run(paint: (ms: number) => boolean, cleanup: () => void): () => void {
  const hold = win().__messageMotionHold;
  if (typeof hold === "number") {
    paint(hold);
    return cleanup;
  }
  let raf = 0;
  let over = false;
  const start = now();
  const tick = () => {
    if (over) return;
    if (paint(now() - start)) stop();
    else raf = requestAnimationFrame(tick);
  };
  const stop = () => {
    if (over) return;
    over = true;
    cancelAnimationFrame(raf);
    cleanup();
  };
  tick();
  return stop;
}

/**
 * Before a rewind to his message at log index `index`: lay the copy of his
 * message and everything below it over the thread. Null when there is
 * nothing to draw (no DOM, the row is not on screen).
 */
export function prepareRewind(
  viewport: HTMLElement | null | undefined,
  index: number,
  opts: PrepareOptions = {},
): Prepared | null {
  if (!viewport || typeof document === "undefined" || typeof requestAnimationFrame !== "function") return null;
  const rowSel = opts.row ?? `.user-turn[data-turn="${index}"]`;
  const row = viewport.querySelector<HTMLElement>(rowSel);
  const inner = row?.parentElement;
  if (!row || !inner) return null;
  const view = viewOf(viewport);
  const rr = row.getBoundingClientRect();
  if (rr.top > view.bottom || rr.bottom < view.top || rr.width === 0) return null;
  const style = styleFor("rewind", opts.style);
  const top = Math.max(rr.top, view.top);

  // The copy: a window over the scroll box from his message down, on the paper.
  const cover = document.createElement("div");
  cover.className = "msg-motion msg-rewind";
  cover.setAttribute("aria-hidden", "true");
  cover.style.cssText = `position:fixed;left:${view.left}px;top:${top}px;width:${view.right - view.left}px;height:${Math.max(0, view.bottom - top)}px;overflow:hidden;pointer-events:none;z-index:${Z}`;
  // The window stays put and clips; the sheet inside it moves, so nothing drawn ever leaves the scroll box.
  const sheet = document.createElement("div");
  sheet.className = "msg-sheet";
  const cs = sheet.style;
  cs.cssText = "position:absolute;inset:0;transform-origin:50% 0";
  cover.appendChild(sheet);
  const paper = document.createElement("div");
  paper.style.cssText = `position:absolute;inset:0;background:${paperOf(viewport)}`;
  sheet.appendChild(paper);
  const rows: HTMLElement[] = [];
  let mine: HTMLElement | null = null;
  let on = false;
  for (const c of Array.from(inner.children)) {
    const el = c as HTMLElement;
    if (el === row) on = true;
    if (!on) continue;
    const r = el.getBoundingClientRect();
    if (r.height === 0 || r.bottom < top || r.top > view.bottom) continue;
    const k = bare(el);
    const s = k.style;
    s.position = "absolute";
    s.left = `${r.left - view.left}px`;
    s.top = `${r.top - top}px`;
    s.width = `${r.width}px`;
    s.margin = "0";
    s.boxSizing = "border-box";
    s.transform = "";
    s.opacity = "";
    sheet.appendChild(k);
    rows.push(k);
    if (el === row) mine = k;
  }
  const line = document.createElement("div");
  line.style.cssText = `position:absolute;left:6px;right:6px;top:0;height:1.5px;border-radius:1px;background:${ACCENT};display:none`;
  cover.appendChild(line);
  const above = rowsNear(inner, view, (el) => el === row || !!(row.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
  const bubble = row.querySelector<HTMLElement>(".user-bubble");
  const br = bubble?.getBoundingClientRect() ?? null;
  const flier = bubble && br && br.width > 0 && style === "A" ? lookAlike(bubble, br) : null;
  const bubbleBg = bubble ? getComputedStyle(bubble).backgroundColor : "transparent";
  viewport.appendChild(cover);

  let committed = false;
  let stop: (() => void) | null = null;
  const remove = () => {
    clearTimeout(ttl);
    cover.remove();
  };
  const ttl = setTimeout(() => {
    if (!committed) remove();
  }, PENDING_TTL_MS);

  return {
    cancel: () => {
      committed = true;
      stop?.();
      remove();
    },
    commit: () => {
      if (committed) return;
      committed = true;
      clearTimeout(ttl);
      nextFrame(() => {
        // Nothing changed (refused, busy, failed): let go.
        if (row.isConnected && row.matches(opts.row ?? ".user-turn")) return remove();
        const moved = above.map((a) => ({
          ...a,
          d: a.el.isConnected ? a.top - a.el.getBoundingClientRect().top : 0,
        }));
        // The copy rides with the row just above it, so it stays attached as the thread settles.
        const attach = moved.length ? -moved[moved.length - 1].d : 0;
        const composer = opts.composer !== undefined ? opts.composer : composerOf(viewport);
        const composerShadow = composer?.style.boxShadow ?? "";
        const myBubble = mine?.querySelector<HTMLElement>(".user-bubble") ?? null;
        const thread = flier ? threadOf() : null;
        if (flier) viewport.appendChild(flier);
        if (thread) viewport.appendChild(thread.svg);
        const from = br ? { x: br.left, y: br.top } : { x: 0, y: 0 };
        const paint = (ms: number) => {
          const f = rewindFrame(style, ms);
          for (const m of moved)
            m.el.style.transform = f.shift >= 1 || !m.d ? m.transform : `translateY(${(m.d * (1 - f.shift)).toFixed(2)}px)`;
          paper.style.opacity = String(f.bg);
          cs.opacity = String(f.cover.opacity);
          cs.transform = `translateY(${(attach * f.shift + f.cover.dy).toFixed(2)}px) scaleY(${f.cover.scaleY.toFixed(4)})`;
          cs.filter = f.cover.blur > 0.01 ? `blur(${f.cover.blur.toFixed(2)}px)` : "";
          const n = rows.length;
          rows.forEach((k, i) => {
            const r = rewindRow(style, ms, n - 1 - i, n);
            k.style.opacity = String(r.opacity);
            k.style.transform = r.dy ? `translateY(${r.dy.toFixed(2)}px)` : "";
          });
          if (f.line) {
            line.style.display = "";
            line.style.opacity = String(f.line.opacity);
            line.style.transform = `translateY(${(attach * f.shift).toFixed(2)}px) scaleX(${f.line.k.toFixed(4)})`;
          } else line.style.display = "none";
          if (flier && thread) {
            if (myBubble) myBubble.style.visibility = "hidden";
            if (f.flight && composer) {
              // The bubble's text lands on the box's text: its top-left sits a padding up and left.
              const at = landingOf(composer);
              const to = {
                x: at.x - (parseFloat(flier.style.paddingLeft) || 0),
                y: at.y - (parseFloat(flier.style.paddingTop) || 0),
              };
              const p = flightPoint(from, to, f.flight.s);
              flier.style.display = "";
              flier.style.transform = `translate3d(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px, 0)`;
              flier.style.opacity = String(f.flight.opacity);
              flier.style.backgroundColor = `color-mix(in srgb, ${bubbleBg} ${Math.round(f.flight.tint * 100)}%, transparent)`;
              if (f.flight.thread > 0.01) {
                const ax = to.x + 24;
                const ay = to.y + 20;
                const bx = p.x + Math.min(flier.offsetWidth / 2, 40);
                const by = p.y + flier.offsetHeight;
                thread.path.setAttribute("d", `M ${ax} ${ay} C ${ax} ${lerp(ay, by, 0.6)}, ${bx} ${lerp(ay, by, 0.5)}, ${bx} ${by}`);
                thread.grad.setAttribute("x1", String(ax));
                thread.grad.setAttribute("y1", String(ay));
                thread.grad.setAttribute("x2", String(bx));
                thread.grad.setAttribute("y2", String(by));
                thread.path.style.opacity = String(f.flight.thread);
                thread.svg.style.display = "";
              } else thread.svg.style.display = "none";
            } else {
              flier.style.display = "none";
              thread.svg.style.display = "none";
            }
          }
          if (composer) composer.style.boxShadow = f.ring === null ? composerShadow : ring(f.ring);
          return f.done;
        };
        stop = run(paint, () => {
          for (const m of moved) m.el.style.transform = m.transform;
          if (composer) composer.style.boxShadow = composerShadow;
          flier?.remove();
          thread?.svg.remove();
          remove();
        });
      });
    },
  };
}

/**
 * Before his message at log index `index` is removed from the context: lay
 * a copy of its bubble over it. Null when there is nothing to draw.
 */
export function prepareDelete(
  viewport: HTMLElement | null | undefined,
  index: number,
  opts: PrepareOptions = {},
): Prepared | null {
  if (!viewport || typeof document === "undefined" || typeof requestAnimationFrame !== "function") return null;
  const sel = `.user-turn[data-turn="${index}"]`;
  const row = viewport.querySelector<HTMLElement>(sel);
  const bubble = row?.querySelector<HTMLElement>(".user-bubble");
  const inner = row?.parentElement;
  if (!row || !bubble || !inner) return null;
  const view = viewOf(viewport);
  const br = bubble.getBoundingClientRect();
  if (br.top > view.bottom || br.bottom < view.top || br.width === 0) return null;
  const style = styleFor("delete", opts.style);
  const ghost = lookAlike(bubble, br);
  ghost.classList.add("msg-motion", "msg-delete");
  ghost.style.overflow = "hidden";
  // One strike through each line of his text, where the line's words are (else one through the middle).
  const strikes = linesOf(bubble, br).map((l) => {
    const d = document.createElement("div");
    d.style.cssText = `position:absolute;left:${l.left}px;width:${l.width}px;top:${l.mid}px;height:1.5px;margin-top:-0.75px;border-radius:1px;background:${ACCENT};transform-origin:0 50%;transform:scaleX(0)`;
    ghost.appendChild(d);
    return d;
  });
  const near = rowsNear(inner, view, () => false);
  viewport.appendChild(ghost);

  let committed = false;
  let stop: (() => void) | null = null;
  const remove = () => {
    clearTimeout(ttl);
    ghost.remove();
  };
  const ttl = setTimeout(() => {
    if (!committed) remove();
  }, PENDING_TTL_MS);

  return {
    cancel: () => {
      committed = true;
      stop?.();
      remove();
    },
    commit: () => {
      if (committed) return;
      committed = true;
      clearTimeout(ttl);
      nextFrame(() => {
        const cur = viewport.querySelector<HTMLElement>(sel);
        if (!cur || !cur.classList.contains("removed")) return remove();
        const placeholder = cur.querySelector<HTMLElement>(".user-bubble");
        const own = placeholder ? placeholder.style.opacity : "";
        const base = placeholder ? parseFloat(getComputedStyle(placeholder).opacity) || 1 : 1;
        const pr = placeholder?.getBoundingClientRect() ?? null;
        const moved = near.map((a) => ({
          ...a,
          d: a.el.isConnected ? a.top - a.el.getBoundingClientRect().top : 0,
        }));
        const paint = (ms: number) => {
          const f = deleteFrame(style, ms);
          for (const m of moved)
            m.el.style.transform = f.shift >= 1 || !m.d ? m.transform : `translateY(${(m.d * (1 - f.shift)).toFixed(2)}px)`;
          if (placeholder) placeholder.style.opacity = f.node >= 1 ? own : String(+(base * f.node).toFixed(4));
          let x = br.left;
          let y = br.top + f.ghost.dy;
          let sx = f.ghost.scale;
          let sy = f.ghost.scale;
          if (f.morph !== null && pr && pr.width > 0) {
            // Onto the placeholder's box as it is now (its row may have slid).
            const slide = moved.find((m) => m.el === cur);
            const py = pr.top + (slide ? slide.d * (1 - f.shift) : 0);
            x = lerp(br.left, pr.left, f.morph);
            y = lerp(br.top, py, f.morph);
            sx = lerp(1, pr.width / br.width, f.morph);
            sy = lerp(1, pr.height / br.height, f.morph);
          } else {
            // Scale about the bubble's centre.
            x += (br.width * (1 - sx)) / 2;
            y += (br.height * (1 - sy)) / 2;
          }
          ghost.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
          ghost.style.opacity = String(f.ghost.opacity);
          ghost.style.filter = f.ghost.blur > 0.01 ? `blur(${f.ghost.blur.toFixed(2)}px)` : "";
          for (const d of strikes) {
            d.style.display = f.strike ? "" : "none";
            if (f.strike) {
              d.style.transform = `scaleX(${f.strike.k.toFixed(4)})`;
              d.style.opacity = String(f.strike.opacity);
            }
          }
          return f.done;
        };
        stop = run(paint, () => {
          for (const m of moved) m.el.style.transform = m.transform;
          if (placeholder) placeholder.style.opacity = own;
          remove();
        });
      });
    },
  };
}
