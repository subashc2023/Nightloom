/**
 * The note page's document head (item 496, his pick: option 2). Pure
 * helpers, so the rules are testable without mounting the view.
 */

/** The name split for the heading: the base without its extension, and the
 *  extension (with its dot) drawn dimmed. A dotfile or a name with no
 *  extension has none. */
export function splitExt(base: string): { stem: string; ext: string } {
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return { stem: base, ext: "" };
  return { stem: base.slice(0, dot), ext: base.slice(dot) };
}

/** The view a three-way switch shows (blocker 1643): Preview, or the
 *  editor mode underneath it. */
export type NoteShown = "plain" | "formatted" | "preview";
export function shownOf(mode: "plain" | "formatted", preview: boolean): NoteShown {
  return preview ? "preview" : mode;
}

/** The key the "who reads this" line's More fold is kept under (one per
 *  scope: the long texts are per scope, not per note). */
export function whoFoldKey(scope: string): string {
  return `note-who:${scope}`;
}
