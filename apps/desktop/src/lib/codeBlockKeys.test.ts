// Item 648: the code-editor keys inside a ``` block in a message box.
import { describe, expect, it } from "vitest";
import type { EditorView } from "@codemirror/view";
import { undo, undoDepth } from "@codemirror/commands";
import { BoxHistory } from "./boxHistory";
import { applyBlockEdit, applyToField, blockAt, codeBlockEdit, fencesOf, indentUnit, scanTo, takeBlockKey, type BlockKey } from "./codeBlockKeys";
import { findFences } from "./codeDetect";
import { composerKeymap, composerState, LiveBoxHandle } from "./composerEditor";

/** `src` with the caret as `|`, or a selection as `[` … `]`. */
function parse(src: string): { text: string; start: number; end: number } {
  const c = src.indexOf("|");
  if (c >= 0) return { text: src.slice(0, c) + src.slice(c + 1), start: c, end: c };
  const a = src.indexOf("[");
  const b = src.indexOf("]", a) - 1;
  return { text: src.slice(0, a) + src.slice(a + 1, b + 1) + src.slice(b + 2), start: a, end: b };
}

function show(text: string, a: number, b: number): string {
  if (a === b) return text.slice(0, a) + "|" + text.slice(a);
  const [s, e] = [Math.min(a, b), Math.max(a, b)];
  return text.slice(0, s) + "[" + text.slice(s, e) + "]" + text.slice(e);
}

/** The box after `key` in `src`, or null when the key is not taken. */
function press(src: string, key: string | BlockKey): string | null {
  const { text, start, end } = parse(src);
  const e = typeof key === "string" ? { key } : key;
  const ed = codeBlockEdit(text, start, end, e);
  if (!ed) return null;
  return show(applyBlockEdit(text, ed), ed.anchor, ed.head);
}

describe("inside a block or not (648)", () => {
  it("a closed block's body is inside; before the opening and after the closing fence is not", () => {
    const t = "hi\n```js\nlet a\n```\nbye";
    expect(blockAt(t, 1)).toBeNull();
    expect(blockAt(t, t.indexOf("let") + 2)).not.toBeNull();
    expect(blockAt(t, t.lastIndexOf("```") + 3)).toBeNull();
    expect(blockAt(t, t.length)).toBeNull();
  });
  it("an unclosed block runs to the end of the box", () => {
    const t = "```py\ndef f():\n  pass\n\nmore";
    expect(blockAt(t, t.length)).not.toBeNull();
  });
  it("the end of the opening fence line counts for Enter, not for Tab or brackets", () => {
    const t = "```py";
    expect(blockAt(t, t.length)).not.toBeNull();
    expect(blockAt(t, t.length, true)).toBeNull();
    expect(blockAt(t, 1)).toBeNull();
  });
  it("a fence quoted in prose mid-line is no block", () => {
    expect(blockAt("use ``` to start code", 10)).toBeNull();
  });
});

describe("the fence rule matches codeDetect's (648)", () => {
  it("same blocks as findFences on closed, unclosed, tilde, indented and nested-length fences", () => {
    const cases = [
      "",
      "plain",
      "```\nx\n```",
      "a\n```js\nlet a\n```\nb\n```\nopen",
      "~~~\nx\n```\nstill in\n~~~",
      "   ```\n  x\n   ```",
      "````\n```\ninner\n````",
      "```py",
      "```\n```",
    ];
    for (const t of cases) {
      const want = findFences(t).map((f) => ({ open: f.open, close: f.close, start: f.start, bodyFrom: f.bodyFrom, bodyTo: f.bodyTo }));
      expect(fencesOf(t)).toEqual(want);
    }
  });
});

