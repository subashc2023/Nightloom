/**
 * Item 870: an open note with unsaved edits whose file changed outside
 * Nightloom (another editor, a script, the phone, iCloud). Save never
 * writes over the outside version without his pick, and no choice drops
 * either text until he makes it: Keep mine (save his text over it), Take
 * theirs (the file's text, his edits dropped by his pick), Show both (one
 * editable buffer holding both, the differing lines marked).
 */

/** What the file on disk means for the buffer. */
export type OutsideChange =
  /** The file is as the editor loaded it. */
  | "none"
  /** The file now reads as his text (his own save landing): saved. */
  | "adopt"
  /** Changed outside and nothing unsaved: take the file's text. */
  | "reload"
  /** Changed outside while he has unsaved edits: ask him. */
  | "conflict";

export function outsideChange(s: { disk: string; saved: string; text: string }): OutsideChange {
  if (s.disk === s.saved) return "none";
  if (s.disk === s.text) return "adopt";
  if (s.text === s.saved) return "reload";
  return "conflict";
}

export const BOTH_MINE = "<<<<<<< yours (unsaved in Nightloom)";
export const BOTH_THEIRS = "======= the file, changed outside Nightloom";
export const BOTH_END = ">>>>>>> end";

/**
 * Both texts in one: the lines they share at the top and the bottom once,
 * and between them his lines then the file's, each under a marker that
 * says whose they are. Nothing of either text is left out.
 */
export function bothText(mine: string, theirs: string): string {
  const a = mine.split("\n");
  const b = theirs.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  return [
    ...a.slice(0, head),
    BOTH_MINE,
    ...midA,
    BOTH_THEIRS,
    ...midB,
    BOTH_END,
    ...a.slice(a.length - tail),
  ].join("\n");
}

/** The words over the choice. */
export function conflictMessage(name: string): string {
  const base = name.split("/").pop() || name;
  return `${base} changed outside Nightloom while you had unsaved edits. Save will not write over it until you choose.`;
}
