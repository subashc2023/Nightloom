// Item 342 — the streaming reply's motion, his pick of item 338 ("Loom +
// fade-in", look G on harness/pick338.html): the words of a live reply fade
// up from a soft blur under a fading accent weft while a small accent shuttle
// rides the writing point. Thinking (the needle) and tool rows (the weft)
// are drawn by AssistantMessage's own CSS and transitions; this file holds
// the text part, which cannot be plain CSS:
//
// the reply's markdown is re-rendered whole on every delta ({@html}), so the
// DOM of a word that arrived 200 ms ago is brand new on each delta. The
// action therefore records *when* each word arrived (by character offset
// into the block's text) and, after each re-render — in a MutationObserver
// callback, which runs before the frame paints — wraps only the words still
// animating, each with a negative `animation-delay` equal to its age, so the
// animation picks up exactly where the replaced node left off. Once every
// word is done the spans are unwrapped and the DOM is the component's own.
// The timings are the harness's (harness/stream338-motion.ts, `shuttlefade`).

import { reducedMotion } from "./sendMotion";

/** Ink rise: each word's fade-up from a soft blur (ms). */
export const RISE_MS = 520;
/** The accent weft under new words, fading (ms) — the longer of the two, so a word's whole life. */
export const WORD_MS = 900;
/** Words in one delta are staggered this far apart, capped at STAGGER_CAP. */
export const STAGGER_MS = 22;
export const STAGGER_CAP_MS = 160;
/** The shuttle hides this long after the last arrival. */
export const SHUTTLE_IDLE_MS = 900;

export interface Arrival {
  /** Character offsets into the block's text, [from, to). */
  from: number;
  to: number;
  /** When the word's animation starts (performance.now() ms). */
  start: number;
}

/** What one markdown block has shown so far and which of its words still animate. */
export interface Track {
  len: number;
  live: Arrival[];
}

/** The motion is off under the OS's reduced-motion setting (and the harnesses' flags). */
export function motionOff(): boolean {
  const w = typeof window !== "undefined" ? (window as unknown as { __replyMotionOff?: boolean }) : null;
  return !!w?.__replyMotionOff || reducedMotion();
}

/**
 * Record what a re-render added. `full` is the block's whole text; the
 * trailing whitespace the rendered blocks end in ("</li>\n</ol>\n") is not
 * counted, or every later arrival shifts a character into the word before.
 * Returns true when something new arrived. Words whose animation has ended
 * by `t` are dropped from `live`.
 */
export function arrive(s: Track, full: string, t: number): boolean {
  const L = full.trimEnd().length;
  let grew = false;
  if (L < s.len) {
    s.len = L;
    s.live = s.live.filter((r) => r.from < L);
  }
  if (L > s.len) {
    grew = true;
    const from = s.len;
    const slice = full.slice(from, L);
    const re = /\S+/g;
    const words: [number, number][] = [];
    for (let m = re.exec(slice); m; m = re.exec(slice)) words.push([from + m.index, from + m.index + m[0].length]);
    // A delta that ends mid-word (the engines' tokens are sub-word): the rest of
    // the word keeps its first piece's timing, or simply shows if that piece is done.
    let carry: number | null = null;
    if (words.length && words[0][0] === from && from > 0 && /\S/.test(full[from - 1])) {
      const prev = s.live.find((r) => r.to === from);
      carry = prev ? prev.start : t - WORD_MS;
    }
    words.forEach(([a, b], k) =>
      s.live.push({ from: a, to: b, start: k === 0 && carry !== null ? carry : t + Math.min(k * STAGGER_MS, STAGGER_CAP_MS) }),
    );
    s.len = L;
  }
  s.live = s.live.filter((r) => r.start + WORD_MS > t);
  return grew;
}

/** A text node's pieces: plain text, or a stretch to wrap with its animation delay (ms, ≤ 0 once begun). */
export type Piece = string | { text: string; delay: number };

/**
 * Split one text node, which starts at offset `a` in its block, into plain
 * and animating pieces. Null when nothing in it is animating.
 */
export function pieces(a: number, data: string, live: Arrival[], t: number): Piece[] | null {
  const b = a + data.length;
  const hits = live.filter((r) => r.to > a && r.from < b);
  if (!hits.length) return null;
  const out: Piece[] = [];
  let cur = a;
  for (const r of hits) {
    const x = Math.max(r.from, a, cur);
    const y = Math.min(r.to, b);
    if (y <= x) continue;
    if (x > cur) out.push(data.slice(cur - a, x - a));
    out.push({ text: data.slice(x - a, y - a), delay: Math.round(r.start - t) });
    cur = y;
  }
  if (cur < b) out.push(data.slice(cur - a));
  return out;
}

/** The latest moment any live word is still animating, or null. */
export function settlesAt(live: Arrival[]): number | null {
  return live.length ? Math.max(...live.map((r) => r.start + WORD_MS)) : null;
}

const WRAP = "rm-w";
const MD = ".markdown";

