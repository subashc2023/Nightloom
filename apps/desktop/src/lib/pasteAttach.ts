/**
 * Paste as an attachment (nightshift item 284, blocker 941's default, 942's
 * key). Pure, so the rules are pinned by a test rather than by a paste in
 * the running app.
 *
 * His ask: ⌘V keeps pasting text into the box; another key puts the
 * clipboard's text in as an attachment instead, so a long text does not
 * take over the box. ⌘⇧V was taken (the clipboard history, item 173), so
 * the key is ⌥⌘V (Ctrl+Alt+V off the Mac). And for a ⌘V paste over
 * `LONG_PASTE_WORDS` words, a "Make this an attachment" offer under the box
 * moves that span out of the box into an attachment on one click, undoably.
 * The text stays in the box until he clicks.
 */

/** A ⌘V paste longer than this many words offers to become an attachment. */
export const LONG_PASTE_WORDS = 2000;

/** The attachment's name, as the model sees it (`<attached-file name=…>`). */
export const PASTED_NAME = "Pasted text";

/** ⌥⌘V (Ctrl+Alt+V off the Mac): paste as an attachment. By the key's
 *  code, since ⌥ turns the key's character into "√" on a Mac. */
export function isPasteAsAttachmentKey(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  code: string;
}): boolean {
  return (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.code === "KeyV";
}

/**
 * What one paste does in the composer:
 * - `box`: the text goes into the box, as ⌘V always has (the browser's own
 *   insert; images on the clipboard still become chips beside it);
 * - `attach`: ⌥⌘V's paste — the text becomes an attachment, not box text;
 * - `empty`: ⌥⌘V with nothing to attach — a toast says so.
 * A clipboard holding a file (an image) is pasted as ⌘V would, ⌥⌘V or not.
 */
export function pasteAction(asAttachment: boolean, text: string, fileCount: number): "box" | "attach" | "empty" {
  if (!asAttachment || fileCount > 0) return "box";
  return text ? "attach" : "empty";
}

/** Line endings as the box holds them: a textarea and CodeMirror both
 *  turn \r\n and \r into \n. */
export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

export function wordCount(s: string): number {
  const m = s.match(/\S+/g);
  return m ? m.length : 0;
}

/** The chip's words: "1,240 words". */
export function pastedLabel(s: string): string {
  const n = wordCount(s);
  return `${n.toLocaleString("en-US")} word${n === 1 ? "" : "s"}`;
}

/** "Pasted text", or "Pasted text (2)" when the box already has one. */
export function pastedName(taken: readonly string[]): string {
  if (!taken.includes(PASTED_NAME)) return PASTED_NAME;
  let i = 2;
  while (taken.includes(`${PASTED_NAME} (${i})`)) i++;
  return `${PASTED_NAME} (${i})`;
}

/** The pasted text as a file, so it takes item 277's text route (`accept`
 *  in `Composer.svelte`): the same caps, engines and chip as a dropped
 *  text file. */
export function pastedFile(text: string, name: string): File {
  return new File([text], name, { type: "text/plain" });
}

/**
 * A ⌘V paste worth offering to move: where it went in the box and what it
 * was. `after` is the box's text once the paste landed — any other text
 * means he edited since, and the offer is gone.
 */
export interface LongPaste {
  start: number;
  pasted: string;
  after: string | null;
}

/** The offer for a ⌘V paste, or null for a short one. */
export function longPasteOffer(pasted: string, start: number): LongPaste | null {
  const p = normalizeNewlines(pasted);
  if (wordCount(p) <= LONG_PASTE_WORDS) return null;
  return { start, pasted: p, after: null };
}

/**
 * The offer against the box's text now: still standing (the paste landed,
 * or nothing changed since it did), or null (he edited, sent, or the paste
 * never landed where it was expected).
 */
export function followOffer(o: LongPaste | null, text: string): LongPaste | null {
  if (!o) return null;
  if (o.after === null) {
    // The paste's own change: the span is where the paste put it.
    if (text.slice(o.start, o.start + o.pasted.length) === o.pasted) return { ...o, after: text };
    return null;
  }
  return text === o.after ? o : null;
}

/** The box's text with the pasted span taken out, or null if it is not
 *  there any more. */
export function withoutSpan(text: string, o: LongPaste): string | null {
  if (text.slice(o.start, o.start + o.pasted.length) !== o.pasted) return null;
  return text.slice(0, o.start) + text.slice(o.start + o.pasted.length);
}

/** What one click of "Make this an attachment" did, for its Undo: the box
 *  before, the box after, and the chip it made. */
export interface Converted {
  before: string;
  after: string;
  chipId: number;
  caret: number;
}

/** Whether the Undo still applies: the box is as the conversion left it
 *  and the chip it made is still there (not sent, not removed). */
export function canUndo(c: Converted | null, text: string, chipIds: readonly number[]): c is Converted {
  return c !== null && text === c.after && chipIds.includes(c.chipId);
}

/** The box after an Undo, and where the caret goes: the end of the span
 *  put back. */
export function undoConverted(c: Converted): { text: string; caret: number } {
  return { text: c.before, caret: c.caret + (c.before.length - c.after.length) };
}

/** A text attachment's words, from its base64 (UTF-8). */
export function decodeText(base64: string): string {
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}
