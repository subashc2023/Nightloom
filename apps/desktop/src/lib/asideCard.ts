// The floating aside card (nightshift backlog 141, 2026-09-17; answers
// blocker 162 — "popover at the selection, and the answer there too").
//
// Highlight a passage, click Ask aside: the passage stays marked in the
// transcript and a small card opens right under it — the question box,
// then the answer streaming in, then the follow-ups — and the view does
// not move. The card sits inside the transcript's scrolled column, so it
// scrolls with the message it is about; this module is the pure part of
// that — where the card goes, given the rectangles — so the suite can pin
// the geometry. `Transcript.svelte` measures and applies it; the highlight
// itself (`markRange`) and the anchor's offsets (`offsetsOf`,
// `rangeFromOffsets`) need a document and are checked in the harness.
//
// The anchor: a passage is remembered as character offsets into the text
// of its prose block (`.markdown` for a reply, `.user-text` for his
// message) under the turn's element. Offsets survive a re-render — the
// log re-syncs at a turn's end and the reply is new DOM — where a `Range`
// would not, and they are small enough to keep with the thread across a
// relaunch (`asides.ts`).

/** A rectangle in the viewport's coordinates, as `getBoundingClientRect`. */
export interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** Where a passage aside is anchored: the turn, and the selection as
 *  offsets into its prose block's text. `side` is decided once, when the
 *  card opens, so a growing answer never flips the card over the
 *  passage mid-stream. */
export interface AsideAnchor {
  turn: number;
  /** Which prose block of the turn, in document order: a reply's text is
   *  one `.markdown` per segment between its tool calls. */
  block: number;
  start: number;
  end: number;
  side: "below" | "above";
}

export interface Placement {
  /** Offsets from the host's (the scrolled column's) top-left corner. */
  top: number;
  left: number;
  width: number;
  /** The most the card may grow on its side of the passage before it
   *  scrolls inside; never under `MIN_CARD_HEIGHT`. */
  maxHeight: number;
  side: "below" | "above";
}

/** The height a card is given room for when its side is chosen: a head
 *  row, a question, a few lines of answer. Past it the card scrolls. */
export const PREFERRED_CARD_HEIGHT = 240;
/** The gap between the passage and the card's edge. */
export const CARD_GAP = 8;
/** The card's width when the column allows it. */
export const CARD_WIDTH = 440;
/** Below this the card scrolls rather than shrinks. */
export const MIN_CARD_HEIGHT = 160;
/** Kept between the card and the viewport's edge on its side. */
export const EDGE_MARGIN = 12;

/**
 * Which side of the passage the card opens on: below when a card of
 * `height` fits between the passage and the viewport's foot, else above
 * when it fits there, else below (the column scrolls; the card is never
 * cut off, only reached). Decided once at open.
 */
export function chooseSide(sel: Rect, vp: Rect, height: number): "below" | "above" {
  const roomBelow = vp.bottom - EDGE_MARGIN - (sel.bottom + CARD_GAP);
  if (roomBelow >= height) return "below";
  const roomAbove = sel.top - CARD_GAP - (vp.top + EDGE_MARGIN);
  if (roomAbove >= height) return "above";
  return roomAbove > roomBelow ? "above" : "below";
}

/**
 * The card's place: under the passage's bottom edge (or over its top
 * edge), its left edge at the selection's, kept inside the host's width —
 * a column narrower than the card gives the card its own width. The
 * `maxHeight` is the room on that side of the passage, so a long answer
 * scrolls inside the card instead of leaving the viewport; a card of
 * `height` that is smaller keeps its size. The room is only known while
 * the passage is in view (the card moves with it, so it is out of view
 * too otherwise — a thread restored on a chat switch is measured before
 * anyone scrolls to it): off-screen, the card gets half the viewport,
 * and never more than the viewport less its margins.
 */
