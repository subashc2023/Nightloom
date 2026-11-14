/**
 * Item 689 (blocker 1993, his answer "I think grid makes more sense no?"):
 * a Markdown table in the message box drawn as a grid he types into.
 *
 * The box's text is still the message, and stays Markdown: the grid is a
 * CodeMirror block widget over the table's lines, and each cell he types in
 * becomes an edit of that cell's characters in the text (`mdTable.ts`
 * `cellChange`), dispatched as typing — so the draft store, Send, and ⌘Z
 * (CodeMirror's history, run from the cell) all see the one string.
 *
 * Around the grid: the caret never sits inside the table's text (atomic
 * ranges), text typed against its edges goes on a line of its own after a
 * blank line (`gridInputFilter`, so the table stays a table), and Backspace /
 * Delete beside it first pick the whole table, then delete it as one step.
 * "Markdown" on the grid's bar shows its source; "Grid" on the source goes back.
 */
import { Annotation, EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, type Extension, type TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { redo as cmRedo, undo as cmUndo, isolateHistory } from "@codemirror/commands";
import { addRowChange, cellChange, narrowChange, columnPx, gridCols, gridValues, parseTable, type MdTable } from "./mdTable";

/** A table's lines in the box: `[from, to)` from its first line's start to its last line's end. */
export interface TableBlock {
  from: number;
  to: number;
}

/** Marks the grid's own edits, which `gridInputFilter` lets through as they are. */
export const gridEdit = Annotation.define<boolean>();

/** Show a table's source (true) or its grid again (false), by the table's start. */
export const showGridSource = StateEffect.define<{ at: number; source: boolean }>();

/** Table starts shown as source, mapped through every edit. */
export const gridSourceField = StateField.define<number[]>({
  create: () => [],
  update(value, tr) {
    let out = tr.docChanged ? value.map((p) => tr.changes.mapPos(p, 1)) : value;
    for (const e of tr.effects) {
      if (!e.is(showGridSource)) continue;
      out = out.filter((p) => p !== e.value.at);
      if (e.value.source) out = [...out, e.value.at];
    }
    return out;
  },
});

/** Every top-level table in the box (one inside a quote or a list is left as text). */
export function tableBlocks(state: EditorState): TableBlock[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  const out: TableBlock[] = [];
  tree.iterate({
    enter(node) {
      if (node.name === "Table") {
        if (node.node.parent?.name === "Document") {
          const from = state.doc.lineAt(node.from).from;
          const to = state.doc.lineAt(node.to).to;
          if (parseTable(state.doc.sliceString(from, to))) out.push({ from, to });
        }
        return false;
      }
      if (node.name === "FencedCode" || node.name === "CodeBlock") return false;
    },
  });
  return out;
}

/** Whether the table at `from` is shown as its source. */
export function sourceShown(state: EditorState, from: number): boolean {
  return (state.field(gridSourceField, false) ?? []).includes(from);
}

/** The tables drawn as grids (not shown as source). */
export function gridTables(state: EditorState): TableBlock[] {
  return tableBlocks(state).filter((t) => !sourceShown(state, t.from));
}

/** The edit deleting a table's lines and one line break beside them. */
export function deleteTableChange(state: EditorState, t: TableBlock): { from: number; to: number } {
  const doc = state.doc;
  if (t.to < doc.length && doc.sliceString(t.to, t.to + 1) === "\n") return { from: t.from, to: t.to + 1 };
  if (t.from > 0 && doc.sliceString(t.from - 1, t.from) === "\n") return { from: t.from - 1, to: t.to };
  return { from: t.from, to: t.to };
}

function deleteTable(view: EditorView, t: TableBlock): void {
  const ch = deleteTableChange(view.state, t);
  view.dispatch({
    changes: { ...ch, insert: "" },
    selection: EditorSelection.cursor(ch.from),
    userEvent: "delete.selection",
    annotations: [isolateHistory.of("full"), gridEdit.of(true)],
    scrollIntoView: true,
  });
  view.focus();
}

/** The table a grid element stands for, read from the state as it is now. */
function blockOf(view: EditorView, el: HTMLElement): TableBlock | null {
  let at: number;
  try {
    at = view.posAtDOM(el);
  } catch {
    return null;
  }
  return tableBlocks(view.state).find((t) => t.from === at) ?? null;
}

function gridEl(view: EditorView, t: TableBlock): HTMLElement | null {
  for (const el of view.contentDOM.querySelectorAll<HTMLElement>(".cm-cgrid")) {
    if (blockOf(view, el)?.from === t.from) return el;
  }
  return null;
}

function cellsOf(wrap: HTMLElement): HTMLTextAreaElement[] {
  return Array.from(wrap.querySelectorAll<HTMLTextAreaElement>("textarea.cm-cgrid-cell"));
}

function cellAt(wrap: HTMLElement, r: number, c: number): HTMLTextAreaElement | null {
  return wrap.querySelector<HTMLTextAreaElement>(`textarea.cm-cgrid-cell[data-r="${r}"][data-c="${c}"]`);
}

/** Focus cell `(r, c)` (clamped), the caret at its end (or `caret`). */
export function focusCell(wrap: HTMLElement, r: number, c: number, caret: number | null = null): boolean {
  const cells = cellsOf(wrap);
  if (cells.length === 0) return false;
  const rows = Math.max(...cells.map((x) => Number(x.dataset.r))) + 1;
  const cols = Math.max(...cells.map((x) => Number(x.dataset.c))) + 1;
  const ta = cellAt(wrap, Math.max(0, Math.min(r, rows - 1)), Math.max(0, Math.min(c, cols - 1)));
  if (!ta) return false;
  ta.focus({ preventScroll: false });
  const at = caret === null ? ta.value.length : Math.min(caret, ta.value.length);
  ta.setSelectionRange(at, at);
  // A cell just added sits under the box's fold until laid out: shown then.
  requestAnimationFrame(() => ta.scrollIntoView({ block: "nearest" }));
  return true;
}

/** A cell's height to its wrapped text (long cells wrap, never scroll). */
function fit(ta: HTMLTextAreaElement): void {
  ta.style.height = "0px";
  ta.style.height = `${ta.scrollHeight}px`;
}

/**
 * The grid: a `<table>` of `<textarea>`s (a textarea per cell keeps his
 * typing, IME and selection the browser's, outside CodeMirror's DOM
 * reading), then a bar: add a row, show the Markdown, delete the table.
 */
export class TableGridWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly picked: boolean,
  ) {
    super();
  }
  eq(other: TableGridWidget): boolean {
    return other.src === this.src && other.picked === this.picked;
  }
  get estimatedHeight(): number {
    return (this.src.split("\n").length - 1) * 30 + 34;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-cgrid";
    wrap.dataset.grid = "";
    this.fill(wrap);
    wire(view, wrap);
    const ro = new ResizeObserver(() => {
      setWidths(wrap, valuesOf(wrap));
      cellsOf(wrap).forEach(fit);
      view.requestMeasure();
    });
    ro.observe(wrap);
    (wrap as GridEl).cgridRo = ro;
    requestAnimationFrame(() => cellsOf(wrap).forEach(fit));
    return wrap;
  }
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const t = parseTable(this.src);
    if (!t) return false;
    const values = gridValues(t);
    dom.classList.toggle("cm-cgrid-picked", this.picked);
    const cells = cellsOf(dom);
    const rows = values.length;
    const cols = values[0]?.length ?? 0;
    const same = cells.length === rows * cols && cells.every((x) => Number(x.dataset.r) < rows && Number(x.dataset.c) < cols);
    if (!same) {
      // A row came or went (added, or an undo took one back): drawn again,
      // the cell he was in focused again.
      const active = document.activeElement;
      const was = active instanceof HTMLTextAreaElement && dom.contains(active)
        ? { r: Number(active.dataset.r), c: Number(active.dataset.c), caret: active.selectionStart }
        : null;
      this.fill(dom);
      if (was) focusCell(dom, was.r, was.c, was.caret);
      requestAnimationFrame(() => cellsOf(dom).forEach(fit));
      view.requestMeasure();
      return true;
    }
    for (const ta of cells) {
      const v = values[Number(ta.dataset.r)][Number(ta.dataset.c)];
      if (ta.value === v) continue;
      const focused = document.activeElement === ta;
      const caret = ta.selectionStart;
      ta.value = v;
      if (focused) ta.setSelectionRange(Math.min(caret, v.length), Math.min(caret, v.length));
      fit(ta);
    }
    setWidths(dom, values);
    view.requestMeasure();
    return true;
  }
  destroy(dom: HTMLElement): void {
    (dom as GridEl).cgridRo?.disconnect();
  }
  ignoreEvent(): boolean {
    return true;
  }
  /** The grid's table and bar, from `src`. */
  private fill(wrap: HTMLElement): void {
    const t = parseTable(this.src) as MdTable;
    const values = gridValues(t);
    wrap.classList.toggle("cm-cgrid-picked", this.picked);
    wrap.replaceChildren();
    const scroll = document.createElement("div");
    scroll.className = "cm-cgrid-scroll";
    const table = document.createElement("table");
    table.className = "cm-cgrid-table";
    const colgroup = document.createElement("colgroup");
    for (let c = 0; c < gridCols(t); c++) colgroup.appendChild(document.createElement("col"));
    table.appendChild(colgroup);
    const head = document.createElement("thead");
    const body = document.createElement("tbody");
    values.forEach((row, r) => {
      const tr = document.createElement("tr");
      row.forEach((v, c) => {
        const cell = document.createElement(r === 0 ? "th" : "td");
        const ta = document.createElement("textarea");
        ta.className = "cm-cgrid-cell";
        ta.rows = 1;
        ta.value = v;
        ta.dataset.r = String(r);
        ta.dataset.c = String(c);
        // Its undo is the box's (CodeMirror's), run from `wire`'s keys.
        ta.setAttribute("data-own-undo", "");
        ta.spellcheck = false;
        ta.setAttribute("autocorrect", "off");
        ta.setAttribute("autocapitalize", "off");
        ta.setAttribute("aria-label", r === 0 ? `Header, column ${c + 1}` : `Row ${r}, column ${c + 1}`);
        const a = t.align[c];
        if (a) ta.style.textAlign = a;
        cell.appendChild(ta);
        tr.appendChild(cell);
      });
      (r === 0 ? head : body).appendChild(tr);
    });
    table.append(head, body);
    scroll.appendChild(table);
    const bar = document.createElement("div");
    bar.className = "cm-cgrid-bar";
    const button = (act: string, label: string, tipText: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cm-cgrid-btn";
      b.dataset.act = act;
      b.textContent = label;
      b.dataset.tip = tipText;
      b.tabIndex = -1;
      return b;
    };
    bar.append(
      button("row", "+ Row", "Add a row (Tab in the last cell adds one too)"),
      button("source", "Markdown", "Show the table as its Markdown text"),
      button("delete", "Delete table", "Delete the whole table (⌘Z brings it back)"),
    );
    wrap.append(scroll, bar);
    setWidths(wrap, values);
  }
}

