/**
 * The message navigator's model (nightshift backlog 065, 2026-09-15): one
 * tick per live message, for the strip `Navigator.svelte` draws at the
 * transcript's right edge. Pure — events in, ticks out — so the suite can
 * pin it without a DOM, and so the strip is a projection of the log the
 * way the transcript is.
 *
 * ~~Modelled on the screenshot he sent of LibreChat's rail … Nothing of
 * theirs is copied; the interaction is what was borrowed.~~ — struck
 * 2026-10-15 (item 359, blocker 1444: "maybe jus use the librechat one").
 * Since 359 the rail is a port of LibreChat's message navigator:
 * `client/src/components/Chat/Messages/MessageNav.tsx`, main as read
 * 2026-10-15, github.com/danny-avila/LibreChat. Its constants, the cosine
 * magnifier, the eased scroll, the chevron rule and the preview cut are
 * theirs, rewritten for Svelte and this app's tokens.
 *
 * Their notice, kept as the license asks:
 *
 *   MIT License
 *
 *   Copyright (c) 2026 LibreChat
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */
import type { SessionEvent } from "./types";

export interface Tick {
  /** The event's index in the log — what the turn's anchor carries. */
  index: number;
  role: "user" | "assistant";
  /** Log-scaled length in [0.25, 1]: the tick's width as a fraction. */
  weight: number;
  /** The message's first non-empty line, for the rib's accessible name. */
  first_line: string;
  /** Item 359: the hover preview, LibreChat's way — the first 80
   *  characters of the text (whitespace collapsed) and "..." if cut. */
  preview: string;
  /** Item 359: the reply being written (`liveTick`); its anchor is
   *  `data-nav-live`, and with no text yet it previews "Generating". */
  pending?: boolean;
}

/** Under this many ticks the strip is not drawn (item 359: LibreChat's
 *  rule — `messageEntries.length < 3` returns nothing — so a short chat of
 *  three messages has its rail, scrolling or not). Was 4 before 359. */
export const MIN_TICKS = 3;

/** Characters at which a tick is full width; anything longer is the same. */
export const FULL_WEIGHT_CHARS = 4000;
export const MIN_WEIGHT = 0.25;
const FIRST_LINE_CHARS = 140;

/**
 * Log scale, so a two-line question and a ten-line one look different
 * and a 4k reply and a 40k one do not: past a screenful the width stops
 * saying anything the bubble does not say better.
 */
export function weightOf(chars: number): number {
  const n = Math.max(0, chars);
  const t = Math.log10(1 + n) / Math.log10(1 + FULL_WEIGHT_CHARS);
  return MIN_WEIGHT + (1 - MIN_WEIGHT) * Math.min(1, Math.max(0, t));
}

/** The first non-empty line, whitespace collapsed, cut with an ellipsis. */
export function firstLine(text: string): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    return line.length > FIRST_LINE_CHARS ? `${line.slice(0, FIRST_LINE_CHARS - 1).trimEnd()}…` : line;
  }
  return "";
}

/**
 * The ticks. `live` is `liveFlags(events)`: a rewound turn is drawn greyed
 * in the transcript but is not part of the conversation, and a map of the
 * conversation should not offer it. `texts`, when given, is `editTexts`'s
 * output — the edited wording where a turn has one — so the bubble says
 * what the bubble on screen says. Compactions and tool results are not
 * messages and get no tick.
 */
export function ticks(
  events: SessionEvent[],
  live: boolean[],
  texts?: (string | null)[],
): Tick[] {
  const out: Tick[] = [];
  events.forEach((e, index) => {
    if (!live[index]) return;
    const edited = texts?.[index] ?? null;
    if (e.event === "user_message") {
      const text = edited ?? e.text;
      out.push({
        index,
        role: "user",
        weight: weightOf(text.length),
        first_line: firstLine(text),
        preview: previewOf(text),
      });
    } else if (e.event === "assistant_message") {
      let said = "";
      let calls = 0;
      for (const b of e.blocks) {
        if (b.type === "text") said += b.text;
        else if (b.type === "tool_use") calls++;
      }
      const text = edited ?? said;
      // A reply that only called tools has nothing to quote; say so rather
      // than show an empty bubble, and give it the thinnest tick.
      const line = firstLine(text) || (calls > 0 ? `(${calls} tool ${calls === 1 ? "call" : "calls"})` : "");
      out.push({
        index,
        role: "assistant",
        weight: weightOf(text.length),
        first_line: line,
        preview: previewOf(text) || line,
      });
    }
  });
  return out;
}

