/**
 * Item 890 (his "how do i create a table myself in textbox / maybe need
 * shortcuts? like a /table"): slash inserts — `/table`, `/math`, `/code`,
 * `/quote`, `/list`, `/numbered` — in the box's `/` menu beside the CLI's
 * skills and the saved prompts. The pure part, shared by the Mac's
 * composer and the phone's boxes: the token being typed, the matches, and
 * each insert's text and caret as one edit.
 *
 * The token is `/word` (plus an argument: `/table 4x3`, `/code py`) ending
 * at the caret, at the start of the box or a line, or after a space — so
 * `and/or` and `/Users/me/…` never open it.
 */

export type InsertName = "table" | "math" | "code" | "quote" | "list" | "numbered";

export interface BoxInsert {
  name: InsertName;
  /** Other words that reach it. */
  aliases: string[];
  /** What the menu row says it does. */
  what: string;
}

export const INSERTS: BoxInsert[] = [
  { name: "table", aliases: [], what: "table · /table 4x3 for 4 columns, 3 rows" },
  { name: "math", aliases: ["maths", "equation"], what: "display maths $$ … $$" },
  { name: "code", aliases: ["fence"], what: "code block · /code py for a language" },
  { name: "quote", aliases: [], what: "quote line >" },
  { name: "list", aliases: ["bullets"], what: "bulleted list -" },
  { name: "numbered", aliases: [], what: "numbered list 1." },
];

/** A table's size when none is typed: 3 columns, 2 rows under the header. */
export const TABLE_COLS = 3;
export const TABLE_ROWS = 2;
const TABLE_MAX = 12;

export interface InsertToken {
  start: number;
  end: number;
  /** The word after the slash. */
  word: string;
  /** What follows the word and one space (`4x3`, `py`), or "". */
  arg: string;
  /** Whether a space follows the word (an argument is being typed). */
  spaced: boolean;
}

