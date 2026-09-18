/**
 * Find in page (nightshift backlog 106, first half): ⌘F opens a small bar
 * over the transcript or the open note, the way Chrome's does; the text
 * on the page is matched as he types, every hit is lit, the current one
 * brighter and scrolled into view, ⏎ / ⇧⏎ (and ⌘G / ⌘⇧G) step through.
 *
 * The bar is `FindBar.svelte`; this file is the parts under it. The pure
 * half — a length-preserving case fold, the match over a list of text
 * segments, the stepping, the count — is what the suite pins. The DOM half
 * walks the page for its visible text nodes and lights the hits from
 * outside: the message components are never edited for this. Lighting is
 * the CSS Custom Highlight API where the webview has it (WKWebView on his
 * macOS does; `CSS.highlights` is the check) — ranges painted by the
 * `::highlight(find-match)` rules in `app.css`, nothing inserted into the
 * DOM — and otherwise `<mark>` wrappers that are taken out again cleanly
 * on close.
 */

/** Where a hit starts or ends: which segment, and the offset within it. */
export interface Pos {
  seg: number;
  off: number;
}

/** One hit — `end` is exclusive, and sits inside its segment (never at
 *  offset 0 of the next). */
export interface Hit {
  start: Pos;
  end: Pos;
}

/**
 * Lower-case that keeps the string's length, so an offset into the folded
 * text is an offset into the original. `toLowerCase` alone does not: a
 * handful of characters (`İ` → `i̇`) lower to two code units. Those keep
 * their original form here — a miss on them is better than a shifted hit
 * on everything after.
 */
