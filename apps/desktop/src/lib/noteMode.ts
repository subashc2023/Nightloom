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
