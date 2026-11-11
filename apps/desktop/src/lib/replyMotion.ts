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
//
// Item 617 (his pick, blocker 1854, 2026-11-11): "the entire line is gradually
// getting shown from left to right, kind of like a … fade-in … the animation has
// to like lag very slightly behind" — the Line reveal look, now the default
// outside Classic. No per-word DOM at all: each block gets one CSS mask — every
// line above the reveal edge shown, the edge's line shown up to x behind a soft
// edge, everything after it hidden — and the edge runs an eased ~0.2 s behind
// the stream at an even speed (616-demo/combo.html, "Line reveal"). The shuttle
// rides the edge in the theme's motion colour (--motion-ink, item 627). Code,
// tables and KaTeX need nothing special: the mask is by position, so a code
// block or table grows down as its rows reveal; a formula shows whole. Classic
// keeps the word rise ("words"); Settings → Animations → Reply text picks.

import { reducedMotion } from "./sendMotion";

/** Item 617: how a streaming reply's text arrives. */
export type ReplyLook = "line" | "words";
export const REPLY_LOOK_KEY = "nightloom.replyLook";
/** A stored value read back; anything unknown is the default (Line reveal). */
export function parseReplyLook(v: string | null): ReplyLook {
  return v === "words" ? "words" : "line";
}
/** The look a reply streams with now: Classic always keeps the word rise (its look is frozen); else the setting. */
export function currentReplyLook(): ReplyLook {
  if (typeof document !== "undefined" && document.documentElement.dataset.layout === "classic") return "words";
  try {
    return parseReplyLook(localStorage.getItem(REPLY_LOOK_KEY));
  } catch {
    return "line";
  }
}

/** Line reveal: the edge trails the stream by about this long (s) — the demo's LAG. */
export const LINE_LAG_S = 0.2;
/** Line reveal is integrated in steps of this many ms, its speed eased by LINE_EASE a step (even, not token-shaped). */
export const LINE_STEP_MS = 16;
export const LINE_EASE = 0.08;
/** The slowest the edge moves while behind (chars/s), so it always lands. */
export const LINE_MIN_CPS = 4;
/** A burst (text after thinking) shows at once but for its last this many characters (626's rule E, for the line look). */
export const LINE_BURST_CHARS = 320;
/** The soft edge's width, in line heights; 70 % of it before the edge, 30 % after. */
export const LINE_SOFT = 3;

/** One block's reveal: `r` characters shown (fractional), moving at `v` chars/s, toward `target`. */
export interface Reveal {
  r: number;
  v: number;
  target: number;
}

/** Advance a reveal by `dt` ms toward its target (the demo's `revealAt`, run on the live target). */
export function stepReveal(st: Reveal, dt: number): void {
  let left = Math.min(200, Math.max(0, dt));
  while (left > 0 && st.r < st.target) {
    const step = Math.min(LINE_STEP_MS, left);
    left -= step;
    const want = Math.max(0, (st.target - st.r) / LINE_LAG_S);
    st.v += (want - st.v) * LINE_EASE * (step / LINE_STEP_MS);
    st.r = Math.min(st.target, st.r + (Math.max(st.v, LINE_MIN_CPS) * step) / 1000);
  }
}

/** A re-render moved the block's text to `target` characters: shrink with it, and let a burst show but its tail. */
export function retarget(st: Reveal, target: number): void {
  st.target = target;
  if (st.r > target) st.r = target;
  if (target - st.r > LINE_BURST_CHARS) st.r = target - LINE_BURST_CHARS;
}

/** The mask for a block whose edge line runs from `top` for `h` px with the edge at `x` (block-local CSS px). */
export function lineMask(top: number, h: number, x: number): string {
  const f = LINE_SOFT * h;
  const t = Math.max(0, top).toFixed(1);
  return (
    `linear-gradient(#000, #000) 0 0 / 100% ${t}px no-repeat, ` +
    `linear-gradient(90deg, #000 ${(x - f * 0.7).toFixed(1)}px, transparent ${(x + f * 0.3).toFixed(1)}px) 0 ${t}px / 100% ${h.toFixed(1)}px no-repeat`
  );
}