export function placeCard(sel: Rect, host: Rect, vp: Rect, height: number, side: "below" | "above"): Placement {
  const hostWidth = host.right - host.left;
  const width = Math.min(CARD_WIDTH, hostWidth);
  const left = Math.max(0, Math.min(sel.left - host.left, hostWidth - width));
  const vpHeight = vp.bottom - vp.top;
  const inView = sel.bottom > vp.top && sel.top < vp.bottom;
  const cap = Math.max(MIN_CARD_HEIGHT, vpHeight - 2 * EDGE_MARGIN);
  const clamp = (room: number) => Math.min(cap, Math.max(MIN_CARD_HEIGHT, inView ? room : vpHeight / 2));
  if (side === "below") {
    const maxHeight = clamp(vp.bottom - EDGE_MARGIN - (sel.bottom + CARD_GAP));
    return { top: sel.bottom + CARD_GAP - host.top, left, width, maxHeight, side };
  }
  const maxHeight = clamp(sel.top - CARD_GAP - (vp.top + EDGE_MARGIN));
  const shown = Math.min(height, maxHeight);
  return { top: sel.top - CARD_GAP - shown - host.top, left, width, maxHeight, side };
}

// ---- Several cards at once (nightshift backlog 176, blocker 318) ----

/** Past this many open cards in a chat, the oldest fold to their head
 *  row — a title strip that re-expands on a click (blocker 318). */
export const MAX_OPEN_ASIDES = 3;

/** A placed card, in the host's coordinates. */
export interface CardBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Keep the floating cards from covering each other (blocker 318's
 * default): in order of their natural top, a card whose box would
 * overlap one already placed — horizontally and vertically — is pushed
 * down to sit `CARD_GAP` under it, so each card stays beside its own
 * passage and none hides another. Returns the tops, in the input's
 * order. Pure; a single card is returned as it came.
 */
export function spreadCards(boxes: readonly CardBox[]): number[] {
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a]!.top - boxes[b]!.top || a - b);
  const tops = boxes.map((b) => b.top);
  const placed: CardBox[] = [];
  for (const i of order) {
    const b = boxes[i]!;
    let top = b.top;
    // Re-check after every push: moving below one card can land on the
    // next one down.
    for (let moved = true; moved; ) {
      moved = false;
      for (const p of placed) {
        const across = b.left < p.left + p.width && p.left < b.left + b.width;
        const along = top < p.top + p.height + CARD_GAP && p.top < top + b.height + CARD_GAP;
        if (across && along) {
          top = p.top + p.height + CARD_GAP;
          moved = true;
        }
      }
    }
    tops[i] = top;
    placed.push({ ...b, top });
  }
  return tops;
}

/**
 * Which cards fold (blocker 318): with more than `max` unfolded, the
 * oldest unfolded ones — never `keep`, the card just opened or clicked
 * open — until `max` remain. Takes the cards oldest first; returns the
 * indices to fold. Pure.
 */
export function foldTheOldest(folded: readonly boolean[], keep: number | null, max = MAX_OPEN_ASIDES): number[] {
  let open = folded.filter((f) => !f).length;
  const out: number[] = [];
  for (let i = 0; i < folded.length && open > max; i++) {
    if (folded[i] || i === keep) continue;
    out.push(i);
    open--;
  }
  return out;
}

// ---- The DOM half: offsets and the mark. Not run in the suite. ----

/** A text-node walker in document order under `root`. */
function* textNodes(root: Node): Generator<Text> {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  let n = walker.nextNode();
  while (n) {
    yield n as Text;
    n = walker.nextNode();
  }
}

/** Where a boundary (a node and an offset within it) falls in the text
 *  under `root`, counting characters of text nodes in order. A boundary
 *  on an element counts the text before its `offset`-th child. */
function charOffset(root: Node, node: Node, offset: number): number {
  let count = 0;
  let target: Node | null = node;
  let inner = offset;
  if (node.nodeType !== 3 /* TEXT_NODE */) {
    // An element boundary: the text of the children before `offset`.
    const child = node.childNodes[offset] ?? null;
    if (child) {
      target = child;
      inner = 0;
    } else {
      // Past the last child: everything under the node.
      for (const t of textNodes(root)) {
        if (node.contains(t)) count = Math.max(count, tally(root, t) + t.data.length);
      }
      return count;
    }
  }
  for (const t of textNodes(root)) {
    if (t === target || (target && target.nodeType !== 3 && target.contains(t))) {
      return count + (t === target ? inner : 0);
    }
    count += t.data.length;
  }
  return count;
}

