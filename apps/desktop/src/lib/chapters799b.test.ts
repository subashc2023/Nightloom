// Item 799 (2026-11-23): the phone's contents list keeps the dividers' order.
import { describe, expect, it } from "vitest";
import { phoneContents, type Chapter } from "./chapters";

const ch = (key: string, index: number): Chapter => ({ key, kind: "commit", index, anchor: index, title: key, at: null, drawn: true });

describe("phoneContents (item 799)", () => {
  it("row by row in draw order, then a place past the rows, then the tail", () => {
    const before = new Map<number, Chapter[]>([
      [3, [ch("hand_off:11", 11)]],
      [1, [ch("wave:4", 4), ch("commit:7", 7)]],
      [9, [ch("late:20", 20)]],
    ]);
    const list = phoneContents({ before, tail: [ch("commit:30", 30)] }, 5);
    expect(list.map((c) => c.key)).toEqual(["wave:4", "commit:7", "hand_off:11", "late:20", "commit:30"]);
  });
  it("no chapters: an empty list (the Contents row is not shown)", () => {
    expect(phoneContents({ before: new Map(), tail: [] }, 4)).toEqual([]);
  });
});