type GridEl = HTMLElement & { cgridRo?: ResizeObserver };

/** The grid's values as its cells hold them. */
function valuesOf(wrap: HTMLElement): string[][] {
  const out: string[][] = [];
  for (const ta of cellsOf(wrap)) (out[Number(ta.dataset.r)] ??= [])[Number(ta.dataset.c)] = ta.value;
  return out;
}

function setWidths(wrap: HTMLElement, values: string[][]): void {
  const cols = wrap.querySelectorAll<HTMLTableColElement>("col");
  const width = wrap.clientWidth;
  if (width <= 0) return;
  columnPx(values, width).forEach((w, i) => {
    if (cols[i]) cols[i].style.width = `${w}px`;
  });
}

/** Leave the grid for the text after it (`down`) or before it. */
function leave(view: EditorView, wrap: HTMLElement, down: boolean): void {
  const t = blockOf(view, wrap);
  if (!t) return view.focus();
  const doc = view.state.doc;
  const at = down ? (t.to < doc.length ? t.to + 1 : t.to) : t.from > 0 ? t.from - 1 : t.from;
  view.dispatch({ selection: EditorSelection.cursor(at), scrollIntoView: true });
  view.focus();
}

/** Add an empty row after row `after`, focusing its first cell. */
function addRow(view: EditorView, wrap: HTMLElement, after: number | null = null): void {
  const t = blockOf(view, wrap);
  const table = t ? parseTable(view.state.doc.sliceString(t.from, t.to)) : null;
  if (!t || !table) return;
  const ch = addRowChange(table, after ?? table.rows.length - 1);
  view.dispatch({
    changes: { from: t.from + ch.from, to: t.from + ch.to, insert: ch.insert },
    userEvent: "input",
    annotations: [isolateHistory.of("full"), gridEdit.of(true)],
  });
  const r = (after ?? table.rows.length - 1) + 1;
  // The widget was updated in place by the dispatch (`updateDOM`).
  const el = gridEl(view, { from: t.from, to: t.to + ch.insert.length }) ?? wrap;
  focusCell(el, r, 0);
}

