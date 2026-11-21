import { mathPasteText, tablePasteText } from "./mathPaste";

/**
 * Item 352, the other direction of 348: copying rendered math out of the
 * app gives its TeX. A reply's formula is KaTeX's output (`math.ts`
 * `renderMath`, `output: "htmlAndMathml"`): a visible copy built from spans
 * and a clipped MathML copy whose `<annotation encoding="application/x-tex">`
 * holds the source (kept by the sanitizer, `markdown.ts` `ALLOW_MATHML`).
 * The browser's own plain text flattens both — 2^4 arrives as "24" (his
 * report, 2026-10-12).
 *
 * KaTeX's `contrib/copy-tex` does the same job, but it builds the plain text
 * from the fragment's `textContent`, which runs paragraphs and list items
 * together; the paste side (`mathPaste.ts`) already turns HTML with KaTeX
 * into text with each formula as `$…$` / `$$…$$` and the layout kept, so
 * the copy goes through it: the selection's HTML in, the plain text out.
 */

/** The copied fragment's HTML as plain text with each formula's TeX, or
 *  null when it holds no rendered formula (the browser's copy stands). */
export function mathCopyText(html: string): string | null {
  if (!/class="[^"]*\bkatex\b/.test(html)) return null;
  return mathPasteText(html);
}

/** The formula a node sits in, display wrapper first. */
function formulaOf(node: Node): Element | null {
  const el = node instanceof Element ? node : node.parentElement;
  return el?.closest(".katex-display") ?? el?.closest(".katex") ?? null;
}

/** Whether any of a formula's drawn glyphs lie between two points. KaTeX's
 *  struts and zero-width spaces do not count; neither does the hidden
 *  MathML copy, which sits before the drawing. */
function drawnBetween(from: (r: Range) => void, to: (r: Range) => void): boolean {
  const r = document.createRange();
  from(r);
  to(r); // a `to` before `from` collapses the range: nothing between
  return r.toString().replace(/[\s​]/g, "") !== "";
}

/** The range's HTML, widened to whole formulas at either end — half a
 *  formula has no source to give. An end that touches a formula without
 *  taking any of its glyphs (a triple-click ending at the next block, which
 *  is a display formula; a drag from just after one) leaves it out instead
 *  (review 2026-10-12: it was pulled in whole). */
function rangeHtml(range: Range): string {
  const r = range.cloneRange();
  const start = formulaOf(r.startContainer);
  const end = formulaOf(r.endContainer);
  if (start) {
    const drawn = start.querySelector(".katex-html") ?? start;
    const taken = drawnBetween((x) => x.setStart(range.startContainer, range.startOffset), (x) => x.setEndAfter(drawn));
    if (taken) r.setStartBefore(start);
    else r.setStartAfter(start);
  }
  if (end) {
    const drawn = end.querySelector(".katex-html") ?? end;
    const taken = drawnBetween((x) => x.setStartBefore(drawn), (x) => x.setEnd(range.endContainer, range.endOffset));
    if (taken) r.setEndAfter(end);
    else r.setEndBefore(end);
  }
  const frag = r.cloneContents();
  // No formula: the browser's own copy stands, and the walk below is skipped.
  if (!frag.querySelector(".katex")) return "";
  try {
    drawnOnly(r.commonAncestorContainer, frag, r, false);
  } catch {
    // The clone did not line up with the page (it always should): the
    // fragment as cloned, as before the review.
  }
  const box = document.createElement("div");
  box.appendChild(frag);
  return box.innerHTML;
}

const isPre = (ws: string) => ws.startsWith("pre") || ws === "break-spaces";

/** Whether a node lies wholly inside the range. */
function inside(range: Range, n: Node): boolean {
  const r = document.createRange();
  r.selectNode(n);
  return range.compareBoundaryPoints(Range.START_TO_START, r) <= 0 && range.compareBoundaryPoints(Range.END_TO_END, r) >= 0;
}