function tally(root: Node, until: Text): number {
  let count = 0;
  for (const t of textNodes(root)) {
    if (t === until) return count;
    count += t.data.length;
  }
  return count;
}

/** The selection as offsets into `prose`'s text. */
export function offsetsOf(prose: Node, range: Range): { start: number; end: number } {
  const start = charOffset(prose, range.startContainer, range.startOffset);
  const end = charOffset(prose, range.endContainer, range.endOffset);
  return start <= end ? { start, end } : { start: end, end: start };
}

/** The range for offsets into `prose`'s text, or null when the text has
 *  changed under them (shorter than `end`, say). */
export function rangeFromOffsets(prose: Node, start: number, end: number): Range | null {
  const doc = prose.ownerDocument;
  if (!doc || end <= start) return null;
  const range = doc.createRange();
  let count = 0;
  let haveStart = false;
  for (const t of textNodes(prose)) {
    const next = count + t.data.length;
    if (!haveStart && start >= count && start < next) {
      range.setStart(t, start - count);
      haveStart = true;
    }
    if (haveStart && end > count && end <= next) {
      range.setEnd(t, end - count);
      return range;
    }
    count = next;
  }
  return null;
}

const HIGHLIGHT_NAME = "aside-passage";

type HighlightSet = { add(r: Range): void; delete(r: Range): boolean; size: number };
type Highlights = {
  set(name: string, h: unknown): void;
  get(name: string): HighlightSet | undefined;
  delete(name: string): void;
};
type HighlightCtor = new (...ranges: Range[]) => HighlightSet;

/**
 * Mark the passage: the CSS Custom Highlight API when the webview has it
 * (WebKit since Safari 17.2; `::highlight(aside-passage)` in the
 * transcript's styles paints it), else each text node the range touches
 * is wrapped in a `<mark class="aside-passage">`. Returns the undo. The
 * fallback is only ever applied to rendered markdown Svelte does not
 * diff (`{@html}`), and it is undone before the next render replaces it.
 */
export function markRange(range: Range): () => void {
  const css = (globalThis as { CSS?: { highlights?: Highlights } }).CSS;
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  if (css?.highlights && Highlight) {
    // One highlight holds every open card's passage (backlog 176): a
    // second `set` under the name used to unmark the first. Each undo
    // takes its own range out, and the last one takes the name away.
    const highlights = css.highlights;
    let shared = highlights.get(HIGHLIGHT_NAME);
    if (!shared) {
      shared = new Highlight();
      highlights.set(HIGHLIGHT_NAME, shared);
    }
    shared.add(range);
    const mine = shared;
    return () => {
      mine.delete(range);
      if (mine.size === 0 && highlights.get(HIGHLIGHT_NAME) === mine) highlights.delete(HIGHLIGHT_NAME);
    };
  }
  const doc = range.startContainer.ownerDocument;
  if (!doc) return () => {};
  const wrapped: HTMLElement[] = [];
  // A selection inside one text node has that node as its common
  // ancestor, and a walker never yields its own root: walk from the
  // parent.
  const common = range.commonAncestorContainer;
  const root = common.nodeType === 3 /* TEXT_NODE */ ? (common.parentNode ?? common) : common;
  const nodes: Text[] = [];
  for (const t of textNodes(root)) if (range.intersectsNode(t)) nodes.push(t);
  for (const t of nodes) {
    let node = t;
    if (node === range.endContainer && range.endOffset < node.data.length) node.splitText(range.endOffset);
    if (node === range.startContainer && range.startOffset > 0) node = node.splitText(range.startOffset);
    if (!node.data) continue;
    const mark = doc.createElement("mark");
    mark.className = "aside-passage";
    node.parentNode?.insertBefore(mark, node);
    mark.appendChild(node);
    wrapped.push(mark);
  }
  return () => {
    for (const m of wrapped) {
      const parent = m.parentNode;
      if (!parent) continue;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
      parent.normalize();
    }
  };
}