describe("Enter inside a block (648)", () => {
  it("outside any block, Enter is not taken (the box sends as before)", () => {
    expect(press("hello|", "Enter")).toBeNull();
    expect(press("```\nx\n```\nafter|", "Enter")).toBeNull();
  });
  it("right after the closing fence, Enter sends as before", () => {
    expect(press("```\nx\n```|", "Enter")).toBeNull();
  });
  it("⌘Enter and Ctrl+Enter are never taken: they send from inside a block", () => {
    expect(press("```\nlet a|\n```", { key: "Enter", metaKey: true })).toBeNull();
    expect(press("```\nlet a|\n```", { key: "Enter", ctrlKey: true })).toBeNull();
    expect(press("```\nlet a|", { key: "Enter", metaKey: true })).toBeNull();
  });
  it("keeps the line's indentation (closed fence)", () => {
    expect(press("```\n    let a = 1|\n```", "Enter")).toBe("```\n    let a = 1\n    |\n```");
  });
  it("keeps the line's indentation (unclosed fence)", () => {
    expect(press("```py\n  x = 1|", "Enter")).toBe("```py\n  x = 1\n  |");
  });
  it("keeps tabs as typed", () => {
    expect(press("```\n\t\tx|\n```", "Enter")).toBe("```\n\t\tx\n\t\t|\n```");
  });
  it("Shift+Enter inside a block does the same", () => {
    expect(press("```\n  a|\n```", { key: "Enter", shiftKey: true })).toBe("```\n  a\n  |\n```");
  });
  it("on the opening fence line's end: a new line, never a send", () => {
    expect(press("```|\n```", "Enter")).toBe("```\n|\n```");
  });
  it("one step more after a line ending in { ( [ or :", () => {
    expect(press("```\nfunction f() {|", "Enter")).toBe("```\nfunction f() {\n    |");
    expect(press("```\n  call(|", "Enter")).toBe("```\n  call(\n      |");
    expect(press("```\nxs = [|", "Enter")).toBe("```\nxs = [\n    |");
    expect(press("```py\ndef f():|", "Enter")).toBe("```py\ndef f():\n    |");
    expect(press("```py\nif x:  |", "Enter")).toBe("```py\nif x:  \n    |");
  });
  it("nested indentation: the step is the block's own (two spaces here)", () => {
    const src = "```js\nif (a) {\n  if (b) {|\n```";
    expect(press(src, "Enter")).toBe("```js\nif (a) {\n  if (b) {\n    |\n```");
  });
  it("Enter between a pair makes two lines: caret one step in, closer at the original indent", () => {
    expect(press("```\n  f() {|}\n```", "Enter")).toBe("```\n  f() {\n      |\n  }\n```");
    expect(press("```\ng(|)", "Enter")).toBe("```\ng(\n    |\n)");
    expect(press("```\n\tx = [|]", "Enter")).toBe("```\n\tx = [\n\t\t|\n\t]");
  });
  it("a selection inside the block is replaced by the new line", () => {
    expect(press("```\n  a[bc]\n```", "Enter")).toBe("```\n  a\n  |\n```");
  });
  it("a selection running out of the block is not taken", () => {
    expect(press("[a\n```\nb]\n```", "Enter")).toBeNull();
  });
  it("Alt+Enter is not taken", () => {
    expect(press("```\na|", { key: "Enter", altKey: true })).toBeNull();
  });
});

describe("indent step (648)", () => {
  it("a tab if a line starts with one, else the smallest space run, else four", () => {
    const f = (t: string) => indentUnit(t, blockAt(t, t.length)!);
    expect(f("```\n\tx\n")).toBe("\t");
    expect(f("```\nif a:\n  b\n    c\n")).toBe("  ");
    expect(f("```\nx\n")).toBe("    ");
  });
});

