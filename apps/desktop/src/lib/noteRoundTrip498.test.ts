import { describe, expect, it } from "vitest";
import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { history } from "@codemirror/commands";
import { isMarkdown, noteDecorations, noteState, setMarkdown } from "./noteEditor";

// Item 498: the one note editor never changes the text by being opened,
// looked at, or switched between its formatted and Markdown views. Over
// every Markdown file in the repository (the docs, the agents' notes, the
// READMEs — node_modules and build output left out) and a few made to have
// tables, maths and CRLF line ends.

const repoNotes = import.meta.glob(
  [
    "../../../../**/*.md",
    "../../../../.agents/**/*.md",
    "!**/node_modules/**",
    "!**/target/**",
    "!**/dist/**",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const made: Record<string, string> = {
  "table + maths, LF": "# T\n\n| a | $x^2$ | [[n|alias]] |\n| --- | :-: | --: |\n| **b** | `c` | $$y$$ |\n\nText $\\alpha$ and\n\n$$\n\\int_0^1 f\n$$\n",
  "CRLF throughout": "# Title\r\n\r\n- [ ] one\r\n- [x] two\r\n\r\n| a | b |\r\n| - | - |\r\n| 1 | 2 |\r\n",
  "lone CR and mixed": "a\rb\r\n## h\nc\r",
  "no trailing newline, fences": "```math\nE=mc^2\n```\n\n~~~\ncode ``` inside\n~~~\n> quote\n> ![img](attachments/a%20b.png)",
  "setext and rules": "Title\n=====\n\npara\n\n---\n\n***\n\n* a\n+ b\n",
  empty: "",
};

/** Open, move about, switch to Markdown, move, switch back: the text read back. */
function openSwitchRead(text: string, startMarkdown = false): string {
  let s: EditorState = noteState(text, 0, [history()], { markdown: startMarkdown });
  const step = (spec: TransactionSpec) => {
    s = s.update(spec).state;
    // The drawing is computed for every state the editor shows.
    if (!isMarkdown(s)) noteDecorations(s);
  };
  const len = s.doc.length;
  step({ selection: EditorSelection.cursor(Math.floor(len / 3)) });
  step({ effects: setMarkdown(!startMarkdown) });
  step({ selection: EditorSelection.cursor(Math.floor((2 * len) / 3)) });
  step({ effects: setMarkdown(startMarkdown) });
  step({ selection: EditorSelection.range(0, len) });
  step({ effects: setMarkdown(!startMarkdown) });
  return s.doc.toString();
}

describe("open + switch views + read back = identical bytes", () => {
  const files = Object.entries(repoNotes);

  it("finds the repository's Markdown to test on", () => {
    // 27 at f7438bb (find, node_modules/target/dist left out).
    expect(files.length).toBeGreaterThanOrEqual(25);
  });

  it("every .md in the repository round-trips, from either view", () => {
    for (const [f, text] of files) {
      expect(openSwitchRead(text), f).toBe(text);
      expect(openSwitchRead(text, true), f).toBe(text);
    }
  });

  it("the made cases (tables, maths, CRLF, CR, fences) round-trip", () => {
    for (const [name, text] of Object.entries(made)) {
      expect(openSwitchRead(text), name).toBe(text);
      expect(openSwitchRead(text, true), name).toBe(text);
    }
  });
});
