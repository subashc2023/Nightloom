// Item 946: Handled as a notification list — what is unseen, what a one-at-a-time mark does, and that seen rows stay.
import { describe, expect, it } from "vitest";
import { handledRows, pruneMarked, unseenWords } from "./watch";
import { emptyHomeKept, newsRows, readHomeKept } from "../../remote/homeFirst";

const row = (min: number, line = "Finished") => ({ at: new Date(Date.UTC(2026, 10, 25, 8, min)).toISOString(), line, kind: "done" });
const feed = [row(1), row(2), row(3), row(4)];
const at = (min: number) => row(min).at;

describe("the Handled list (item 946)", () => {
  it("lists newest first; a row newer than the seen time is unseen, older ones stay listed as seen", () => {
    const h = handledRows(feed, at(2), {});
    expect(h.list.map((r) => r.row.at)).toEqual([at(4), at(3), at(2), at(1)]);
    expect(h.list.map((r) => r.unseen)).toEqual([true, true, false, false]);
    expect(h.unseen).toBe(2);
    expect(h.more).toBe(0);
  });
  it("counts everything as unseen when he has never marked the feed seen", () => {
    expect(handledRows(feed, null, {}).unseen).toBe(4);
  });
  it("marks one row seen by its key, and leaves the others", () => {
    const first = handledRows(feed, null, {});
    const key = first.list[1].key;
    const h = handledRows(feed, null, { [key]: 1 });
    expect(h.unseen).toBe(3);
    expect(h.list.find((r) => r.key === key)?.unseen).toBe(false);
    expect(h.list).toHaveLength(4);
  });
  it("keeps a row's key when newer rows arrive, even an identical one", () => {
    const twin = [row(1), row(1)];
    const k = handledRows(twin, null, {}).list.map((r) => r.key);
    expect(new Set(k).size).toBe(2);
    const before = handledRows(feed, null, {}).list.map((r) => r.key).reverse();
    const after = handledRows([...feed, row(9)], null, {}).list.map((r) => r.key).reverse();
    expect(after.slice(0, 4)).toEqual(before);
  });
  it("draws every unseen row, and seen ones only up to the cap", () => {
    const many = Array.from({ length: 30 }, (_, i) => row(i));
    const h = handledRows(many, at(9), {}, 25);
    expect(h.unseen).toBe(20);
    expect(h.list).toHaveLength(25);
    expect(h.more).toBe(5);
    const all = handledRows(many, null, {}, 5);
    expect(all.list).toHaveLength(30);
  });
  it("lets go of marks that Mark all seen covers or the feed no longer holds, and says when nothing went", () => {
    const keys = handledRows(feed, null, {}).list.map((r) => r.key); // newest first
    const marked = { [keys[0]]: 1, [keys[3]]: 1, gone: 1 };
    expect(pruneMarked(marked, feed, at(2))).toEqual({ [keys[0]]: 1 });
    const same = { [keys[0]]: 1 };
    expect(pruneMarked(same, feed, at(2))).toBe(same);
  });
  it("words the count", () => {
    expect([unseenWords(0), unseenWords(7), unseenWords(112)]).toEqual(["", "7", "99+"]);
  });
});

describe("the phone's Handled (item 946)", () => {
  it("lists the feed's news rows only, seen or not", () => {
    const rows = [{ ...row(1), kind: "done" }, { ...row(2), kind: "question" }, { ...row(3), kind: "scan" }, { ...row(4), kind: "approval" }];
    expect(newsRows(rows).map((r) => r.kind)).toEqual(["done", "scan"]);
  });
  it("keeps open or shut and the one-at-a-time marks across a reload", () => {
    expect(emptyHomeKept().handledOpen).toBe(false);
    const back = readHomeKept(JSON.parse(JSON.stringify({ ...emptyHomeKept(), handledOpen: true, marked: { a: 1 } })));
    expect(back.handledOpen).toBe(true);
    expect(back.marked).toEqual({ a: 1 });
    expect(readHomeKept({ marked: [1, 2] }).marked).toEqual({});
  });
});
