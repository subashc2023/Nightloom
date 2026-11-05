/**
 * The note toolbar's actions (item 498): text style, code, table, image,
 * checklist and the Insert menu, each a function from the editor's state to
 * one transaction that writes ordinary Markdown at the selection. One
 * transaction is one undo step (`isolateHistory` keeps it from merging with
 * typing just before or after), and nothing outside the selected lines is
 * touched, so the rest of the file stays byte for byte as it was.
 *
 * Pure over `EditorState` — no view, no DOM — so the suite runs each one on
 * a state and reads the text back. The same functions serve the formatted
 * view and the Markdown view: both are one editor over one text.
 */
import { EditorSelection, EditorState, Transaction, type ChangeSpec, type TransactionSpec } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";

export type Command = (state: EditorState) => TransactionSpec | null;

/** Every toolbar transaction: its own undo step, labelled as formatting. */
function tx(spec: TransactionSpec): TransactionSpec {
  return {
    ...spec,
    scrollIntoView: true,
    annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.format")],
  };
}

/** The line numbers a selection range covers. A range ending at a line's
 *  very start does not take that line (a triple-click selects to the next
 *  line's start). */
function rangeLines(state: EditorState, from: number, to: number): number[] {
  const doc = state.doc;
  const first = doc.lineAt(from).number;
  let last = doc.lineAt(to).number;
  if (to > from && last > first && doc.line(last).from === to) last--;
  const out: number[] = [];
  for (let n = first; n <= last; n++) out.push(n);
  return out;
}

/** Every line any selection range covers, each once, in order. */
function selectedLines(state: EditorState): number[] {
  const set = new Set<number>();
  for (const r of state.selection.ranges) for (const n of rangeLines(state, r.from, r.to)) set.add(n);
  return [...set].sort((a, b) => a - b);
}

// ---- text style: block styles --------------------------------------------

export type BlockStyle = "normal" | "h1" | "h2" | "h3" | "quote";

