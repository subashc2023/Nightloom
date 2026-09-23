/**
 * The proposal card's editable diff (nightshift backlog 184): the dream's
 * proposed replacement for `AGENTS.md`, shown beside the file as saved,
 * with the proposed side a text box he can type in and, on each changed
 * block, "keep saved" and "take proposed".
 *
 * Three texts are in play:
 *
 * - `saved` — the file on disk, the left side; never changed here.
 * - `original` — the dream's proposal as it was written.
 * - `proposed` — the right side as it reads now: the original, plus his
 *   typing, plus any blocks he put back.
 *
 * A block is a run of lines where `proposed` differs from another text,
 * in `proposed`'s line numbers. "Keep saved" on a block of
 * `blocks(proposed, saved)` puts the saved lines back; "take proposed" on
 * a block of `blocks(proposed, original)` puts the dream's lines back —
 * which is how a kept block is undone, and how a hand edit is dropped.
 * The two are one operation (`applyBlock`) against different texts.
 *
 * Line numbers are indexes into `text.split("\n")`, which is also how the
 * text box lays its lines out; `lineDiff` drops a final empty line (the
 * text's trailing newline) and the indexes agree everywhere else.
 */
import { lineDiff } from "./diff";

/** A run of `base`'s lines [start, end) that `other` has as `lines`. An
 *  empty run (start === end) is lines `other` has and `base` lacks, to be
 *  inserted before line `start`. */
export interface Block {
  start: number;
  end: number;
  lines: string[];
}

/** Every changed run between `base` and `other`, in `base`'s lines. */
export function blocks(base: string, other: string): Block[] {
  const out: Block[] = [];
  let at = 0;
  let open: Block | null = null;
  for (const l of lineDiff(base, other)) {
    if (l.kind === "ctx") {
      if (open) out.push(open);
      open = null;
      at++;
      continue;
    }
    if (!open) open = { start: at, end: at, lines: [] };
    if (l.kind === "del") {
      open.end = ++at;
    } else {
      open.lines.push(l.text);
    }
  }
  if (open) out.push(open);
  return out;
}

/** `base` with the block's lines replaced by the other text's. The
 *  trailing newline, if `base` had one, stays. */
export function applyBlock(base: string, block: Block): string {
  const rows = base.split("\n");
  rows.splice(block.start, block.end - block.start, ...block.lines);
  return rows.join("\n");
}

/** One row of the left ("as saved") side. `at` is the proposed line the
 *  row sits beside — for a removed line, the proposed line that follows
 *  it — which is what keeps the two sides scrolled together. */
export interface SavedRow {
  no: number | null;
  text: string;
  kind: "ctx" | "del" | "pad";
  at: number;
}

export interface ReviewRows {
  /** The saved text, with its removed lines marked and a hatched pad
   *  beside each added line. */
  left: SavedRow[];
  /** Per line of `proposed.split("\n")`: whether it is new. */
  right: ("ctx" | "add")[];
  added: number;
  removed: number;
}

export function reviewRows(saved: string, proposed: string): ReviewRows {
  const left: SavedRow[] = [];
  const right: ("ctx" | "add")[] = [];
  let no = 1;
  let at = 0;
  let added = 0;
  let removed = 0;
  for (const l of lineDiff(saved, proposed)) {
    if (l.kind === "ctx") {
      left.push({ no: no++, text: l.text, kind: "ctx", at: at++ });
      right.push("ctx");
    } else if (l.kind === "del") {
      left.push({ no: no++, text: l.text, kind: "del", at });
      removed++;
    } else {
      left.push({ no: null, text: "", kind: "pad", at: at++ });
      right.push("add");
      added++;
    }
  }
  // The text box shows one more line than `lineDiff` counts when the text
  // ends in a newline (the empty line after it), and one line when empty.
  const shown = proposed.split("\n").length;
  while (right.length < shown) right.push("ctx");
  return { left, right, added, removed };
}

export interface HunkAction {
  kind: "keep" | "take";
  block: Block;
}

/**
 * The gutter's buttons, by the proposed line each sits on: "keep saved"
 * wherever the right side differs from the file, "take proposed" wherever
 * it differs from the dream's text. A block of only-missing lines sits on
 * the line after the gap, or the last line when the gap is at the end.
 */
export function hunkActions(saved: string, original: string, proposed: string): Map<number, HunkAction[]> {
  const last = Math.max(0, proposed.split("\n").length - 1);
  const out = new Map<number, HunkAction[]>();
  const put = (kind: HunkAction["kind"], block: Block) => {
    const line = Math.min(block.start, last);
    const list = out.get(line) ?? [];
    list.push({ kind, block });
    out.set(line, list);
  };
  for (const b of blocks(proposed, saved)) put("keep", b);
  for (const b of blocks(proposed, original)) put("take", b);
  return out;
}