/**
 * The cloned fragment as the page draws it (review 2026-10-12). A clone
 * carries no styles, so the copy took text the browser's own copy leaves
 * out — a message's time row (`user-select: none`), anything
 * `display: none` — and ran a pre-wrapped message's lines together (his
 * turn in `UserBubble.svelte` is plain text in `white-space: pre-wrap`).
 * The page's nodes and the clone's are walked side by side (the clone holds
 * exactly the page's nodes that meet the range, in order): an element the
 * page hides or will not select is dropped, and one whose white-space
 * differs from its parent's is marked `data-nl-ws` for `mathPasteText`.
 * Formulas are not entered: their hidden MathML is the source.
 */
function drawnOnly(live: Node, clone: Node, range: Range, whole: boolean): void {
  const lk = whole ? Array.from(live.childNodes) : Array.from(live.childNodes).filter((n) => range.intersectsNode(n));
  const ck = Array.from(clone.childNodes);
  if (lk.length !== ck.length) throw new Error("clone mismatch");
  const parentPre = live instanceof Element ? isPre(getComputedStyle(live).whiteSpace) : false;
  if (!(clone instanceof Element) && parentPre && live instanceof Element) {
    // The range's top lies inside pre-wrapped text: its loose pieces are pre.
    const wrap = document.createElement("div");
    wrap.setAttribute("data-nl-ws", "pre");
    wrap.append(...ck);
    clone.appendChild(wrap);
  }
  for (let i = 0; i < lk.length; i++) {
    const l = lk[i];
    const c = ck[i];
    if (l.nodeName !== c.nodeName) throw new Error("clone mismatch");
    if (!(l instanceof Element) || !(c instanceof Element)) continue;
    if (l.classList.contains("katex") || l.classList.contains("katex-display")) continue;
    const s = getComputedStyle(l);
    const sel = s.getPropertyValue("user-select") || s.getPropertyValue("-webkit-user-select");
    if (s.display === "none" || s.visibility === "hidden" || sel === "none") {
      c.remove();
      continue;
    }
    const pre = isPre(s.whiteSpace);
    if (pre !== parentPre) c.setAttribute("data-nl-ws", pre ? "pre" : "normal");
    drawnOnly(l, c, range, whole || inside(range, l));
  }
}

/**
 * The rich copy: the fragment with each formula as its MathML alone (the
 * visible span copy needs KaTeX's stylesheet, which a paste elsewhere does
 * not have; MathML draws as math in Chrome, Safari, Word and Docs that take
 * it). Blocker 1410. A pre-wrapped element keeps its line breaks there too.
 */
function richHtml(html: string): string {
  const box = document.createElement("template");
  box.innerHTML = html;
  for (const e of Array.from(box.content.querySelectorAll("[data-nl-ws]"))) {
    if (e.getAttribute("data-nl-ws") === "pre") (e as HTMLElement).style.whiteSpace = "pre-wrap";
    e.removeAttribute("data-nl-ws");
  }
  for (const k of Array.from(box.content.querySelectorAll(".katex"))) {
    const math = k.querySelector(".katex-mathml math");
    if (!math) continue;
    if (k.parentElement?.classList.contains("katex-display")) math.setAttribute("display", "block");
    k.replaceWith(math);
  }
  return box.innerHTML;
}

function inEditable(sel: Selection): boolean {
  const a = document.activeElement;
  if (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) return true;
  const n = sel.anchorNode;
  const el = n instanceof Element ? n : (n?.parentElement ?? null);
  return !!el?.closest('[contenteditable=""], [contenteditable="true"], .cm-editor');
}

let memo: { key: unknown[]; out: { text: string; html: string } | null } | null = null;

/** What a copy of the page's selection should put on the clipboard, or
 *  null when the selection holds no rendered formula. */
