/**
 * A file-editing tool call as a diff for the transcript (nightshift backlog
 * 433): Claude Code's `Edit`, `MultiEdit` and `Write`, and the provider
 * engine's `edit_file` and `write_file`, read from the call's own input —
 * nothing re-reads the file, so what is drawn is what the model asked for,
 * whether or not the call was allowed. Pure; `EditDiffView.svelte` draws it.
 */
import { lineDiff, type RawLine } from "./diff";

export interface EditDiffLine extends RawLine {
  /** A divider between the edits of one `MultiEdit` call. */
  sep?: boolean;
}

export interface EditDiff {
  /** What the call does, in a word: "Edit", "Write". */
  verb: string;
  path: string;
  lines: EditDiffLine[];
  added: number;
  removed: number;
  /** A whole-file write: every line is new as far as the input knows. */
  whole: boolean;
  /** `replace_all` was set on an edit: the change lands at every match. */
  everyMatch: boolean;
}

/** Past this many lines the view shows the first ones and a *Show all*. */
export const EDIT_DIFF_FOLD = 20;

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function counts(lines: EditDiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.sep) continue;
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}

/** The call's diff, or null for any other tool or an input it cannot read. */
export function editDiffOf(name: string, input: unknown): EditDiff | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  const path = str(o.file_path) ?? str(o.path);
  if (path === null) return null;
  switch (name) {
    case "Edit":
    case "edit_file": {
      const before = str(o.old_string);
      const after = str(o.new_string);
      if (before === null || after === null) return null;
      const lines: EditDiffLine[] = lineDiff(before, after);
      return { verb: "Edit", path, lines, ...counts(lines), whole: false, everyMatch: o.replace_all === true };
    }
    case "MultiEdit": {
      if (!Array.isArray(o.edits)) return null;
      const lines: EditDiffLine[] = [];
      let everyMatch = false;
      for (const e of o.edits) {
        if (e === null || typeof e !== "object") return null;
        const ed = e as Record<string, unknown>;
        const before = str(ed.old_string);
        const after = str(ed.new_string);
        if (before === null || after === null) return null;
        if (lines.length) lines.push({ kind: "ctx", text: "", sep: true });
        lines.push(...lineDiff(before, after));
        if (ed.replace_all === true) everyMatch = true;
      }
      return { verb: "Edit", path, lines, ...counts(lines), whole: false, everyMatch };
    }
    case "Write":
    case "write_file": {
      const content = str(o.content);
      if (content === null) return null;
      const lines: EditDiffLine[] = lineDiff("", content);
      return { verb: "Write", path, lines, ...counts(lines), whole: true, everyMatch: false };
    }
    default:
      return null;
  }
}

/** The lines to draw: all of them, or the first `EDIT_DIFF_FOLD` and how many are hidden. */
export function foldDiff(
  lines: readonly EditDiffLine[],
  all: boolean,
): { shown: readonly EditDiffLine[]; hidden: number } {
  if (all || lines.length <= EDIT_DIFF_FOLD) return { shown: lines, hidden: 0 };
  return { shown: lines.slice(0, EDIT_DIFF_FOLD), hidden: lines.length - EDIT_DIFF_FOLD };
}

/** A path for the header: the file's name, and the folder it sits in. */
export function shortPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf("/");
  if (i < 0) return { name: path, dir: "" };
  return { name: path.slice(i + 1), dir: path.slice(0, i + 1) };
}
