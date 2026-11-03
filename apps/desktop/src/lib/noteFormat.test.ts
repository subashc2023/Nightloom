import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { history, undo, undoDepth } from "@codemirror/commands";
import {
  TABLE_3X3,
  attachmentsFolder,
  blockStyleAt,
  codeAction,
  imageAlt,
  imageNoteName,
  insertDivider,
  insertFormula,
  insertImage,
  insertLink,
  insertTable,
  insertWikilink,
  leadingBlockMark,
  linkPath,
  relativeToNote,
  setBlockStyle,
  toggleChecklist,
  toggleInline,
  toggleTaskAt,
  type Command,
} from "./noteFormat";
import { ensureSyntaxTree } from "@codemirror/language";
import { isMarkdown, noteState, setMarkdown } from "./noteEditor";
import { NOTE_MARKDOWN_KEY, loadNoteMarkdown, saveNoteMarkdown } from "./noteMode";

// Item 498: the note toolbar's actions. Each writes ordinary Markdown at the
// selection as one transaction; the text is read back after.

/** `|` marks the caret, `[`…`]`-free text: `«` and `»` mark a selection. */
function at(src: string): EditorState {
  const a = src.indexOf("«");
  if (a >= 0) {
    const b = src.indexOf("»") - 1;
    const text = src.replace("«", "").replace("»", "");
    return EditorState.create({ doc: text, selection: EditorSelection.range(a, b), extensions: [history()] });
  }
  const c = src.indexOf("|");
  const text = src.replace("|", "");
  return EditorState.create({ doc: text, selection: EditorSelection.cursor(c < 0 ? 0 : c), extensions: [history()] });
}

/** Apply and show the result with the selection marked the same way. */
function apply(cmd: Command, src: string): string {
  const s = at(src);
  const spec = cmd(s);
  if (!spec) return "(nothing)";
  return show(s.update(spec).state);
}
function show(s: EditorState): string {
  const r = s.selection.main;
  const t = s.doc.toString();
  if (r.empty) return t.slice(0, r.head) + "|" + t.slice(r.head);
  return t.slice(0, r.from) + "«" + t.slice(r.from, r.to) + "»" + t.slice(r.to);
}

describe("text style: headings, quote, normal", () => {
  it("makes a line a heading, at any level, and back", () => {
    expect(apply(setBlockStyle("h1"), "Ti|tle")).toBe("# Ti|tle");
    expect(apply(setBlockStyle("h2"), "# Ti|tle")).toBe("## Ti|tle");
    expect(apply(setBlockStyle("h3"), "## Ti|tle\nnext")).toBe("### Ti|tle\nnext");
    expect(apply(setBlockStyle("normal"), "### Ti|tle")).toBe("Ti|tle");
  });
  it("a heading on a blank line puts the caret after the #s", () => {
    expect(apply(setBlockStyle("h2"), "a\n|\nb")).toBe("a\n## |\nb");
  });
  it("quote toggles, line by line, skipping blank lines", () => {
    expect(apply(setBlockStyle("quote"), "«one\n\ntwo»")).toBe("> «one\n\n> two»");
    expect(apply(setBlockStyle("quote"), "«> one\n\n> two»")).toBe("«one\n\ntwo»");
  });
  it("a heading inside a quote stays in it; Normal takes the quote off", () => {
    expect(apply(setBlockStyle("h2"), "> ti|tle")).toBe("> ## ti|tle");
    expect(apply(setBlockStyle("normal"), "> ## ti|tle")).toBe("ti|tle");
  });
  it("already that style: nothing", () => {
    expect(apply(setBlockStyle("h1"), "# a|")).toBe("(nothing)");
  });
  it("reads the caret line's style for the menu's tick", () => {
    expect(blockStyleAt(at("## a|"))).toBe("h2");
    expect(blockStyleAt(at("> a|"))).toBe("quote");
    expect(blockStyleAt(at("#### a|"))).toBe("normal");
    expect(blockStyleAt(at("#hashtag|"))).toBe("normal");
  });
});

