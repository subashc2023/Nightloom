/**
 * Item 689 (blocker 1993, his answer "I think grid makes more sense no?"):
 * a Markdown table in the message box, read as a grid of cells and written
 * back as edits to its own text. The box's text stays the Markdown — the
 * model reads a Markdown table — and a cell edit changes only that cell's
 * characters, so everything he did not touch (spacing, the `|---|` rule,
 * alignment colons) comes back byte for byte.
 *
 * Pure: offsets are into the table's own text (its lines joined by `\n`).
 */

export type Align = "left" | "center" | "right" | null;

/** One cell: `[from, to)` is its content with the spaces round it trimmed
 *  (an empty cell's is the place a value goes); `text` is what the grid
 *  shows, `\|` read as `|`. */
export interface MdCell {
  from: number;
  to: number;
  text: string;
  /** An empty cell too narrow for a spaced value (`||`, `| |`): the
   *  spaces a value takes with it. */
  pad?: "both" | "after";
}

export interface MdRow {
  /** The line's own `[from, to)`. */
  from: number;
  to: number;
  cells: MdCell[];
  /** Whether the line has a leading / trailing pipe. */
  lead: boolean;
  trail: boolean;
}

export interface MdTable {
  /** Row 0 is the header; the `|---|` line is not a row. */
  rows: MdRow[];
  align: Align[];
  cols: number;
  /** The end of the `|---|` line. */
  delimTo: number;
}

const DELIM_CELL = /^\s*:?-+:?\s*$/;

/** The cells of one line at `base` (unescaped pipes split it). */
function splitRow(line: string, base: number): MdRow {
  const pipes: number[] = [];
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line[i] === "|") pipes.push(i);
  }
  const first = line.search(/\S/);
  const lastNon = line.trimEnd().length - 1;
  const lead = first >= 0 && pipes[0] === first;
  const trail = lastNon >= 0 && pipes[pipes.length - 1] === lastNon && (pipes.length > 1 || !lead);
  const inner = pipes.filter((p) => !(lead && p === first) && !(trail && p === lastNon));
  const bounds = [lead ? first : -1, ...inner, trail ? lastNon : line.length];
  const cells: MdCell[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const s = bounds[k] + 1;
    const e = bounds[k + 1];
    const seg = line.slice(s, e);
    const lo = seg.search(/\S/);
    if (lo < 0) {
      // Empty: a value goes after one space, if there is one.
      const at = s + (seg.length > 0 ? 1 : 0);
      cells.push({ from: base + at, to: base + at, text: "", pad: seg.length === 0 ? "both" : seg.length === 1 ? "after" : undefined });
      continue;
    }
    const hi = seg.trimEnd().length;
    cells.push({ from: base + s + lo, to: base + s + hi, text: unescapeCell(seg.slice(lo, hi)) });
  }
  return { from: base, to: base + line.length, cells, lead, trail };
}

/** `\|` → `|`, the one escape a cell needs. */
export function unescapeCell(s: string): string {
  return s.replace(/\\\|/g, "|");
}

/** A grid value as cell text: one line, `|` escaped. */
export function escapeCell(s: string): string {
  return s.replace(/\r\n?|\n/g, " ").replace(/\|/g, "\\|");
}

/** The table `text` is (header, `|---|` rule, rows), or null when it is not one. */
export function parseTable(text: string): MdTable | null {
  const lines = text.split("\n");
  if (lines.length < 2) return null;
  const starts: number[] = [];
  let at = 0;
  for (const l of lines) {
    starts.push(at);
    at += l.length + 1;
  }
  const delim = splitRow(lines[1], starts[1]);
  const delimTexts = delim.cells.map((c) => text.slice(c.from, c.to));
  if (delimTexts.length === 0 || !delimTexts.every((d) => DELIM_CELL.test(d))) return null;
  const header = splitRow(lines[0], starts[0]);
  if (!lines[0].includes("|") && !lines[1].includes("|")) return null;
  const cols = delimTexts.length;
  const align: Align[] = delimTexts.map((d) => {
    const l = d.startsWith(":");
    const r = d.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : null;
  });
  const rows = [header];
  for (let i = 2; i < lines.length; i++) rows.push(splitRow(lines[i], starts[i]));
  return { rows, align, cols, delimTo: delim.to };
}

/** The grid's values: `rows × cols`, a missing cell "" (extra cells are
 *  kept by `gridCols`, never dropped). */
