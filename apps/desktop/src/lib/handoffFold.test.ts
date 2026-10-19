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
import { noteStay, stayedFromWrapped } from "./handoffFold.svelte";

describe("383: Hand off after Stay here", () => {
  it("reopens the card Stay here closed", () => {
    noteStay("e", "wrapped");
    expect(stayedFromWrapped("e")).toBe(true);
    reopenHandoff(stayedFromWrapped("e"));
    expect(handoff.stage).toBe("wrapped");
    noteStay("f", "due");
    reopenHandoff(stayedFromWrapped("f"));
    expect(handoff.stage).toBe("due");
  });
});
