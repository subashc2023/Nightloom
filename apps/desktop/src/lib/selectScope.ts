/**
 * ⌘A outside a text box selects the pane he is in, not the whole app
 * (item 646). The Edit menu's Select All is native: it selected the whole
 * document — sidebar, tabs, the new-chat dial — which `app.css`'s "what can
 * be selected" section now keeps from painting, but a chat beside another
 * would still select both. So ⌘A is taken here first (WebKit hands a
 * page its key equivalents before the menu, as `fieldUndo.ts` relies on):
 *
 * - in a field or an editor (input, textarea, contenteditable): left to the
 *   field, which selects its own text;
 * - in a chat or an aside's thread: that thread's text;
 * - in any other tab's content, a dialog or an overlay: that;
 * - anywhere else (the sidebar, the tab strip, the top bar): nothing — it
 *   is chrome, and there is nothing in it to select.
 *
 * "Where he is" is the last place he pressed the pointer, else the focused
 * element, else the current selection's anchor.
 */

/** A thread: the tightest scope, so ⌘A in a chat never takes its composer's row or another pane. */
const THREAD = ".transcript, .aside-thread";
/** A tab's content, or something drawn over the app. */
const PANE = '.content, .settings-overlay, [role="dialog"], [role="alertdialog"]';

/** Duck-typed (tag names, not `instanceof`), so the node-run suite can drive it with plain objects. */
export function isField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "INPUT") return true;
  const ce = el.closest("[contenteditable]");
  return !!ce && ce.getAttribute("contenteditable") !== "false";
}

/** The outermost `.content` (a tab's), not one a component nested inside it. */
function outermost(el: Element, sel: string): Element | null {
  let hit = el.closest(sel);
  while (hit?.parentElement) {
    const up = hit.parentElement.closest(sel);
    if (!up) break;
    hit = up;
  }
  return hit;
}

/** The element ⌘A should select inside, or null for "nothing" (chrome). */
export function selectScope(from: Element | null): Element | null {
  if (!from) return null;
  return from.closest(THREAD) ?? outermost(from, PANE);
}

function asElement(n: Node | null | undefined): Element | null {
  if (!n) return null;
  return n.nodeType === 1 ? (n as Element) : n.parentElement;
}

/** Listen on the whole page, in the capture phase (main.ts, once). */
export function installSelectScope(target: Window = window): () => void {
  let pressed: Element | null = null;
  const onDown = (e: Event) => {
    pressed = asElement(e.target as Node | null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key !== "a" && e.key !== "A") return;
    const doc = target.document;
    const focused = doc.activeElement;
    if (isField(asElement(e.target as Node | null)) || isField(focused)) return;
    const sel = doc.getSelection();
    const from =
      (pressed?.isConnected ? pressed : null) ??
      (focused && focused !== doc.body ? focused : null) ??
      asElement(sel?.anchorNode);
    e.preventDefault();
    const scope = selectScope(from);
    if (!sel) return;
    if (scope) sel.selectAllChildren(scope);
    else sel.removeAllRanges();
  };
  const opts = { capture: true };
  target.addEventListener("pointerdown", onDown, opts);
  target.addEventListener("keydown", onKey, opts);
  return () => {
    target.removeEventListener("pointerdown", onDown, opts);
    target.removeEventListener("keydown", onKey, opts);
  };
}
