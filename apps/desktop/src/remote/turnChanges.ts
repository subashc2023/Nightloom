/**
 * A reply's file changes for the phone (item 742): the Changes row under a
 * reply that edited files, and the per-file pages its sheet swipes between.
 *
 * The data is the desktop's (`lib/editDiff.ts`, item 433): each file-editing
 * call's diff read from the call's own input — Claude Code's `Edit`,
 * `MultiEdit` and `Write`, the provider engine's `edit_file` and
 * `write_file` — so nothing re-reads a file on the Mac. Only calls that ran
 * and succeeded count (a denied or failed edit changed nothing); several
 * edits to one file join into one page, in the order they happened, a
 * divider between them. A subagent's calls (a live turn's `children`)
 * count too. Pure; `ChangesSheet.svelte` draws it.
 */
import { editDiffOf, shortPath, type EditDiff, type EditDiffLine } from "../lib/editDiff";
import type { ToolRow } from "./client";

export interface FileChange {
  path: string;
  /** The file's name and the folder it sits in, for the page's header. */
  name: string;
  dir: string;
  lines: EditDiffLine[];
  added: number;
  removed: number;
  /** How many calls touched it. */
  edits: number;
  /** A `Write` made or replaced it whole: every line reads as new. */
  whole: boolean;
  /** An edit set `replace_all`: the change lands at every match. */
  everyMatch: boolean;
}

/** Past this many lines a page shows the first ones and a *Show all*. */
export const PHONE_DIFF_CAP = 400;

// One diff per call input: `transcriptRows` runs again on every event, and
// the events (so the inputs) are the same objects each time.
const cache = new WeakMap<object, EditDiff | null>();

function diffOf(t: ToolRow): EditDiff | null {
  const input = t.input;
  if (input === null || typeof input !== "object") return null;
  if (cache.has(input)) return cache.get(input) ?? null;
  const d = editDiffOf(t.name, input);
  cache.set(input, d);
  return d;
}

function walk(tools: readonly ToolRow[], out: ToolRow[]): void {
  for (const t of tools) {
    out.push(t);
    if (t.children.length) walk(t.children, out);
  }
}

/** The files a reply's calls changed, in the order each was first touched. */
export function turnChanges(tools: readonly ToolRow[]): FileChange[] {
  const all: ToolRow[] = [];
  walk(tools, all);
  const byPath = new Map<string, FileChange>();
  for (const t of all) {
    if (t.ok !== true || t.input === undefined) continue;
    const d = diffOf(t);
    if (!d) continue;
    let f = byPath.get(d.path);
    if (!f) {
      const where = shortPath(d.path);
      f = { path: d.path, name: where.name, dir: where.dir, lines: [], added: 0, removed: 0, edits: 0, whole: false, everyMatch: false };
      byPath.set(d.path, f);
    }
    if (f.lines.length) f.lines.push({ kind: "ctx", text: "", sep: true });
    f.lines.push(...d.lines);
    f.added += d.added;
    f.removed += d.removed;
    f.edits += 1;
    f.whole ||= d.whole;
    f.everyMatch ||= d.everyMatch;
  }
  return [...byPath.values()];
}

/** The row's read-out: "2 files · +14 −3". */
export function changesLine(files: readonly FileChange[]): string {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added;
    removed += f.removed;
  }
  const n = `${files.length} ${files.length === 1 ? "file" : "files"}`;
  const pm = [added ? `+${added}` : "", removed ? `−${removed}` : ""].filter(Boolean).join(" ");
  return pm ? `${n} · ${pm}` : n;
}

/** The lines a page draws: all, or the first `cap` and how many are hidden. */
export function capLines(lines: readonly EditDiffLine[], all: boolean, cap = PHONE_DIFF_CAP): { shown: readonly EditDiffLine[]; hidden: number } {
  if (all || lines.length <= cap) return { shown: lines, hidden: 0 };
  return { shown: lines.slice(0, cap), hidden: lines.length - cap };
}

/** The page a pager scrolled to, from its scroll offset and page width. */
export function pageAt(scrollLeft: number, width: number, count: number): number {
  if (count <= 0 || width <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.round(scrollLeft / width)));
}
