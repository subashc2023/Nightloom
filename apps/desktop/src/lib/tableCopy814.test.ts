import { beforeEach, describe, expect, it } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import { asideQuestion, quoteSummary } from "./asideQuote";
import { renderMath } from "./math";
import { clipboardFor, mathCopyText } from "./mathCopy";
import { mathPasteText, quoteText, tablePasteText } from "./mathPaste";
import { chipLabel } from "./passageComments";
import { heldChip, heldFor, heldLabel, heldPassage, holdPassage, dropHeldOnPaste } from "./heldPassage.svelte";
import { cellMathHtml } from "./tableGrid";
import { textPastePlan } from "./textPaste";

// Item 814 (his bug, 2026-11-17, "like i've asked a millioni times"): his z-table — a header cell
// that is maths (`$z$`, drawn by KaTeX) over eight rows — copied from a reply came out as loose lines,
// and the box grew an "About:" chip he never asked for. The HTML here is what a reply draws.
const z = renderMath("z", false);
const ROWS: [string, string, string][] = [
  ["−1.5", "0.0668", "0.0606"],
  ["−1.2", "0.1151", "0.1056"],
  ["−0.7", "0.2420", "0.2266"],
  ["−0.5", "0.3085", "0.2912"],
  ["0.5", "0.6915", "0.7088"],
  ["0.7", "0.7580", "0.7734"],
  ["1.2", "0.8849", "0.8944"],
  ["1.5", "0.9332", "0.9394"],
];
const HEAD = `<tr><th>${z}</th><th>.00</th><th>.05</th></tr>`;
const BODY = ROWS.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("\n");
const TABLE = `<table><thead>${HEAD}</thead><tbody>\n${BODY}</tbody></table>`;
const MD = ["| $z$ | .00 | .05 |", "|---|---|---|", ...ROWS.map((r) => `| ${r.join(" | ")} |`)].join("\n");

describe("item 814: a table with a maths cell copies as a table", () => {
  it("the formula read of a copy (what ran first) writes the table as a Markdown table", () => {
    expect(mathCopyText(TABLE)).toBe(MD);
  });

  it("the copy takes the table read first, whatever else the selection holds", () => {
    expect(clipboardFor(TABLE, TABLE)?.text).toBe(MD);
    expect(clipboardFor(`<p>Here:</p>${TABLE}`, "")?.text).toBe(`Here:\n\n${MD}`);
  });

  it("a selection from one row to another (bare rows, no <table>) is still a table, header kept", () => {
    const bare = `${HEAD}\n${BODY}`;
    expect(mathPasteText(bare)).toBe(MD);
    expect(tablePasteText(bare)).toBe(MD);
  });
});

describe("item 814: pasted into a message box it lands as a table", () => {
  // The main box, an aside's box (the same Composer) and the edit box all read a paste by `textPastePlan`.
  const plain = ["z\t.00\t.05", ...ROWS.map((r) => r.join("\t"))].join("\n");
  it("the reply's HTML", () => {
    expect(textPastePlan({ plain, html: TABLE, fileCount: 0, text: "", caret: 0 })).toEqual({ kind: "math", text: MD });
  });
  it("the copy's rich side (each formula as its MathML)", () => {
    const mml = `<math><semantics><mi>z</mi><annotation encoding="application/x-tex">z</annotation></semantics></math>`;
    const rich = TABLE.replace(z, mml);
    expect(textPastePlan({ plain, html: rich, fileCount: 0, text: "", caret: 0 })).toEqual({ kind: "math", text: MD });
  });
  it("bare rows on the clipboard", () => {
    expect(textPastePlan({ plain, html: `${HEAD}${BODY}`, fileCount: 0, text: "", caret: 0 })).toEqual({ kind: "math", text: MD });
  });
});

describe("item 814: a quoted table (Ask aside, comment, reply) is Markdown, its chip a short label", () => {
  it("the quote's text is the Markdown table, and the aside's prompt carries it", () => {
    expect(quoteText(TABLE)).toBe(MD);
    expect(asideQuestion({ text: quoteText(TABLE)!, role: "assistant", ordinal: 2 }, "why?")).toContain(`"""\n${MD}\n"""`);
  });
  it("lists keep their markers", () => {
    expect(quoteText("<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>")).toBe("- one\n- two\n\n1. first");
  });
  it("the About chip: Table · its headers · its rows, no raw $…$", () => {
    expect(heldLabel({ text: MD, role: "assistant", ordinal: 2 })).toBe("Table · z, .00, .05 · 8 rows");
    expect(chipLabel({ quote: `See ${"$x^2$"}:\n\n${MD}`, source: "reply" })).toBe("See x^2: Table · z, .00, .05 · 8 rows");
    expect(quoteSummary("| a | b | c | d | e |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |", 80)).toBe("Table · a, b, c, … · 1 row");
  });
  it("plain prose reads as before", () => {
    expect(heldLabel({ text: "the  passage\nhe highlighted", role: "assistant", ordinal: 1 })).toBe("the passage he highlighted");
  });
});

describe("item 814: a paste never adds the About chip", () => {
  const quote = { text: MD, role: "assistant" as const, ordinal: 2 };
  beforeEach(() => {
    heldPassage.value = null;
  });
  it("a click into the box holds the passage but shows no chip until he writes", () => {
    holdPassage("chat", quote, null);
    expect(heldChip(heldFor("chat"), "")).toBeNull();
    expect(heldChip(heldFor("chat"), "  \n")).toBeNull();
    expect(heldChip(heldFor("chat"), "why is this")?.quote.text).toBe(MD);
  });
  it("a paste drops the held passage, so the pasted table stands alone", () => {
    holdPassage("chat", quote, null);
    dropHeldOnPaste("chat");
    expect(heldFor("chat")).toBeNull();
    expect(heldChip(heldFor("chat"), MD)).toBeNull();
  });
  it("the composer: its paste drops the passage, its chip is the written-in one", () => {
    const paste = composerSrc.slice(composerSrc.indexOf("function onpaste(e: ClipboardEvent)"));
    expect(paste.slice(0, 400)).toContain("dropHeldOnPaste(key)");
    expect(composerSrc).toContain("{#if heldShown}");
    expect(composerSrc).not.toContain("{#if held}");
  });
});

describe("item 814: the table editor draws a maths cell as maths", () => {
  it("a cell with a formula renders it; a plain cell has no layer", () => {
    expect(cellMathHtml("$z$")).toContain('class="katex"');
    expect(cellMathHtml("$z$ <b>")).toContain("&lt;b&gt;");
    expect(cellMathHtml("0.0668")).toBeNull();
  });
});