describe("Tab and Shift+Tab inside a block (648)", () => {
  it("Tab at a caret inserts one step", () => {
    expect(press("```\nx|\n```", "Tab")).toBe("```\nx    |\n```");
    expect(press("```\n  a\n|", "Tab")).toBe("```\n  a\n    |");
  });
  it("Tab outside a block is not taken (focus moves as before)", () => {
    expect(press("hello|", "Tab")).toBeNull();
    expect(press("```py|", "Tab")).toBeNull();
  });
  it("Tab with a selection indents every selected line, the selection kept on them", () => {
    expect(press("```\n[a\nb]\n```", "Tab")).toBe("```\n[    a\n    b]\n```");
    expect(press("```\n  a\n  [b\n  c]\n```", "Tab")).toBe("```\n  a\n      [b\n      c]\n```");
  });
  it("a selection ending at a line's start does not take that line", () => {
    expect(press("```\n[a\n]b\n```", "Tab")).toBe("```\n[    a\n]b\n```");
  });
  it("blank lines inside a multi-line selection stay blank", () => {
    expect(press("```\n[a\n\nb]\n```", "Tab")).toBe("```\n[    a\n\n    b]\n```");
  });
  it("Shift+Tab outdents the caret's line by one step", () => {
    expect(press("```\n    x|\n```", { key: "Tab", shiftKey: true })).toBe("```\nx|\n```");
    expect(press("```\n\t\tx|\n```", { key: "Tab", shiftKey: true })).toBe("```\n\tx|\n```");
    expect(press("```\n  |x\n```", { key: "Tab", shiftKey: true })).toBe("```\n|x\n```");
  });
  it("Shift+Tab outdents every selected line, as far as each goes", () => {
    expect(press("```\n[    a\n  b\nc]\n```", { key: "Tab", shiftKey: true })).toBe("```\n[a\nb\nc]\n```");
  });
  it("Shift+Tab on a line with no indent is taken but changes nothing", () => {
    expect(press("```\nx|\n```", { key: "Tab", shiftKey: true })).toBe("```\nx|\n```");
  });
  it("⌘Tab, Ctrl+Tab and Alt+Tab are not taken", () => {
    expect(press("```\nx|", { key: "Tab", metaKey: true })).toBeNull();
    expect(press("```\nx|", { key: "Tab", ctrlKey: true })).toBeNull();
    expect(press("```\nx|", { key: "Tab", altKey: true })).toBeNull();
  });
});

describe("brackets inside a block (648, blocker 1928)", () => {
  it("( [ { insert their closer, the caret between", () => {
    expect(press("```\nf|\n```", "(")).toBe("```\nf(|)\n```");
    expect(press("```\nx = |", "[")).toBe("```\nx = [|]");
    expect(press("```\nif a |", "{")).toBe("```\nif a {|}");
  });
  it("before a word an opener is just itself (not taken)", () => {
    expect(press("```\n|foo", "(")).toBeNull();
  });
  it("before a closer it still closes (nested pairs)", () => {
    expect(press("```\nf(|)", "[")).toBe("```\nf([|])");
  });
  it("typing the closer that is already next steps over it", () => {
    expect(press("```\nf(|)", ")")).toBe("```\nf()|");
    expect(press("```\n[|]", "]")).toBe("```\n[]|");
    expect(press("```\n{|}", "}")).toBe("```\n{}|");
  });
  it("a closer with no closer next types as usual", () => {
    expect(press("```\nf(a|", ")")).toBeNull();
  });
  it("Backspace between an empty pair deletes both", () => {
    expect(press("```\nf(|)", "Backspace")).toBe("```\nf|");
    expect(press("```\n{|}\n```", "Backspace")).toBe("```\n|\n```");
  });
  it("Backspace elsewhere is not taken", () => {
    expect(press("```\nf(a|)", "Backspace")).toBeNull();
    expect(press("```\nf[)|", "Backspace")).toBeNull();
    expect(press("```\n[a(]\n```", "Backspace")).toBeNull();
  });
  it("an opener with a selection wraps it, the selection kept inside", () => {
    expect(press("```\nx = [a + b]\n```", "(")).toBe("```\nx = ([a + b])\n```");
    expect(press("```\n[k]", "{")).toBe("```\n{[k]}");
  });
  it("outside a block nothing changes: no auto-close, no step-over, no paired Backspace", () => {
    expect(press("call f|", "(")).toBeNull();
    expect(press("f(|)", ")")).toBeNull();
    expect(press("f(|)", "Backspace")).toBeNull();
    expect(press("```\nx\n```\nf(|)", ")")).toBeNull();
  });
  it("on the opening fence line brackets are not taken (```{r} stays as typed)", () => {
    expect(press("```|", "{")).toBeNull();
  });
  it("⌘( and Ctrl+( are not taken; ⌥ is (layouts type { with ⌥)", () => {
    expect(press("```\nx |", { key: "(", metaKey: true })).toBeNull();
    expect(press("```\nx |", { key: "(", ctrlKey: true })).toBeNull();
    expect(press("```\nx |", { key: "{", altKey: true })).toBe("```\nx {|}");
  });
});

