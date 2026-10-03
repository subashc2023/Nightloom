import { describe, expect, it } from "vitest";
import { applyBlock, blocks, hunkActions, reviewRows } from "./proposalMerge";

const SAVED = "# Title\n\nUse cargo.\nKeep it short.\nEnd.\n";
const PROPOSED = "# Title\n\nUse cargo and tokio.\nKeep it short.\nNew rule.\nEnd.\n";

describe("blocks", () => {
  it("finds a changed line and an added one, in the base's lines", () => {
    expect(blocks(PROPOSED, SAVED)).toEqual([
      { start: 2, end: 3, lines: ["Use cargo."] },
      { start: 4, end: 5, lines: [] },
    ]);
  });

  it("gives an insertion as an empty run", () => {
    expect(blocks(SAVED, PROPOSED)).toEqual([
      { start: 2, end: 3, lines: ["Use cargo and tokio."] },
      { start: 4, end: 4, lines: ["New rule."] },
    ]);
  });

  it("is empty for texts that differ only by the trailing newline", () => {
    expect(blocks("a\nb\n", "a\nb")).toEqual([]);
  });
});

describe("applyBlock — the hunk merge", () => {
  it("keep saved on every block gives back the saved text", () => {
    let text = PROPOSED;
    // Last first, so the earlier blocks' line numbers still hold.
    for (const b of blocks(text, SAVED).reverse()) text = applyBlock(text, b);
    expect(text).toBe(SAVED);
  });

  it("keep saved on one block puts the old lines back and leaves the other", () => {
    const [first] = blocks(PROPOSED, SAVED);
    expect(applyBlock(PROPOSED, first)).toBe("# Title\n\nUse cargo.\nKeep it short.\nNew rule.\nEnd.\n");
  });

  it("take proposed undoes a keep", () => {
    const [first] = blocks(PROPOSED, SAVED);
    const kept = applyBlock(PROPOSED, first);
    const [back] = blocks(kept, PROPOSED);
    expect(applyBlock(kept, back)).toBe(PROPOSED);
  });

  it("restores lines deleted at the very end", () => {
    const cut = "# Title\n\nUse cargo.\n";
    const [b] = blocks(cut, SAVED);
    expect(b).toEqual({ start: 3, end: 3, lines: ["Keep it short.", "End."] });
    expect(applyBlock(cut, b)).toBe(SAVED);
  });

  it("restores into an emptied text", () => {
    const [b] = blocks("", "one\ntwo");
    expect(applyBlock("", b)).toBe("one\ntwo\n");
  });

  it("keeps a text without a trailing newline without one", () => {
    const [b] = blocks("a\nX", "a\nb");
    expect(applyBlock("a\nX", b)).toBe("a\nb");
  });
});

describe("reviewRows", () => {
  it("marks removed lines on the left, pads beside added ones, and new lines on the right", () => {
    const r = reviewRows(SAVED, PROPOSED);
    expect(r.left.map((l) => l.kind)).toEqual(["ctx", "ctx", "del", "pad", "ctx", "pad", "ctx"]);
    expect(r.left.map((l) => l.no)).toEqual([1, 2, 3, null, 4, null, 5]);
    // The right side has one entry per line the text box shows, the empty
    // one after the final newline included.
    expect(r.right).toEqual(["ctx", "ctx", "add", "ctx", "add", "ctx", "ctx"]);
    expect([r.added, r.removed]).toEqual([2, 1]);
  });

  it("anchors each left row to the proposed line beside it", () => {
    const r = reviewRows(SAVED, PROPOSED);
    expect(r.left.map((l) => l.at)).toEqual([0, 1, 2, 2, 3, 4, 5]);
  });

  it("shows one line for an empty proposal", () => {
    expect(reviewRows("a\n", "").right).toEqual(["ctx"]);
  });
});

describe("hunkActions", () => {
  it("offers keep saved on each changed block and nothing else before any edit", () => {
    const acts = hunkActions(SAVED, PROPOSED, PROPOSED);
    expect([...acts.keys()]).toEqual([2, 4]);
    expect(acts.get(2)!.map((a) => a.kind)).toEqual(["keep"]);
  });

  it("offers take proposed where a block was kept", () => {
    const [first] = blocks(PROPOSED, SAVED);
    const kept = applyBlock(PROPOSED, first);
    const acts = hunkActions(SAVED, PROPOSED, kept);
    expect(acts.get(2)!.map((a) => a.kind)).toEqual(["take"]);
    expect(acts.get(4)!.map((a) => a.kind)).toEqual(["keep"]);
  });

  it("offers both on a line he typed over", () => {
    const typed = PROPOSED.replace("Use cargo and tokio.", "Use cargo and async-std.");
    expect(hunkActions(SAVED, PROPOSED, typed).get(2)!.map((a) => a.kind)).toEqual(["keep", "take"]);
  });

  it("puts a gap at the end on the last line", () => {
    const acts = hunkActions("a\nb\nc", "a\nb\nc", "a");
    expect([...acts.keys()]).toEqual([0]);
  });
});
