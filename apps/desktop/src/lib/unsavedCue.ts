/**
 * Item 867: the unsaved-changes cue — a note or file whose edits are not
 * yet written to disk carries a small mark beside its name wherever it
 * shows (the Notes list and its pinned rows, a shut folder that holds one,
 * its tab in either strip). Notes do not autosave: the unsaved text lives
 * in `app.noteDrafts` (the draft mirror, kept in localStorage) from the
 * first keystroke until a Save lands, so the cue is exactly "the key has a
 * draft". A Save that fails leaves the draft, and so the cue. This module
 * only reads that state; it never changes how saving works.
 */

/** The hover on the cue (his words for it, item 867's spec). */
export const UNSAVED_TIP = "Unsaved changes";
/** The hover on a shut folder's cue: the note itself is out of sight. */
export const UNSAVED_IN_FOLDER_TIP = "Unsaved changes in this folder";

/** The note under `key` (a `noteDraftKey`) has unsaved edits. */
export function isUnsaved(drafts: Readonly<Record<string, string>>, key: string): boolean {
  return drafts[key] !== undefined;
}

/**
 * Some note inside the folder whose key prefix is `prefix` (a
 * `noteDraftKey` of the folder's path with a trailing `/`) has unsaved
 * edits — at any depth below it.
 */
export function folderUnsaved(drafts: Readonly<Record<string, string>>, prefix: string): boolean {
  if (!prefix.endsWith("/")) prefix += "/";
  for (const k in drafts) if (k.startsWith(prefix) && drafts[k] !== undefined) return true;
  return false;
}