describe("quotes inside a block (648, blocker 1928: \"unless you're in a comment they should close tho\")", () => {
  it('" \' ` close themselves in code', () => {
    expect(press("```\nx = |", '"')).toBe('```\nx = "|"');
    expect(press("```\nx = |", "'")).toBe("```\nx = '|'");
    expect(press("```js\nx = |", "`")).toBe("```js\nx = `|`");
    expect(press("```\nf(|)", '"')).toBe('```\nf("|")');
  });
  it("' right after a letter or digit is an apostrophe, not a pair", () => {
    expect(press("```\nprint(\"don|", "'")).toBeNull();
    expect(press("```\nx = it|", "'")).toBeNull();
    expect(press("```\nn = 3|", "'")).toBeNull();
    expect(press("```\nx = é|", "'")).toBeNull();
  });
  it('" after a letter still closes (f"…", r"…")', () => {
    expect(press("```py\ns = f|", '"')).toBe('```py\ns = f"|"');
  });
  it("in a // or # line comment, or inside /* … */, a quote is just itself", () => {
    expect(press("```\nx = 1 // it|", "'")).toBeNull();
    expect(press("```\nx = 1 // see |", '"')).toBeNull();
    expect(press("```py\n# say |", '"')).toBeNull();
    expect(press("```py\nx = 1  # say |", '"')).toBeNull();
    expect(press("```\n/* a\n  b |", "'")).toBeNull();
    expect(press("```\n/* a */ x = |", "'")).toBe("```\n/* a */ x = '|'");
  });
  it("the next line after a line comment is code again", () => {
    expect(press("```py\n# note\nx = |", '"')).toBe('```py\n# note\nx = "|"');
  });
  it("a # or // inside a string is not a comment", () => {
    expect(scanTo('x = "#fff" + ', 0, 13)).toBe("code");
    expect(press('```\nc = "#fff"; d = |', "'")).toBe('```\nc = "#fff"; d = \'|\'');
    expect(press('```\nu = "http://a"; v = |', '"')).toBe('```\nu = "http://a"; v = "|"');
  });
  it("# after a letter is not a comment (a#b, C# in prose)", () => {
    expect(scanTo("a#b ", 0, 4)).toBe("code");
  });
  it("typing the quote that ends the string steps over it", () => {
    expect(press('```\nx = "|"', '"')).toBe('```\nx = ""|');
    expect(press("```\nx = 'ab|'", "'")).toBe("```\nx = 'ab'|");
    expect(press("```\nx = `|`", "`")).toBe("```\nx = ``|");
  });
  it("a quote in front of the next string is typed, not stepped over", () => {
    expect(press('```\nx = |"abc"', '"')).toBeNull();
  });
  it("inside a string, another kind of quote is just itself", () => {
    expect(press('```\nx = "it|"', "'")).toBeNull();
    expect(press('```\nx = "a |"', "'")).toBeNull();
  });
  it("a selection is wrapped", () => {
    expect(press("```\nx = [abc]", '"')).toBe('```\nx = "[abc]"');
    expect(press("```\nx = [abc]", "`")).toBe("```\nx = `[abc]`");
  });
  it("Backspace between an empty quote pair deletes both; in a comment it does not", () => {
    expect(press('```\nx = "|"', "Backspace")).toBe("```\nx = |");
    expect(press("```\nx = '|'", "Backspace")).toBe("```\nx = |");
    expect(press("```\n// a ''|'", "Backspace")).toBeNull();
    expect(press("```\n// say \"|\"", "Backspace")).toBeNull();
  });
  it("backticks on a line of their own are a fence being typed, never paired", () => {
    expect(press("```\nx\n|", "`")).toBeNull();
    expect(press("```\nx\n``|", "`")).toBeNull();
  });
  it("outside a block quotes are untouched", () => {
    expect(press('say |', '"')).toBeNull();
    expect(press("```\nx\n```\nsay |", "'")).toBeNull();
    expect(press('a "|"', "Backspace")).toBeNull();
  });
  it("on the opening fence line a quote is just itself", () => {
    expect(press("```|", "'")).toBeNull();
  });
});

