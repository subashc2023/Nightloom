import { describe, expect, it } from "vitest";
import { tablePasteText } from "./mathPaste";
import { textPastePlan } from "./textPaste";

// Item 684 (his ask, 2026-11-12): a table copied from a reply and pasted into the message box stays
// a table — a Markdown table he can fill values into — not a column of loose lines.
const TABLE = `<table><thead><tr><th>Line</th><th>p →</th><th>q →</th></tr></thead><tbody>
<tr><td><code>int* p = new int; *p = 2;</code></td><td></td><td></td></tr>
<tr><td><code>int* q = p;</code></td><td></td><td></td></tr>
<tr><td><code>*q = 9;</code></td><td></td><td></td></tr></tbody></table>`;

describe("item 684: tables copy and paste as Markdown tables", () => {
  it("a table becomes a Markdown table with its empty cells kept", () => {
    expect(tablePasteText(TABLE)).toBe(
      [
        "| Line | p → | q → |",
        "|---|---|---|",
        "| int* p = new int; *p = 2; |  |  |",
        "| int* q = p; |  |  |",
        "| *q = 9; |  |  |",
      ].join("\n"),
    );
  });
  it("text around the table stays, a pipe in a cell is escaped, short rows are padded", () => {
    const out = tablePasteText(`<p>Fill this in:</p><table><tr><th>a|b</th><th>c</th></tr><tr><td>1</td></tr></table><p>Done.</p>`);
    expect(out).toBe(["Fill this in:", "", "| a\\|b | c |", "|---|---|", "| 1 |  |", "", "Done."].join("\n"));
  });
  it("no table: null, so every other paste is unchanged", () => {
    expect(tablePasteText("<p>hello</p>")).toBeNull();
    expect(textPastePlan({ plain: "hello", html: "<p>hello</p>", fileCount: 0, text: "", caret: 0 })).toEqual({ kind: "plain" });
  });
  it("the message box's paste plan inserts the Markdown table", () => {
    const plan = textPastePlan({ plain: "Line\np →", html: TABLE, fileCount: 0, text: "", caret: 0 });
    expect(plan.kind).toBe("math");
    expect(plan.kind === "math" && plan.text.startsWith("| Line | p → | q → |\n|---|---|---|")).toBe(true);
  });
});
