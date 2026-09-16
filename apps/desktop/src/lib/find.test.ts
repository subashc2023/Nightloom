import { describe, expect, it } from "vitest";
import {
  countLabel,
  findChord,
  findMatches,
  foldCase,
  keepHit,
  stepHit,
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

  it("leaves ⌘⇧F to the search-everywhere half, and bare or ⌥ keys alone", () => {
    expect(findChord(k("KeyF", true), true)).toBeNull();
    expect(findChord(k("KeyF"), false)).toBeNull();
    expect(findChord(k("KeyF", false, true), true)).toBeNull();
  });
});
