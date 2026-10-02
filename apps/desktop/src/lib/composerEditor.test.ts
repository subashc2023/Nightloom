import { describe, expect, it } from "vitest";
import { EditorSelection, type EditorState } from "@codemirror/state";
import { composerState, liveSpans, setFocused, type LiveKind } from "./composerEditor";
import { loadComposerFormat, saveComposerFormat } from "./composerFormat.svelte";

// The formatted message box (nightshift item 276). What matters most: the
// text he types is the text sent, toggle on or off; and the things that are
// not math or emphasis in a chat message stay plain text.

/** The kinds drawn for `text`, the box unfocused (everything drawn). */
function kinds(text: string): LiveKind[] {
  return liveSpans(composerState(text, [], text.length, false))
    .filter((s) => s.kind !== "quote")
    .map((s) => s.kind);
}

/** Type `keys` one character at a time into a box, as keystrokes do. */
function typeInto(state: EditorState, keys: string): EditorState {
  let s = state;
  for (const ch of keys) s = s.update(s.replaceSelection(ch), { userEvent: "input.type" }).state;
  return s;
}

describe("not math, in a chat message", () => {
  const plain = [
    "between $5 and $10",
    "$ ls -la",
    "a lone $ here",
    "escaped \\$5\\$ stays",
    "code `$x$` stays",
    "```sh\necho $x$y\n```",
    "export PATH=$HOME/bin:$PATH",
    "echo $USER$HOST",
    "the estimate is $$\\hat{p} = \\frac{x}{n}",
    "price $100$200",
  ];
  for (const t of plain) it(JSON.stringify(t), () => expect(kinds(t).filter((k) => k.startsWith("math"))).toEqual([]));

  it("math still is", () => {
    expect(kinds("$x^2$")).toEqual(["math"]);
    expect(kinds("$$\\hat{p}$$")).toEqual(["math-block"]);
    expect(kinds("so $$E=mc^2$$ here")).toEqual(["math"]);
    expect(kinds("a\n$$\n\\int_0^1 f\n$$\nb")).toEqual(["math-block"]);
    expect(kinds("broken $\\frac{1}$ still a span")).toEqual(["math"]);
  });
});

describe("emphasis and headings", () => {
  it("bold, italic, nested", () => {
    expect(kinds("**a**")).toEqual(["strong"]);
    expect(kinds("*a*")).toEqual(["em"]);
    expect(kinds("_a_")).toEqual(["em"]);
    expect(kinds("***a***").sort()).toEqual(["em", "strong"]);
  });
  it("snake_case and arithmetic stay text", () => {
    expect(kinds("snake_case_names")).toEqual([]);
    expect(kinds("2*3*4")).toEqual([]);
    expect(kinds("a*b*c")).toEqual([]);
  });
  it("headings need a space and words; #hashtag and C# stay text", () => {
    expect(kinds("# Title")).toEqual(["heading"]);
    expect(kinds("###### six")).toEqual(["heading"]);
    expect(kinds("#hashtag")).toEqual([]);
    expect(kinds("C# is fine")).toEqual([]);
    expect(kinds("#")).toEqual([]);
    expect(kinds("# ")).toEqual([]);
  });
  it("math inside code or a formula is not emphasis", () => {
    expect(kinds("$a*b*c$")).toEqual(["math"]);
  });
});

describe("the source opens under the cursor", () => {
  const text = "x $y^2$ z";
  const at = (pos: number, focused = true) =>
    liveSpans(
      composerState(text, [], pos, true).update({ effects: setFocused.of(focused) }).state,
    ).find((s) => s.kind === "math")!.open;
  it("inside or at the start: open; just past the end: drawn", () => {
    expect(at(4)).toBe(true);
    expect(at(2)).toBe(true);
    expect(at(7)).toBe(false);
    expect(at(0)).toBe(false);
  });
  it("unfocused, everything is drawn", () => {
    expect(at(4, false)).toBe(false);
  });
  it("a selection across a formula opens it", () => {
    const s = composerState(text, [], 0, true).update({
      selection: EditorSelection.range(0, text.length),
      effects: setFocused.of(true),
    }).state;
    expect(liveSpans(s).find((x) => x.kind === "math")!.open).toBe(true);
  });
});

describe("sent text equals typed text", () => {
  const typed = [
    "$$\\hat{p}$$",
    "# Heading\nbody **bold** and $x^2$ and 2*3*4",
    "> quote\nanswer",
    "  indented - list\n- item\n  - nested",
    "tabs\there",
    "",
  ];
  it("toggle on: typing into the formatted box gives the same string", () => {
    for (const t of typed) {
      const s = typeInto(composerState("", [], 0, true), t);
      expect(s.doc.toString()).toBe(t);
    }
  });
  it("toggle on: a draft set from outside comes back unchanged", () => {
    for (const t of typed) expect(composerState(t).doc.toString()).toBe(t);
  });
  it("line breaks are normalised as a textarea normalises them", () => {
    // A textarea's value turns \r\n and \r into \n; so does the box.
    expect(composerState("a\r\nb\rc").doc.toString()).toBe("a\nb\nc");
  });
  it("toggle off: the plain box is untouched by this code (the pref only picks the box)", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(loadComposerFormat(storage)).toBe(false);
    saveComposerFormat(true, storage);
    expect(loadComposerFormat(storage)).toBe(true);
    saveComposerFormat(false, storage);
    expect(loadComposerFormat(storage)).toBe(false);
  });
});
