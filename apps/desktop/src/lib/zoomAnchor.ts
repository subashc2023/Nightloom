/**
 * Item 672 (his words: "doing command plus or minus changes the location of
 * where i am in the text that im reading significantly"): ⌘+ / ⌘− keep the
 * reader's place in every scrolled view.
 *
 * Page zoom reflows text at a new width, so the content above a view's
 * scroll offset grows or shrinks while `scrollTop` keeps its number, and the
 * line he was on slides away. The webview has no scroll anchoring of its own
 * (Transcript's `keepPlace` notes the same). So, before the zoom, each view
 * scrolled away from its top records what sits at its top edge — the text
 * position there (`caretRangeFromPoint`, WebKit's), else the element and how
 * far down it the edge falls (a PDF page, an image) — and after the new
 * layout each view is scrolled so the same spot sits at the same place.
 * A view at its bottom (a chat following a reply) stays at its bottom.
 *
 * Every view at once, whatever it is — chat, aside, notes, files, PDFs,
 * Settings, the terminal's own scroller — since the zoom is the whole app's
 * (practices §4: a principle covers its whole class).
 */

export type Anchor =
  | { kind: "bottom"; el: Element }
  | { kind: "text"; el: Element; range: Range; offset: number }
  | { kind: "box"; el: Element; target: Element; frac: number };

/** Within this many px of the end counts as "at the bottom". */
const BOTTOM_SLOP = 2;

function scrolled(el: Element): boolean {
  return el.scrollTop > 0 && el.scrollHeight > el.clientHeight + 1;
}

/** The views scrolled away from their top, outermost first (document order). */
export function scrolledViews(doc: Document = document): Element[] {
  const out: Element[] = [];
  const root = doc.scrollingElement;
  if (root && scrolled(root)) out.push(root);
  for (const el of Array.from(doc.body?.querySelectorAll("*") ?? [])) {
    if (scrolled(el)) out.push(el);
  }
  return out;
}

/** The top of a view's visible box, in viewport px. */
function viewTop(el: Element, doc: Document): number {
  return el === doc.scrollingElement ? 0 : el.getBoundingClientRect().top;
}

/** A range's top in viewport px — a collapsed range has no box in WebKit, so one character is taken. */
export function rangeTop(r: Range): number | null {
  const c = r.cloneRange();
  const n = c.startContainer;
  if (n.nodeType === 3) {
    const len = (n as Text).length;
    if (c.startOffset < len) c.setEnd(n, c.startOffset + 1);
    else if (c.startOffset > 0) c.setStart(n, c.startOffset - 1);
  }
  const rects = c.getClientRects();
  const box = rects.length ? rects[0] : c.getBoundingClientRect();
  if (!box || (box.width === 0 && box.height === 0 && box.top === 0)) return null;
  return box.top;
}

type CaretDoc = Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };

/** What sits at `view`'s top edge, or null when nothing on screen can be held. */
export function anchorOf(view: Element, doc: Document = document): Anchor | null {
  if (view.scrollHeight - view.scrollTop - view.clientHeight <= BOTTOM_SLOP)
    return { kind: "bottom", el: view };
  const isRoot = view === doc.scrollingElement;
  const box = isRoot
    ? { left: 0, top: 0, width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight }
    : view.getBoundingClientRect();
  const top = viewTop(view, doc);
  const cd = doc as CaretDoc;
  // A few points along the top band: the text column may not start at the left edge.
  // Every point is tried for an exact text position before any falls back to an element.
  let fallback: Anchor | null = null;
  for (const dy of [4, 16, 32]) {
    for (const fx of [0.5, 0.25, 0.75, 0.1]) {
      const x = box.left + box.width * fx;
      const y = top + dy;
      const hit = doc.elementFromPoint(x, y);
      if (!hit || !view.contains(hit) || (hit !== view && innerScroller(hit, view))) continue;
      const r = cd.caretRangeFromPoint?.(x, y) ?? null;
      if (r && r.startContainer.nodeType === 3 && view.contains(r.startContainer)) {
        const t = rangeTop(r);
        if (t !== null && t >= top - 40 && t <= top + box.height / 3)
          return { kind: "text", el: view, range: r, offset: t - top };
      }
      if (hit !== view && !fallback) {
        const hb = hit.getBoundingClientRect();
        if (hb.height > 0) fallback = { kind: "box", el: view, target: hit, frac: (top - hb.top) / hb.height };
      }
    }
  }
  return fallback;
}

/** Whether `el` sits inside a scroller nested in `view` (that one holds its own place). */
function innerScroller(el: Element, view: Element): boolean {
  for (let p: Element | null = el.parentElement; p && p !== view; p = p.parentElement) {
    if (p.scrollHeight > p.clientHeight + 1) {
      const oy = getComputedStyle(p).overflowY;
      if (oy === "auto" || oy === "scroll") return true;
    }
  }
  return false;
}

/** Scroll `a.el` so its anchor sits where it was. Idempotent: safe to run on several frames. */
export function restore(a: Anchor, doc: Document = document): void {
  const view = a.el;
  if (!view.isConnected) return;
  if (a.kind === "bottom") {
    view.scrollTop = view.scrollHeight;
    return;
  }
  const top = viewTop(view, doc);
  let delta: number | null = null;
  if (a.kind === "text") {
    if (!a.range.startContainer.isConnected) return;
    const t = rangeTop(a.range);
    if (t !== null) delta = t - top - a.offset;
  } else {
    if (!a.target.isConnected) return;
    const hb = a.target.getBoundingClientRect();
    delta = hb.top + a.frac * hb.height - top;
  }
  if (delta !== null && Math.abs(delta) >= 1) view.scrollTop += delta;
}

/** Every scrolled view's anchor, now. */
export function captureAnchors(doc: Document = document): Anchor[] {
  const out: Anchor[] = [];
  for (const v of scrolledViews(doc)) {
    const a = anchorOf(v, doc);
    if (a) out.push(a);
  }
  return out;
}

/**
 * Run `change` (the zoom) with every view's place kept: anchors taken
 * before, then put back once the window has re-laid out (its `resize`,
 * else ~250 ms), and again over the next few frames for content that
 * settles late (a PDF page redrawn at the new size). A scroll of his own
 * in that window ends the re-tries, so they never fight him.
 */
export async function keepPlacesAcross(change: () => Promise<void>): Promise<void> {
  if (typeof document === "undefined") return change();
  const anchors = captureAnchors();
  if (!anchors.length) return change();
  const w0 = window.innerWidth;
  let laidOut: () => void = () => {};
  const resized = new Promise<void>((res) => (laidOut = res));
  const onResize = () => laidOut();
  window.addEventListener("resize", onResize, { once: true });
  await change();
  if (window.innerWidth === w0) await Promise.race([resized, new Promise((r) => setTimeout(r, 250))]);
  window.removeEventListener("resize", onResize);
  let stopped = false;
  const stop = () => (stopped = true);
  for (const ev of ["wheel", "keydown", "pointerdown", "touchstart"]) window.addEventListener(ev, stop, { once: true, capture: true });
  const run = () => {
    if (!stopped) for (const a of anchors) restore(a);
  };
  run();
  const frames = [1, 2, 4, 8, 16];
  // The re-tries run on without holding the caller (the zoom's toast shows at once).
  let n = 0;
  const step = () => {
    n++;
    if (frames.includes(n)) run();
    if (n >= 16 || stopped) {
      for (const ev of ["wheel", "keydown", "pointerdown", "touchstart"]) window.removeEventListener(ev, stop, { capture: true });
      return;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
