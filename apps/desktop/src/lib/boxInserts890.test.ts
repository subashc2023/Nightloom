import { describe, expect, it } from "vitest";
import src from "./Composer.svelte?raw";
import phone from "../remote/promptBox.ts?raw";
import { history, undo } from "@codemirror/commands";
import { applyInsert, INSERTS, insertEdit, insertMatches, insertToken, tableSize, type BoxInsert } from "./boxInserts";
import { gridValues, hasTable, parseTable } from "./mdTable";
import { boxDrawing, composerState } from "./composerEditor";
import { tableBlocks } from "./tableGrid";

const byName = (n: string): BoxInsert => INSERTS.find((i) => i.name === n)!;
/** Type `text`, the caret at its end, and pick `name`. */
function run(t: string, name: string) {
  const tok = insertToken(t, t.length)!;
  expect(tok).not.toBeNull();
  const ed = insertEdit(t, tok, byName(name));
  return { ed, out: applyInsert(t, ed), caret: ed.head };
}

describe("890: the /word token", () => {
  it("opens at the box's start, a line's start and after a space", () => {
    expect(insertToken("/ta", 3)).toMatchObject({ start: 0, word: "ta" });
    expect(insertToken("hi\n/ta", 6)).toMatchObject({ start: 3, word: "ta" });
    expect(insertToken("see /ta", 7)).toMatchObject({ start: 4, word: "ta" });
    expect(insertToken("/", 1)).toMatchObject({ start: 0, word: "" });
  });
  it("never inside a word or a path", () => {
    expect(insertToken("and/or", 6)).toBeNull();
    expect(insertToken("w/o", 3)).toBeNull();
    expect(insertToken("24/7", 4)).toBeNull();
    expect(insertToken("/Users/me/", 10)).toBeNull();
    expect(insertToken("/Users/me/table", 15)).toBeNull();
    expect(insertMatches(insertToken("/Users", 6))).toEqual([]);
  });
  it("is the token ending at the caret, mid-text too", () => {
    const t = "first /tab and more";
    expect(insertToken(t, 10)).toMatchObject({ start: 6, end: 10, word: "tab" });
    expect(insertToken(t, t.length)).toBeNull();
  });
  it("takes a size or a language after one space", () => {
    expect(insertToken("/table 4x3", 10)).toMatchObject({ word: "table", arg: "4x3", spaced: true });
    expect(insertToken("/code py", 8)).toMatchObject({ word: "code", arg: "py" });
  });
});

describe("890: filtering", () => {
  const names = (t: string) => insertMatches(insertToken(t, t.length)).map((i) => i.name);
  it("filters by the start of a name or alias, an exact one first", () => {
    expect(names("/ta")).toEqual(["table"]);
    expect(names("/")).toEqual(["table", "math", "code", "quote", "list", "numbered"]);
    expect(names("/ma")).toEqual(["math"]);
    expect(names("/eq")).toEqual(["math"]);
    expect(names("/fe")).toEqual(["code"]);
    expect(names("/xyz")).toEqual([]);
  });
  it("an argument only on the insert that takes one", () => {
    expect(names("/table 4x3")).toEqual(["table"]);
    expect(names("/table 4")).toEqual(["table"]);
    expect(names("/table abc")).toEqual([]);
    expect(names("/code python")).toEqual(["code"]);
    expect(names("/quote this")).toEqual([]);
    expect(names("/tab 4x3")).toEqual([]);
  });
  it("sizes clamp", () => {
    expect(tableSize("")).toEqual({ cols: 3, rows: 2 });
    expect(tableSize("4x3")).toEqual({ cols: 4, rows: 3 });
    expect(tableSize("4×3")).toEqual({ cols: 4, rows: 3 });
    expect(tableSize("99x0")).toEqual({ cols: 12, rows: 1 });
  });
});

