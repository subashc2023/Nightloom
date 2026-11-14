import { describe, expect, it } from "vitest";
import { EditorSelection, Transaction } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { addRowChange, cellChange, columnPx, gridValues, hasTable, narrowChange, parseTable } from "./mdTable";
import { boxDrawing, composerDecorations, composerState, liveSpans } from "./composerEditor";
import { deleteTableChange, gridEdit, gridTables, showGridSource, tableBlocks } from "./tableGrid";

// His table (item 684's screenshot): Q3's rows, columns #, Asked, Answer, Why.
const Q3 = [
  "| # | Asked | Answer | Why |",
  "|---|---|---|---|",
  "| 1 | What is the time complexity of push? | O(1) | One append to the queue |",
  "| 2 | And pop? |  | |",
  "| 3 | Space used by $n$ items | O(n) | Each item is stored once, \\| no copies |",
].join("\n");

/** The box's text after each cell edit the grid would make (`writeCell`). */
function edit(text: string, r: number, c: number, value: string): string {
  const t = parseTable(text)!;
  const ch = cellChange(t, r, c, value)!;
  return text.slice(0, ch.from) + ch.insert + text.slice(ch.to);
}

describe("item 689: a Markdown table ⇄ the grid", () => {
  it("reads his table as a grid: header and rows, empty cells blank, \\| as |", () => {
    const t = parseTable(Q3)!;
    expect(t.cols).toBe(4);
    const v = gridValues(t);
    expect(v[0]).toEqual(["#", "Asked", "Answer", "Why"]);
    expect(v[2]).toEqual(["2", "And pop?", "", ""]);
    expect(v[3][3]).toBe("Each item is stored once, | no copies");
    expect(v.length).toBe(4);
  });

  it("Markdown in = Markdown out: writing every cell back unchanged changes nothing", () => {
    let text = Q3;
    const v = gridValues(parseTable(Q3)!);
    v.forEach((row, r) => row.forEach((val, c) => (text = edit(text, r, c, val))));
    expect(text).toBe(Q3);
  });

  it("a cell edit changes only that cell's characters", () => {
    const out = edit(Q3, 2, 2, "O(n) — move n−1 items");
    expect(out.split("\n")[3]).toBe("| 2 | And pop? | O(n) — move n−1 items | |");
    // Every other line, byte for byte.
    expect(out.split("\n").filter((_, i) => i !== 3)).toEqual(Q3.split("\n").filter((_, i) => i !== 3));
    expect(gridValues(parseTable(out)!)[2][2]).toBe("O(n) — move n−1 items");
  });

  it("an empty cell with no space (`||`) takes a value padded; a | typed is escaped; a line break is a space", () => {
    expect(edit(Q3, 2, 3, "a|b")).toContain("| And pop? |  | a\\|b |");
    expect(gridValues(parseTable(edit(Q3, 2, 3, "a|b"))!)[2][3]).toBe("a|b");
    const bare = "| a | b |\n|---|---|\n| x ||";
    expect(edit(bare, 1, 1, "y")).toBe("| a | b |\n|---|---|\n| x | y |");
    expect(edit(bare, 1, 0, "one\ntwo")).toBe("| a | b |\n|---|---|\n| one two ||");
  });

  it("a row with fewer cells than the header gets the missing ones when a later cell is typed", () => {
    const short = "| a | b | c |\n|---|---|---|\n| x |";
    const out = edit(short, 1, 2, "z");
    expect(out).toBe("| a | b | c |\n|---|---|---|\n| x |  | z |");
    expect(gridValues(parseTable(out)!)[1]).toEqual(["x", "", "z"]);
    const noPipes = "a | b\n--|--\nx";
    expect(gridValues(parseTable(edit(noPipes, 1, 1, "y"))!)[1]).toEqual(["x", "y"]);
  });

  it("a row can be added, in the header's pipe style, and filled", () => {
    const t = parseTable(Q3)!;
    const ch = addRowChange(t);
    const out = Q3.slice(0, ch.from) + ch.insert + Q3.slice(ch.to);
    expect(out).toBe(Q3 + "\n|  |  |  |  |");
    const filled = edit(out, 4, 1, "Peek?");
    expect(gridValues(parseTable(filled)!)[4]).toEqual(["", "Peek?", "", ""]);
    // Under the header when the table has no rows yet.
    const head = "| a | b |\n|---|---|";
    const h = addRowChange(parseTable(head)!, 0);
    expect(head.slice(0, h.from) + h.insert).toBe("| a | b |\n|---|---|\n|  |  |");
  });

  it("column widths: a share by content, never narrower than the header word", () => {
    const px = columnPx(gridValues(parseTable(Q3)!), 650);
    expect(px.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(651);
    // "Answer": 6 letters × 8 + 20 padding.
    expect(px[2]).toBeGreaterThanOrEqual(68);
    expect(px[0]).toBeLessThan(px[1]);
  });

  it("hasTable: a pipe line then a rule; not a setext heading, not a pipe in prose", () => {
    expect(hasTable(Q3)).toBe(true);
    expect(hasTable("Before\n\n" + Q3 + "\n\nafter")).toBe(true);
    expect(hasTable("Title\n---")).toBe(false);
    expect(hasTable("a | b is a pipe")).toBe(false);
  });
});

describe("item 689: the grid in the box (CodeMirror state)", () => {
  const doc = `My answers:\n\n${Q3}\n\nThanks`;
  const plainState = (text = doc, cursor = 0) => composerState(text, [boxDrawing.of("plain"), history()], cursor, false);

  it("finds the table's lines and draws it as one grid; nothing inside it is drawn on its own", () => {
    const st = plainState();
    const [t] = tableBlocks(st);
    expect(st.doc.sliceString(t.from, t.to)).toBe(Q3);
    const spans = liveSpans(st);
    expect(spans.filter((s) => s.kind === "table")).toHaveLength(1);
    // `$n$` in a cell is not drawn as maths while the grid stands over it.
    expect(spans.some((s) => s.kind === "math")).toBe(false);
  });

  it("the plain box draws the grid and leaves the text round it plain", () => {
    const st = plainState("**bold** text\n\n" + Q3);
    const kinds: string[] = [];
    composerDecorations(st).between(0, st.doc.length, (_f, _t, d) => {
      kinds.push((d.spec.widget?.constructor?.name as string) ?? d.spec.class ?? "replace");
    });
    expect(kinds).toEqual(["TableGridWidget"]);
  });

  it("a table shown as Markdown is text again, with its Grid button", () => {
    let st = plainState();
    const [t] = tableBlocks(st);
    st = st.update({ effects: showGridSource.of({ at: t.from, source: true }) }).state;
    expect(gridTables(st)).toHaveLength(0);
    const kinds: string[] = [];
    composerDecorations(st).between(0, st.doc.length, (_f, _to, d) => {
      kinds.push(d.spec.widget?.constructor?.name ?? "?");
    });
    expect(kinds).toContain("GridBackWidget");
    st = st.update({ effects: showGridSource.of({ at: t.from, source: false }) }).state;
    expect(gridTables(st)).toHaveLength(1);
  });

  it("cell typing is the box's typing: the draft is the Markdown, and ⌘Z gives the cell back", () => {
    let st = plainState();
    const [t] = tableBlocks(st);
    // Three keystrokes into row 2's empty Answer cell, as `writeCell` dispatches them.
    for (const v of ["O", "O(", "O(1"]) {
      const table = parseTable(st.doc.sliceString(t.from, t.to))!;
      const full = cellChange(table, 2, 2, v)!;
      const ch = narrowChange(st.doc.sliceString(t.from + full.from, t.from + full.to), full)!;
      // One keystroke is one character in.
      expect(ch.insert.length).toBe(1);
      st = st.update({
        changes: { from: t.from + ch.from, to: t.from + ch.to, insert: ch.insert },
        userEvent: "input.type",
        annotations: gridEdit.of(true),
      }).state;
    }
    expect(st.doc.toString()).toBe(doc.replace("| 2 | And pop? |  | |", "| 2 | And pop? | O(1 | |"));
    const box = { state: st, dispatch: (tr: Transaction) => (box.state = tr.state) };
    undo(box);
    expect(box.state.doc.toString()).toBe(doc);
  });

  it("deleting the whole table is one change, one undo step, with one line break", () => {
    const st = plainState();
    const [t] = tableBlocks(st);
    const ch = deleteTableChange(st, t);
    let after = st.update({ changes: { ...ch, insert: "" }, userEvent: "delete.selection" }).state;
    expect(after.doc.toString()).toBe("My answers:\n\n\nThanks");
    const box = { state: after, dispatch: (tr: Transaction) => (box.state = tr.state) };
    undo(box);
    after = box.state;
    expect(after.doc.toString()).toBe(doc);
  });

  it("text typed against the grid's edge goes on its own line after a blank one, so the table stays a table", () => {
    const at = (text: string, pos: number, insert: string) => {
      const st = plainState(text, pos);
      return st.update({ changes: { from: pos, insert }, selection: EditorSelection.cursor(pos + insert.length), userEvent: "input.type" }).state;
    };
    // Right after the last row (the caret just past the grid).
    let st = at(Q3, Q3.length, "x");
    expect(st.doc.toString()).toBe(Q3 + "\n\nx");
    expect(st.selection.main.head).toBe(st.doc.length);
    expect(tableBlocks(st)).toHaveLength(1);
    // On the empty line right under it.
    st = at(Q3 + "\n", Q3.length + 1, "y");
    expect(st.doc.toString()).toBe(Q3 + "\n\ny");
    // Just before it.
    st = at(Q3, 0, "Hi");
    expect(st.doc.toString()).toBe("Hi\n\n" + Q3);
    expect(st.selection.main.head).toBe(2);
    // A bare Enter is left as typed; the grid's own edits are never moved.
    expect(at(Q3, Q3.length, "\n").doc.toString()).toBe(Q3 + "\n");
    const st0 = plainState(Q3, 0);
    const own = st0.update({ changes: { from: Q3.length, insert: "\n|  |  |  |  |" }, annotations: gridEdit.of(true), userEvent: "input" }).state;
    expect(own.doc.toString()).toBe(Q3 + "\n|  |  |  |  |");
  });

  it("a table in a fence or a quote is left as text", () => {
    expect(tableBlocks(plainState("```\n" + Q3 + "\n```"))).toHaveLength(0);
    expect(tableBlocks(plainState(Q3.split("\n").map((l) => "> " + l).join("\n")))).toHaveLength(0);
  });

  it("the Format box (drawing all) draws the grid too, and formatting round it", () => {
    const full = composerState("**bold**\n\n" + Q3, [boxDrawing.of("all")], 0, false);
    const kinds = liveSpans(full).map((s) => s.kind);
    expect(kinds).toContain("table");
    expect(kinds).toContain("strong");
  });
});
