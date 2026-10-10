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

export interface RawLine {
  kind: "ctx" | "del" | "add";
  text: string;
}

/**
 * Two texts to one line sequence — the classic longest-common-subsequence
 * diff, small enough to live here rather than pull a dependency for. Made
 * for the proposal review (an `AGENTS.md` of a few thousand characters
 * against its proposed replacement), where nothing runs `git` and the two
 * texts are in hand. Quadratic in lines, which at that size is nothing; past
 * a million cells it gives up on alignment and shows the whole old text
 * removed and the whole new one added, which is still a correct diff and
 * still readable.
 */
export function lineDiff(oldText: string, newText: string): RawLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length * b.length > 1_000_000) {
    return [
      ...a.map((text): RawLine => ({ kind: "del", text })),
      ...b.map((text): RawLine => ({ kind: "add", text })),
    ];
  }
  // lcs[i][j] = length of the LCS of a[i..] and b[j..].
  const n = a.length;
  const m = b.length;
  const lcs: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) lcs.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: RawLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "del", text: a[i++] });
    } else {
      out.push({ kind: "add", text: b[j++] });
    }
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

/** Lines without their terminators; an empty text is no lines, not one. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/**
 * Render two texts as the unified diff `parseDiff` reads, so `DiffView`
 * shows them the way it shows a `git diff` — file strip, +/−, hunks with
 * three lines of context. Identical texts give an empty string, which the
 * view reads as "No changes."; a missing old text (`null`) is a new file.
 */
export function unifiedDiff(
  oldText: string | null,
  newText: string,
  path: string,
  context = 3,
): string {
  const lines = lineDiff(oldText ?? "", newText);
  if (lines.every((l) => l.kind === "ctx")) return "";
  // Hunks: each run of changes, widened by `context` lines each side, and
  // runs whose widened ranges touch merged into one.
  const ranges: [number, number][] = [];
  let k = 0;
  while (k < lines.length) {
    if (lines[k].kind === "ctx") {
      k++;
      continue;
    }
    let end = k;
    while (end < lines.length && lines[end].kind !== "ctx") end++;
    const start = Math.max(0, k - context);
    const stop = Math.min(lines.length, end + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1]) last[1] = stop;
    else ranges.push([start, stop]);
    k = end;
  }
  const out: string[] = [
    `diff --git a/${path} b/${path}`,
    oldText === null ? "--- /dev/null" : `--- a/${path}`,
    `+++ b/${path}`,
  ];
  // Line numbers on each side at the start of each range.
  let oldNo = 1;
  let newNo = 1;
  let at = 0;
  for (const [start, stop] of ranges) {
    for (; at < start; at++) {
      if (lines[at].kind !== "add") oldNo++;
      if (lines[at].kind !== "del") newNo++;
    }
    const slice = lines.slice(start, stop);
    const oldLen = slice.filter((l) => l.kind !== "add").length;
    const newLen = slice.filter((l) => l.kind !== "del").length;
    out.push(`@@ -${oldLen === 0 ? 0 : oldNo},${oldLen} +${newLen === 0 ? 0 : newNo},${newLen} @@`);
    for (const l of slice) {
      out.push((l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text);
    }
    for (; at < stop; at++) {
      if (lines[at].kind !== "add") oldNo++;
      if (lines[at].kind !== "del") newNo++;
    }
  }
  return out.join("\n") + "\n";
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
