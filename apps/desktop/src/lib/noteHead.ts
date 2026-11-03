/**
 * The note page's document head (item 496, his pick: option 2). Pure
 * helpers, so the rules are testable without mounting the view.
 */

/**
 * Whether a note opens with its own title: its first non-blank line (after
 * a YAML front-matter block, if any) is a level-one ATX heading, `# Title`.
 *
 * Blocker 1649's rule: such a note keeps its own heading as the page's
 * title, and the head shows the name small, on the folder line, instead of
 * as the large serif heading — so the page never shows two titles. Plain
 * mode follows the same rule, so the head does not change shape when he
 * switches between Plain, Formatted and Preview.
 */
export function leadsWithTitle(text: string): boolean {
  const lines = text.split(/\r?\n/);
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, j) => j > 0 && (l.trim() === "---" || l.trim() === "..."));
    if (end > 0) i = end + 1;
  }
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    return /^ {0,3}#[ \t]+\S/.test(l);
  }
  return false;
}

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