export function foldCase(s: string): string {
  const lower = s.toLowerCase();
  if (lower.length === s.length) return lower;
  let out = "";
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

/**
 * Every case-insensitive occurrence of `query` in the segments read as one
 * string, so a hit may cross a segment boundary — "the `foo` bar" is three
 * text nodes and "foo bar" should still find it. The walker puts a "\n"
 * segment between blocks, which a typed query never contains, so a hit
 * never crosses a paragraph. Hits do not overlap: the search resumes after
 * each one, as Chrome's does. An empty query has no hits.
 */
export function findMatches(segments: readonly string[], query: string): Hit[] {
  const q = foldCase(query);
  if (q.length === 0) return [];
  const starts: number[] = [];
  let total = 0;
  let text = "";
  for (const s of segments) {
    starts.push(total);
    total += s.length;
    text += foldCase(s);
  }
  const hits: Hit[] = [];
  let from = 0;
  for (;;) {
    const i = text.indexOf(q, from);
    if (i < 0) break;
    const last = posOf(starts, segments, i + q.length - 1);
    hits.push({
      start: posOf(starts, segments, i),
      end: { seg: last.seg, off: last.off + 1 },
    });
    from = i + q.length;
  }
  return hits;
}

/** The segment holding global offset `i` (which must lie inside one). */
function posOf(
  starts: readonly number[],
  segments: readonly string[],
  i: number,
): Pos {
  // Binary search over the segment starts; empty segments hold nothing
  // and are skipped by the `i < start + length` test.
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  while (lo < segments.length - 1 && i >= starts[lo] + segments[lo].length)
    lo++;
  return { seg: lo, off: i - starts[lo] };
}

/**
 * The next or previous hit, wrapping at the ends the way Chrome's ⏎ does.
 * From nowhere, a step forward is the first hit and a step back the last.
 * No hits: nowhere.
 */
export function stepHit(
  current: number | null,
  dir: 1 | -1,
  count: number,
): number | null {
  if (count <= 0) return null;
  if (current === null) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}

/**
 * The hit that should be current after the page changed under an open
 * search: the same ordinal if it still exists, else the last, else none.
 */
export function keepHit(current: number | null, count: number): number | null {
  if (count <= 0) return null;
  if (current === null) return 0;
  return Math.min(current, count - 1);
}

/** The bar's count: `3 of 12`; `0 of 0` with nothing found. */
export function countLabel(current: number | null, count: number): string {
  return `${current === null ? 0 : current + 1} of ${count}`;
}

/**
 * The search-everywhere panel's chord (nightshift backlog 117), as one
 * physical key so his answer to blocker 164 is a one-line change: the
 * boards draw ⌘⇧F, but ⌘⇧F is the Fable model switch (a menu accelerator
 * on macOS, which fires the menu event *and* the keydown, so a second
 * binding on it would open the panel and switch the model at once). ⌘⇧E —
 * "everywhere" — is free on every platform. `SEARCH_CHORD_LABEL` is what
 * the bar's link, the panel's footer and the docs print.
 */
export const SEARCH_KEY = "KeyE";
export const SEARCH_CHORD_LABEL = "⌘⇧E";

/**
 * Which of the bar's chords a key event is, or null. ⌘F opens (or refocuses)
 * the bar; ⌘G / ⌘⇧G step, the browsers' convention beside ⏎ / ⇧⏎ in the
 * field; `SEARCH_KEY` with ⇧ is "everywhere", the search panel (backlog
 * 117). Physical keys, so a layout cannot move them; `primary` is ⌘ on
 * macOS and Ctrl elsewhere, decided by the caller. None of the four is a
 * menu item, so macOS cannot double-fire them. ~~⌘⇧F stays free: the
 * search-everywhere half (backlog 117) is drawn first.~~ 2026-09-16: ⌘⇧F
 * is the Fable switch (blocker 164); the panel is on `SEARCH_KEY`.
 */
export function findChord(
  e: { code: string; shiftKey: boolean; altKey: boolean },
  primary: boolean,
): "open" | "next" | "prev" | "everywhere" | null {
  if (!primary || e.altKey) return null;
  if (e.code === "KeyF") return e.shiftKey ? null : "open";
  if (e.code === "KeyG") return e.shiftKey ? "prev" : "next";
  if (e.code === SEARCH_KEY) return e.shiftKey ? "everywhere" : null;
  return null;
}

// ---- The DOM half ---------------------------------------------------------

/**
 * An editable field the search reads by value (nightshift backlog 162):
 * a `<textarea>` — the composer's draft, an open in-place edit, a note's
 * box — or an element carrying `data-find-text` (a queued message's row,
 * which shows its first line and holds the whole text there). A textarea's
 * value is not a text node, so the walker used to skip it, and ⌘F on a
 * long draft found nothing. The value is searched as it stands (never
 * rendered into a hidden element); a hit in one is shown by selecting the
 * range in the textarea and scrolling the field into view, not by a
 * highlight, which a textarea cannot hold.
 */
export interface Field {
  field: Element;
  value: string;
}

/** The visible text of a subtree: the nodes, and their text in the same
 *  order. A `null` node is a block boundary, its text "\n"; a `Field` is
 *  an editable field's value. */
export interface Segments {
  nodes: (Text | Field | null)[];
  texts: string[];
}

export function isField(n: Text | Field | null): n is Field {
  return n !== null && typeof n === "object" && "field" in n;
}

/** The attribute a row sets to be searched by its whole text rather than
 *  the part it shows (the queue strip). */
export const FIND_TEXT_ATTR = "data-find-text";

/**
 * Append a field's value as its own segment, boxed by block boundaries so
 * a hit never runs from the page into the field or out of it. An empty
 * value adds nothing. Pure, for the test.
 */
export function addField(seg: Segments, field: Element, value: string): void {
  if (value.length === 0) return;
  if (seg.nodes.length > 0 && seg.nodes[seg.nodes.length - 1] !== null) {
    seg.nodes.push(null);
    seg.texts.push("\n");
  }
  seg.nodes.push({ field, value });
  seg.texts.push(value);
  seg.nodes.push(null);
  seg.texts.push("\n");
}

/** A hit that lies in one field: the field and the offsets into its
 *  value. Null for a hit in the page's text. */
export function fieldHit(seg: Segments, hit: Hit): { field: Element; start: number; end: number } | null {
  const a = seg.nodes[hit.start.seg];
  if (!isField(a) || hit.end.seg !== hit.start.seg) return null;
  return { field: a.field, start: hit.start.off, end: hit.end.off };
}

/**
 * Where a textarea should scroll so the line holding `offset` sits in the
 * middle of its box: the line's top (hard line breaks only — a wrapped
 * long line lands near enough) less half the box. Never negative.
 */
export function fieldScrollTop(value: string, offset: number, lineHeight: number, clientHeight: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < value.length; i++) if (value.charCodeAt(i) === 10) line++;
  return Math.max(0, line * lineHeight - clientHeight / 2 + lineHeight / 2);
}

