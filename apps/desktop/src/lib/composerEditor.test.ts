import { describe, expect, it } from "vitest";
import { EditorSelection, type EditorState } from "@codemirror/state";
import { composerDecorations, composerState, liveSpans, setFocused, type LiveKind } from "./composerEditor";
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
  it("strictly inside: open; just before or just past it: drawn", () => {
    expect(at(4)).toBe(true);
    expect(at(3)).toBe(true);
    // Fix pass: the caret just before a formula is where he puts it to type
    // in front of one — the formula stays drawn there (was: open).
    expect(at(2)).toBe(false);
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

// Fix pass (2026-10-01): the two bugs he found in five seconds, and the ones
// found typing and clicking in the real composer after them.
describe("fix pass: unclosed and mismatched dollars never render", () => {
  const mathKinds = (t: string) => kinds(t).filter((k) => k.startsWith("math"));
  it("his input: $$dflkjdsl$ is text, not a $ and then $dflkjdsl$", () => {
    expect(mathKinds("$$dflkjdsl$")).toEqual([]);
  });
  it("$$…$ is not math, wherever it stands", () => {
    expect(mathKinds("so $$abc$ here")).toEqual([]);
    expect(mathKinds("$$\\hat{p}$")).toEqual([]);
    expect(mathKinds("$$a $b$")).toEqual(["math"]);
  });
  it("a closing $ followed by $ is not a one-dollar close", () => {
    expect(mathKinds("$a$$")).toEqual([]);
    expect(mathKinds("$a$$b$")).toEqual([]);
  });
  it("a half-typed $$ before a real formula does not swallow it", () => {
    const s = liveSpans(composerState("$$x$ and $y$", [], 0, false)).filter((x) => x.kind === "math");
    expect(s.map((x) => [x.from, x.to])).toEqual([[9, 12]]);
  });
  it("typing $$\\hat{p}$$ one key at a time: nothing renders until the last $", () => {
    const keys = "$$\\hat{p}$$";
    let s = composerState("", [], 0, true);
    for (let i = 0; i < keys.length; i++) {
      s = typeInto(s, keys[i]);
      const m = liveSpans(s).filter((x) => x.kind.startsWith("math"));
      expect(m.length, JSON.stringify(s.doc.toString())).toBe(i === keys.length - 1 ? 1 : 0);
    }
  });
  it("deleting it one key at a time from the end: drawn only while whole", () => {
    let s = composerState("$$\\hat{p}$$", [], 11, true);
    for (let n = 11; n > 0; n--) {
      const m = liveSpans(s).filter((x) => x.kind.startsWith("math"));
      expect(m.length, JSON.stringify(s.doc.toString())).toBe(n === 11 ? 1 : 0);
      s = s.update({ changes: { from: n - 1, to: n }, userEvent: "delete.backward" }).state;
    }
  });
});

describe("fix pass: a formula is an inline widget over its own span", () => {
  /** Every replace decoration with a widget: its range and whether it is a block. */
  function widgets(text: string, cursor = text.length, focus = true) {
    const set = composerDecorations(composerState(text, [], cursor, focus));
    const out: { from: number; to: number; block: boolean }[] = [];
    set.between(0, text.length, (from, to, d) => {
      if (d.spec.widget) out.push({ from, to, block: !!d.spec.block });
    });
    return out;
  }
  it("a lone display formula: as wide as its span, never a block over the row", () => {
    expect(widgets("$$\\hat{p}$$")).toEqual([{ from: 0, to: 11, block: false }]);
  });
  it("a multi-line $$ … $$ is one inline widget over its line breaks", () => {
    const t = "Then:\n$$\n\\sum_i i\n$$\nafter";
    expect(widgets(t)).toEqual([{ from: 6, to: 20, block: false }]);
  });
  it("the caret just before and just after a lone formula leaves it drawn", () => {
    const t = "$$\\hat{p}$$";
    for (const at of [0, t.length]) {
      const s = composerState(t, [], at, true);
      expect(liveSpans(s).find((x) => x.kind.startsWith("math"))!.open).toBe(false);
    }
  });
  it("only the formula opens: the caret elsewhere on its row leaves it drawn", () => {
    const t = "$$x$$ then words";
    expect(liveSpans(composerState(t, [], 12, true)).find((x) => x.kind.startsWith("math"))!.open).toBe(false);
    expect(liveSpans(composerState(t, [], 3, true)).find((x) => x.kind.startsWith("math"))!.open).toBe(true);
  });
  it("the caret just after a multi-line formula leaves it drawn", () => {
    const t = "$$\nx^2\n$$";
    expect(liveSpans(composerState(t, [], t.length, true))[0].open).toBe(false);
  });
});

describe("fix pass: emphasis half typed does not flash", () => {
  it("**bold* is not italic, *a** is not italic", () => {
    expect(kinds("**bold*")).toEqual([]);
    expect(kinds("*a**")).toEqual([]);
    expect(kinds("__a_")).toEqual([]);
  });
  it("nested runs still draw", () => {
    expect(kinds("***a***").sort()).toEqual(["em", "strong"]);
    expect(kinds("**bold *it* more**").sort()).toEqual(["em", "strong"]);
  });
  it("typing **bold** one key at a time: no italic on the way, bold at the end", () => {
    let s = composerState("a ", [], 2, true);
    for (const ch of "**bold**") {
      s = typeInto(s, ch);
      const k = liveSpans(s).map((x) => x.kind);
      expect(k.includes("em"), JSON.stringify(s.doc.toString())).toBe(false);
    }
    expect(liveSpans(s).map((x) => x.kind)).toEqual(["strong"]);
  });
});