/** The cell's text into the box's text: one edit of that cell's characters. */
function writeCell(view: EditorView, wrap: HTMLElement, ta: HTMLTextAreaElement): void {
  const t = blockOf(view, wrap);
  const table = t ? parseTable(view.state.doc.sliceString(t.from, t.to)) : null;
  if (!t || !table) return;
  const ch = cellChange(table, Number(ta.dataset.r), Number(ta.dataset.c), ta.value);
  fit(ta);
  if (!ch) return;
  // Only the characters that changed, as a keystroke changes them: the
  // box's history then joins a run of typing into one ⌘Z step, as it does
  // for typing in the text.
  const n = narrowChange(view.state.doc.sliceString(t.from + ch.from, t.from + ch.to), ch);
  if (!n) return;
  view.dispatch({
    changes: { from: t.from + n.from, to: t.from + n.to, insert: n.insert },
    userEvent: "input.type",
    annotations: gridEdit.of(true),
  });
}

function wire(view: EditorView, wrap: HTMLElement): void {
  wrap.addEventListener("input", (e) => {
    const ta = e.target;
    if (ta instanceof HTMLTextAreaElement) writeCell(view, wrap, ta);
  });
  // A cell is one line of the table: a pasted line break is a space.
  wrap.addEventListener("paste", (e) => {
    const ta = e.target;
    if (!(ta instanceof HTMLTextAreaElement)) return;
    e.stopPropagation();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!/[\r\n]/.test(text)) return;
    e.preventDefault();
    ta.setRangeText(text.replace(/\s*(\r\n?|\n)\s*/g, " "), ta.selectionStart, ta.selectionEnd, "end");
    writeCell(view, wrap, ta);
  });
  wrap.addEventListener("mousedown", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.cm-cgrid-btn");
    if (b) e.preventDefault();
  });
  wrap.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.cm-cgrid-btn");
    if (!b) return;
    const t = blockOf(view, wrap);
    if (!t) return;
    if (b.dataset.act === "row") addRow(view, wrap);
    else if (b.dataset.act === "delete") deleteTable(view, t);
    else if (b.dataset.act === "source") {
      view.dispatch({ effects: showGridSource.of({ at: t.from, source: true }), selection: EditorSelection.cursor(t.from) });
      view.focus();
    }
  });
  wrap.addEventListener("keydown", (e) => {
    const ta = e.target;
    if (!(ta instanceof HTMLTextAreaElement) || e.isComposing || e.keyCode === 229) return;
    const r = Number(ta.dataset.r);
    const c = Number(ta.dataset.c);
    const cells = cellsOf(wrap);
    const rows = Math.max(...cells.map((x) => Number(x.dataset.r))) + 1;
    const cols = Math.max(...cells.map((x) => Number(x.dataset.c))) + 1;
    const mod = e.metaKey || e.ctrlKey;
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const key = e.key.toLowerCase();
    if (mod && !e.altKey && (key === "z" || key === "y")) {
      done();
      ((key === "z" && e.shiftKey) || key === "y" ? cmRedo : cmUndo)(view);
      return;
    }
    if (e.key === "Tab" && !mod && !e.altKey) {
      done();
      const i = r * cols + c + (e.shiftKey ? -1 : 1);
      if (i < 0) return leave(view, wrap, false);
      if (i >= rows * cols) return addRow(view, wrap);
      focusCell(wrap, Math.floor(i / cols), i % cols);
      return;
    }
    if (e.key === "Enter" && !mod && !e.altKey) {
      done();
      const to = r + (e.shiftKey ? -1 : 1);
      if (to < 0) return leave(view, wrap, false);
      if (to >= rows) return leave(view, wrap, true);
      focusCell(wrap, to, c);
      return;
    }
    const empty = ta.selectionStart === ta.selectionEnd;
    if (e.key === "ArrowUp" && empty && !e.shiftKey && !mod && ta.selectionStart === 0) {
      done();
      if (r === 0) return leave(view, wrap, false);
      focusCell(wrap, r - 1, c);
      return;
    }
    if (e.key === "ArrowDown" && empty && !e.shiftKey && !mod && ta.selectionStart === ta.value.length) {
      done();
      if (r + 1 >= rows) return leave(view, wrap, true);
      focusCell(wrap, r + 1, c);
      return;
    }
    if (e.key === "Escape") {
      done();
      leave(view, wrap, true);
    }
  });
}