/** Elements whose start ends the run of inline text before them. */
const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "LI",
  "UL",
  "OL",
  "PRE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "TR",
  "TD",
  "TH",
  "TABLE",
  "BLOCKQUOTE",
  "SUMMARY",
  "DETAILS",
  "BUTTON",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
  "HR",
  "BR",
  "DT",
  "DD",
]);

/** Elements the search never enters: no rendered text, or not the page. */
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "INPUT",
  "SELECT",
  "NOSCRIPT",
  "SVG",
]);

/**
 * Walk `root` for the text nodes that are on screen, in document order.
 * Folded activity (thinking, tool calls) is not in the DOM at all, so it
 * is out by construction; a closed `<details>` keeps its body in the DOM
 * unrendered, so anything under one that is not its summary is skipped,
 * as is anything `checkVisibility` reports unrendered. `exclude` is the
 * bar itself and the toasts — chrome over the page, not the page.
 */
export function collectSegments(
  root: Element,
  exclude: (el: Element) => boolean,
): Segments {
  const nodes: (Text | null)[] = [];
  const texts: string[] = [];
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(n) {
        if (n.nodeType === Node.TEXT_NODE) {
          // The text under a `data-find-text` row is the part it shows;
          // the row's whole text is searched instead (backlog 162).
          return n.parentElement?.closest(`[${FIND_TEXT_ATTR}]`)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        }
        const el = n as Element;
        if (SKIP_TAGS.has(el.tagName.toUpperCase()) || exclude(el))
          return NodeFilter.FILTER_REJECT;
        const parent = el.parentElement;
        if (
          parent &&
          parent.tagName === "DETAILS" &&
          !(parent as HTMLDetailsElement).open &&
          el.tagName !== "SUMMARY"
        ) {
          return NodeFilter.FILTER_REJECT;
        }
        if (typeof el.checkVisibility === "function" && !el.checkVisibility())
          return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );
  const seg: Segments = { nodes, texts };
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n as Text;
      if (t.data.length === 0) continue;
      nodes.push(t);
      texts.push(t.data);
    } else if ((n as Element).tagName.toUpperCase() === "TEXTAREA") {
      // Searched by value (backlog 162): the composer, an edit, a note.
      addField(seg, n as Element, (n as HTMLTextAreaElement).value);
    } else if ((n as Element).hasAttribute(FIND_TEXT_ATTR)) {
      addField(seg, n as Element, (n as Element).getAttribute(FIND_TEXT_ATTR) ?? "");
    } else if (
      BLOCK_TAGS.has((n as Element).tagName.toUpperCase()) &&
      nodes.length > 0 &&
      nodes[nodes.length - 1] !== null
    ) {
      nodes.push(null);
      texts.push("\n");
    }
  }
  return { nodes, texts };
}

/** The hit as a live DOM range, or null if it touches a block boundary
 *  (which a typed query cannot, but the guard is cheap). */
export function hitRange(seg: Segments, hit: Hit): Range | null {
  const a = seg.nodes[hit.start.seg];
  const b = seg.nodes[hit.end.seg];
  // A field's hit is no DOM range: it is shown by the field's selection.
  if (!a || !b || isField(a) || isField(b)) return null;
  const r = a.ownerDocument.createRange();
  r.setStart(a, hit.start.off);
  r.setEnd(b, hit.end.off);
  return r;
}

/** True where the webview has the CSS Custom Highlight API. */
export function supportsHighlightApi(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  );
}

/** Lights the hits and takes the light off again. Two of these below. */
export interface Highlighter {
  /** Light every hit, `current` (an index into `hits`) brighter. */
  apply(seg: Segments, hits: Hit[], current: number | null): void;
  clear(): void;
  /** Whether `apply` edits the DOM (the mark fallback does; the observer
   *  that re-runs the search on page changes must stand aside for it). */
  readonly mutates: boolean;
}