describe("890: each insert's text and caret", () => {
  it("/table: a 3×2 table the box draws as a grid", () => {
    const { ed, out } = run("/table", "table");
    expect(out).toBe("|   |   |   |\n| --- | --- | --- |\n|   |   |   |\n|   |   |   |");
    expect(ed.tableAt).toBe(0);
    expect(hasTable(out)).toBe(true);
    const t = parseTable(out)!;
    expect(gridValues(t)).toEqual([["", "", ""], ["", "", ""], ["", "", ""]]);
    const st = composerState(out, [boxDrawing.of("plain")], 0, false);
    expect(tableBlocks(st)).toEqual([{ from: 0, to: out.length }]);
  });
  it("/table 4x3 after text: a blank line above, so it stays a table", () => {
    const { ed, out } = run("Here:\n/table 4x3", "table");
    expect(out.startsWith("Here:\n\n|   |   |   |   |\n")).toBe(true);
    expect(gridValues(parseTable(out.slice(ed.tableAt!))!).length).toBe(4);
    const st = composerState(out, [boxDrawing.of("plain")], 0, false);
    expect(tableBlocks(st)).toHaveLength(1);
    const mid = run("Here: /table", "table").out;
    expect(mid.startsWith("Here:\n\n|")).toBe(true);
  });
  it("/math: $$ lines, caret on the empty middle line", () => {
    const { out, caret } = run("/math", "math");
    expect(out).toBe("$$\n\n$$");
    expect(caret).toBe(3);
  });
  it("/code and /code py: a fence, caret inside", () => {
    let r = run("/code", "code");
    expect(r.out).toBe("```\n\n```");
    expect(r.caret).toBe(4);
    r = run("x\n/code py", "code");
    expect(r.out).toBe("x\n```py\n\n```");
    expect(r.out.slice(r.caret)).toBe("\n```");
  });
  it("a block before more text gets a line break after it", () => {
    const t = "a /math| b";
    const caret = t.indexOf("|");
    const s = t.replace("|", "");
    const ed = insertEdit(s, insertToken(s, caret)!, byName("math"));
    expect(applyInsert(s, ed)).toBe("a\n$$\n\n$$\n b");
  });
  it("/quote, /list, /numbered: the line's mark, caret after it", () => {
    expect(run("/quote", "quote")).toMatchObject({ out: "> ", caret: 2 });
    expect(run("/list", "list")).toMatchObject({ out: "- ", caret: 2 });
    expect(run("one\n/numbered", "numbered")).toMatchObject({ out: "one\n1. ", caret: 7 });
    expect(run("said /quote", "quote").out).toBe("said\n> ");
  });
  it("one undo step in the grid editor gives /table back", () => {
    const text = "/table";
    const ed = insertEdit(text, insertToken(text, 6)!, byName("table"));
    let st = composerState(text, [boxDrawing.of("plain"), history()], 6, false);
    st = st.update({ changes: { from: ed.from, to: ed.to, insert: ed.insert }, userEvent: "input" }).state;
    expect(hasTable(st.doc.toString())).toBe(true);
    let back = st;
    undo({ state: st, dispatch: (tr) => (back = tr.state) });
    expect(back.doc.toString()).toBe("/table");
  });
});

describe("890: wiring", () => {
  it("the composer's one / list carries the inserts; IME keys never pick", () => {
    expect(src).toMatch(/insertMatches\(insTok\)/);
    expect(src).toMatch(/\[\.\.\.mine, \.\.\.ours, \.\.\.cmd, \.\.\.theirs\]/);
    expect(src).toMatch(/const imeKey = composing \|\| e\.isComposing \|\| e\.keyCode === 229/);
    expect(src).toMatch(/m\.kind \+ "\\u0000" \+ m\.name/);
    expect(src).toMatch(/ta\.insertBlock\(ed\)/);
  });
  it("the phone's boxes offer them too", () => {
    expect(phone).toMatch(/insertMatches\(insertToken\(node\.value, node\.selectionEnd\)\)/);
  });
});
