import { describe, expect, it } from "vitest";
import { fold, isFolded, unfold } from "./handoffFold.svelte";

describe("383: the hand-off card's Minimize", () => {
  it("folds per chat and survives looking at another chat", () => {
    fold("a", "wrapped");
    expect(isFolded("a", "wrapped")).toBe(true);
    expect(isFolded("b", "wrapped")).toBe(false);
    expect(isFolded("a", "wrapped")).toBe(true);
  });
  it("opens in full at the next stage, once", () => {
    fold("c", "due");
    expect(isFolded("c", "due")).toBe(true);
    expect(isFolded("c", "wrapped")).toBe(false);
  });
  it("Expand unfolds; no chat never folds", () => {
    fold("d", "wrapped");
    unfold("d");
    expect(isFolded("d", "wrapped")).toBe(false);
    fold(null, "due");
    expect(isFolded(null, "due")).toBe(false);
  });
});

import { handoff, reopenHandoff } from "./handoff.svelte";
import { noteStay } from "./handoffFold.svelte";

describe("383: Hand off after Stay here", () => {
  it("reopens the notice; item 506: the wrapped card is gone, whatever was stayed past", () => {
    noteStay("e");
    handoff.stage = "wrapped";
    reopenHandoff();
    expect(handoff.stage).toBe("due");
  });
});

describe("383 review: Stay here ends a fold", () => {
  it("a notice folded, then wrapped up and stayed past, re-asks in full", () => {
    fold("g", "due");
    noteStay("g");
    expect(isFolded("g", "due")).toBe(false);
  });
});