/** The `/word [arg]` ending at `caret`, or null. */
export function insertToken(text: string, caret: number): InsertToken | null {
  if (caret < 0 || caret > text.length) return null;
  const head = text.slice(0, caret);
  const m = /(^|\s)\/([A-Za-z]{0,12})( [A-Za-z0-9+#.x×-]{0,12})?$/.exec(head);
  if (!m) return null;
  const tail = m[3] ?? "";
  const start = caret - tail.length - m[2].length - 1;
  return { start, end: caret, word: m[2], arg: tail.slice(1), spaced: tail.length > 0 };
}

/** A table size `CxR` (`4x3`, `4×3`, `4`), clamped; null when not one. */
export function tableSize(arg: string): { cols: number; rows: number } | null {
  if (!arg) return { cols: TABLE_COLS, rows: TABLE_ROWS };
  const m = /^(\d{1,2})(?:[x×](\d{1,2})?)?$/i.exec(arg);
  if (!m) return null;
  const clamp = (n: number) => Math.max(1, Math.min(TABLE_MAX, n));
  return { cols: clamp(Number(m[1])), rows: m[2] ? clamp(Number(m[2])) : TABLE_ROWS };
}

/** A code fence's language: letters, digits, `+ # . -`. */
const LANG = /^[A-Za-z0-9+#.-]{1,12}$/;

/**
 * The inserts the token reaches: names or aliases starting with the word,
 * an exact one first. With an argument the word must be whole and the
 * argument the insert's own (a size for `/table`, a language for `/code`);
 * the others take none.
 */
export function insertMatches(tok: InsertToken | null): BoxInsert[] {
  if (!tok) return [];
  const w = tok.word.toLowerCase();
  const words = (i: BoxInsert) => [i.name, ...i.aliases];
  if (tok.spaced) {
    const hit = INSERTS.find((i) => words(i).includes(w));
    if (!hit) return [];
    if (hit.name === "table") return tableSize(tok.arg) ? [hit] : [];
    if (hit.name === "code") return !tok.arg || LANG.test(tok.arg) ? [hit] : [];
    return [];
  }
  const found = INSERTS.filter((i) => words(i).some((x) => x.startsWith(w)));
  found.sort((a, b) => Number(words(b).includes(w)) - Number(words(a).includes(w)));
  return found;
}

/** The menu row's words for an insert under this token (the size typed). */
export function insertLabel(ins: BoxInsert, tok: InsertToken | null): string {
  if (ins.name === "table" && tok?.spaced) {
    const s = tableSize(tok.arg);
    if (s) return `table, ${s.cols} columns × ${s.rows} rows`;
  }
  if (ins.name === "code" && tok?.spaced && tok.arg) return `code block in ${tok.arg}`;
  return ins.what;
}

/** One edit: replace `[from, to)` with `insert`, then select `[anchor, head]`
 *  (the shape of `codeBlockKeys.ts`'s `BlockEdit`, so both boxes take it). */
export interface InsertEdit {
  from: number;
  to: number;
  insert: string;
  anchor: number;
  head: number;
  /** For a table: where its first line starts in the new text. */
  tableAt?: number;
}

/** The breaks a block needs before it: none at the box's start or after a
 *  blank line; a table also needs a blank line above it to stay a table. */
function lead(before: string, blank: boolean): string {
  if (before === "" || before.endsWith("\n\n")) return "";
  if (before.endsWith("\n")) return blank ? "\n" : "";
  return blank ? "\n\n" : "\n";
}

/** A table skeleton: an empty header, the delimiter, `rows` empty rows. */
export function tableText(cols: number, rows: number): { text: string; firstCell: number } {
  const row = "|" + "   |".repeat(cols);
  const delim = "|" + " --- |".repeat(cols);
  const text = [row, delim, ...Array.from({ length: rows }, () => row)].join("\n");
  return { text, firstCell: 2 };
}

/** The edit an insert makes in place of the token. */
export function insertEdit(text: string, tok: InsertToken, ins: BoxInsert): InsertEdit {
  const before = text.slice(0, tok.start);
  // A token after a space: the space it followed goes with it when the
  // block starts a line of its own (no trailing blank before the break).
  const trimmedBefore = before.replace(/[ \t]+$/, "");
  const after = text.slice(tok.end);
  const trail = (body: string) => (after === "" || after.startsWith("\n") ? body : body + "\n");
  const block = (body: string, caretIn: number, blank: boolean, table = false): InsertEdit => {
    const from = tok.start - (before.length - trimmedBefore.length);
    const pre = lead(trimmedBefore, blank);
    const insert = pre + trail(body);
    const caret = from + pre.length + caretIn;
    const out: InsertEdit = { from, to: tok.end, insert, anchor: caret, head: caret };
    if (table) out.tableAt = from + pre.length;
    return out;
  };
  switch (ins.name) {
    case "table": {
      const size = tableSize(tok.spaced ? tok.arg : "") ?? { cols: TABLE_COLS, rows: TABLE_ROWS };
      const t = tableText(size.cols, size.rows);
      return block(t.text, t.firstCell, true, true);
    }
    case "math":
      return block("$$\n\n$$", 3, false);
    case "code": {
      const lang = tok.spaced && LANG.test(tok.arg) ? tok.arg : "";
      return block("```" + lang + "\n\n```", 4 + lang.length, false);
    }
    case "quote":
    case "list":
    case "numbered": {
      const mark = ins.name === "quote" ? "> " : ins.name === "list" ? "- " : "1. ";
      const atLineStart = before === "" || before.endsWith("\n");
      const pre = atLineStart ? "" : "\n";
      const from = atLineStart ? tok.start : tok.start - (before.length - trimmedBefore.length);
      const caret = from + pre.length + mark.length;
      return { from, to: tok.end, insert: pre + mark, anchor: caret, head: caret };
    }
  }
}

/** The text after an edit (for tests and the phone's box). */
export function applyInsert(text: string, ed: InsertEdit): string {
  return text.slice(0, ed.from) + ed.insert + text.slice(ed.to);
}