/** Whether the selection covers the whole of `t` (the grid drawn picked). */
export function tablePicked(state: EditorState, t: TableBlock): boolean {
  const s = state.selection.main;
  return !s.empty && s.from <= t.from && s.to >= t.to;
}

/**
 * Backspace / Delete beside a grid pick the table first (an outline), so
 * one key never takes a whole table by surprise nor joins a line into its
 * text; with the table picked they delete it, with one line break, as one
 * undo step. ↓ from the line above a grid and ↑ from the line below go
 * into its cells.
 */
function gridKeys(): Extension {
  const pick = (view: EditorView, t: TableBlock) => {
    view.dispatch({ selection: EditorSelection.range(t.from, t.to), scrollIntoView: true });
    return true;
  };
  const del = (forward: boolean) => (view: EditorView) => {
    const s = view.state.selection.main;
    const doc = view.state.doc;
    for (const t of gridTables(view.state)) {
      if (!s.empty) {
        if (s.from === t.from && s.to === t.to) {
          deleteTable(view, t);
          return true;
        }
        continue;
      }
      const p = s.head;
      if (!forward) {
        if (p === t.to) return pick(view, t);
        if (p === t.to + 1 && doc.lineAt(p).length > 0) return pick(view, t);
      } else {
        if (p === t.from) return pick(view, t);
        if (p === t.from - 1 && doc.lineAt(p).length > 0) return pick(view, t);
        if (p === t.to && p < doc.length && doc.lineAt(p + 1).length > 0) return true;
      }
    }
    return false;
  };
  const into = (down: boolean) => (view: EditorView) => {
    const s = view.state.selection.main;
    if (!s.empty) return false;
    const line = view.state.doc.lineAt(s.head);
    for (const t of gridTables(view.state)) {
      const hit = down ? s.head === t.from || line.to + 1 === t.from : s.head === t.to || line.from - 1 === t.to;
      if (!hit) continue;
      const el = gridEl(view, t);
      if (!el) return false;
      const rows = (parseTable(view.state.doc.sliceString(t.from, t.to))?.rows.length ?? 1) - 1;
      return focusCell(el, down ? 0 : rows, 0);
    }
    return false;
  };
  return Prec.high(
    keymap.of([
      { key: "Backspace", run: del(false) },
      { key: "Delete", run: del(true) },
      { key: "Mod-Backspace", run: del(false) },
      { key: "Alt-Backspace", run: del(false) },
      { key: "ArrowDown", run: into(true) },
      { key: "ArrowUp", run: into(false) },
    ]),
  );
}

