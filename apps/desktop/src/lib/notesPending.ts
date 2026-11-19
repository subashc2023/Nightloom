/*
 * Item 855 (his bug, 2026-11-18: a PowerPoint dropped into Notes showed
 * only a small "Keeping 1 file…" line at the panel's foot, which "looks
 * visibly like it just failed") — every file dropped or uploaded into the
 * Project notes shows at once as a row in the list, "adding…", in the
 * folder it lands in. The row goes when the real note is in the list (the
 * keep refreshes Notes before it returns, so the note takes its place), or
 * turns into an error row with the reason and a dismiss.
 *
 * The pure half: the rows as a list, and how a drop moves them. The panel's
 * store (`notesPending.svelte.ts`) holds them outside the panel, so a
 * conversion that outlives a switch to Chats and back still shows.
 */
import { convertingWords, routeOf } from "./attachKinds";

/** One file on its way into the notes. `project`: the project's id, so a
 *  row shows only in the project it was dropped into. `folder`: the
 *  docspace folder it lands in (`files`, `files/sub`). */
export type PendingNote = {
  id: number;
  project: string;
  folder: string;
  name: string;
  /** A zip is unpacked into a folder, not kept whole (item 414). */
  zip: boolean;
  phase: "adding" | "failed";
  /** Why it failed, in the drop's own words. */
  why?: string;
  /** Item 868: when the row appeared (ms), for an office file's
   *  "converting slides · 1:12" while it converts. */
  since?: number;
};

/** What a drop tells its rows: one per file at the moment of the drop,
 *  then each failed (with why) or ended. `end` after `fail` keeps the
 *  error row; `end` alone removes the row. */
export type DropRows = {
  start(files: readonly { name: string; zip: boolean }[]): number[];
  fail(id: number, why: string): void;
  end(id: number): void;
};

export function addRows(
  list: readonly PendingNote[],
  project: string,
  folder: string,
  files: readonly { name: string; zip: boolean }[],
  nextId: () => number,
  now: number = Date.now(),
): { list: PendingNote[]; ids: number[] } {
  const made = files.map((f) => ({
    id: nextId(),
    project,
    folder,
    name: f.name,
    zip: f.zip,
    phase: "adding" as const,
    since: now,
  }));
  return { list: [...list, ...made], ids: made.map((r) => r.id) };
}

export function failRow(list: readonly PendingNote[], id: number, why: string): PendingNote[] {
  return list.map((r) => (r.id === id ? { ...r, phase: "failed" as const, why } : r));
}

/** The drop is done with a row: still adding → gone (its note is in the
 *  list now, or it was refused in words a toast carries); failed → kept
 *  until he dismisses it. */
export function endRow(list: readonly PendingNote[], id: number): PendingNote[] {
  return list.filter((r) => r.id !== id || r.phase === "failed");
}

export function dismissRow(list: readonly PendingNote[], id: number): PendingNote[] {
  return list.filter((r) => r.id !== id);
}

/** The words on a row. */
export function rowWords(
  r: Pick<PendingNote, "phase" | "zip" | "folder" | "why"> & { name?: string; since?: number },
  // Item 868: the clock, for an office file's elapsed time; without it the
  // row says "adding to …" as before.
  now?: number,
): string {
  if (r.phase === "failed") {
    // The row already names the file: "deck.pptx: it is damaged" → "it is damaged".
    const why = r.why ?? "could not be added";
    return r.name && why.startsWith(`${r.name}: `) ? why.slice(r.name.length + 2) : why;
  }
  if (!r.zip && r.name && now !== undefined && r.since !== undefined && routeOf(r.name, "") === "office")
    return convertingWords(r.name, "pdf", now - r.since);
  return r.zip ? `unpacking into ${r.folder}/…` : `adding to ${r.folder}/…`;
}

/**
 * Where the rows show in the tree: under the folder row they land in when
 * that folder is in the list, else at the top of the list (a folder not
 * made yet, or one a search hides). `folders`: the docspace paths of the
 * folder rows in view. Keys are folder paths; `""` is the top.
 */
export function placeRows(rows: readonly PendingNote[], folders: ReadonlySet<string>): Map<string, PendingNote[]> {
  const out = new Map<string, PendingNote[]>();
  for (const r of rows) {
    const at = folders.has(r.folder) ? r.folder : "";
    const l = out.get(at);
    if (l) l.push(r);
    else out.set(at, [r]);
  }
  return out;
}