/** Wrap the still-animating words of one block, walking its text nodes back from the end. */
function decorate(el: HTMLElement, live: Arrival[], t: number): void {
  if (!live.length) return;
  const minFrom = Math.min(...live.map((r) => r.from));
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.lastChild() as Text | null;
  let end = (el.textContent ?? "").length;
  const todo: [Text, number][] = [];
  while (node && end > minFrom) {
    const a = end - node.data.length;
    todo.push([node, a]);
    end = a;
    node = walker.previousNode() as Text | null;
  }
  for (const [n, a] of todo) {
    const p = n.parentElement;
    // Top-level nodes are the {@html} block's own bookends; KaTeX is left whole;
    // a node already wrapped is already animating.
    if (!p || p === el || p.classList.contains(WRAP) || p.closest(".katex")) continue;
    const parts = pieces(a, n.data, live, t);
    if (!parts) continue;
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (typeof part === "string") frag.append(part);
      else {
        const span = document.createElement("span");
        span.className = WRAP;
        span.style.animationDelay = `${part.delay}ms`;
        span.textContent = part.text;
        frag.append(span);
      }
    }
    n.replaceWith(frag);
  }
}

/** Put the block's DOM back as the component rendered it. */
export function unwrap(el: HTMLElement): void {
  const spans = el.querySelectorAll<HTMLElement>(`span.${WRAP}`);
  if (!spans.length) return;
  const parents = new Set<Node>();
  spans.forEach((s) => {
    if (s.parentNode) parents.add(s.parentNode);
    s.replaceWith(document.createTextNode(s.textContent ?? ""));
  });
  parents.forEach((p) => p.normalize());
}

/** The end of a block's text, where the shuttle rides: the last non-space character's right edge. */
function headOf(el: HTMLElement): { x: number; y: number } | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n = walker.lastChild() as Text | null;
  while (n && !/\S/.test(n.data)) n = walker.previousNode() as Text | null;
  if (!n) return null;
  let i = n.data.length;
  while (i > 0 && /\s/.test(n.data[i - 1])) i--;
  const r = document.createRange();
  r.setStart(n, Math.max(0, i - 1));
  r.setEnd(n, i);
  const rects = r.getClientRects();
  const rect = rects[rects.length - 1];
  if (!rect) return null;
  return { x: rect.right + 3, y: rect.top + rect.height / 2 };
}

/**
 * `use:replyMotion={streaming}` on the reply's root (which must be
 * positioned). Active only while the turn streams and motion is not
 * reduced; a reply already on screen when it starts keeps its words as they
 * are (only what arrives afterwards animates).
 */