export function gridValues(t: MdTable): string[][] {
  const n = gridCols(t);
  return t.rows.map((r) => Array.from({ length: n }, (_, c) => r.cells[c]?.text ?? ""));
}

/** Columns the grid shows: the header's, or more when a row has more —
 *  so text typed past the last column is never hidden. */
export function gridCols(t: MdTable): number {
  return Math.max(t.cols, ...t.rows.map((r) => r.cells.length));
}

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** The edit that makes cell `(r, c)` read `value`. */
export function cellChange(t: MdTable, r: number, c: number, value: string): TextChange | null {
  const row = t.rows[r];
  if (!row) return null;
  const v = escapeCell(value);
  const cell = row.cells[c];
  if (cell) {
    const insert = !v || !cell.pad ? v : cell.pad === "both" ? ` ${v} ` : `${v} `;
    return { from: cell.from, to: cell.to, insert };
  }
  if (v === "") return null;
  // Past the row's last cell: the missing cells, then this one.
  const missing = c - row.cells.length;
  const insert = row.trail ? "  |".repeat(missing) + ` ${v} |` : " | ".repeat(missing) + " | " + v;
  return { from: row.to, to: row.to, insert };
}

/** A new empty row's line, in the header's pipe style. */
export function emptyRow(t: MdTable): string {
  const h = t.rows[0];
  const n = gridCols(t);
  const inner = Array.from({ length: n }, () => "  ").join("|");
  return (h.lead ? "|" : "") + inner + (h.trail ? "|" : "");
}

/** The edit adding an empty row after row `after` (default: the last;
 *  0 puts it first, under the `|---|` rule). */
export function addRowChange(t: MdTable, after = t.rows.length - 1): TextChange {
  const i = Math.max(0, Math.min(after, t.rows.length - 1));
  const end = i === 0 ? t.delimTo : t.rows[i].to;
  return { from: end, to: end, insert: "\n" + emptyRow(t) };
}

/** Column widths as fractions (summing to 1), by each column's longest
 *  value, clamped so a `#` column stays narrow and a long one never takes
 *  the whole box. */
export function columnWeights(values: string[][]): number[] {
  const n = values[0]?.length ?? 0;
  const w = Array.from({ length: n }, (_, c) => {
    // Never narrower than its header word, nor than a short answer
    // ("O(n)" broke over two lines at 3).
    const longest = Math.max(1, ...values.map((r) => (r[c] ?? "").length));
    const floor = Math.max(8, (values[0]?.[c] ?? "").length + 3);
    return Math.max(floor, Math.min(40, longest));
  });
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((x) => x / sum);
}

/** Whether `text` holds a Markdown table (a line with a pipe, then a
 *  `|---|` rule) — the cheap test the boxes use to pick the grid box. */
export function hasTable(text: string): boolean {
  if (!text.includes("|") || !text.includes("-")) return false;
  return /(^|\n)[^\n]*\|[^\n]*\n[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*(\n|$)/.test(text);
}

/** `ch` (replacing `old`) cut to the characters that differ — one typed
 *  character is a one-character insert — or null when nothing changes. */
export function narrowChange(old: string, ch: TextChange): TextChange | null {
  if (old === ch.insert) return null;
  let a = 0;
  while (a < old.length && a < ch.insert.length && old[a] === ch.insert[a]) a++;
  let b = 0;
  while (b < old.length - a && b < ch.insert.length - a && old[old.length - 1 - b] === ch.insert[ch.insert.length - 1 - b]) b++;
  return { from: ch.from + a, to: ch.to - b, insert: ch.insert.slice(a, ch.insert.length - b) };
}

/** Column widths in px for a grid `width` wide: each column's share
 *  (`columnWeights`), but never narrower than its header word plus the
 *  cell's padding ("Answer" broke over two lines on a share alone); the
 *  columns above their floor give back what the floors took. */
export function columnPx(values: string[][], width: number, charPx = 8, pad = 20): number[] {
  const share = columnWeights(values).map((w) => w * width);
  const floor = (values[0] ?? []).map((h) => Math.max(4, h.length) * charPx + pad);
  let px = share.map((w, i) => Math.max(w, floor[i] ?? 0));
  const over = px.reduce((a, b) => a + b, 0) - width;
  if (over > 0) {
    const room = px.map((w, i) => Math.max(0, w - (floor[i] ?? 0)));
    const total = room.reduce((a, b) => a + b, 0);
    if (total > 0) px = px.map((w, i) => w - (room[i] / total) * Math.min(over, total));
  }
  return px.map((w) => Math.round(w));
}