describe("text style: bold, italic, strikethrough", () => {
  it("wraps a selection and keeps it selected", () => {
    expect(apply(toggleInline("bold"), "a «word» b")).toBe("a **«word»** b");
    expect(apply(toggleInline("italic"), "a «word» b")).toBe("a *«word»* b");
    expect(apply(toggleInline("strike"), "a «word» b")).toBe("a ~~«word»~~ b");
  });
  it("unwraps when the marks are just outside or just inside", () => {
    expect(apply(toggleInline("bold"), "a **«word»** b")).toBe("a «word» b");
    expect(apply(toggleInline("bold"), "a «**word**» b")).toBe("a «word» b");
    expect(apply(toggleInline("italic"), "a *«word»* b")).toBe("a «word» b");
  });
  it("italic inside bold adds, not strips, its star", () => {
    expect(apply(toggleInline("italic"), "**«word»**")).toBe("***«word»***");
    expect(apply(toggleInline("italic"), "***«word»***")).toBe("**«word»**");
    expect(apply(toggleInline("bold"), "***«word»***")).toBe("*«word»*");
  });
  it("leaves whitespace at the ends outside the marks", () => {
    expect(apply(toggleInline("bold"), "a« word »b")).toBe("a **«word»** b");
  });
  it("marks each line of a multi-line selection after its list or heading mark", () => {
    const s = at("«- one\n## two»");
    const out = s.update(toggleInline("bold")(s)!).state.doc.toString();
    expect(out).toBe("- **one**\n## **two**");
  });
  it("an empty caret inserts the pair, caret between", () => {
    expect(apply(toggleInline("bold"), "a |b")).toBe("a **|**b");
  });
  it("leadingBlockMark finds what an inline mark goes after", () => {
    expect(leadingBlockMark("  - [ ] task")).toBe("  - [ ] ");
    expect(leadingBlockMark("> # t")).toBe("> # ");
    expect(leadingBlockMark("12. x")).toBe("12. ");
    expect(leadingBlockMark("plain")).toBe("");
  });
});

describe("code", () => {
  it("inline on a one-line selection, off again", () => {
    expect(apply(codeAction, "run «npm test» now")).toBe("run `«npm test»` now");
    expect(apply(codeAction, "run `«npm test»` now")).toBe("run «npm test» now");
    expect(apply(codeAction, "run «`npm`» now")).toBe("run «npm» now");
  });
  it("a selection holding a backtick gets a double fence", () => {
    expect(apply(codeAction, "«a`b»")).toBe("`` «a`b» ``");
  });
  it("a caret in text inserts an inline pair", () => {
    expect(apply(codeAction, "a |b")).toBe("a `|`b");
  });
  it("a caret on a blank line opens a fenced block, caret inside", () => {
    expect(apply(codeAction, "text\n|")).toBe("text\n\n```\n|\n```");
  });
  it("several lines are fenced whole", () => {
    expect(apply(codeAction, "«a = 1\nb = 2»")).toBe("```\n«a = 1\nb = 2»\n```");
  });
  it("a fence inside the lines gets a longer fence", () => {
    const s = at("«x\n```\ny»");
    expect(s.update(codeAction(s)!).state.doc.toString()).toBe("````\nx\n```\ny\n````");
  });
});

describe("blocks: table and divider on lines of their own", () => {
  it("a table after the caret's paragraph, blank line between, Column 1 selected", () => {
    const out = apply(insertTable, "para|");
    expect(out).toBe("para\n\n| «Column 1» | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |");
  });
  it("a table on a blank line between paragraphs keeps them apart", () => {
    const s = at("a\n|\nb");
    const t = s.update(insertTable(s)!).state.doc.toString();
    expect(t).toBe(`a\n\n${TABLE_3X3}\n\nb`);
  });
  it("the table parses as a table", () => {
    const s = at("|");
    const doc = s.update(insertTable(s)!).state.doc.toString() + "\n\nafter";
    const st = noteState(doc, doc.length);
    let table = false;
    ensureSyntaxTree(st, st.doc.length, 5000)!.iterate({
      enter: (n) => {
        if (n.name === "Table") table = true;
      },
    });
    expect(table).toBe(true);
  });
  it("a divider under a paragraph never turns it into a heading", () => {
    expect(apply(insertDivider, "para|\nnext")).toBe("para\n\n---|\n\nnext");
  });
});

describe("checklist", () => {
  it("turns lines into tasks, keeps a bullet or a number", () => {
    const s = at("«milk\n- eggs\n2. bread\n\n  tea»");
    expect(s.update(toggleChecklist(s)!).state.doc.toString()).toBe("- [ ] milk\n- [ ] eggs\n2. [ ] bread\n\n  - [ ] tea");
  });
  it("again takes the boxes off (bullets go too, numbers stay)", () => {
    const s = at("«- [ ] milk\n- [x] eggs\n2. [ ] bread»");
    expect(s.update(toggleChecklist(s)!).state.doc.toString()).toBe("milk\neggs\n2. bread");
  });
  it("a caret on a blank line starts an item", () => {
    expect(apply(toggleChecklist, "a\n|")).toBe("a\n- [ ] |");
  });
  it("a caret at a line's start moves with the inserted box", () => {
    expect(apply(toggleChecklist, "|milk")).toBe("- [ ] |milk");
  });
  it("a click on a drawn box ticks it, and again unticks it", () => {
    const s = at("- [ ] milk");
    const ticked = s.update(toggleTaskAt(s, 2)!).state;
    expect(ticked.doc.toString()).toBe("- [x] milk");
    expect(ticked.update(toggleTaskAt(ticked, 2)!).state.doc.toString()).toBe("- [ ] milk");
    expect(toggleTaskAt(s, 0)).toBeNull();
  });
});

