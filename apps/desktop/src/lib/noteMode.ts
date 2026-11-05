/**
 * Which editor a note opens in (nightshift backlog 150): `plain`, the
 * textarea as it always was, or `formatted`, the CodeMirror editor that
 * draws the Markdown and the math in place (`noteEditor.ts`).
 *
 * One setting for every note, the last one picked, remembered in
 * localStorage the way the transcript toggles are (`transcriptPrefs`).
 * Global rather than per note because the choice is about how he likes to
 * write, not about the note; a per-note memory would have every note open
 * in whatever it happened to be left in (nightshift blocker 342 holds the
 * question with this default).
 *
 * The first launch opens in `plain`, so nothing changes until he flips it.
 */
export type NoteMode = "plain" | "formatted";

export const NOTE_MODE_KEY = "nightloom.noteMode";

export function parseNoteMode(raw: string | null | undefined): NoteMode {
  return raw === "formatted" ? "formatted" : "plain";
}

export function loadNoteMode(storage: Pick<Storage, "getItem"> = localStorage): NoteMode {
  try {
    return parseNoteMode(storage.getItem(NOTE_MODE_KEY));
  } catch {
    return "plain";
  }
}

export function saveNoteMode(mode: NoteMode, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(NOTE_MODE_KEY, mode);
  } catch {
    // A preference that cannot be kept is still the mode for this session.
  }
}

/**
 * Whether a note opens in the Preview (item 495: "if I click on preview …
 * that should be saved so that when I go to another chat and then go back,
 * it still holds which thing I'm on"). The same one setting as the mode
 * above, kept beside it rather than folded into it: Preview's Edit button
 * goes back to whichever side, Plain or Formatted, was picked last, so the
 * two are separate facts. Only his own clicks write it — a jump to a line
 * (a memory hit, a search result) leaves the Preview for that one view and
 * does not change what the next note opens in.
 */
export const NOTE_PREVIEW_KEY = "nightloom.notePreview";

export function loadNotePreview(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return storage.getItem(NOTE_PREVIEW_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveNotePreview(on: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(NOTE_PREVIEW_KEY, on ? "1" : "0");
  } catch {
    // As with the mode: kept for this session even when it cannot be stored.
  }
}

/**
 * Item 498: a note has one editor now, opened formatted, with one switch to
 * its raw Markdown. The Plain / Formatted / Preview settings above are no
 * longer read by the note view (left as they were, keys and all; blocker
 * 1653: every note opens formatted after the update, even if Plain was the
 * last pick, so `nightloom.noteMode` does not carry over). The Markdown
 * switch is its own setting under a new key, one for every note, the last
 * picked (blocker 1632's "global"), kept across a chat switch, a tab switch
 * and a relaunch as 495 kept the Preview.
 */
export const NOTE_MARKDOWN_KEY = "nightloom.noteMarkdown";

export function loadNoteMarkdown(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return storage.getItem(NOTE_MARKDOWN_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveNoteMarkdown(on: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(NOTE_MARKDOWN_KEY, on ? "1" : "0");
  } catch {
    // Kept for this session even when it cannot be stored.
  }
}

/**
 * The smallest single edit that turns `from` into `to`: the common prefix
 * and suffix kept, the middle replaced. How the editor takes a text set
 * from outside (Revert, a proposal loaded) without moving a cursor that
 * sits in the unchanged part. `null` when the texts are equal.
 */
export function minimalChange(
  from: string,
  to: string,
): { from: number; to: number; insert: string } | null {
  if (from === to) return null;
  let a = 0;
  const max = Math.min(from.length, to.length);
  while (a < max && from.charCodeAt(a) === to.charCodeAt(a)) a++;
  let b = 0;
  while (
    b < max - a &&
    from.charCodeAt(from.length - 1 - b) === to.charCodeAt(to.length - 1 - b)
  )
    b++;
  return { from: a, to: from.length - b, insert: to.slice(a, to.length - b) };
}

/** A caret offset kept inside `text`. */
export function clampCaret(offset: number, text: string): number {
  return Number.isFinite(offset) ? Math.max(0, Math.min(Math.floor(offset), text.length)) : 0;
}