/**
 * Text typed or pasted against a grid's edge (the caret just before or
 * after it) goes in on its own lines with a blank line between, so the
 * table stays a table — "x" at a table's end would otherwise join its last
 * row and be drawn inside the grid; before it, it would turn the table's
 * header into a paragraph line. Bare line breaks (Enter) go in as typed.
 */
export const gridInputFilter = EditorState.transactionFilter.of((tr: Transaction): Transaction | TransactionSpec[] => {
  if (!tr.docChanged || tr.annotation(gridEdit) || !tr.isUserEvent("input")) return tr;
  const tables = gridTables(tr.startState);
  if (tables.length === 0) return tr;
  const changes: { from: number; to: number; insert: string }[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, ins) => changes.push({ from: fromA, to: toA, insert: ins.toString() }));
  if (changes.length !== 1) return tr;
  const ch = changes[0];
  if (ch.from !== ch.to || !/[^\n]/.test(ch.insert)) return tr;
  const doc = tr.startState.doc;
  const blank = (p: number) => p >= 0 && p <= doc.length && doc.lineAt(p).length === 0;
  for (const t of tables) {
    // On an empty line right under or over a grid: a blank line between.
    if (ch.from === t.to + 1 && blank(ch.from) && !ch.insert.startsWith("\n")) {
      return [{
        changes: { from: ch.from, insert: "\n" + ch.insert },
        selection: EditorSelection.cursor(ch.from + 1 + ch.insert.length),
        userEvent: tr.annotation(Transaction.userEvent) ?? "input",
        scrollIntoView: true,
      }];
    }
    if (ch.from === t.from - 1 && blank(ch.from) && !ch.insert.endsWith("\n")) {
      return [{
        changes: { from: ch.from, insert: ch.insert + "\n" },
        selection: EditorSelection.cursor(ch.from + ch.insert.length),
        userEvent: tr.annotation(Transaction.userEvent) ?? "input",
        scrollIntoView: true,
      }];
    }
    if (ch.from === t.to) {
      const has = ch.insert.match(/^\n*/)?.[0].length ?? 0;
      const lead = "\n".repeat(Math.max(0, 2 - has));
      return [{
        changes: { from: ch.from, insert: lead + ch.insert },
        selection: EditorSelection.cursor(ch.from + lead.length + ch.insert.length),
        userEvent: tr.annotation(Transaction.userEvent) ?? "input",
        scrollIntoView: true,
      }];
    }
    if (ch.from === t.from) {
      const has = ch.insert.match(/\n*$/)?.[0].length ?? 0;
      const tail = "\n".repeat(Math.max(0, 2 - has));
      return [{
        changes: { from: ch.from, insert: ch.insert + tail },
        selection: EditorSelection.cursor(ch.from + ch.insert.length),
        userEvent: tr.annotation(Transaction.userEvent) ?? "input",
        scrollIntoView: true,
      }];
    }
  }
  return tr;
});

/** The grids are atomic to the caret: it steps over a table, never into its text. */
const gridAtomic = EditorView.atomicRanges.of((view) =>
  Decoration.set(gridTables(view.state).filter((t) => t.to > t.from).map((t) => Decoration.mark({}).range(t.from, t.to))),
);

/** Everything the grid needs in a box, besides the decorations (`composerEditor.ts`). */
export function tableGridSupport(): Extension {
  return [gridSourceField, gridKeys(), gridInputFilter, gridAtomic];
}

/** On a table shown as source: "Grid" puts its grid back. */
export class GridBackWidget extends WidgetType {
  constructor(readonly at: number) {
    super();
  }
  eq(other: GridBackWidget): boolean {
    return other.at === this.at;
  }
  toDOM(view: EditorView): HTMLElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-cgrid-back";
    b.textContent = "Grid";
    b.dataset.tip = "Show this table as a grid";
    b.tabIndex = -1;
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const at = tableBlocks(view.state).find((t) => t.from <= view.posAtDOM(b) && view.posAtDOM(b) <= t.to)?.from;
      if (at === undefined) return;
      view.dispatch({ effects: showGridSource.of({ at, source: false }) });
    });
    return b;
  }
  ignoreEvent(): boolean {
    return true;
  }
}