const HEADING = /^(#{1,6})[ \t]+|^#{1,6}$/;
const QUOTE = /^>[ ]?/;

/** What style the caret's line has now, for the menu's tick. */
export function blockStyleAt(state: EditorState): BlockStyle {
  const text = state.doc.lineAt(state.selection.main.head).text;
  const h = /^(#{1,6})(?:[ \t]|$)/.exec(text);
  if (h) return h[1].length <= 3 ? (`h${h[1].length}` as BlockStyle) : "normal";
  if (QUOTE.test(text)) return "quote";
  return "normal";
}

/**
 * Set the selected lines' block style: a heading's `#`s, a quote's `>`, or
 * neither (Normal text). Only the line's leading mark changes. Quote again
 * on lines that are all quoted takes the `>` off (a toggle, as the
 * checklist is); a heading replaces any heading or quote mark there.
 */
export function setBlockStyle(style: BlockStyle): Command {
  return (state) => {
    const lines = selectedLines(state).map((n) => state.doc.line(n));
    const multi = lines.length > 1;
    const skip = (t: string) => multi && t.trim() === "";
    const changes: ChangeSpec[] = [];
    if (style === "quote") {
      const allQuoted = lines.every((l) => QUOTE.test(l.text) || skip(l.text));
      for (const l of lines) {
        if (skip(l.text)) continue;
        const q = QUOTE.exec(l.text);
        if (allQuoted) {
          if (q) changes.push({ from: l.from, to: l.from + q[0].length, insert: "" });
        } else if (!q) changes.push({ from: l.from, insert: "> " });
      }
    } else {
      const want = style === "normal" ? "" : "#".repeat(Number(style.slice(1))) + " ";
      for (const l of lines) {
        if (skip(l.text)) continue;
        // A heading in a quote stays in it; Normal text takes the quote off too.
        const q = QUOTE.exec(l.text);
        const at = q ? q[0].length : 0;
        const h = HEADING.exec(l.text.slice(at));
        const end = at + (h ? h[0].length : 0);
        const start = style === "normal" ? 0 : at;
        if (l.text.slice(start, end) === want) continue;
        changes.push({ from: l.from + start, to: l.from + end, insert: want });
      }
    }
    if (changes.length === 0) return null;
    const set = state.changes(changes);
    return tx({ changes: set, selection: state.selection.map(set, 1) });
  };
}

// ---- text style: inline marks --------------------------------------------

export type InlineMark = "bold" | "italic" | "strike";
const MARK: Record<InlineMark, string> = { bold: "**", italic: "*", strike: "~~" };

/** The run of `ch` ending at `pos` (going left) or starting there (right). */
function runLeft(s: string, pos: number, ch: string): number {
  let n = 0;
  while (pos - n - 1 >= 0 && s[pos - n - 1] === ch) n++;
  return n;
}
function runRight(s: string, pos: number, ch: string): number {
  let n = 0;
  while (pos + n < s.length && s[pos + n] === ch) n++;
  return n;
}

/** Does a run of `n` marker characters hold this mark? `*`: 1 or 3 (bold
 *  italic); `**`: 2 or 3; `~~`: 2. */
function runHolds(mark: InlineMark, n: number): boolean {
  if (mark === "italic") return n === 1 || n === 3;
  if (mark === "bold") return n === 2 || n === 3;
  return n === 2;
}

/**
 * Bold, italic or strikethrough on the selection, or off it when the
 * selection is already wrapped in that mark. A selection over several
 * lines is marked line by line (an emphasis cannot cross a blank line, and
 * a heading's or a list's leading mark stays outside). An empty selection
 * inserts the pair with the caret between. Whitespace at a selection's ends
 * stays outside the marks: `** bold**` is not bold.
 */
export function toggleInline(mark: InlineMark): Command {
  return (state) => {
    const m = MARK[mark];
    const ch = m[0];
    const doc = state.doc;
    const result = state.changeByRange((range) => {
      if (range.empty) {
        // Nothing selected: the pair, the caret between, to type into.
        return {
          changes: { from: range.from, insert: m + m },
          range: EditorSelection.cursor(range.from + m.length),
        };
      }
      // Unwrap: the marks sit just outside the selection…
      const line = doc.lineAt(range.from);
      const sameLine = doc.lineAt(range.to).number === line.number;
      if (sameLine) {
        const t = line.text;
        const a = range.from - line.from;
        const b = range.to - line.from;
        const left = runLeft(t, a, ch);
        const right = runRight(t, b, ch);
        if (runHolds(mark, left) && runHolds(mark, right)) {
          const k = m.length;
          return {
            changes: [
              { from: range.from - k, to: range.from, insert: "" },
              { from: range.to, to: range.to + k, insert: "" },
            ],
            range: EditorSelection.range(range.from - k, range.to - k),
          };
        }
        // …or just inside it.
        const inner = t.slice(a, b);
        if (inner.length >= 2 * m.length && inner.startsWith(m) && inner.endsWith(m)) {
          const il = runRight(inner, 0, ch);
          const ir = runLeft(inner, inner.length, ch);
          if (runHolds(mark, il) && runHolds(mark, ir)) {
            const k = m.length;
            return {
              changes: [
                { from: range.from, to: range.from + k, insert: "" },
                { from: range.to - k, to: range.to, insert: "" },
              ],
              range: EditorSelection.range(range.from, range.to - 2 * k),
            };
          }
        }
      }
      // Wrap, line by line, each line's text without its leading block mark
      // and without the whitespace at its ends.
      const changes: ChangeSpec[] = [];
      const spans: [number, number][] = [];
      for (const n of rangeLines(state, range.from, range.to)) {
        const l = doc.line(n);
        let s = Math.max(range.from, l.from);
        let e = Math.min(range.to, l.to);
        if (s === l.from) s += leadingBlockMark(l.text).length;
        while (s < e && /\s/.test(doc.sliceString(s, s + 1))) s++;
        while (e > s && /\s/.test(doc.sliceString(e - 1, e))) e--;
        if (e <= s) continue;
        changes.push({ from: s, insert: m }, { from: e, insert: m });
        spans.push([s, e]);
      }
      if (spans.length === 0) return { range };
      const k = m.length;
      return {
        changes,
        // One span: its text stays selected, inside the marks. Several: the
        // whole of what was selected, marks and all.
        range:
          spans.length === 1
            ? EditorSelection.range(spans[0][0] + k, spans[0][1] + k)
            : EditorSelection.range(range.from, range.to + 2 * k * spans.length),
      };
    });
    if (result.changes.empty) return null;
    return tx(result);
  };
}

/** A line's leading block mark: indentation, quote marks, a heading's #s,
 *  a list marker and a task box — what an inline mark goes after. */
export function leadingBlockMark(text: string): string {
  const m = /^[ \t]*(?:>[ ]?)*[ \t]*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/.exec(text);
  return m ? m[0] : "";
}

// ---- code ------------------------------------------------------------------

/**
 * Code: inline code on a selection within one line (`` `x` ``, or
 * ``` `` x `` ``` when the text holds a backtick), off again when the
 * selection is already code; a fenced block around the selected lines
 * otherwise. An empty caret on a blank line opens an empty fenced block;
 * in a line of text it inserts an inline pair with the caret inside.
 */
export const codeAction: Command = (state) => {
  const doc = state.doc;
  const r = state.selection.main;
  const line = doc.lineAt(r.from);
  const oneLine = doc.lineAt(r.to).number === line.number;
  if (oneLine && !(r.empty && line.text.trim() === "")) {
    if (r.empty) {
      return tx({ changes: { from: r.from, insert: "``" }, selection: EditorSelection.cursor(r.from + 1) });
    }
    const t = doc.sliceString(r.from, r.to);
    const before = doc.sliceString(r.from - 1, r.from);
    const after = doc.sliceString(r.to, r.to + 1);
    if (before === "`" && after === "`") {
      return tx({
        changes: [
          { from: r.from - 1, to: r.from, insert: "" },
          { from: r.to, to: r.to + 1, insert: "" },
        ],
        selection: EditorSelection.range(r.from - 1, r.to - 1),
      });
    }
    if (t.length >= 2 && t.startsWith("`") && t.endsWith("`") && !t.slice(1, -1).includes("`")) {
      return tx({
        changes: { from: r.from, to: r.to, insert: t.slice(1, -1) },
        selection: EditorSelection.range(r.from, r.to - 2),
      });
    }
    const fence = t.includes("`") ? "`` " : "`";
    const close = t.includes("`") ? " ``" : "`";
    return tx({
      changes: { from: r.from, to: r.to, insert: fence + t + close },
      selection: EditorSelection.range(r.from + fence.length, r.to + fence.length),
    });
  }
  if (r.empty) {
    // A blank line: an empty fenced block, the caret on its middle line.
    return insertBlockAt(state, "```\n\n```", 4);
  }
  const lines = rangeLines(state, r.from, r.to);
  const first = doc.line(lines[0]);
  const last = doc.line(lines[lines.length - 1]);
  const body = doc.sliceString(first.from, last.to);
  const fence = longestRun(body, "`") >= 3 ? "`".repeat(longestRun(body, "`") + 1) : "```";
  return tx({
    changes: [
      { from: first.from, insert: fence + "\n" },
      { from: last.to, insert: "\n" + fence },
    ],
    selection: EditorSelection.range(first.from + fence.length + 1, last.to + fence.length + 1),
  });
};

function longestRun(s: string, ch: string): number {
  let best = 0;
  let n = 0;
  for (const c of s) {
    n = c === ch ? n + 1 : 0;
    if (n > best) best = n;
  }
  return best;
}

// ---- blocks: table, divider -----------------------------------------------

/**
 * Put a block on lines of its own at the caret: on the caret's line when it
 * is blank, else after it, with a blank line between it and any text above
 * or below (a table or a `---` straight under a paragraph line would be read
 * as part of it — `---` would turn the line into a heading). `caretAt` is an
 * offset into `block`, `selectLen` how much from there to select.
 */
export function insertBlockAt(state: EditorState, block: string, caretAt: number, selectLen = 0): TransactionSpec {
  const doc = state.doc;
  const line = doc.lineAt(state.selection.main.head);
  const blank = line.text.trim() === "";
  let from: number;
  let to: number;
  let lead = "";
  if (blank) {
    from = line.from;
    to = line.to;
    if (line.number > 1 && doc.line(line.number - 1).text.trim() !== "") lead = "\n";
  } else {
    from = to = line.to;
    lead = "\n\n";
  }
  let tail = "";
  const nextNo = line.number + 1;
  if (nextNo <= doc.lines && doc.line(nextNo).text.trim() !== "") tail = "\n";
  const insert = lead + block + tail;
  const at = from + lead.length + caretAt;
  return tx({ changes: { from, to, insert }, selection: EditorSelection.range(at, at + selectLen) });
}

/** The table the Table button inserts: three columns, a header and two rows. */
export const TABLE_3X3 = "| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |";

/** Insert a 3×3 table, "Column 1" selected so typing names it. */
export const insertTable: Command = (state) => insertBlockAt(state, TABLE_3X3, 2, "Column 1".length);

/** Insert a divider (`---`) on a line of its own. */
export const insertDivider: Command = (state) => insertBlockAt(state, "---", 3);

// ---- checklist ---------------------------------------------------------------

const TASK = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[[ xX]\][ \t]?/;
const LIST = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)/;

/**
 * Checklist: the selected lines become `- [ ] ` items — a bullet or a
 * numbered item keeps its marker and gains the box — or, when every
 * non-blank one already is a task, lose the box and the bullet again. A
 * caret on a blank line starts an item there.
 */
export const toggleChecklist: Command = (state) => {
  const doc = state.doc;
  const lines = selectedLines(state).map((n) => doc.line(n));
  const real = lines.filter((l) => l.text.trim() !== "");
  const changes: ChangeSpec[] = [];
  if (real.length === 0) {
    const l = lines[0];
    changes.push({ from: l.from, to: l.to, insert: l.text.match(/^[ \t]*/)?.[0] + "- [ ] " });
    const at = l.from + (l.text.match(/^[ \t]*/)?.[0].length ?? 0) + 6;
    return tx({ changes, selection: EditorSelection.cursor(at) });
  }
  const allTasks = real.every((l) => TASK.test(l.text));
  for (const l of real) {
    if (allTasks) {
      const m = TASK.exec(l.text)!;
      const indent = /^[ \t]*/.exec(l.text)![0];
      // A bullet task goes back to plain text; a numbered one keeps its number.
      const bulleted = /^[ \t]*[-*+]/.test(l.text);
      changes.push({ from: l.from, to: l.from + m[0].length, insert: bulleted ? indent : m[1] });
      continue;
    }
    if (TASK.test(l.text)) continue;
    const list = LIST.exec(l.text);
    if (list) {
      changes.push({ from: l.from + list[0].length, insert: "[ ] " });
      continue;
    }
    const indent = /^[ \t]*/.exec(l.text)![0];
    changes.push({ from: l.from + indent.length, insert: "- [ ] " });
  }
  if (changes.length === 0) return null;
  const set = state.changes(changes);
  return tx({ changes: set, selection: state.selection.map(set, 1) });
};

/**
 * Tick or untick the task box whose `[` is at `pos` (a click on a drawn
 * box): `[ ]` ↔ `[x]`, one character, nothing else.
 */
export function toggleTaskAt(state: EditorState, pos: number): TransactionSpec | null {
  const box = state.doc.sliceString(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(box)) return null;
  const done = box[1] !== " ";
  return tx({ changes: { from: pos + 1, to: pos + 2, insert: done ? " " : "x" } });
}

// ---- Insert + ---------------------------------------------------------------

/** Wrap the selection as `open…close`, or insert `open+placeholder+close`
 *  with the placeholder selected. */
function wrapOrPlace(open: string, close: string, placeholder: string): Command {
  return (state) => {
    const result = state.changeByRange((r) => {
      const t = state.sliceDoc(r.from, r.to);
      if (r.empty || t.includes("\n")) {
        const insert = open + placeholder + close;
        return {
          changes: { from: r.from, to: r.to, insert: r.empty ? insert : open + t + close },
          range: r.empty
            ? EditorSelection.range(r.from + open.length, r.from + open.length + placeholder.length)
            : EditorSelection.range(r.from + open.length, r.from + open.length + t.length),
        };
      }
      return {
        changes: { from: r.from, to: r.to, insert: open + t + close },
        range: EditorSelection.range(r.from + open.length, r.from + open.length + t.length),
      };
    });
    return tx(result);
  };
}

/**
 * A link: the selection becomes its text and `url` is selected to type
 * over; with nothing selected, `[text](url)` with `text` selected.
 */
export const insertLink: Command = (state) => {
  const result = state.changeByRange((r) => {
    const t = state.sliceDoc(r.from, r.to);
    if (r.empty || t.includes("\n")) {
      return {
        changes: { from: r.from, to: r.to, insert: "[text](url)" },
        range: EditorSelection.range(r.from + 1, r.from + 5),
      };
    }
    const looksUrl = /^(https?:\/\/|www\.)\S+$/.test(t);
    if (looksUrl) {
      return {
        changes: { from: r.from, to: r.to, insert: `[text](${t})` },
        range: EditorSelection.range(r.from + 1, r.from + 5),
      };
    }
    const at = r.from + 1 + t.length + 2;
    return {
      changes: { from: r.from, to: r.to, insert: `[${t}](url)` },
      range: EditorSelection.range(at, at + 3),
    };
  });
  return tx(result);
};

/** A note link: `[[selection]]`, or `[[note]]` with `note` selected. */
export const insertWikilink: Command = wrapOrPlace("[[", "]]", "note");

/** An inline formula: `$selection$`, or `$x$` with `x` selected. */
export const insertFormula: Command = wrapOrPlace("$", "$", "x");

// ---- image ------------------------------------------------------------------

/** A path as a Markdown link destination: each part percent-encoded where
 *  a space, a bracket or the like would end or break the link. */
export function linkPath(rel: string): string {
  return rel
    .split("/")
    .map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/** The alt text for an image file: its name without the extension, with
 *  brackets that would end the alt taken out. */
export function imageAlt(file: string): string {
  const leaf = file.split("/").pop() ?? file;
  const dot = leaf.lastIndexOf(".");
  return (dot > 0 ? leaf.slice(0, dot) : leaf).replace(/[[\]\n\r]/g, " ").trim() || "image";
}

/** Insert `![alt](path)` at the caret, replacing any selection. */
export function insertImage(alt: string, path: string): Command {
  return (state) => {
    const r = state.selection.main;
    const insert = `![${alt}](${path})`;
    return tx({ changes: { from: r.from, to: r.to, insert }, selection: EditorSelection.cursor(r.from + insert.length) });
  };
}

/** The folder, relative to its notes store, that a note's images go in:
 *  `attachments/` beside it (blocker 1652). */
export function attachmentsFolder(noteName: string): string {
  const slash = noteName.lastIndexOf("/");
  return slash < 0 ? "attachments" : `${noteName.slice(0, slash)}/attachments`;
}

/** Where a kept file is, relative to the note: `rel` is store-relative. */
export function relativeToNote(noteName: string, rel: string): string {
  const slash = noteName.lastIndexOf("/");
  const dir = slash < 0 ? "" : noteName.slice(0, slash + 1);
  return dir && rel.startsWith(dir) ? rel.slice(dir.length) : rel;
}

/**
 * A relative image link in a note, as the store-relative name of the file
 * it points at — for drawing it from the store (`readNoteMedia`). Null for
 * anything with a scheme, a rooted path, or one that climbs out of the store.
 */
export function imageNoteName(noteName: string, src: string): string | null {
  const u = src.trim();
  if (!u || /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith("/") || u.startsWith("#")) return null;
  let path: string;
  try {
    path = decodeURIComponent(u.replace(/[?#].*$/, ""));
  } catch {
    return null;
  }
  const slash = noteName.lastIndexOf("/");
  const parts = slash < 0 ? [] : noteName.slice(0, slash).split("/");
  for (const p of path.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(p);
  }
  return parts.length ? parts.join("/") : null;
}