export function mathSelection(sel: Selection | null): { text: string; html: string } | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed || inEditable(sel)) return null;
  // One ⌘C asks twice — this module's copy handler and the clip ring's
  // (`clipRing.svelte.ts`) — and a ⌘A over a long chat takes ~0.5 s each
  // (review 2026-10-12): the answer is kept for the rest of the event.
  const r0 = sel.getRangeAt(0);
  const key = [sel.rangeCount, r0.startContainer, r0.startOffset, r0.endContainer, r0.endOffset];
  if (memo && memo.key.every((k, i) => k === key[i])) return memo.out;
  const out = computeSelection(sel);
  memo = { key, out };
  setTimeout(() => (memo = null), 0);
  return out;
}

/**
 * Item 684: the range's HTML when it takes any of a table — a selection inside one table (a few
 * rows, or cells) as that table cut to the rows it touches, its header row always kept; a wider
 * selection as cloned. Empty when it takes no table.
 */
function tableRangeHtml(range: Range): string {
  const anc = range.commonAncestorContainer;
  const at = anc instanceof Element ? anc : anc.parentElement;
  // Item 688 (his bug, 2026-11-13): text inside one cell copies as that
  // text, not as the cell's row under the header.
  if (at?.closest("td, th")) return "";
  const inTable = at?.closest("table");
  if (inTable) {
    const rows = Array.from(inTable.rows);
    const keep = rows.filter((r, i) => i === 0 || range.intersectsNode(r));
    const t = document.createElement("table");
    for (const r of keep) t.appendChild(r.cloneNode(true));
    return t.outerHTML;
  }
  const frag = range.cloneContents();
  if (!frag.querySelector("table, tr")) return "";
  // Item 814: with a formula in it, the fragment as `rangeHtml` gives it — formulas cut at either
  // end widened to whole ones (half a formula has no source), hidden parts dropped.
  const wide = frag.querySelector(".katex") ? rangeHtml(range) : "";
  const box = document.createElement("div");
  if (wide) box.innerHTML = wide;
  else box.appendChild(frag);
  wholeTableEnds(box, range);
  return box.innerHTML;
}

/**
 * Item 814: a selection that begins or ends inside a table and runs on past it takes that table's
 * rows whole — the row it begins in and the row it ends in as the page has them, not cut to the
 * cells it touched (a cut row's cells slid left under the wrong headers, WebKit check) — and the
 * table keeps its header row, as a selection inside one table does (684). `box` holds the range's
 * cloned contents; its first table is the one the range began in, its last the one it ended in.
 */
export function wholeTableEnds(box: Element, range: Range): void {
  const elOf = (n: Node) => (n instanceof Element ? n : n.parentElement);
  const tables = box.querySelectorAll("table");
  if (tables.length === 0) return;
  const startTable = elOf(range.startContainer)?.closest("table");
  if (startTable) {
    const t = tables[0];
    const live = elOf(range.startContainer)?.closest("tr");
    const first = t.querySelector("tr");
    if (live && first) first.replaceWith(live.cloneNode(true));
    const head = startTable.rows[0];
    const top = t.querySelector("tr");
    if (head && top && head !== live && !range.intersectsNode(head)) top.parentElement?.insertBefore(head.cloneNode(true), top);
  }
  if (elOf(range.endContainer)?.closest("table")) {
    const rows = tables[tables.length - 1].querySelectorAll("tr");
    const live = elOf(range.endContainer)?.closest("tr");
    const last = rows[rows.length - 1];
    if (live && last && !(startTable && live === elOf(range.startContainer)?.closest("tr"))) last.replaceWith(live.cloneNode(true));
  }
}

/**
 * Item 814 (his bug, "like i've asked a millioni times"): the clipboard for a selection, given the
 * HTML its table read (`tableRangeHtml`) and its formula read (`rangeHtml`). A table goes first:
 * before, the formula read ran first, and any table with a formula in the selection (his `$z$`
 * header) came out as loose tab-parted lines, while the same table selected from its second row
 * on (no formula in it) came out a table — the outcome hung on where the selection began.
 */