describe("Insert +", () => {
  it("a link: the selection is its text, url selected to type over", () => {
    expect(apply(insertLink, "see «the docs»")).toBe("see [the docs](«url»)");
    expect(apply(insertLink, "|")).toBe("[«text»](url)");
    expect(apply(insertLink, "«https://x.io»")).toBe("[«text»](https://x.io)");
  });
  it("a note link and a formula wrap or place", () => {
    expect(apply(insertWikilink, "«Plan»")).toBe("[[«Plan»]]");
    expect(apply(insertWikilink, "|")).toBe("[[«note»]]");
    expect(apply(insertFormula, "«a^2»")).toBe("$«a^2»$");
    expect(apply(insertFormula, "|")).toBe("$«x»$");
  });
});

describe("image", () => {
  it("inserts the link at the caret, the path made safe", () => {
    expect(apply(insertImage("my shot", linkPath("attachments/my shot (2).png")), "a |b")).toBe(
      "a ![my shot](attachments/my%20shot%20%282%29.png)|b",
    );
  });
  it("attachments/ beside the note, and the link relative to it", () => {
    expect(attachmentsFolder("plan.md")).toBe("attachments");
    expect(attachmentsFolder("people/ann.md")).toBe("people/attachments");
    expect(relativeToNote("people/ann.md", "people/attachments/x.png")).toBe("attachments/x.png");
    expect(relativeToNote("plan.md", "attachments/x.png")).toBe("attachments/x.png");
  });
  it("resolves a relative link to the stored file's name, never out of the store", () => {
    expect(imageNoteName("people/ann.md", "attachments/my%20shot.png")).toBe("people/attachments/my shot.png");
    expect(imageNoteName("people/ann.md", "../pics/a.png")).toBe("pics/a.png");
    expect(imageNoteName("ann.md", "../a.png")).toBeNull();
    expect(imageNoteName("ann.md", "https://x/a.png")).toBeNull();
    expect(imageNoteName("ann.md", "/etc/a.png")).toBeNull();
  });
  it("alt text from the file name", () => {
    expect(imageAlt("Screen Shot [1].png")).toBe("Screen Shot  1");
    expect(imageAlt(".png")).toBe(".png");
  });
});

describe("every action is one undo step", () => {
  const cases: [string, Command, string][] = [
    ["heading", setBlockStyle("h1"), "a|"],
    ["bold", toggleInline("bold"), "«a»"],
    ["code", codeAction, "«a\nb»"],
    ["table", insertTable, "a|"],
    ["checklist", toggleChecklist, "«a\nb»"],
    ["link", insertLink, "«a»"],
    ["divider", insertDivider, "a|"],
    ["image", insertImage("x", "attachments/x.png"), "a|"],
  ];
  for (const [name, cmd, src] of cases) {
    it(name, () => {
      let s = at(src);
      // Typing first, then the action at once: still two separate steps.
      s = s.update({ changes: { from: 0, insert: "z" }, userEvent: "input.type" }).state;
      const before = s.doc.toString();
      const spec = cmd(s) as TransactionSpec;
      s = s.update(spec).state;
      expect(undoDepth(s)).toBe(2);
      let back = s;
      undo({ state: s, dispatch: (tr) => (back = tr.state) });
      expect(back.doc.toString()).toBe(before);
    });
  }
});

describe("the Markdown switch", () => {
  it("is one global setting under its own key, off at first", () => {
    localStorage.removeItem(NOTE_MARKDOWN_KEY);
    expect(loadNoteMarkdown()).toBe(false);
    saveNoteMarkdown(true);
    expect(loadNoteMarkdown()).toBe(true);
    saveNoteMarkdown(false);
    expect(loadNoteMarkdown()).toBe(false);
  });
  it("an old Plain pick does not carry over (blocker 1653)", () => {
    localStorage.removeItem(NOTE_MARKDOWN_KEY);
    localStorage.setItem("nightloom.noteMode", "plain");
    localStorage.setItem("nightloom.notePreview", "1");
    expect(loadNoteMarkdown()).toBe(false);
  });
  it("switches the drawing off and on in the same state, selection and history kept", () => {
    let s = noteState("# T\n\n**b** $x$", 6, [history()]);
    s = s.update({ changes: { from: 0, insert: "z" } }).state;
    expect(isMarkdown(s)).toBe(false);
    s = s.update({ effects: setMarkdown(true) }).state;
    expect(isMarkdown(s)).toBe(true);
    expect(s.selection.main.head).toBe(7);
    expect(undoDepth(s)).toBe(1);
    s = s.update({ effects: setMarkdown(false) }).state;
    expect(isMarkdown(s)).toBe(false);
    expect(s.doc.toString()).toBe("z# T\n\n**b** $x$");
  });
  it("opens in the Markdown view when asked", () => {
    expect(isMarkdown(noteState("a", 0, [], { markdown: true }))).toBe(true);
    expect(isMarkdown(noteState("a", 0))).toBe(false);
  });
});
