/**
 * The mouse cursor the page asks for is the one on screen (nightshift item
 * 828, his words: "why is my cursor like the pointer cursor even in the
 * textbox in nightloom?", and "Even when higlighting text in the chat
 * history").
 *
 * The page's CSS asks for the I-beam over every text box and over
 * selectable text (measured: `notes/runner-design/827-828-report-2026-11-18.md` in nightshift-code;
 * no rule sets `cursor: default` over text). The cursor is drawn by AppKit,
 * and WebKit only sets it from the page's hit test after its own checks
 * (macOS 27's WebKit adds one: the window's content view must hit-test to
 * the web view at the mouse, WebKit bug 315425), so a cursor left as the
 * arrow by anything outside the page stays the arrow until WebKit wants a
 * different one. This is the page's half of the repair: it works out the
 * cursor WebKit's own rule gives at the mouse (`kindFor`, the same order:
 * an explicit CSS cursor, then an editable box, then a link, then text) and
 * tells `cursor_keep.rs` when that changes and again when the mouse rests;
 * Rust sets it when AppKit's current cursor is another (and logs that it
 * had to, so the cause can be read off his Mac later). Only the three
 * standard cursors are kept; any other CSS cursor (a resize edge, a grab
 * handle) is left to WebKit alone.
 */
import { invoke } from "@tauri-apps/api/core";

export type CursorKind = "ibeam" | "hand" | "arrow";

/** How long the mouse rests before the cursor is checked once more. */
export const REST_MS = 150;

/**
 * WebKit's choice of cursor at a point (WebCore `EventHandler::selectCursor`),
 * from what the page knows there: the computed `cursor`, whether the point
 * is in an editable box, over a link, over selectable text. `null` for a
 * cursor that is none of the three kept ones. Pure.
 */
export function kindFor(cursor: string, editable: boolean, overLink: boolean, overText: boolean): CursorKind | null {
  const c = cursor.trim().toLowerCase();
  if (c === "text") return "ibeam";
  if (c === "pointer") return "hand";
  if (c === "default") return "arrow";
  if (c !== "auto" && c !== "") return null;
  if (editable) return "ibeam";
  if (overLink) return "hand";
  return overText ? "ibeam" : "arrow";
}

/** Whether `el` is a box he types in: a textarea, a text-like input, or contenteditable. */
export function isTypeable(el: Element | null): boolean {
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return !el.disabled;
  if (el instanceof HTMLInputElement) {
    if (el.disabled) return false;
    return ["text", "search", "url", "email", "password", "tel", "number", ""].includes(el.type);
  }
  return false;
}

/** Whether (x, y) is over a selectable character of text. */
function overSelectableText(doc: Document, x: number, y: number): boolean {
  const r = doc.caretRangeFromPoint?.(x, y);
  const node = r?.startContainer;
  if (!r || !node || node.nodeType !== Node.TEXT_NODE) return false;
  const parent = node.parentElement;
  if (!parent) return false;
  const st = getComputedStyle(parent) as CSSStyleDeclaration & { webkitUserSelect?: string };
  if ((st.webkitUserSelect || st.userSelect) === "none") return false;
  const len = (node.textContent ?? "").length;
  const at = r.startOffset;
  const probe = doc.createRange();
  for (const [a, b] of [
    [at - 1, at],
    [at, at + 1],
  ]) {
    if (a < 0 || b > len) continue;
    probe.setStart(node, a);
    probe.setEnd(node, b);
    for (const box of probe.getClientRects()) {
      if (x >= box.left - 1 && x <= box.right + 1 && y >= box.top && y <= box.bottom) return true;
    }
  }
  return false;
}

/** The kept cursor at (x, y) over `target`, or null. */
export function kindAt(doc: Document, target: Element, x: number, y: number): CursorKind | null {
  const cursor = getComputedStyle(target).cursor;
  const editable = isTypeable(target) || isTypeable(target.closest("[contenteditable]"));
  const overLink = !!target.closest("a[href]");
  const c = cursor.trim().toLowerCase();
  // Text is only looked for when the answer depends on it.
  const needText = (c === "auto" || c === "") && !editable && !overLink;
  return kindFor(cursor, editable, overLink, needText && overSelectableText(doc, x, y));
}

let installed = false;

/** Listen for the mouse over the page. macOS only (the caller checks); once per page. */
export function installCursorKeep(doc: Document = document, win: Window = window): void {
  if (installed) return;
  installed = true;
  let last: CursorKind | null = null;
  let rest = 0;
  let frame = 0;
  let pending: MouseEvent | null = null;
  const send = (kind: CursorKind, trigger: string) => {
    invoke("keep_cursor", { kind, trigger }).catch(() => {
      // Off Tauri: nothing to keep.
    });
  };
  const look = () => {
    frame = 0;
    const e = pending;
    pending = null;
    // A drag (a selection being made, a resize) is WebKit's own business.
    if (!e || e.buttons !== 0) return;
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const kind = kindAt(doc, t, e.clientX, e.clientY);
    win.clearTimeout(rest);
    if (kind == null) {
      last = null;
      return;
    }
    if (kind !== last) send(kind, "change");
    last = kind;
    rest = win.setTimeout(() => send(kind, "rest"), REST_MS);
  };
  doc.addEventListener(
    "mousemove",
    (e) => {
      pending = e;
      if (!frame) frame = win.requestAnimationFrame(look);
    },
    { capture: true, passive: true },
  );
  const forget = () => {
    win.clearTimeout(rest);
    last = null;
  };
  doc.documentElement.addEventListener("mouseleave", forget);
  win.addEventListener("blur", forget);
}
