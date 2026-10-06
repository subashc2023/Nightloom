import { describe, expect, it } from "vitest";
import { BoxHistory, caretAfterChange, editKind, historyInput, MAX_STEPS } from "./boxHistory";

const snap = (text: string, start = text.length, end = start) => ({ text, start, end });

/** Type `s` at the end of the box, one character a keystroke, as WebKit reports it. */
function typeEnd(h: BoxHistory, s: string): void {
  for (const ch of s) {
    const t = h.current.text;
    h.before(snap(t));
    h.input("type", snap(t + ch));
  }
}

describe("boxHistory (blocker 1210)", () => {
  it("classifies input types", () => {
    expect(editKind("insertText")).toBe("type");
    expect(editKind("insertLineBreak")).toBe("type");
    expect(editKind("insertCompositionText")).toBe("type");
    expect(editKind("deleteContentBackward")).toBe("delete");
    expect(editKind("deleteWordBackward")).toBe("delete");
    expect(editKind("deleteByCut")).toBe("other");
    expect(editKind("insertFromPaste")).toBe("other");
    expect(editKind("")).toBe("other");
    expect(historyInput("historyUndo")).toBe("undo");
    expect(historyInput("historyRedo")).toBe("redo");
    expect(historyInput("insertText")).toBeNull();
  });

  it("a run of typing is one step; a caret move starts another", () => {
    const h = new BoxHistory();
    typeEnd(h, "hello ");
    typeEnd(h, "world");
    expect(h.undo()?.text).toBe("");
    expect(h.canUndo).toBe(false);
    expect(h.redo()?.text).toBe("hello world");
    // Caret moved to 0, then typing there: a new step.
    h.before(snap("hello world", 0));
    h.input("type", snap("Xhello world", 1));
    expect(h.undo()).toMatchObject({ text: "hello world", start: 0, end: 0 });
  });

  it("typing and deleting are separate steps", () => {
    const h = new BoxHistory();
    typeEnd(h, "abc");
    h.before(snap("abc"));
    h.input("delete", snap("ab"));
    h.before(snap("ab"));
    h.input("delete", snap("a"));
    expect(h.undo()?.text).toBe("abc");
    expect(h.undo()?.text).toBe("");
  });

  it("the blocker's sequence: no stale text on redo, nothing lost", () => {
    // type "hello ", code paste fenced (two script steps), type "X".
    const h = new BoxHistory();
    typeEnd(h, "hello ");
    const raw = "hello def f():\n  pass";
    const wrapped = "hello \n```python\ndef f():\n  pass\n```";
    h.external(raw, raw.length);
    h.external(wrapped, wrapped.length);
    typeEnd(h, "X");
    const seen = new Set(["", "hello ", raw, wrapped, wrapped + "X"]);
    const states: string[] = [];
    for (let i = 0; i < 6; i++) states.push(h.undo()?.text ?? h.current.text);
    expect(states).toEqual([wrapped, raw, "hello ", "", "", ""]);
    for (let i = 0; i < 6; i++) states.push(h.redo()?.text ?? h.current.text);
    for (const s of states) expect(seen.has(s)).toBe(true);
    expect(h.current.text).toBe(wrapped + "X");
  });

  it("a script-set echo of the box's own text is not a step", () => {
    const h = new BoxHistory();
    typeEnd(h, "hi");
    expect(h.external("hi")).toBe(false);
    expect(h.undo()?.text).toBe("");
    expect(h.canUndo).toBe(false);
  });

  it("a new edit after an undo drops the redo", () => {
    const h = new BoxHistory();
    typeEnd(h, "one");
    h.external("one two");
    h.undo();
    expect(h.canRedo).toBe(true);
    typeEnd(h, "!");
    expect(h.canRedo).toBe(false);
  });

  it("carries a tag through undo and redo (284's chip)", () => {
    const h = new BoxHistory("intro LONG");
    h.external("intro ", 6, { convert: true });
    expect(h.undoTag).toEqual({ convert: true });
    typeEnd(h, "ok");
    expect(h.undo()?.tag).toBeUndefined();
    expect(h.undo()).toMatchObject({ text: "intro LONG", tag: { convert: true } });
    expect(h.redo()).toMatchObject({ text: "intro ", tag: { convert: true } });
    expect(h.redo()?.text).toBe("intro ok");
  });

  it("reset starts a fresh history", () => {
    const h = new BoxHistory();
    typeEnd(h, "abc");
    h.reset("other chat");
    expect(h.canUndo).toBe(false);
    expect(h.current.text).toBe("other chat");
  });

  it("keeps at most MAX_STEPS steps", () => {
    const h = new BoxHistory();
    for (let i = 0; i < MAX_STEPS + 20; i++) h.external(`v${i}`);
    let n = 0;
    while (h.undo()) n++;
    expect(n).toBe(MAX_STEPS);
  });

  it("puts the caret at the end of a script-set change", () => {
    expect(caretAfterChange("ab", "aXb")).toBe(2);
    expect(caretAfterChange("abc", "abc\n> q\n")).toBe(8);
    expect(caretAfterChange("hello", "")).toBe(0);
  });
});
