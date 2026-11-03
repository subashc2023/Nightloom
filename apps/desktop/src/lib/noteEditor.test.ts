import { describe, expect, it } from "vitest";
import { EditorSelection } from "@codemirror/state";
import { TableWidget, drawableImage, noteDecorations, noteState, tableWikilinks } from "./noteEditor";
import { Marked } from "marked";
import { clampCaret, loadNoteMode, minimalChange, parseNoteMode, saveNoteMode } from "./noteMode";
import { findMath } from "./math";

// The formatted note editor (nightshift backlog 150). The promise that
// matters is that it never changes his text: a note opened in formatted mode
// and saved without an edit is byte-identical, whichever way its lines end.

/** The repo's own Markdown — its reference docs and design notes — as text. */
const repoNotes = import.meta.glob(["../../../../docs/**/*.md", "../../../../.agents/**/*.md", "../../../../*.md"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** The text a round trip through the editor state gives back. */
function roundTrip(text: string, cursor = 0): string {
  const state = noteState(text, cursor);
  // A no-op edit, as focusing and clicking about would produce, and a
  // selection move: neither may touch the text.
  const moved = state.update({ selection: EditorSelection.cursor(Math.floor(text.length / 2)) }).state;
  return moved.doc.toString();
}

describe("the text survives the formatted editor byte for byte", () => {
  const files = Object.entries(repoNotes);

  it("finds the repo's own notes to test on", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("every Markdown file in the repo's docs round-trips", () => {
    for (const [f, text] of files) expect(roundTrip(text), f).toBe(text);
  });

  it("keeps CRLF, a lone CR, a trailing newline, and none", () => {
    for (const text of ["a\r\nb\r\n", "a\rb", "one\n", "none", "", "\n\n\n", "mixed\r\nline\nends\r"]) {
      expect(roundTrip(text)).toBe(text);
    }
  });

  it("keeps math, links and marks the decorations hide", () => {
    const text = "# Title ##\n\n*a* **b** ~~c~~ `d` [e](f) [[g|h]] $x^2$\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n- item\n\n---\n";
    expect(roundTrip(text, 3)).toBe(text);
  });

  it("an edit typed in formatted mode is the edit a textarea would make", () => {
    const text = "- one\n- two";
    const state = noteState(text, text.length);
    const typed = state.update(state.replaceSelection("\n")).state;
    // No list continuation: Enter types a newline and nothing more.
    expect(typed.doc.toString()).toBe("- one\n- two\n");
  });
});

describe("switching plain ↔ formatted keeps every character", () => {
  it("a text set from outside reaches the editor as the smallest edit", () => {
    const pairs: [string, string][] = [
      ["hello world", "hello brave world"],
      ["abc", ""],
      ["", "abc"],
      ["same", "same"],
      ["aaa", "aa"],
      ["x\r\ny", "x\r\nz"],
    ];
    for (const [a, b] of pairs) {
      const state = noteState(a, 0);
      const change = minimalChange(a, b);
      const next = change ? state.update({ changes: change }).state : state;
      expect(next.doc.toString()).toBe(b);
    }
  });

  it("the smallest edit leaves the common prefix and suffix alone", () => {
    expect(minimalChange("hello world", "hello brave world")).toEqual({ from: 6, to: 6, insert: "brave " });
    expect(minimalChange("same", "same")).toBeNull();
  });

  it("a caret carried across is kept inside the text", () => {
    expect(clampCaret(5, "abc")).toBe(3);
    expect(clampCaret(-1, "abc")).toBe(0);
    expect(clampCaret(Number.NaN, "abc")).toBe(0);
    expect(clampCaret(2, "abc")).toBe(2);
  });

  it("the mode is one remembered setting, plain until picked", () => {
    expect(parseNoteMode(null)).toBe("plain");
    expect(parseNoteMode("junk")).toBe("plain");
    expect(loadNoteMode()).toBe("plain");
    saveNoteMode("formatted");
    expect(loadNoteMode()).toBe("formatted");
    saveNoteMode("plain");
    expect(loadNoteMode()).toBe("plain");
  });
});

/** The decorations as `[from, to, kind]`, kind the widget's class or "hide". */
function decorations(text: string, cursor: number) {
  const set = noteDecorations(noteState(text, cursor));
  const out: { from: number; to: number; widget: string | null; cls: string | null }[] = [];
  set.between(0, text.length, (from, to, d) => {
    const spec = d.spec as { widget?: { constructor: { name: string }; tex?: string }; class?: string };
    out.push({
      from,
      to,
      widget: spec.widget ? (spec.widget.tex ?? spec.widget.constructor.name) : null,
      cls: spec.class ?? null,
    });
  });
  return out;
}

describe("math is found and drawn off the cursor", () => {
  it("finds inline and display formulas in the preview's spellings", () => {
    const text = "Energy $E=mc^2$ and \\(a+b\\).\n\n$$\n\\sum_i x_i\n$$\n\nprice $5 and $10.";
    const spans = findMath(text);
    expect(spans.map((m) => m.tex)).toEqual(["E=mc^2", "a+b", "\n\\sum_i x_i\n"]);
    expect(spans[2].block).toBe(true);
    expect(text.slice(spans[0].from, spans[0].to)).toBe("$E=mc^2$");
  });

  it("an escaped dollar opens nothing", () => {
    expect(findMath("costs \\$5 and $x$")).toHaveLength(1);
  });

  it("a formula becomes a widget while the cursor is elsewhere", () => {
    const text = "Energy $E=mc^2$ here.";
    const widgets = decorations(text, 0).filter((d) => d.widget === "E=mc^2");
    expect(widgets).toEqual([{ from: 7, to: 15, widget: "E=mc^2", cls: null }]);
  });

  it("and shows its source when the cursor is in it", () => {
    const text = "Energy $E=mc^2$ here.";
    expect(decorations(text, 10).filter((d) => d.widget === "E=mc^2")).toEqual([]);
  });

  it("a display block is one widget over its lines", () => {
    const text = "Before.\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nAfter.";
    const w = decorations(text, 0).filter((d) => d.widget?.includes("\\int"));
    expect(w).toHaveLength(1);
    expect(text.slice(w[0].from, w[0].to)).toBe("$$\n\\int_0^1 x\\,dx\n$$");
    // On the block's lines, the source.
    expect(decorations(text, text.indexOf("\\int")).filter((d) => d.widget?.includes("\\int"))).toEqual([]);
  });

  it("a ```math fence is typeset too", () => {
    const text = "x\n\n```math\na^2+b^2\n```\n";
    expect(decorations(text, 0).some((d) => d.widget?.trim() === "a^2+b^2")).toBe(true);
  });

  it("no formula inside code", () => {
    const text = "Use `$PATH$` and\n\n```\n$x$\n```\n";
    expect(decorations(text, 0).filter((d) => d.widget && d.widget !== "BulletWidget")).toEqual([]);
  });

  it("emphasis inside a formula is the formula's", () => {
    const text = "see $a*b*c$ now";
    const d = decorations(text, 0);
    expect(d.some((x) => x.cls === "cm-nem")).toBe(false);
    expect(d.some((x) => x.widget === "a*b*c")).toBe(true);
  });
});

describe("Markdown marks hide off the cursor and come back on it", () => {
  it("a heading's #s hide off its line", () => {
    const text = "# Title\n\nbody";
    const off = decorations(text, text.length);
    expect(off.some((d) => d.cls === "cm-nh cm-nh1")).toBe(true);
    expect(off.some((d) => d.from === 0 && d.to === 2 && d.widget === null && d.cls === null)).toBe(true);
    const on = decorations(text, 3);
    expect(on.some((d) => d.from === 0 && d.to === 2 && d.cls === null)).toBe(false);
  });

  it("bold's stars hide until the cursor touches it", () => {
    const text = "a **b** c";
    const hidden = (c: number) => decorations(text, c).filter((d) => d.cls === null && d.widget === null);
    expect(hidden(0).map((d) => [d.from, d.to])).toEqual([
      [2, 4],
      [5, 7],
    ]);
    expect(hidden(5)).toEqual([]);
  });

  it("a [[link]] is drawn as one and names its target", () => {
    const text = "see [[Plan|the plan]] here";
    const d = decorations(text, 0);
    expect(d.some((x) => x.cls === "cm-nwikilink")).toBe(true);
  });
});

describe("item 494: what the preview renders, Formatted draws", () => {
  const table = "| Option | Cost |\n|:--|--:|\n| **A** | $5 |\n| B with [[Plan|the plan]] | `x` $y^2$ |";
  const doc = `Intro.\n\n${table}\n\nAfter.`;
  const start = doc.indexOf("| Option");

  it("a GFM table is one widget over its lines while the cursor is elsewhere", () => {
    const w = decorations(doc, 0).filter((d) => d.widget === "TableWidget");
    expect(w).toHaveLength(1);
    expect(doc.slice(w[0].from, w[0].to)).toBe(table);
    // Nothing inside it is drawn a second time: no formula, no [[link]] over the widget.
    const inside = decorations(doc, 0).filter((d) => d.from > w[0].from && d.to <= w[0].to);
    expect(inside).toEqual([]);
  });

  it("the cursor in the table brings the source back, in mono", () => {
    const d = decorations(doc, start + 3);
    expect(d.some((x) => x.widget === "TableWidget")).toBe(false);
    expect(d.filter((x) => x.cls === "cm-ntablesrc")).toHaveLength(4);
  });

  it("the widget renders the preview's table, cells and all", () => {
    const set = noteDecorations(noteState(doc, 0));
    let w: TableWidget | null = null;
    set.between(0, doc.length, (_f, _t, d) => {
      const spec = d.spec as { widget?: unknown };
      if (spec.widget instanceof TableWidget) w = spec.widget;
    });
    expect(w).not.toBeNull();
    const tw = w as unknown as TableWidget;
    // Header row, then two body rows, each cell's start relative to the table.
    expect(tw.cells.length).toBe(3);
    expect(table.slice(tw.cells[1][0], tw.cells[1][0] + 5)).toBe("**A**");
    // The widget draws this through `renderMarkdown` (marked + DOMPurify, the
    // preview's own path; DOMPurify needs a DOM, so the harness checks the
    // drawn table). Here: marked turns the source into a table with its cells.
    const src = tableWikilinks(tw.source);
    expect(src).toContain('<span class="cm-nwikilink">the plan</span>');
    const html = new Marked({ gfm: true }).parse(src, { async: false }) as string;
    expect(html).toContain("<table>");
    expect(html).toContain("<th");
    expect(html).toContain("<strong>A</strong>");
    expect(html).not.toContain("|---");
  });

  it("a task list's [ ] and [x] are boxes off the cursor's line", () => {
    const text = "- [ ] todo\n- [x] done\n\nend";
    const off = decorations(text, text.length).filter((d) => d.widget === "TaskWidget");
    expect(off.map((d) => text.slice(d.from, d.to))).toEqual(["[ ]", "[x]"]);
    expect(decorations(text, 3).filter((d) => d.widget === "TaskWidget")).toHaveLength(1);
  });

  it("an image is drawn off the cursor, a javascript: one never", () => {
    const text = "see ![a cat](https://x.y/cat.png) and ![bad](javascript:alert(1))\n\nend";
    const w = decorations(text, text.length).filter((d) => d.widget === "ImageWidget");
    expect(w.map((d) => text.slice(d.from, d.to))).toEqual(["![a cat](https://x.y/cat.png)"]);
    expect(decorations(text, 6).filter((d) => d.widget === "ImageWidget")).toEqual([]);
    expect(drawableImage("pics/a.png")).toBe(true);
    expect(drawableImage("data:text/html,x")).toBe(false);
  });

  it("autolinks and bare URLs are drawn as links", () => {
    const text = "<https://a.b> and https://c.d\n\nend";
    const links = decorations(text, text.length).filter((d) => d.cls === "cm-nlink");
    expect(links.map((d) => text.slice(d.from, d.to))).toEqual(["https://a.b", "https://c.d"]);
  });

  it("every new construct still round-trips byte for byte", () => {
    const text = `${doc}\n\n- [ ] t\n\n![i](p.png) <https://a.b>\n`;
    for (const c of [0, start + 3, text.length]) expect(roundTrip(text, c)).toBe(text);
  });
});