export function clipboardFor(tableHtml: string, formulaHtml: string): { text: string; html: string } | null {
  const ttext = tableHtml ? tablePasteText(tableHtml) : null;
  // The rich side needs a document (`richHtml`); the tests' plain-text check runs without one.
  const rich = (h: string) => (typeof document === "undefined" ? h : richHtml(h));
  if (ttext !== null) return { text: ttext, html: rich(tableHtml) };
  const text = mathCopyText(formulaHtml);
  return text === null ? null : { text, html: rich(formulaHtml) };
}

function computeSelection(sel: Selection): { text: string; html: string } | null {
  // Item 684: a selection taking a table copies it as a Markdown table on the plain-text side
  // (pasted into the message box it stays a table to fill in); the rich side keeps the table.
  const tparts: string[] = [];
  const mparts: string[] = [];
  for (let i = 0; i < sel.rangeCount; i++) tparts.push(tableRangeHtml(sel.getRangeAt(i)));
  const thtml = tparts.filter(Boolean).join("\n");
  if (!thtml) for (let i = 0; i < sel.rangeCount; i++) mparts.push(rangeHtml(sel.getRangeAt(i)));
  return clipboardFor(thtml, mparts.join("\n"));
}

/** ⌘C on the page: the TeX on the plain-text side, MathML on the rich. */
export function onMathCopy(e: ClipboardEvent): void {
  // A CodeMirror box handles its own copy (its source text) first.
  if (e.defaultPrevented || !e.clipboardData) return;
  const got = mathSelection(document.getSelection());
  if (!got) return;
  e.preventDefault();
  e.clipboardData.setData("text/plain", got.text);
  e.clipboardData.setData("text/html", got.html);
}

let installed = false;
/** Once per page: the desktop (`main.ts`) and the phone page (`remote/main.ts`). */
export function installMathCopy(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("copy", onMathCopy);
}

/**
 * Item 838 (his "highlighting is broken", 2026-11-18): a selection across a
 * rendered formula was painted glyph by glyph — KaTeX draws a formula as
 * nested inline boxes of different heights, and the browser highlights each
 * box: patchy blocks, gaps between, a display formula's parts boxed apart.
 * Here a formula the selection touches is highlighted as one box
 * (`.math-sel`, `mathBase.css`) and its glyphs' own highlight is switched
 * off (`:root.math-sel-on .katex *::selection`). The selection itself — and
 * what a copy takes — is the browser's, unchanged.
 *
 * `formulasIn` is the rule, pure over a range; the listener applies it once
 * per frame. The desktop only: a phone draws its own selection handles and
 * ignores `::selection`.
 */
export function formulasIn(range: Range | null): Element[] {
  if (!range || range.collapsed) return [];
  const root = range.commonAncestorContainer;
  const scope = root instanceof Element ? root : root.parentElement;
  if (!scope) return [];
  const inside = scope.closest(".katex");
  const all = inside ? [inside] : Array.from(scope.querySelectorAll(".katex"));
  return all.filter((el) => range.intersectsNode(el));
}

let selInstalled = false;
export function installMathSelection(): void {
  if (selInstalled || typeof document === "undefined") return;
  selInstalled = true;
  document.documentElement.classList.add("math-sel-on");
  let marked: Element[] = [];
  let queued = false;
  const apply = () => {
    queued = false;
    const sel = document.getSelection();
    const next = sel && sel.rangeCount > 0 ? formulasIn(sel.getRangeAt(0)) : [];
    const keep = new Set(next);
    for (const el of marked) if (!keep.has(el)) el.classList.remove("math-sel");
    for (const el of next) el.classList.add("math-sel");
    marked = next;
  };
  document.addEventListener("selectionchange", () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(apply);
  });
}
