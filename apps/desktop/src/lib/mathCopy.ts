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

/** The range's HTML, widened to whole formulas at either end — half a
 *  formula has no source to give. */
function rangeHtml(range: Range): string {
  const r = range.cloneRange();
  const start = formulaOf(r.startContainer);
  const end = formulaOf(r.endContainer);
  if (start) r.setStartBefore(start);
  if (end) r.setEndAfter(end);
  const box = document.createElement("div");
  box.appendChild(r.cloneContents());
  return box.innerHTML;
}

/**
 * The rich copy: the fragment with each formula as its MathML alone (the
 * visible span copy needs KaTeX's stylesheet, which a paste elsewhere does
 * not have; MathML draws as math in Chrome, Safari, Word and Docs that take
 * it). Blocker 1410.
 */
function richHtml(html: string): string {
  const box = document.createElement("div");
  box.innerHTML = html;
  for (const k of Array.from(box.querySelectorAll(".katex"))) {
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
