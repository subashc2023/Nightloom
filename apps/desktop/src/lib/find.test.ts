import { describe, expect, it } from "vitest";
import {
  addField,
  countLabel,
  fieldHit,
  fieldScrollTop,
  findChord,
  findMatches,
  foldCase,
  isField,
  keepHit,
  stepHit,
  type Segments,
} from "./find";

// Find in page (nightshift backlog 106, first half): the case fold, the
// match over text segments, the stepping and the count. The DOM half
// (the walker, the two highlighters) needs a document and is the
// checklist's.

describe("foldCase", () => {
  it("lower-cases and keeps the length", () => {
    expect(foldCase("Hello World")).toBe("hello world");
    expect(foldCase("ÀÉÎ")).toBe("àéî");
  });

  it("leaves a character alone when its lower form would change the length", () => {
    const s = "İstanbul";
    expect("İ".toLowerCase().length).toBe(2);
    const f = foldCase(s);
    expect(f.length).toBe(s.length);
    expect(f).toBe("İstanbul");
  });
});

describe("findMatches", () => {
  it("finds every occurrence, case-insensitively, with exclusive ends", () => {
    const hits = findMatches(["The cat sat on the mat"], "the");
    expect(hits).toEqual([
      { start: { seg: 0, off: 0 }, end: { seg: 0, off: 3 } },
      { start: { seg: 0, off: 15 }, end: { seg: 0, off: 18 } },
    ]);
  });

  it("has no hits for an empty query or an empty page", () => {
    expect(findMatches(["anything"], "")).toEqual([]);
    expect(findMatches([], "x")).toEqual([]);
    expect(findMatches([""], "x")).toEqual([]);
  });

  it("crosses a segment boundary, as inline markup splits text nodes", () => {
    // "the `foo` bar" is three text nodes once rendered.
    const hits = findMatches(["the ", "foo", " bar"], "foo bar");
    expect(hits).toEqual([
      { start: { seg: 1, off: 0 }, end: { seg: 2, off: 4 } },
    ]);
  });

  it("ends a hit inside its last segment, never at offset 0 of the next", () => {
    const hits = findMatches(["ab", "cd"], "ab");
    expect(hits).toEqual([
      { start: { seg: 0, off: 0 }, end: { seg: 0, off: 2 } },
    ]);
  });

  it("does not cross the block boundary the walker inserts", () => {
    expect(findMatches(["foo", "\n", "bar"], "foo bar")).toEqual([]);
    expect(findMatches(["foo", "\n", "bar"], "bar")).toEqual([
      { start: { seg: 2, off: 0 }, end: { seg: 2, off: 3 } },
    ]);
  });

  it("skips empty segments when placing a hit", () => {
    const hits = findMatches(["", "", "xy", "", "z"], "yz");
    expect(hits).toEqual([
      { start: { seg: 2, off: 1 }, end: { seg: 4, off: 1 } },
    ]);
  });

  it("does not overlap hits, like Chrome", () => {
    expect(findMatches(["aaaa"], "aa")).toHaveLength(2);
  });
});

describe("stepHit and keepHit", () => {
  it("wraps at both ends and starts from the right end", () => {
    expect(stepHit(null, 1, 3)).toBe(0);
    expect(stepHit(null, -1, 3)).toBe(2);
    expect(stepHit(2, 1, 3)).toBe(0);
    expect(stepHit(0, -1, 3)).toBe(2);
    expect(stepHit(1, 1, 3)).toBe(2);
    expect(stepHit(0, 1, 0)).toBeNull();
  });

  // His note on board 11b (backlog 117, 2026-09-16): the bar the panel
  // hands off to loops — at 1/4, ↑ goes to 4/4, and at 4/4, ↓ to 1/4.
  it("loops the bar's count at the ends: 1 of 4, ↑ → 4 of 4", () => {
    expect(countLabel(stepHit(0, -1, 4), 4)).toBe("4 of 4");
    expect(countLabel(stepHit(3, 1, 4), 4)).toBe("1 of 4");
  });

  it("keeps the ordinal across a page change where it can", () => {
    expect(keepHit(4, 10)).toBe(4);
    expect(keepHit(4, 3)).toBe(2);
    expect(keepHit(null, 3)).toBe(0);
    expect(keepHit(2, 0)).toBeNull();
  });
});

