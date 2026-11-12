// Item 648: the code-editor keys inside a ``` block in a message box.
import { describe, expect, it } from "vitest";
import type { EditorView } from "@codemirror/view";
import { undoDepth } from "@codemirror/commands";
import { applyBlockEdit, applyToField, blockAt, codeBlockEdit, fencesOf, indentUnit, takeBlockKey, type BlockKey } from "./codeBlockKeys";
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
    expect(press("```py|", "Enter")).toBe("```py\n|");
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
  it("quotes are never auto-closed", () => {
    expect(press("```\nx = |", '"')).toBeNull();
    expect(press("```\nx = |", "'")).toBeNull();
    expect(press("```\nx = |", "`")).toBeNull();
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
});
