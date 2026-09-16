import { describe, expect, it } from "vitest";
import { hasChange, tokenize, wordDiff, type DiffOp } from "./textdiff";

// The edited message's inline diff (nightshift backlog 105). These pin the
// five shapes the Definition of done names, the two edges the transcript
// leans on — an empty `before` (an appended block is all insertion) and
// that the ops reassemble both texts — and the cap.

const before = (ops: DiffOp[]) =>
  ops
    .filter((o) => o.kind !== "add")
    .map((o) => o.text)
    .join("");
const after = (ops: DiffOp[]) =>
  ops
    .filter((o) => o.kind !== "del")
    .map((o) => o.text)
    .join("");

describe("wordDiff", () => {
  it("an insertion marks only the added words", () => {
    const ops = wordDiff("run the sweep", "run the whole sweep");
    expect(ops).toEqual([
      { kind: "same", text: "run the " },
      { kind: "add", text: "whole " },
      { kind: "same", text: "sweep" },
    ]);
  });

  it("a deletion marks only the removed words", () => {
    const ops = wordDiff("run the whole sweep", "run the sweep");
    expect(ops).toEqual([
      { kind: "same", text: "run the " },
      { kind: "del", text: "whole " },
      { kind: "same", text: "sweep" },
    ]);
  });

  it("a replacement is the old word struck and the new one added, in that order", () => {
    const ops = wordDiff("cite the two heads", "cite the six features");
    expect(ops).toEqual([
      { kind: "same", text: "cite the " },
      { kind: "del", text: "two heads" },
      { kind: "add", text: "six features" },
    ]);
  });

  it("unchanged text is one same op, and empty text is no op", () => {
    expect(wordDiff("as it was", "as it was")).toEqual([{ kind: "same", text: "as it was" }]);
    expect(wordDiff("", "")).toEqual([]);
    expect(hasChange(wordDiff("as it was", "as it was"))).toBe(false);
  });

  it("a whitespace-only edit changes the spacing, not the words", () => {
    const ops = wordDiff("one two", "one  two");
    expect(ops).toEqual([
      { kind: "same", text: "one" },
      { kind: "del", text: " " },
      { kind: "add", text: "  " },
      { kind: "same", text: "two" },
    ]);
    const nl = wordDiff("a b", "a\nb");
    expect(nl.filter((o) => o.kind !== "same").map((o) => o.text)).toEqual([" ", "\n"]);
  });

  it("an empty before is all insertion, an empty after all deletion", () => {
    expect(wordDiff("", "new text")).toEqual([{ kind: "add", text: "new text" }]);
    expect(wordDiff("old text", "")).toEqual([{ kind: "del", text: "old text" }]);
  });

  it("the ops reassemble both texts exactly", () => {
    const a = "The claim rests on one measurement:\n\nthe divergence appears once the pool is removed.";
    const b = "The claim rests on two measurements —\n\nthe divergence appears only once the unlabelled pool is removed, and again at zero.";
    const ops = wordDiff(a, b);
    expect(before(ops)).toBe(a);
    expect(after(ops)).toBe(b);
    expect(hasChange(ops)).toBe(true);
  });

  it("one word inside a long text is one insertion, whatever the text's length", () => {
    // ~~past the cap the diff is one removal and one insertion~~ 2026-09-16:
    // the common head and tail no longer count toward the cap.
    const a = Array.from({ length: 2100 }, (_, i) => `w${i}`).join(" ");
    const b = a.replace("w7 ", "w7 x ");
    const ops = wordDiff(a, b);
    expect(ops.filter((op) => op.kind !== "same")).toEqual([{ kind: "add", text: "x " }]);
    expect(before(ops)).toBe(a);
    expect(after(ops)).toBe(b);
  });

  it("past the cap on the differing middle the diff is one removal and one insertion, still exact", () => {
    const a = Array.from({ length: 2100 }, (_, i) => `w${i}`).join(" ");
    const b = Array.from({ length: 2100 }, (_, i) => `v${i}`).join(" ");
    const ops = wordDiff("same " + a + " same", "same " + b + " same");
    expect(ops).toEqual([
      { kind: "same", text: "same " },
      { kind: "del", text: a },
      { kind: "add", text: b },
      { kind: "same", text: " same" },
    ]);
  });

  it("tokenize keeps whitespace runs as tokens and punctuation on its own", () => {
    expect(tokenize("a  b\nc")).toEqual(["a", "  ", "b", "\n", "c"]);
    expect(tokenize("removed. It's q5-depth.md")).toEqual([
      "removed", ".", " ", "It's", " ", "q5-depth", ".", "md",
    ]);
    expect(tokenize("")).toEqual([]);
  });

  it("punctuation changes on its own, leaving the word before it unmarked", () => {
    expect(wordDiff("pool is removed.", "pool is removed, and again.")).toEqual([
      { kind: "same", text: "pool is removed" },
      { kind: "add", text: ", and again" },
      { kind: "same", text: "." },
    ]);
    expect(wordDiff("one measurement:", "two measurements:")).toEqual([
      { kind: "del", text: "one measurement" },
      { kind: "add", text: "two measurements" },
      { kind: "same", text: ":" },
    ]);
  });
});

/// His report (2026-09-16): two words cut from the end of a long reply
/// showed as the whole reply struck and added back — the LCS cap was
/// reached on the whole text. The common head and tail are stripped
/// first now, so the size of the message is not the size of the diff.
it("a trailing deletion from a long text is one strike, not a whole replacement", () => {
  const long = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(" ");
  const ops = wordDiff(long + " the end", long);
  expect(ops).toEqual([
    { kind: "same", text: long },
    { kind: "del", text: " the end" },
  ]);
});
