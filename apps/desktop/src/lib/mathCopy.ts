import { mathPasteText } from "./mathPaste";

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

/** What a copy of the page's selection should put on the clipboard, or
 *  null when the selection holds no rendered formula. */
export function mathSelection(sel: Selection | null): { text: string; html: string } | null {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed || inEditable(sel)) return null;
  const parts: string[] = [];
  for (let i = 0; i < sel.rangeCount; i++) parts.push(rangeHtml(sel.getRangeAt(i)));
  const html = parts.join("\n");
  const text = mathCopyText(html);
  return text === null ? null : { text, html: richHtml(html) };
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