/** How far under the viewport's top edge a jump lands a message. */
export const JUMP_OFFSET = 12;
/** The reading line: this far under the top edge, or a third of the
 *  viewport if that is less. */
export const READ_LINE = 48;

/**
 * Which tick is being read: the last one whose top is at or above the
 * reading line, a little under the viewport's top edge — the message the
 * top of the screen is inside. A line a third of the way down was tried
 * first and picked the *next* message after every jump to a short one,
 * since a short question and the reply under it both fit above such a
 * line; the line has to be closer to the edge than a short message is
 * tall. At the foot of the chat the last message is the one being read
 * whatever the line says (the last message may be shorter than the
 * viewport). `tops` are the anchors' offsets in the viewport's scroll
 * space, in tick order; null for none.
 */
export function activeTick(
  tops: readonly number[],
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number = Infinity,
): number | null {
  if (tops.length === 0) return null;
  if (scrollTop + clientHeight >= scrollHeight - 8) return tops.length - 1;
  const line = scrollTop + Math.min(clientHeight / 3, READ_LINE);
  let best = 0;
  tops.forEach((top, i) => {
    if (top <= line) best = i;
  });
  return best;
}

/** How far above the foot of the chat the view must be before the
 *  jump-to-latest ⌄ shows (item 218). Under it the foot is a flick away
 *  and a button would only flash while the last line settles. */
export const JUMP_DOWN_SHOW = 160;

/**
 * Whether the round ⌄ above the composer shows (item 218, the Claude
 * app's place for it): the view scrolls, it is more than `JUMP_DOWN_SHOW`
 * above the foot, and a click on it is not already carrying the view
 * down (`chasing`) — a smooth scroll passes through every height on its
 * way, and the button would otherwise stay lit for the whole ride.
 */
export function showJumpDown(scrollTop: number, clientHeight: number, scrollHeight: number, chasing = false): boolean {
  if (chasing) return false;
  if (scrollHeight <= clientHeight + 8) return false;
  return scrollHeight - scrollTop - clientHeight > JUMP_DOWN_SHOW;
}

/**
 * Item 304: whether the ⌄ shows the "still speaking" dots — a reply is
 * still coming in the chat drawn, so a reader scrolled up can see it is
 * going and, when the dots settle into the ⌄, that it is done. The open
 * chat's turn runs while `busy` (a tool call, an approval) as well as while
 * its `live` turn streams; a pane's chat has only its own `live`. A
 * parked turn (`parked`: it runs in a chat set aside, while another is on
 * screen) keeps `busy` true, but its reply is not coming here (303 + 304
 * review).
 */
export function replyGoing(live: boolean, busy: boolean, inPane: boolean, parked = false): boolean {
  return live || (!inPane && busy && !parked);
}

/** The scroll target for the latest message: the foot of the view. */
export function latestTop(scrollHeight: number, clientHeight: number): number {
  return Math.max(0, scrollHeight - clientHeight);
}

/** What a click on the ⌄ does to the viewport: one smooth scroll to the
 *  latest message. The caller re-pins, so a reply still streaming is
 *  followed from there. */
export function scrollToLatest(
  el: Pick<HTMLElement, "scrollHeight" | "clientHeight" | "scrollTo">,
  behavior: ScrollBehavior = "smooth",
): void {
  el.scrollTo({ top: latestTop(el.scrollHeight, el.clientHeight), behavior });
}

/**
 * The tick a step lands on from the current one: ⌥↓ from the last stays
 * on it, ⌥↑ from the first stays on it, and with nothing current a step
 * down goes to the first and a step up to the last.
 */
export function stepTick(current: number | null, dir: 1 | -1, count: number): number | null {
  if (count === 0) return null;
  if (current === null) return dir > 0 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + dir));
}

// ---- Item 359: LibreChat's rail (MessageNav.tsx), ported ----

/** Their preview cut: 80 characters, then "...". */
export const PREVIEW_LIMIT = 80;

/** The hover preview: the text with whitespace collapsed (their `<p>`
 *  collapses it on screen), cut at `PREVIEW_LIMIT` with "...". */
export function previewOf(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.slice(0, PREVIEW_LIMIT) + (t.length > PREVIEW_LIMIT ? "..." : "");
}

/** What a rib's preview says: the reply being written with no text yet
 *  says "Generating" (their `previewTextFor` with `isPending`); any other
 *  empty one says there is no preview. */