/** Ink rise: each word's fade-up from a soft blur (ms). */
export const RISE_MS = 520;
/** The accent weft under new words, fading (ms) — the longer of the two, so a word's whole life. */
export const WORD_MS = 900;
/** Words in one delta are staggered this far apart, capped at STAGGER_CAP. */
export const STAGGER_MS = 22;
export const STAGGER_CAP_MS = 160;
/** Item 626: at most this many words of one delta animate; a burst's earlier words show at once. */
export const BURST_WORDS = 40;
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
  /** Item 626: the text the offsets index (trailing whitespace trimmed); absent, the text is taken to have only grown. */
  text?: string;
}

/**
 * Item 626: line the shown text `was` up with the text `now` after a re-render rewrote it from offset `p` on (closing
 * markup — `**wor` → `world`, `[text](ur` → `text`, a table's pipes, a fence's backticks — deletes characters; a table
 * adds newlines between cells). Greedy: equal characters map; a whitespace character only in `now` is skipped there;
 * anything else in `was` was deleted. Returns each old character's new offset (or -1) and where the mapped text ends.
 */
export function align(was: string, now: string, p: number): { at: Int32Array; end: number } {
  const at = new Int32Array(was.length).fill(-1);
  for (let k = 0; k < p; k++) at[k] = k;
  let i = p;
  let j = p;
  let end = p;
  while (i < was.length && j < now.length) {
    if (was[i] === now[j]) {
      at[i++] = j++;
      end = j;
    } else if (/\s/.test(now[j]) && !/\s/.test(was[i])) j++;
    else i++;
  }
  return { at, end };
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
  const was = s.text;
  if (was !== undefined && !full.startsWith(was)) {
    // Item 626: text already shown was rewritten (the markdown closed around it). Keep each live word on its own
    // characters — before, the offsets kept pointing where the word used to be, so spans wrapped pieces of shown
    // words (hidden again, then rising: the words seemed to move) while the new text showed unanimated.
    let p = 0;
    while (p < was.length && p < L && was[p] === full[p]) p++;
    const { at, end } = align(was, full.slice(0, L), p);
    const moved: Arrival[] = [];
    for (const r of s.live) {
      let a = -1;
      let b = -1;
      for (let k = r.from; k < r.to && k < at.length; k++) {
        if (at[k] < 0) continue;
        if (a < 0) a = at[k];
        b = at[k] + 1;
      }
      if (a >= 0) moved.push({ from: a, to: b, start: r.start });
    }
    s.live = moved;
    s.len = Math.min(end, L);
  } else if (L < s.len) {
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
    // Item 626: the stagger runs on from the previous delta's words, never before them. It restarted at `t` on every
    // delta, so with deltas ~40 ms apart and up to 160 ms of stagger the next delta's first words began while the last
    // delta's were still hidden — words appeared out of order. Each word starts STAGGER_MS after the one before, and
    // never later than STAGGER_CAP_MS after its own arrival, so a burst cannot build a queue.
    let prev = s.live.reduce((m, r) => Math.max(m, r.start), -Infinity);
    // Item 626 (his second report: after thinking, "the entire screen … gets replaced by a bunch of text, except like
    // only half of the tokens are actually showing … random letters across the screen"): a burst of thousands of
    // characters wrapped every word in its own blurred, rising span at once. Only the burst's last BURST_WORDS animate;
    // the words before them simply show.
    if (words.length > BURST_WORDS) {
      words.splice(0, words.length - BURST_WORDS);
      carry = null;
      // Words still waiting on their stagger begin now, so none is hidden behind the burst's shown words.
      for (const r of s.live) if (r.start > t) r.start = t;
      prev = Math.min(prev, t);
    }
    words.forEach(([a, b], k) => {
      if (k === 0 && carry !== null) {
        s.live.push({ from: a, to: b, start: carry });
        return;
      }
      const start = Math.min(t + STAGGER_CAP_MS, Math.max(t, prev + STAGGER_MS));
      prev = start;
      s.live.push({ from: a, to: b, start });
    });
    s.len = L;
  }
  s.text = full.slice(0, L);
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
/** Item 626: what other code adds inside a block (codeCopy's buttons, the next-chat row) is not the reply's text. */
const EXTRA = "button.code-copy, button.code-run, div.handoff-go";

/** The block's text nodes, less those inside EXTRA. */
function textWalker(el: HTMLElement): TreeWalker {
  return document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(EXTRA) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
}

/** The block's text as the offsets index it (item 626: before, a Run button's label shifted every offset after it). */
export function blockText(el: HTMLElement): string {
  let s = "";
  const w = textWalker(el);
  for (let n = w.nextNode(); n; n = w.nextNode()) s += (n as Text).data;
  return s;
}

/** Wrap the still-animating words of one block, walking its text nodes back from the end. */
function decorate(el: HTMLElement, live: Arrival[], t: number, length: number): void {
  if (!live.length) return;
  const minFrom = Math.min(...live.map((r) => r.from));
  const walker = textWalker(el);
  let node = walker.lastChild() as Text | null;
  let end = length;
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
    // Item 452: split the node in place rather than replace it, so the words
    // already there stay the same node and a selection in them survives;
    // only each animating stretch moves into its span.
    let cur: Text | null = n;
    for (const part of parts) {
      if (!cur) break;
      const len = typeof part === "string" ? part.length : part.text.length;
      const rest: Text | null = cur.data.length > len ? cur.splitText(len) : null;
      if (typeof part !== "string") {
        const span = document.createElement("span");
        span.className = WRAP;
        span.style.animationDelay = `${part.delay}ms`;
        cur.parentNode!.insertBefore(span, cur);
        span.appendChild(cur);
      }
      cur = rest;
    }
  }
}

