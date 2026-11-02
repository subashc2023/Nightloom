/**
 * Item 492 (his words, 2026-11-01: "if i upload a file into notes i can't
 * put it into like a specific folder it's only like dropped into the
 * entire notes section"): which notes folder a file lands in. The pure
 * half — the panel reads the row under the pointer, this says where that
 * is, and the backend (`keep::keep_in_folder`) checks it again.
 *
 * - A folder row → that folder.
 * - A note row → the folder the note is in (pointing at `people/alice.md`
 *   means "in people").
 * - The section's head, its empty space, a top-level note → the root,
 *   which for a kept file is `files/`, where a drop has always gone
 *   (blocker 1624: New note / New folder at the root stay the top level).
 */

/** Where a file pointed at the root lands: `.agents/files/`, as before. */
export const ROOT_FOLDER = "files";

/** The folder a note is in, `""` at the top level. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "";
}

/** A `data-folder` / `data-note` value (`project:people/a.md`) for `scope`,
 *  its path; null for another scope or none. */
function pathIn(attr: string | null | undefined, scope: string): string | null {
  if (!attr || !attr.startsWith(`${scope}:`)) return null;
  return attr.slice(scope.length + 1);
}

/**
 * The folder a drop points at, from the nearest row's attributes (the
 * folder row's `data-folder`, else the note row's `data-note`): `""` for
 * the root. A row of another section counts as the root (the Project
 * section is the only one that takes files).
 */
export function pointedFolder(
  hit: { folder?: string | null; note?: string | null },
  scope = "project",
): string {
  const folder = pathIn(hit.folder, scope);
  if (folder !== null) return folder;
  const note = pathIn(hit.note, scope);
  if (note !== null) return parentOf(note);
  return "";
}

/** The folder a kept file is written to: the pointed folder, or `files`
 *  for the root. */
export function landingFolder(pointed: string): string {
  return pointed === "" ? ROOT_FOLDER : pointed;
}

/**
 * A folder path as the panel may send it, cleaned (`/`-separated, no empty
 * or `.` parts), or null when it would leave the notes: absolute, a `..`,
 * a hidden part (the trash is `.trash/`), a drive letter. The backend
 * refuses the same; this keeps a bad path from ever being sent.
 */
export function safeFolder(raw: string): string | null {
  const t = raw.trim().replace(/\\/g, "/");
  if (t.startsWith("/")) return null;
  const parts = t.split("/").map((p) => p.trim()).filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === ".." || p.startsWith(".") || p.includes(":") || p.includes("\0"))) return null;
  return parts.join("/");
}

/** What the section says while files are held over it, by target. */
export function holdWords(pointed: string): string {
  return pointed === "" ? `Drop to keep in ${ROOT_FOLDER}/` : `Drop into ${pointed}/`;
}

/** A path's last part. */
function leaf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The clash question's words (Keep both is the default and first). */
export function clashWords(rel: string, both: string): { question: string; both: string; replace: string; sure: string } {
  return {
    question: `${rel} is there already, with other contents.`,
    both: `Keep both (as ${leaf(both)})`,
    replace: "Replace",
    sure: "Replace — the old one goes to the notes trash",
  };
}

export type ClashAnswer = "both" | "replace" | "cancel";