describe("Backspace in a line's leading whitespace inside a block (653)", () => {
  const sp = (n: number) => " ".repeat(n);
  it("deletes back to the previous indent stop of a four-space step: 8 → 4, 6 → 4, 3 → 0, 4 → 0", () => {
    expect(press("```\n" + sp(8) + "|", "Backspace")).toBe("```\n" + sp(4) + "|");
    expect(press("```\n" + sp(6) + "|\n```", "Backspace")).toBe("```\n" + sp(4) + "|\n```");
    expect(press("```\n" + sp(3) + "|", "Backspace")).toBe("```\n|");
    expect(press("```\n" + sp(4) + "|", "Backspace")).toBe("```\n|");
    expect(press("```\n" + sp(1) + "|", "Backspace")).toBe("```\n|");
  });
  it("with code after the caret too", () => {
    const head = "```py\nif x:\n" + sp(4) + "if y:\n";
    expect(press(head + sp(8) + "|z = 1", "Backspace")).toBe(head + sp(4) + "|z = 1");
  });
  it("uses the block's own step (two spaces in a block written with two)", () => {
    expect(press("```\na\n  b\n    c\n" + sp(4) + "|", "Backspace")).toBe("```\na\n  b\n    c\n" + sp(2) + "|");
    expect(press("```\na\n  b\n    c\n" + sp(3) + "|", "Backspace")).toBe("```\na\n  b\n    c\n" + sp(2) + "|");
  });
  it("a tab right before the caret deletes as one", () => {
    expect(press("```\n\t\t|", "Backspace")).toBe("```\n\t|");
    expect(press("```\n\t|x", "Backspace")).toBe("```\n|x");
    expect(press("```\n" + sp(2) + "\t|", "Backspace")).toBe("```\n" + sp(2) + "|");
  });
  it("spaces after a tab stop at the tab, never past it", () => {
    expect(press("```\n\t" + sp(6) + "|", "Backspace")).toBe("```\n\t" + sp(4) + "|");
    expect(press("```\n\t" + sp(2) + "|", "Backspace")).toBe("```\n\t|");
  });
  it("unchanged: mid-line, column 0, a selection, the fence lines, outside a block, modified or composing keys", () => {
    expect(press("```\nx" + sp(4) + "|", "Backspace")).toBeNull();
    expect(press("```\n" + sp(4) + "x|", "Backspace")).toBeNull();
    expect(press("```\na\n|" + sp(4) + "b", "Backspace")).toBeNull();
    expect(press("```\n[" + sp(8) + "]", "Backspace")).toBeNull();
    expect(press("```\n" + sp(4) + "[" + sp(4) + "]", "Backspace")).toBeNull();
    expect(press(sp(2) + "```|\nx", "Backspace")).toBeNull();
    expect(press("```\nx\n" + sp(2) + "|```", "Backspace")).toBeNull();
    expect(press(sp(8) + "|", "Backspace")).toBeNull();
    expect(press("```\nx\n```\n" + sp(8) + "|", "Backspace")).toBeNull();
    expect(press("```\n" + sp(8) + "|", { key: "Backspace", altKey: true })).toBeNull();
    expect(press("```\n" + sp(8) + "|", { key: "Backspace", metaKey: true })).toBeNull();
    expect(press("```\n" + sp(8) + "|", { key: "Backspace", keyCode: 229 })).toBeNull();
  });
  it("648's paired delete still wins after leading whitespace", () => {
    expect(press("```\n" + sp(4) + "(|)", "Backspace")).toBe("```\n" + sp(4) + "|");
    expect(press("```\n" + sp(4) + '"|"', "Backspace")).toBe("```\n" + sp(4) + "|");
  });
});

describe("Right arrow at the end of a closing fence (648)", () => {
  it("the fence ends the text: a new line is added and the caret goes onto it", () => {
    expect(press("```\nx\n```|", "ArrowRight")).toBe("```\nx\n```\n|");
    expect(press("hi\n```py\nx = 1\n```|", "ArrowRight")).toBe("hi\n```py\nx = 1\n```\n|");
  });
  it("text follows the fence: the caret goes to the next line's start, nothing added", () => {
    expect(press("```\nx\n```|\nbye", "ArrowRight")).toBe("```\nx\n```\n|bye");
  });
  it("an unclosed block mid-text: Right is the box's own", () => {
    expect(press("```\nx|y", "ArrowRight")).toBeNull();
    expect(press("```\nx|\ny", "ArrowRight")).toBeNull();
  });
  it("a selection, a modifier, or a caret not at the fence's end: not taken", () => {
    expect(press("```\nx\n[```]", "ArrowRight")).toBeNull();
    expect(press("```\nx\n```|", { key: "ArrowRight", shiftKey: true })).toBeNull();
    expect(press("```\nx\n```|", { key: "ArrowRight", metaKey: true })).toBeNull();
    expect(press("```\nx\n```|", { key: "ArrowRight", altKey: true })).toBeNull();
    expect(press("```\nx\n``|`", "ArrowRight")).toBeNull();
    expect(press("```\nx|\n```", "ArrowRight")).toBeNull();
    expect(press("plain|", "ArrowRight")).toBeNull();
  });
  it("the opening fence's end is not the end of a block", () => {
    expect(press("```|\nx\n```", "ArrowRight")).toBeNull();
  });
});