/** Whether the document's selection has an end inside `el` (item 452). */
function selectionIn(el: HTMLElement): boolean {
  const sel = typeof document !== "undefined" ? document.getSelection() : null;
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  return el.contains(sel.anchorNode) || el.contains(sel.focusNode);
}

/** Item 617: a block's text nodes and where each starts, for finding the reveal edge's character. */
interface Index {
  nodes: Text[];
  starts: number[];
  len: number;
  /** The length less the trailing whitespace the rendered blocks end in (what `arrive` counts too). */
  trimmed: number;
}
function indexOf(el: HTMLElement): Index {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let len = 0;
  let text = "";
  const w = textWalker(el);
  for (let n = w.nextNode() as Text | null; n; n = w.nextNode() as Text | null) {
    nodes.push(n);
    starts.push(len);
    len += n.data.length;
    text += n.data;
  }
  return { nodes, starts, len, trimmed: text.trimEnd().length };
}

/** The reveal edge in viewport px: its line's top and height, and x. Null when no character there has a box. */
function edgeOf(ix: Index, r: number, target: number): { top: number; h: number; x: number } | null {
  if (!ix.nodes.length || target <= 0) return null;
  let k = Math.min(Math.floor(r), target - 1, ix.len - 1);
  const frac = Math.min(1, Math.max(0, r - k));
  // The node holding character k (binary search on the starts).
  let lo = 0;
  let hi = ix.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ix.starts[mid] <= k) lo = mid;
    else hi = mid - 1;
  }
  let ni = lo;
  let first = true;
  // Walk back from k to a character with a box (whitespace between blocks has none); a bounded walk.
  for (let tries = 0; tries < 96 && k >= 0; tries++) {
    const n = ix.nodes[ni];
    const off = k - ix.starts[ni];
    if (off < 0) {
      ni--;
      if (ni < 0) return null;
      continue;
    }
    // A formula reveals whole: its box, edge at its right.
    const kx = n.parentElement?.closest(".katex");
    if (kx) {
      const b = kx.getBoundingClientRect();
      return { top: b.top, h: b.height, x: b.right };
    }
    const c = n.data[off];
    if (c !== undefined && /\S/.test(c)) {
      const rg = document.createRange();
      rg.setStart(n, off);
      rg.setEnd(n, off + 1);
      const rs = rg.getClientRects();
      const b = rs[rs.length - 1];
      if (b && (b.width > 0 || b.height > 0)) return { top: b.top, h: b.height, x: first ? b.left + frac * b.width : b.right };
    }
    first = false;
    k--;
  }
  return null;
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
 * are (only what arrives afterwards animates). The look (item 617) is taken
 * when a stream starts: Line reveal, or Classic's / the setting's word rise.
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
  /** A block's unwrapping waits on his selection (item 452); look again this often. */
  let held = false;
  const HOLD_MS = 500;
  // Item 617, Line reveal.
  let look: ReplyLook = "words";
  const reveals = new Map<HTMLElement, { st: Reveal; ix: Index; masked: boolean }>();
  let lastFrame = 0;
  let lastActive = -1e9;
  /** The NoteEditPanel case: the root is the block, so a shuttle inside it would sit under its own mask — it rides fixed on the body. */
  let fixedShuttle = false;
  let clipEl: HTMLElement | null = null;

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
    if (look === "line") {
      recordLine(el, t, false);
      return;
    }
    const s = trackOf(el);
    const text = blockText(el);
    if (arrive(s, text, t)) {
      lastBlock = el;
      lastArrival = t;
      run();
    }
    decorate(el, s.live, t, text.length);
  }

  // ---- Line reveal (item 617) ----

  function setMask(el: HTMLElement, m: string | null): void {
    if (m === null) {
      el.style.removeProperty("mask");
      el.style.removeProperty("-webkit-mask");
    } else {
      el.style.setProperty("-webkit-mask", m);
      el.style.setProperty("mask", m);
    }
  }

  /** A re-render touched block `el`: re-index it, move its target; `shown` (a block on screen already) starts fully revealed. */
  function recordLine(el: HTMLElement, t: number, shown: boolean): void {
    const ix = indexOf(el);
    const target = ix.trimmed;
    let rec = reveals.get(el);
    if (!rec) {
      rec = { st: { r: shown ? target : 0, v: 0, target }, ix, masked: false };
      reveals.set(el, rec);
      blocks.add(el);
    }
    rec.ix = ix;
    const grew = target > rec.st.target;
    retarget(rec.st, target);
    if (grew) {
      lastBlock = el;
      lastArrival = t;
    }
    // Before this frame paints (an observer callback runs first): the new text never shows ahead of the edge.
    paintLine(el, rec);
    if (rec.st.r < rec.st.target) run();
  }

  /** Mask block `el` at its edge, or clear the mask once the edge has reached its end. Returns the edge (viewport px). */
  function paintLine(el: HTMLElement, rec: { st: Reveal; ix: Index; masked: boolean }) {
    if (rec.st.r >= rec.st.target - 1e-3) {
      if (rec.masked) setMask(el, null);
      rec.masked = false;
      return null;
    }
    const e = edgeOf(rec.ix, rec.st.r, rec.st.target);
    const b = el.getBoundingClientRect();
    if (!e) {
      // Nothing with a box yet (the block's first characters): hide it whole until there is.
      if (rec.st.r <= 0) {
        setMask(el, "linear-gradient(transparent, transparent)");
        rec.masked = true;
      }
      return null;
    }
    const s = el.offsetWidth ? b.width / el.offsetWidth : 1;
    const pad = e.h * 0.18;
    const top = (e.top - b.top) / s - pad;
    const h = e.h / s + pad * 2;
    setMask(el, lineMask(top, h, (e.x - b.left) / s));
    rec.masked = true;
    return { x: e.x, y: e.top + e.h / 2 };
  }

  /** The harness's measuring hook (617-harness): each block's reveal, every frame. */
  const probe =
    typeof window !== "undefined" ? (window as unknown as { __replyRevealProbe?: (el: HTMLElement, st: Reveal) => void }).__replyRevealProbe : undefined;

  function lineFrame(t: number): boolean {
    const dt = lastFrame ? t - lastFrame : LINE_STEP_MS;
    lastFrame = t;
    let edge: { x: number; y: number } | null = null;
    let active = false;
    for (const [el, rec] of reveals) {
      if (!el.isConnected) {
        reveals.delete(el);
        continue;
      }
      if (rec.st.r < rec.st.target) {
        stepReveal(rec.st, dt);
        active = true;
      }
      const e = paintLine(el, rec);
      if (e && !edge) edge = e;
      probe?.(el, rec.st);
    }
    if (active) lastActive = t;
    moveShuttle(edge, t - lastActive < 250);
    return active || (!!shuttle && shuttle.style.opacity === "1");
  }

  function placeShuttle(): void {
    shuttle = document.createElement("div");
    shuttle.className = "rm-shuttle";
    shuttle.setAttribute("aria-hidden", "true");
    fixedShuttle = look === "line" && root.matches(MD);
    if (fixedShuttle) {
      // The panel's own CSS styles a shuttle inside it; this one lives on the body, so it carries its look.
      shuttle.style.cssText =
        "position:fixed;left:0;top:0;width:18px;height:5px;margin:-2.5px 0 0 0;border-radius:50% / 100%;pointer-events:none;z-index:60;opacity:0;transition:opacity 260ms ease-out;" +
        "background:linear-gradient(90deg, color-mix(in srgb, var(--motion-ink, var(--accent)) 10%, transparent), var(--motion-ink-hi, var(--accent-ink, var(--accent))));" +
        "box-shadow:0 0 8px color-mix(in srgb, var(--motion-ink, var(--accent)) 70%, transparent);";
      document.body.appendChild(shuttle);
      clipEl = null;
      for (let p = root.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowY;
        if (o === "auto" || o === "scroll" || o === "hidden") {
          clipEl = p;
          break;
        }
      }
    } else root.appendChild(shuttle);
  }

  /** Ease the shuttle toward viewport point `target` (or hide it). */
  function moveShuttle(target: { x: number; y: number } | null, show: boolean): void {
    if (!shuttle) return;
    if (target && fixedShuttle && clipEl) {
      const c = clipEl.getBoundingClientRect();
      if (target.y < c.top || target.y > c.bottom) target = null;
    }
    if (!target) {
      // Caught up between deltas: it waits where it is a moment rather than blink.
      if (!show) shuttle.style.opacity = "0";
      return;
    }
    let tx = target.x;
    let ty = target.y;
    if (!fixedShuttle) {
      const base = root.getBoundingClientRect();
      const s = root.offsetWidth ? base.width / root.offsetWidth : 1;
      tx = (tx - base.left) / s;
      ty = (ty - base.top) / s;
    }
    // The edge already moves at an even, eased speed: the shuttle sits on it, centred (the demo's), rather than chasing it.
    sx = tx - 9;
    sy = ty;
    shuttle.style.opacity = "1";
    shuttle.style.transform = `translate3d(${sx.toFixed(1)}px, ${sy.toFixed(1)}px, 0)`;
  }

  /** Every mask off and the shuttle gone (the reveal has landed, or the reply left). */
  function finishLine(): void {
    for (const [el, rec] of reveals) if (rec.masked) setMask(el, null);
    reveals.clear();
    const s = shuttle;
    shuttle = null;
    if (s) {
      s.style.opacity = "0";
      setTimeout(() => s.remove(), 300);
    }
  }

  // ---- Word rise (item 342; Classic, and the setting's "words") ----

  /** Unwrap every block once its words are done; re-arm while any still animate. */
  function scheduleSettle(): void {
    if (settleTimer) clearTimeout(settleTimer);
    let latest: number | null = null;
    for (const el of blocks) {
      const s = tracks.get(el);
      const at = s ? settlesAt(s.live) : null;
      if (at != null && (latest == null || at > latest)) latest = at;
    }
    const wait = held ? HOLD_MS : latest == null ? 0 : Math.max(0, latest - now()) + 30;
    settleTimer = setTimeout(() => {
      settleTimer = null;
      const t = now();
      let pending = false;
      held = false;
      for (const el of blocks) {
        const s = tracks.get(el);
        if (s) s.live = s.live.filter((r) => r.start + WORD_MS > t);
        if (s?.live.length) pending = true;
        // Item 452: unwrapping replaces the spans' text, which would drop a
        // selection in them; a block he is selecting in waits until he is done.
        else if (el.isConnected && el.querySelector(`span.${WRAP}`) && selectionIn(el)) pending = held = true;
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
    if (look === "line") {
      const t = now();
      if (lineFrame(t)) raf = requestAnimationFrame(frame);
      else {
        lastFrame = 0;
        if (!obs) finishLine();
      }
      return;
    }
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
    if (!raf && (shuttle || look === "line")) raf = requestAnimationFrame(frame);
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
    if (mds.size && look === "words") scheduleSettle();
  }

  function start(): void {
    if (obs || motionOff()) return;
    look = currentReplyLook();
    // What is on screen already stays as it is.
    const onScreen = root.matches(MD) ? [root] : Array.from(root.querySelectorAll<HTMLElement>(MD));
    onScreen.forEach((el) => {
      if (look === "line") {
        recordLine(el, now(), true);
        return;
      }
      const s = trackOf(el);
      s.text = blockText(el).trimEnd();
      s.len = s.text.length;
    });
    if (shuttle && look === "line") {
      // A stream restarted before the last reveal's shuttle left.
      shuttle.remove();
      shuttle = null;
    }
    if (!shuttle) placeShuttle();
    obs = new MutationObserver(handle);
    obs.observe(root, { childList: true, subtree: true, characterData: true });
  }

  function stop(): void {
    // The delta that came with the turn's end lands in the same update: take it first.
    if (obs) handle(obs.takeRecords());
    obs?.disconnect();
    obs = null;
    if (look === "line") {
      // The edge runs on to the end, then the masks come off and the shuttle goes (frame → finishLine).
      if (raf) return;
      finishLine();
      return;
    }
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
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (look === "line") finishLine();
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
