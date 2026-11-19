// Item 872: the rules as one pass shared by the Mac's and the phone's stage, and done tasks folding by themselves.
import { describe, expect, it } from "vitest";
import { rulesPass, foldDone, unfold, FOLD_AFTER_MS, type FocusBag } from "./focus";
import type { Tab } from "./tabs";

const tab = (id: string, needs = 0, live = true): Tab => ({ id, view: id === "watch" ? "watch" : "todo", name: id, needs, live }) as Tab;
const bagOf = (): FocusBag => ({ follow: true, split: false, primed: false, ready: [], seen: {}, doneSeen: {}, folded: [] });

describe("rulesPass", () => {
  it("primes on the first read, so what is there does not pulse; a new tab then waits ready", () => {
    const fk = bagOf();
    const row = [tab("watch"), tab("task:a")];
    const n = { now: 1_000_000, lastTouch: 1_000_000, busy: false };
    expect(rulesPass(fk, "watch", null, row, n, () => false, true).focus).toBe("watch");
    expect(fk.primed).toBe(true);
    expect(fk.ready).toEqual([]);
    rulesPass(fk, "watch", null, [...row, tab("task:b")], n, () => false, true);
    expect(fk.ready).toEqual(["task:b"]);
  });
  it("a new task he asked for takes focus at once unless he is typing", () => {
    const fk = bagOf();
    const row = [tab("watch")];
    const n = { now: 5, lastTouch: 5, busy: false };
    rulesPass(fk, "watch", null, row, n, () => true, true);
    expect(rulesPass(fk, "watch", null, [...row, tab("task:c")], { ...n, busy: true }, () => true, true).focus).toBe("watch");
    const fk2 = bagOf();
    rulesPass(fk2, "watch", null, row, n, () => true, true);
    expect(rulesPass(fk2, "watch", null, [...row, tab("task:c")], n, () => true, true).focus).toBe("task:c");
  });
});

describe("done tasks fold by themselves", () => {
  const row = [tab("watch"), tab("task:a", 0, false), tab("task:b")];
  const done = (id: string) => id === "task:a";
  it("only once he has seen it done and been away a minute; never the one in focus; never unseen", () => {
    const fk = bagOf();
    foldDone(fk, row, done, "watch", 0);
    expect(fk.folded).toEqual([]); // never seen done: stays
    foldDone(fk, row, done, "task:a", 1000);
    expect(fk.folded).toEqual([]); // in focus
    foldDone(fk, row, done, "watch", 1000 + FOLD_AFTER_MS - 1);
    expect(fk.folded).toEqual([]);
    foldDone(fk, row, done, "watch", 1000 + FOLD_AFTER_MS);
    expect(fk.folded).toEqual(["task:a"]);
  });
  it("comes back on his click and stays until he looks again; a gone task is forgotten", () => {
    const fk = bagOf();
    foldDone(fk, row, done, "task:a", 0);
    foldDone(fk, row, done, "watch", FOLD_AFTER_MS);
    unfold(fk);
    expect(fk.folded).toEqual([]);
    foldDone(fk, row, done, "watch", FOLD_AFTER_MS * 5);
    expect(fk.folded).toEqual([]);
    foldDone(fk, row, done, "task:a", FOLD_AFTER_MS * 5);
    foldDone(fk, [tab("watch")], done, "watch", FOLD_AFTER_MS * 9);
    expect(fk.folded).toEqual([]);
    expect(fk.doneSeen).toEqual({});
  });
});
