/**
 * The text last selected outside a text box (nightshift item 800's
 * `{selection}` blank): clicking into the message box to type `/name` ends
 * the transcript's selection, so it is remembered as it is made. Only a
 * selection in the page's text counts — one inside a textarea, an input or
 * an editor is the box's own. Kept for ten minutes, then forgotten, so an
 * old selection does not land in a prompt typed much later.
 *
 * Shared by the Mac's window and the phone's page; `watchSelection` is
 * called once by each.
 */

const KEEP_MS = 10 * 60 * 1000;

let last: { text: string; at: number } | null = null;
let watching = false;

/** Whether a node sits in something he types into. */
function inBox(node: Node | null): boolean {
  // An element answers `closest`; a text node asks its parent.
  const el = (node && "closest" in node ? node : node?.parentElement) as Element | null | undefined;
  return !!el?.closest("textarea, input, [contenteditable=''], [contenteditable='true'], .cm-editor");
}

/** Record `text` as the selection (the listener's step; tests call it). */
export function noteSelection(text: string, anchor: Node | null, now = Date.now()): void {
  const t = text.trim();
  if (!t || inBox(anchor)) return;
  last = { text: t, at: now };
}

/** The remembered selection, or the page's own when one is up now. */
export function lastSelection(now = Date.now()): string | null {
  if (typeof window !== "undefined") {
    const s = window.getSelection();
    const live = s?.toString().trim();
    if (live && !inBox(s?.anchorNode ?? null)) return live;
  }
  if (last && now - last.at <= KEEP_MS) return last.text;
  return null;
}

/** Forget it (a test's reset). */
export function forgetSelection(): void {
  last = null;
}

/** Listen to the page's selection changes, once. */
export function watchSelection(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  document.addEventListener("selectionchange", () => {
    const s = window.getSelection();
    if (!s || s.isCollapsed) return;
    noteSelection(s.toString(), s.anchorNode);
  });
}
