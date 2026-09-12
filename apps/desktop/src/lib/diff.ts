/**
 * A unified diff (what `git diff` and `git show` print), parsed into files
 * and hunks and paired for a side-by-side view. Presentation only: the text
 * is what the backend returned, and nothing here re-reads a repository.
 */

export type Side = "ctx" | "del" | "add" | "pad" | "hunk";

export interface DiffCell {
  /** Line number on that side; null for padding and hunk headers. */
  no: number | null;
  text: string;
  kind: Side;
}

/** One row of the side-by-side view: what the old file shows, what the new one shows. */
export interface DiffRow {
  left: DiffCell;
  right: DiffCell;
}

export interface DiffHunk {
  /** The `@@ … @@` line, verbatim. */
  header: string;
  rows: DiffRow[];
}

export interface DiffFile {
  /** The new path, or the old one for a deletion. */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  added: number;
  removed: number;
  binary: boolean;
  hunks: DiffHunk[];
}

interface RawLine {
  kind: "ctx" | "del" | "add";
  text: string;
}

const PAD: DiffCell = { no: null, text: "", kind: "pad" };

/**
 * Pair a hunk's lines. A context line sits on both sides; a run of removals
 * followed by a run of additions is laid side by side, the shorter run
 * padded with hatched cells so the rows keep step.
 */
export function pairLines(
  lines: RawLine[],
  oldStart: number,
  newStart: number,
): DiffRow[] {
  const rows: DiffRow[] = [];
  let l = oldStart;
  let r = newStart;
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.kind === "ctx") {
      rows.push({
        left: { no: l++, text: ln.text, kind: "ctx" },
        right: { no: r++, text: ln.text, kind: "ctx" },
      });
      i++;
      continue;
    }
    const dels: RawLine[] = [];
    const adds: RawLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const d = dels[k];
      const a = adds[k];
      rows.push({
        left: d ? { no: l++, text: d.text, kind: "del" } : PAD,
        right: a ? { no: r++, text: a.text, kind: "add" } : PAD,
      });
    }
  }
  return rows;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(p: string): string {
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

/** Parse `diff --git` output. Unknown lines are skipped, never thrown on. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunkLines: RawLine[] | null = null;
  let hunkHeader = "";
  let oldStart = 0;
  let newStart = 0;

  const closeHunk = () => {
    if (file && hunkLines) {
      file.hunks.push({
        header: hunkHeader,
        rows: pairLines(hunkLines, oldStart, newStart),
      });
    }
    hunkLines = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      closeHunk();
      // `diff --git a/x b/y` — the two paths, which may contain spaces; the
      // `---`/`+++` lines that follow are the reliable source when present.
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = {
        path: m ? m[2] : line.slice(11),
        oldPath: m ? m[1] : null,
        newPath: m ? m[2] : null,
        added: 0,
        removed: 0,
        binary: false,
        hunks: [],
      };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (hunkLines === null) {
      if (line.startsWith("--- ")) {
        const p = line.slice(4).split("\t")[0];
        file.oldPath = p === "/dev/null" ? null : stripPrefix(p);
        continue;
      }
      if (line.startsWith("+++ ")) {
        const p = line.slice(4).split("\t")[0];
        file.newPath = p === "/dev/null" ? null : stripPrefix(p);
        file.path = file.newPath ?? file.oldPath ?? file.path;
        continue;
      }
      if (line.startsWith("Binary files ")) {
        file.binary = true;
        continue;
      }
    }
    const h = HUNK.exec(line);
    if (h) {
      closeHunk();
      hunkHeader = line;
      oldStart = Number(h[1]);
      newStart = Number(h[3]);
      hunkLines = [];
      continue;
    }
    if (hunkLines === null) continue;
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) {
      hunkLines.push({ kind: "add", text: line.slice(1) });
      file.added++;
    } else if (line.startsWith("-")) {
      hunkLines.push({ kind: "del", text: line.slice(1) });
      file.removed++;
    } else if (line.startsWith(" ")) {
      hunkLines.push({ kind: "ctx", text: line.slice(1) });
    } else if (line === "") {
      // A blank context line whose leading space was stripped somewhere.
      hunkLines.push({ kind: "ctx", text: "" });
    } else {
      // Something that is not part of the hunk: the hunk is over.
      closeHunk();
    }
  }
  closeHunk();
  return files;
}

/** Totals across every file — the header's `+935 −3 · 8 files`. */
export function diffTotals(files: DiffFile[]): {
  added: number;
  removed: number;
  files: number;
} {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added;
    removed += f.removed;
  }
  return { added, removed, files: files.length };
}
