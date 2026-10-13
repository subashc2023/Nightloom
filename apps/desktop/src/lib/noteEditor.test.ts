import { describe, expect, it } from "vitest";
import { EditorSelection } from "@codemirror/state";
import { noteDecorations, noteState } from "./noteEditor";
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