export function replyMotion(root: HTMLElement, streaming: boolean) {
  const tracks = new WeakMap<HTMLElement, Track>();
  const blocks = new Set<HTMLElement>();
  let obs: MutationObserver | null = null;
  let shuttle: HTMLElement | null = null;
  let lastBlock: HTMLElement | null = null;
  let lastArrival = -1e9;
  let raf = 0;
  let sx = 0;
  let sy = 0;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  const now = () => performance.now();

  function trackOf(el: HTMLElement): Track {
    let s = tracks.get(el);
    if (!s) {
      s = { len: 0, live: [] };
      tracks.set(el, s);
      blocks.add(el);
    }
    return s;
  }

  function record(el: HTMLElement, t: number): void {
    const s = trackOf(el);
    if (arrive(s, el.textContent ?? "", t)) {
      lastBlock = el;
      lastArrival = t;
      run();
    }
    decorate(el, s.live, t);
  }

  /** Unwrap every block once its words are done; re-arm while any still animate. */
  function scheduleSettle(): void {
    if (settleTimer) clearTimeout(settleTimer);
    let latest: number | null = null;
    for (const el of blocks) {
      const s = tracks.get(el);
      const at = s ? settlesAt(s.live) : null;
      if (at != null && (latest == null || at > latest)) latest = at;
    }
    const wait = latest == null ? 0 : Math.max(0, latest - now()) + 30;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      const t = now();
      let pending = false;
      for (const el of blocks) {
        const s = tracks.get(el);
        if (s) s.live = s.live.filter((r) => r.start + WORD_MS > t);
        if (s?.live.length) pending = true;
        else if (el.isConnected) unwrap(el);
      }
      obs?.takeRecords(); // the unwrapping is not a delta
      if (pending) scheduleSettle();
    }, wait);
  }

  // The shuttle: one element, eased toward the writing point every frame, only
  // while words are arriving (the loop stops itself once the shuttle has hidden).
  function frame(): void {
    raf = 0;
    if (!shuttle) return;
    const age = now() - lastArrival;
    const target = lastBlock && lastBlock.isConnected && age < SHUTTLE_IDLE_MS ? headOf(lastBlock) : null;
    if (!target) {
      shuttle.style.opacity = "0";
      return;
    }
    const base = root.getBoundingClientRect();
    const tx = target.x - base.left;
    const ty = target.y - base.top;
    if (shuttle.style.opacity !== "1" || Math.abs(ty - sy) > 400) {
      sx = tx;
      sy = ty;
    }
    // y settles fast, x glides: a new line reads as the shuttle's return across.
    sx += (tx - sx) * 0.22;
    sy += (ty - sy) * 0.45;
    shuttle.style.opacity = "1";
    shuttle.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`;
    raf = requestAnimationFrame(frame);
  }
  function run(): void {
    if (!raf && shuttle) raf = requestAnimationFrame(frame);
  }

  function handle(recs: MutationRecord[]): void {
    if (motionOff()) return;
    const t = now();
    const mds = new Set<HTMLElement>();
    for (const r of recs) {
      const tgt = r.target instanceof HTMLElement ? r.target : r.target.parentElement;
      const m = tgt?.closest<HTMLElement>(MD);
      if (m && root.contains(m)) mds.add(m);
      r.addedNodes.forEach((n) => {
        if (!(n instanceof HTMLElement)) return;
        if (n.matches(MD)) mds.add(n);
        n.querySelectorAll<HTMLElement>(MD).forEach((e) => mds.add(e));
      });
    }
    mds.forEach((el) => record(el, t));
    obs?.takeRecords(); // our own wrapping is not a delta
    if (mds.size) scheduleSettle();
  }

  function start(): void {
    if (obs || motionOff()) return;
    // What is on screen already stays as it is.
    root.querySelectorAll<HTMLElement>(MD).forEach((el) => {
      trackOf(el).len = (el.textContent ?? "").trimEnd().length;
    });
    shuttle = document.createElement("div");
    shuttle.className = "rm-shuttle";
    shuttle.setAttribute("aria-hidden", "true");
    root.appendChild(shuttle);
    obs = new MutationObserver(handle);
    obs.observe(root, { childList: true, subtree: true, characterData: true });
  }

  function stop(): void {
    // The delta that came with the turn's end lands in the same update: take it first.
    if (obs) handle(obs.takeRecords());
    obs?.disconnect();
    obs = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    const s = shuttle;
    shuttle = null;
    if (s) {
      s.style.opacity = "0";
      setTimeout(() => s.remove(), 300);
    }
    // The last words finish their animation, then the DOM is the component's own.
    scheduleSettle();
  }

  if (streaming) start();
  return {
    update(next: boolean) {
      if (next) start();
      else stop();
    },
    destroy() {
      stop();
      if (settleTimer) clearTimeout(settleTimer);
      shuttle?.remove();
    },
  };
}

/**
 * Which rows of a reply were born live — first seen by this component after
 * its first render, while the turn streamed and the row not yet done. Only
 * those get the needle and the weft; a reply drawn again (a chat switched
 * back to mid-turn) starts its finished rows still.
 */
export class Births {
  private seen = new Map<string, boolean>();
  settled = false;
  of(id: string, streaming: boolean, done: boolean): boolean {
    let b = this.seen.get(id);
    if (b === undefined) {
      b = this.settled && streaming && !done;
      this.seen.set(id, b);
    }
    return b;
  }
}

// ---- thinking: the needle ------------------------------------------------------
// Svelte transitions on `.thinking-text` (the harness drove the same keyframes
// through the Web Animations API from outside). The thread itself is the
// block's background (AssistantMessage's CSS), so `background-size` draws it.

const cubicOut = (t: number) => 1 - (1 - t) ** 3;
const cubicInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Opening: the thread draws down the margin over the first half, then the words ink in (420 ms, ease-out). */
export function needleIn(_node: HTMLElement, opts: { on: boolean }) {
  if (!opts.on || motionOff()) return { duration: 0 };
  return {
    duration: 420,
    easing: cubicOut,
    css: (t: number) => {
      const drawn = Math.min(1, t / 0.5) * 100;
      const ink = t < 0.5 ? 0 : ((t - 0.5) / 0.5) * 100;
      return `background-size: 2px ${drawn.toFixed(1)}%; color: color-mix(in srgb, var(--dim) ${ink.toFixed(1)}%, transparent);`;
    },
  };
}

/** Closing: the words fade by a third of the way, then the block folds up as the accent thread retracts (420 ms, ease-in-out). */
export function needleOut(node: HTMLElement, opts: { on: boolean }) {
  if (!opts.on || motionOff()) return { duration: 0 };
  const h = node.offsetHeight;
  node.classList.add("rm-retract");
  return {
    duration: 420,
    easing: cubicInOut,
    css: (_t: number, u: number) => {
      const ink = u < 0.35 ? (1 - u / 0.35) * 100 : 0;
      const left = u < 0.35 ? 1 : 1 - (u - 0.35) / 0.65;
      return `overflow: hidden; height: ${(h * left).toFixed(1)}px; background-size: 2px ${(left * 100).toFixed(1)}%; color: color-mix(in srgb, var(--dim) ${ink.toFixed(1)}%, transparent);`;
    },
  };
}