describe("countLabel", () => {
  it("is n of m, 0 of 0 with nothing found", () => {
    expect(countLabel(2, 12)).toBe("3 of 12");
    expect(countLabel(null, 0)).toBe("0 of 0");
    expect(countLabel(null, 2)).toBe("0 of 2");
  });
});

describe("findChord", () => {
  const k = (code: string, shiftKey = false, altKey = false) => ({
    code,
    shiftKey,
    altKey,
  });

  it("is ⌘F to open, ⌘G / ⌘⇧G to step, nothing else", () => {
    expect(findChord(k("KeyF"), true)).toBe("open");
    expect(findChord(k("KeyG"), true)).toBe("next");
    expect(findChord(k("KeyG", true), true)).toBe("prev");
    expect(findChord(k("KeyH"), true)).toBeNull();
  });

  // ~~⌥ keys alone~~ 2026-09-23: ⌘⌥F is search everywhere (blocker 164).
  it("leaves ⌘⇧F (the Fable switch) and bare keys alone; ⌘⌥F is everywhere", () => {
    expect(findChord(k("KeyF", true), true)).toBeNull();
    expect(findChord(k("KeyF"), false)).toBeNull();
    expect(findChord(k("KeyF", false, true), true)).toBe("everywhere");
    expect(findChord(k("KeyG", false, true), true)).toBeNull();
  });
});

// The field walker (nightshift backlog 162): the composer's draft, an
// edit box, a note's textarea and a queued row are searched by value.
// The DOM walker calls `addField` for each; these pin what it appends,
// how a hit in one resolves, and that ⏎ walks page text and fields in
// document order.
describe("fields searched by value (backlog 162)", () => {
  // Stand-ins: the segment only holds an element; a text node is read
  // for its `data` by the painters, which these tests do not run.
  const el = (name: string) => ({ name }) as unknown as Element;
  const text = (data: string) => ({ data }) as unknown as Text;

  it("boxes a field's value with block boundaries and skips an empty one", () => {
    const seg: Segments = { nodes: [], texts: [] };
    addField(seg, el("empty"), "");
    expect(seg.texts).toEqual([]);
    addField(seg, el("draft"), "the draft");
    expect(seg.texts).toEqual(["the draft", "\n"]);
    expect(isField(seg.nodes[0])).toBe(true);
    expect(seg.nodes[1]).toBeNull();
    // After page text: a boundary first, so a hit never runs into the field.
    const seg2: Segments = { nodes: [text("page text")], texts: ["page text"] };
    addField(seg2, el("draft"), "the draft");
    expect(seg2.texts).toEqual(["page text", "\n", "the draft", "\n"]);
  });

  it("walks the transcript and the draft in document order, and resolves a field hit to its offsets", () => {
    const seg: Segments = { nodes: [text("a word in the reply")], texts: ["a word in the reply"] };
    addField(seg, el("draft"), "typing the word twice: word");
    addField(seg, el("queued"), "a queued word");
    const hits = findMatches(seg.texts, "word");
    expect(hits).toHaveLength(4);
    expect(fieldHit(seg, hits[0]!)).toBeNull(); // the reply's
    expect(fieldHit(seg, hits[1]!)).toEqual({ field: el("draft"), start: 11, end: 15 });
    expect(fieldHit(seg, hits[2]!)).toEqual({ field: el("draft"), start: 23, end: 27 });
    expect(fieldHit(seg, hits[3]!)).toEqual({ field: el("queued"), start: 9, end: 13 });
    // A query with a space does not cross from the page into the field.
    expect(findMatches(seg.texts, "reply typing")).toEqual([]);
  });

  it("scrolls a textarea so the hit's line is in the middle of its box", () => {
    expect(fieldScrollTop("one\ntwo\nthree", 0, 20, 100)).toBe(0);
    expect(fieldScrollTop("one\ntwo\nthree", 4, 20, 100)).toBe(0);
    const v = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const at = v.indexOf("line 30");
    expect(fieldScrollTop(v, at, 20, 100)).toBe(30 * 20 - 50 + 10);
  });
});
