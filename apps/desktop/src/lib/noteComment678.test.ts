// Item 678: ⌘/ in a note's fenced code block comments its lines in the block's language.
import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { commentInBlock } from "./noteEditor";

function fakeView(text: string, anchor: number, head = anchor) {
  let state = EditorState.create({ doc: text, selection: EditorSelection.range(anchor, head) });
  return {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<typeof state.update>[0]) {
      state = state.update(spec).state;
    },
  };
}

describe("⌘/ in a note's code block (678)", () => {
  it("comments the selected lines with the block's token, selection over them", () => {
    const t = "# Notes\n\n```py\nx = 1\ny = 2\n```\n";
    const v = fakeView(t, t.indexOf("x"), t.indexOf("y = 2") + 5);
    expect(commentInBlock(v as unknown as EditorView)).toBe(true);
    expect(v.state.doc.toString()).toBe("# Notes\n\n```py\n# x = 1\n# y = 2\n```\n");
    const s = v.state.selection.main;
    expect(v.state.sliceDoc(s.from, s.to)).toBe("# x = 1\n# y = 2");
  });
  it("outside a block it is left to the default keymap", () => {
    const v = fakeView("just prose", 3);
    expect(commentInBlock(v as unknown as EditorView)).toBe(false);
    expect(v.state.doc.toString()).toBe("just prose");
  });
});