export const HIGHLIGHT_ALL = "find-match";
export const HIGHLIGHT_CURRENT = "find-current";

/** The Highlight API: ranges registered under two names, painted by the
 *  `::highlight()` rules in `app.css`. Nothing in the DOM changes. */
export function highlightApi(): Highlighter {
  return {
    mutates: false,
    apply(seg, hits, current) {
      const all = new Highlight();
      const cur = new Highlight();
      hits.forEach((h, i) => {
        const r = hitRange(seg, h);
        if (!r) return;
        (i === current ? cur : all).add(r);
      });
      CSS.highlights.set(HIGHLIGHT_ALL, all);
      CSS.highlights.set(HIGHLIGHT_CURRENT, cur);
    },
    clear() {
      CSS.highlights.delete(HIGHLIGHT_ALL);
      CSS.highlights.delete(HIGHLIGHT_CURRENT);
    },
  };
}

export const MARK_CLASS = "find-hit";
export const MARK_CURRENT_CLASS = "find-current";

/**
 * The fallback: each hit wrapped in `<mark class="find-hit">`, one mark per
 * text node it spans. Wrapping splits text nodes, so the hits go in from
 * the last to the first and each hit's segments from the last to the
 * first — `splitText` keeps the head in the original node, so every
 * earlier offset stays right. `clear` unwraps every mark under `root` and
 * normalises, which merges the pieces back into the node they came from:
 * the node Svelte holds a reference to survives.
 */
export function markFallback(root: () => Element | null): Highlighter {
  return {
    mutates: true,
    apply(seg, hits, current) {
      const doc = root()?.ownerDocument ?? document;
      for (let i = hits.length - 1; i >= 0; i--) {
        const h = hits[i];
        for (let s = h.end.seg; s >= h.start.seg; s--) {
          const node = seg.nodes[s];
          if (!node || isField(node)) continue;
          const from = s === h.start.seg ? h.start.off : 0;
          const to = s === h.end.seg ? h.end.off : node.data.length;
          if (to <= from) continue;
          const r = doc.createRange();
          r.setStart(node, from);
          r.setEnd(node, to);
          const mark = doc.createElement("mark");
          mark.className =
            i === current ? `${MARK_CLASS} ${MARK_CURRENT_CLASS}` : MARK_CLASS;
          try {
            r.surroundContents(mark);
          } catch {
            // A range that cannot be wrapped (it should not happen for a
            // range inside one text node) is left unlit rather than thrown.
          }
        }
      }
    },
    clear() {
      const el = root();
      if (!el) return;
      const parents = new Set<Node>();
      for (const mark of Array.from(
        el.querySelectorAll(`mark.${MARK_CLASS}`),
      )) {
        const parent = mark.parentNode;
        if (!parent) continue;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        parent.removeChild(mark);
        parents.add(parent);
      }
      for (const p of parents) p.normalize();
    },
  };
}

/**
 * Bring a range into view inside the nearest scrolling ancestor — the
 * transcript's viewport or the note's pane — centred, instantly. Only that
 * one element scrolls: `scrollIntoView` would also move any ancestor that
 * happened to overflow. Nothing moves when the hit is already in view.
 */
export function scrollRangeIntoView(range: Range, stop: Element): void {
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  let el: Element | null =
    range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : (range.startContainer as Element);
  let scroller: Element | null = null;
  while (el && el !== stop) {
    const oy = getComputedStyle(el).overflowY;
    if (
      (oy === "auto" || oy === "scroll") &&
      el.scrollHeight > el.clientHeight
    ) {
      scroller = el;
      break;
    }
    el = el.parentElement;
  }
  if (!scroller) return;
  const box = scroller.getBoundingClientRect();
  const margin = 24;
  if (rect.top >= box.top + margin && rect.bottom <= box.bottom - margin)
    return;
  scroller.scrollTop += rect.top - box.top - box.height / 2 + rect.height / 2;
}

/** The current hit's element, for the mark fallback's scroll. */
export function currentMark(root: Element): Element | null {
  return root.querySelector(`mark.${MARK_CURRENT_CLASS}`);
}