export function previewText(t: Tick): string {
  if (t.preview !== "") return t.preview;
  return t.pending ? "Generating" : "No preview";
}

/** The rib for the reply still streaming (LibreChat's rail lists the row
 *  the moment it mounts, a frame before its first token). Its anchor is
 *  `data-nav-live` (not a `data-turn`: code that reads `[data-turn]` as a
 *  log index must not see it); `index` is -1, never a log index. */
export function liveTick(text: string): Tick {
  return {
    index: -1,
    role: "assistant",
    weight: weightOf(text.length),
    first_line: firstLine(text),
    preview: previewOf(text),
    pending: true,
  };
}

/** The selector of a tick's anchor in the transcript. */
export function anchorSelector(index: number): string {
  return index < 0 ? "[data-nav-live]" : `[data-turn="${index}"]`;
}

export interface RibDims {
  baseW: number;
  baseH: number;
  peakW: number;
  peakH: number;
}
/** Their sizes, CSS px: the origin and terminus dots, a message rib, and
 *  the rib being read (longer at rest — "where am I" from length alone). */
export const RIB_END: RibDims = { baseW: 3, baseH: 3, peakW: 4.5, peakH: 4.5 };
export const RIB_MESSAGE: RibDims = { baseW: 12, baseH: 3, peakW: 39, peakH: 6 };
export const RIB_CURRENT: RibDims = { baseW: 21, baseH: 3, peakW: 39, peakH: 6 };
/** Row height and the gap between rows: a 12 px pitch. `peakH` never
 *  exceeds the row, so magnifying never reflows the rail. */
export const RIB_ROW = 6;
export const RIB_GAP = 6;
/** The magnifier's reach above and below the pointer. */
export const MAG_INFLUENCE = 50;
/** Delay before the preview first opens; later moves follow at once. */
export const TOOLTIP_OPEN_DELAY = 60;
/** Their click-to-scroll: 400 ms, ease-out cubic. */
export const SCROLL_DURATION = 400;
/** Slack in the "has this message's top passed the viewport's top" test. */
export const JUMP_EPS = 4;
/** A press that moves this far becomes a drag (scrub) rather than a click. */
export const DRAG_THRESHOLD = 4;

export function ribDims(isEnd: boolean, isCurrent: boolean): RibDims {
  if (isEnd) return RIB_END;
  return isCurrent ? RIB_CURRENT : RIB_MESSAGE;
}

/** Cosine bell: 1 at the pointer, easing to 0 at the influence radius. */
export function magnifyFalloff(distance: number, influence: number): number {
  if (distance >= influence) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * distance) / influence));
}