describe("input method composition is never touched (648, item 322)", () => {
  it("a key the input method holds is not taken, whatever it is", () => {
    for (const key of ["Enter", "Tab", "(", ")", "Backspace"]) {
      expect(press("```\nf(|)", { key, isComposing: true })).toBeNull();
      expect(press("```\nf(|)", { key, keyCode: 229 })).toBeNull();
    }
  });
});

/** A textarea's text, selection and events, without a DOM (the suite runs in node). */
class FakeField extends EventTarget {
  value = "";
  selectionStart = 0;
  selectionEnd = 0;
  direction = "none";
  disabled = false;
  readOnly = false;
  setSelectionRange(a: number, b: number, d = "none"): void {
    this.selectionStart = a;
    this.selectionEnd = b;
    this.direction = d;
  }
}

function key(k: string, mods: Partial<BlockKey> = {}) {
  return {
    key: k,
    ...mods,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

describe("applied to the boxes (648)", () => {
  it("a textarea gets the text and the selection", () => {
    const el = new FakeField();
    el.value = "```\n  a\n  b\n```";
    el.setSelectionRange(4, 11);
    const ed = codeBlockEdit(el.value, el.selectionStart, el.selectionEnd, { key: "Tab" })!;
    expect(applyToField(el, ed)).toBe("```\n      a\n      b\n```");
    expect(el.value).toBe("```\n      a\n      b\n```");
    expect([el.selectionStart, el.selectionEnd]).toEqual([4, 19]);
  });
  it("an input-event box (edit box, phone): the key taken, beforeinput then input sent", () => {
    const el = new FakeField();
    el.value = "```\n  if (a) {";
    el.setSelectionRange(el.value.length, el.value.length);
    const seen: string[] = [];
    el.addEventListener("beforeinput", () => seen.push("before:" + el.value));
    el.addEventListener("input", () => seen.push("input:" + el.value));
    const e = key("Enter");
    expect(takeBlockKey(e, el)).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    expect(seen).toEqual(["before:```\n  if (a) {", "input:```\n  if (a) {\n      "]);
    expect(el.selectionStart).toBe(el.value.length);
  });
  it("⌘Enter in a block and Enter outside one are left to the box (send)", () => {
    const el = new FakeField();
    el.value = "```\nx";
    el.setSelectionRange(5, 5);
    const cmd = key("Enter", { metaKey: true });
    expect(takeBlockKey(cmd, el)).toBe(false);
    expect(cmd.defaultPrevented).toBe(false);
    el.value = "plain";
    el.setSelectionRange(5, 5);
    const plain = key("Enter");
    expect(takeBlockKey(plain, el)).toBe(false);
    expect([el.value, plain.defaultPrevented]).toEqual(["plain", false]);
  });
  it("a composing Enter in a block is left to the input method", () => {
    const el = new FakeField();
    el.value = "```\nx";
    el.setSelectionRange(5, 5);
    const e = key("Enter", { keyCode: 229 });
    expect(takeBlockKey(e, el)).toBe(false);
    expect([el.value, e.defaultPrevented]).toEqual(["```\nx", false]);
  });
  it("a step over a closer moves the caret and sends no input", () => {
    const el = new FakeField();
    el.value = "```\nf()";
    el.setSelectionRange(6, 6);
    let inputs = 0;
    el.addEventListener("input", () => inputs++);
    expect(takeBlockKey(key(")"), el)).toBe(true);
    expect([el.selectionStart, inputs]).toEqual([7, 0]);
  });
  it("the formatted box takes the edit as typing, one undo step per key", () => {
    let state = composerState("```\n  f() {", [composerKeymap()]);
    const view = {
      get state() {
        return state;
      },
      dispatch(spec: Parameters<typeof state.update>[0]) {
        state = state.update(spec).state;
      },
    };
    const h = new LiveBoxHandle(view as unknown as EditorView);
    expect(codeBlockEdit(h.value, h.selectionStart, h.selectionEnd, { key: "}" })).toBeNull();
    expect(takeBlockKey(key("Enter"), h)).toBe(true);
    expect(h.value).toBe("```\n  f() {\n      ");
    expect(h.selectionStart).toBe(h.value.length);
    expect(takeBlockKey(key("("), h)).toBe(true);
    expect(h.value).toBe("```\n  f() {\n      ()");
    expect(h.selectionStart).toBe(h.value.length - 1);
    expect(takeBlockKey(key("Backspace"), h)).toBe(true);
    expect(h.value).toBe("```\n  f() {\n      ");
    expect(undoDepth(state)).toBeGreaterThan(0);
  });
  it("653: an indent-step Backspace is one undo step, in the formatted box and the plain box's history", () => {
    // Formatted (CodeMirror) box.
    let state = composerState("```\nx\n        ", [composerKeymap()]);
    const view = {
      get state() {
        return state;
      },
      dispatch(spec: Parameters<typeof state.update>[0]) {
        state = state.update(spec).state;
      },
    };
    const h = new LiveBoxHandle(view as unknown as EditorView);
    const depth = undoDepth(state);
    expect(takeBlockKey(key("Backspace"), h)).toBe(true);
    expect(h.value).toBe("```\nx\n    ");
    expect(undoDepth(state)).toBe(depth + 1);
    expect(undo({ state, dispatch: (tr) => (state = tr.state) })).toBe(true);
    expect(state.doc.toString()).toBe("```\nx\n        ");
    // Plain box: Composer's `applyBoxEdit` records the edit as one `external` step.
    const el = new FakeField();
    el.value = "```\nx\n      ";
    el.setSelectionRange(el.value.length, el.value.length);
    const hist = new BoxHistory(el.value);
    const ed = codeBlockEdit(el.value, el.selectionStart, el.selectionEnd, { key: "Backspace" })!;
    const next = applyToField(el, ed);
    expect(hist.external(next, ed.head)).toBe(true);
    expect(el.value).toBe("```\nx\n    ");
    expect(hist.undo()?.text).toBe("```\nx\n      ");
    expect(hist.canUndo).toBe(false);
  });
});

describe("a code block never traps the caret (676)", () => {
  it("Right at the end of an unclosed block adds the closing fence and a new line below it", () => {
    expect(press("```cpp\nint main() {}|", "ArrowRight")).toBe("```cpp\nint main() {}\n```\n|");
    expect(press("hi\n```py\nx = 1|", "ArrowRight")).toBe("hi\n```py\nx = 1\n```\n|");
    expect(press("```\nx|", "ArrowRight")).toBe("```\nx\n```\n|");
  });
  it("an empty last line takes the fence; indentation on the last line is kept", () => {
    expect(press("```cpp\nint x;\n|", "ArrowRight")).toBe("```cpp\nint x;\n```\n|");
    expect(press("```cpp\nint x;\n    |", "ArrowRight")).toBe("```cpp\nint x;\n    \n```\n|");
  });
  it("on the opening line itself (nothing typed yet) it closes an empty block", () => {
    expect(press("```py|", "ArrowRight")).toBe("```py\n```\n|");
  });
  it("the closing fence matches the opener's mark, length and indent", () => {
    expect(press("````md\nx|", "ArrowRight")).toBe("````md\nx\n````\n|");
    expect(press("~~~\nx|", "ArrowRight")).toBe("~~~\nx\n~~~\n|");
    expect(press("  ```\nx|", "ArrowRight")).toBe("  ```\nx\n  ```\n|");
  });
  it("Down on the last line of an unclosed block does the same, from any column", () => {
    expect(press("```cpp\nint| main() {}", "ArrowDown")).toBe("```cpp\nint main() {}\n```\n|");
    expect(press("```cpp\nint x;\n|", "ArrowDown")).toBe("```cpp\nint x;\n```\n|");
  });
  it("Down on a closing fence that ends the text adds a line below and goes there", () => {
    expect(press("```\nx\n``|`", "ArrowDown")).toBe("```\nx\n```\n|");
  });
  it("Down anywhere with a line below, or outside a block, is the box's own", () => {
    expect(press("```\nx|\ny", "ArrowDown")).toBeNull();
    expect(press("```\nx|\n```", "ArrowDown")).toBeNull();
    expect(press("```\nx\n```\nbye|", "ArrowDown")).toBeNull();
    expect(press("plain|", "ArrowDown")).toBeNull();
  });
  it("Down with Shift, a modifier, a selection or a composing key is not taken", () => {
    expect(press("```\nx|", { key: "ArrowDown", shiftKey: true })).toBeNull();
    expect(press("```\nx|", { key: "ArrowDown", metaKey: true })).toBeNull();
    expect(press("```\nx|", { key: "ArrowDown", ctrlKey: true })).toBeNull();
    expect(press("```\nx|", { key: "ArrowDown", altKey: true })).toBeNull();
    expect(press("```\n[x]", "ArrowDown")).toBeNull();
    expect(press("```\nx|", { key: "ArrowDown", keyCode: 229 })).toBeNull();
  });
  it("Enter after an opening fence with nothing below adds the closing fence, caret inside", () => {
    expect(press("```py|", "Enter")).toBe("```py\n|\n```");
    expect(press("hi\n  ```cpp|", "Enter")).toBe("hi\n  ```cpp\n  |\n  ```");
    expect(press("~~~~|", "Enter")).toBe("~~~~\n|\n~~~~");
    expect(press("```py|\n\n", "Enter")).toBe("```py\n|\n```\n\n");
  });
  it("Enter after an opening fence with text below is a plain new line (no fence added)", () => {
    expect(press("```py|\nx = 1", "Enter")).toBe("```py\n|\nx = 1");
  });
  it("nothing typed is lost: every edit only inserts", () => {
    const cases: [string, string][] = [
      ["```cpp\nint x;|", "ArrowRight"],
      ["```cpp\nint x;\n    |", "ArrowDown"],
      ["```py|", "Enter"],
      ["```\nx\n``|`", "ArrowDown"],
    ];
    for (const [src, key] of cases) {
      const { text, start, end } = parse(src);
      const ed = codeBlockEdit(text, start, end, { key })!;
      expect(ed.to).toBe(ed.from);
      const next = applyBlockEdit(text, ed);
      expect(next.slice(0, ed.from) + next.slice(ed.from + ed.insert.length)).toBe(text);
    }
  });
  it("after the fence is added, the block is closed and the next Enter sends", () => {
    const { text, start } = parse("```cpp\nint x;|");
    const ed = codeBlockEdit(text, start, start, { key: "ArrowRight" })!;
    const next = applyBlockEdit(text, ed);
    expect(fencesOf(next)[0].close).not.toBeNull();
    expect(codeBlockEdit(next, ed.head, ed.head, { key: "Enter" })).toBeNull();
  });
  it("in the formatted box and a plain textarea: Right closes the block in one undo step", () => {
    let state = composerState("```cpp\nint x;", [composerKeymap()]);
    const view = {
      get state() {
        return state;
      },
      dispatch(spec: Parameters<typeof state.update>[0]) {
        state = state.update(spec).state;
      },
    };
    const h = new LiveBoxHandle(view as unknown as EditorView);
    const depth = undoDepth(state);
    expect(takeBlockKey(key("ArrowRight"), h)).toBe(true);
    expect(h.value).toBe("```cpp\nint x;\n```\n");
    expect(h.selectionStart).toBe(h.value.length);
    expect(undoDepth(state)).toBe(depth + 1);
    expect(undo({ state, dispatch: (tr) => (state = tr.state) })).toBe(true);
    expect(state.doc.toString()).toBe("```cpp\nint x;");
    const el = new FakeField();
    el.value = "```cpp\nint x;";
    el.setSelectionRange(3, 3);
    expect(takeBlockKey(key("ArrowDown"), el)).toBe(false);
    el.setSelectionRange(el.value.length - 2, el.value.length - 2);
    expect(takeBlockKey(key("ArrowDown"), el)).toBe(true);
    expect([el.value, el.selectionStart]).toEqual(["```cpp\nint x;\n```\n", 18]);
  });
});
