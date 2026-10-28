/*
 * Item 415 — the search box at the top of the Notes panel, the pure half.
 *
 * As he types, each section's list narrows to the notes whose name or text
 * holds the query, case-insensitively; name matches come first, then the
 * notes that match only in their text, each group in the list's own order.
 * The text half is the backend's existing note search (`search_everywhere`
 * with scope `notes`, nightshift backlog 117) — no new command. Until its
 * answer arrives a note's summary (its first heading or line, already in
 * the list) counts as text, so the commonest text hits show at once.
 */
import type { Note, NoteGroup, NoteScope } from "./types";

/** The query as compared: trimmed and lower-cased; "" means no search. */
export function foldQuery(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * The notes to show for `query`: every note when it is empty, else the
 * name matches, then the text-only matches (`textHits`: the names the
 * backend found the query in, or null before it has answered).
 */
export function narrowNotes(
  notes: readonly Note[],
  query: string,
  textHits: ReadonlySet<string> | null,
): Note[] {
  const q = foldQuery(query);
  if (!q) return [...notes];
  const byName: Note[] = [];
  const byText: Note[] = [];
  for (const n of notes) {
    if (n.name.toLowerCase().includes(q)) byName.push(n);
    else if (textHits?.has(n.name) || (n.summary ?? "").toLowerCase().includes(q)) byText.push(n);
  }
  return [...byName, ...byText];
}

/** The backend's note groups as one set of names per section. */
export function hitsByScope(groups: readonly NoteGroup[]): Record<"project" | "knowledge", Set<string>> {
  const out = { project: new Set<string>(), knowledge: new Set<string>() };
  for (const g of groups) {
    const scope = g.scope as NoteScope;
    if (scope === "project" || scope === "knowledge") out[scope].add(g.name);
  }
  return out;
}