/** A rib's size at falloff `t` (0 at rest, 1 at the peak). */
export function magnified(d: RibDims, t: number): { w: number; h: number } {
  return { w: d.baseW + (d.peakW - d.baseW) * t, h: d.baseH + (d.peakH - d.baseH) * t };
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * A CSS length snapped to whole device pixels. WebKit's
 * `devicePixelRatio` includes page zoom (measured 2026-10-13: 2 at 100 %,
 * 2.5 at 125 % on his display), so at 90 % a 3 px rib is 5.4 device px
 * and neighbours round to 5 or 6; snapped, every rib is the same. Never
 * below one device pixel for a positive length.
 */
export function snapPx(css: number, dpr: number): number {
  if (!(dpr > 0)) return css;
  const dev = Math.round(css * dpr);
  return (css > 0 ? Math.max(1, dev) : dev) / dpr;
}

/** Where a jump lands a message: its top less `JUMP_OFFSET`, clamped to
 *  what the viewport can reach (their `snapPointFor`). */
export function snapPoint(top: number, maxScroll: number, offset: number = JUMP_OFFSET): number {
  return Math.max(0, Math.min(top - offset, maxScroll));
}

/** Their ⌃: the last message whose snap point is above the view's top by
 *  more than `JUMP_EPS` — the start of the message being read when the
 *  view is partway into it. Null when there is none (the chevron greys). */
export function prevTarget(tops: readonly number[], scrollTop: number, maxScroll: number): number | null {
  for (let i = tops.length - 1; i >= 0; i--) {
    if (snapPoint(tops[i], maxScroll) < scrollTop - JUMP_EPS) return i;
  }
  return null;
}

/** Their ⌄: the first message whose snap point is below the view's top by
 *  more than `JUMP_EPS`. Null when there is none. */
export function nextTarget(tops: readonly number[], scrollTop: number, maxScroll: number): number | null {
  for (let i = 0; i < tops.length; i++) {
    if (snapPoint(tops[i], maxScroll) > scrollTop + JUMP_EPS) return i;
  }
  return null;
}

/** The messages with any part on screen, as [first, last], or null. */
export function inViewRange(
  tops: readonly number[],
  bottoms: readonly number[],
  scrollTop: number,
  clientHeight: number,
): [number, number] | null {
  const viewBottom = scrollTop + clientHeight;
  let first = -1;
  let last = -1;
  for (let i = 0; i < tops.length; i++) {
    if (bottoms[i] <= scrollTop) continue;
    if (tops[i] >= viewBottom) break;
    if (first === -1) first = i;
    last = i;
  }
  return first === -1 ? null : [first, last];
}

/**
 * Where the rail's own column scrolls to (theirs): at the foot of the
 * chat, or with the last message on screen, to its own foot; otherwise so
 * the on-screen ribs sit in its middle. `ribTop(i)`/`ribBottom(i)` are
 * rib edges in the column's content space.
 */
export function columnFollow(
  range: [number, number] | null,
  count: number,
  atFoot: boolean,
  ribTop: (i: number) => number,
  ribBottom: (i: number) => number,
  colHeight: number,
  colScrollHeight: number,
): number | null {
  const max = Math.max(0, colScrollHeight - colHeight);
  if (atFoot || (range && range[1] === count - 1)) return max;
  if (!range) return null;
  const mid = (ribTop(range[0]) + ribBottom(range[1])) / 2;
  return Math.max(0, Math.min(mid - colHeight / 2, max));
}

/**
 * Their click-to-scroll: `SCROLL_DURATION` ms of ease-out cubic from where
 * the view is to `target()`, re-read every frame so a message that moves
 * (a reply growing above it) is still where it lands. Starting another
 * cancels this one. Returns a cancel.
 */
let scrollToken = 0;
export function animateScroll(
  el: HTMLElement,
  target: () => number | null,
  duration: number = SCROLL_DURATION,
  raf: (cb: (now: number) => void) => unknown = requestAnimationFrame,
  now: () => number = () => performance.now(),
): () => void {
  const token = ++scrollToken;
  const from = el.scrollTop;
  const start = now();
  const step = (t: number) => {
    if (token !== scrollToken) return;
    const to = target();
    if (to === null) return;
    const p = duration <= 0 ? 1 : Math.min(1, (t - start) / duration);
    el.scrollTop = from + (to - from) * easeOutCubic(p);
    if (p < 1) raf(step);
  };
  raf(step);
  return () => {
    if (token === scrollToken) scrollToken++;
  };
}

/** Cancels whatever `animateScroll` is running (a wheel, a drag). */
export function cancelScroll(): void {
  scrollToken++;
}

/**
 * A rib's line in its row, on whole device pixels: width and height
 * snapped, and its top inset the floor of half the difference — centring
 * with `align-items` puts a 3 px line in a 6 px row half a device pixel
 * off at 125 % (row 15, line 8 device px) and blurs it (measured).
 */
export function ribBox(w: number, h: number, row: number, dpr: number): { w: number; h: number; top: number } {
  const sw = snapPx(w, dpr);
  const sh = snapPx(h, dpr);
  if (!(dpr > 0)) return { w: sw, h: sh, top: (row - sh) / 2 };
  const rowDev = Math.round(row * dpr);
  const hDev = Math.round(sh * dpr);
  return { w: sw, h: sh, top: Math.max(0, Math.floor((rowDev - hDev) / 2)) / dpr };
}

/**
 * A scroll offset for the rail's own column that keeps its ribs on device
 * pixels. WebKit keeps `scrollTop` in whole CSS pixels (inferred from the
 * 90 % shot: ribs sat 0.22 device px off after a follow), so at a zoom
 * whose `devicePixelRatio` is not whole (1.8 at 90 %) only some whole
 * offsets are whole device pixels (multiples of 5 at 1.8). The nearest
 * such offset within `reach` CSS px; else the nearest whole one.
 */
export function snapScroll(target: number, dpr: number, max: number, reach = 8): number {
  const clamp = (n: number) => Math.max(0, Math.min(Math.floor(max), n));
  const base = Math.round(target);
  if (!(dpr > 0)) return clamp(base);
  for (let d = 0; d <= reach; d++) {
    for (const n of d === 0 ? [base] : [base - d, base + d]) {
      const dev = n * dpr;
      if (n === clamp(n) && Math.abs(dev - Math.round(dev)) < 1e-3) return n;
    }
  }
  return clamp(base);
}
