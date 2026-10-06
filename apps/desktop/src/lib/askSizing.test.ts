import { describe, expect, it } from "vitest";
import { cardBox, MIN_HEIGHT } from "./askSizing";

// The interruption cards' height rule (nightshift backlog 314): the question
// card grows with its content to 60 % of the window and then scrolls as a
// whole, with no dragged height; the plan card keeps its two-thirds cap and
// drag; the permission prompt has neither.

describe("cardBox — the question card", () => {
  it("is capped at 60 % of the window, and the card scrolls as one", () => {
    expect(cardBox("question", false, null, 549, 780)).toEqual({
      height: null,
      maxHeight: 468,
      scrollsWhole: true,
      draggable: false,
    });
  });

  it("ignores a dragged height saved before 314", () => {
    const b = cardBox("question", false, 180, 549, 780);
    expect(b.height).toBeNull();
    expect(b.maxHeight).toBe(468);
    expect(b.draggable).toBe(false);
  });

  it("is never taller than the transcript it sits in", () => {
    expect(cardBox("question", false, null, 300, 780).maxHeight).toBe(276);
  });

  it("keeps a floor in a tiny window", () => {
    expect(cardBox("question", false, null, 100, 200).maxHeight).toBe(MIN_HEIGHT);
  });

  it("has no cap before the window is measured, or when folded", () => {
    expect(cardBox("question", false, null, 0, 0).maxHeight).toBeNull();
    expect(cardBox("question", true, null, 549, 780).maxHeight).toBeNull();
  });

  it("treats NaN or infinite heights as not measured", () => {
    expect(cardBox("question", false, null, NaN, NaN).maxHeight).toBeNull();
    expect(cardBox("question", false, null, NaN, 780).maxHeight).toBe(468);
    expect(cardBox("question", false, null, Infinity, 780).maxHeight).toBe(468);
    expect(cardBox("plan", false, NaN, 549, 780)).toMatchObject({ height: null, maxHeight: 366 });
  });
});

describe("cardBox — the plan card and the permission prompt are unchanged", () => {
  it("the plan card: two thirds of the transcript, its body scrolling inside", () => {
    expect(cardBox("plan", false, null, 549, 780)).toEqual({
      height: null,
      maxHeight: 366,
      scrollsWhole: false,
      draggable: true,
    });
  });

  it("the plan card keeps a dragged height", () => {
    expect(cardBox("plan", false, 240, 549, 780)).toMatchObject({ height: 240, maxHeight: null });
  });

  it("the permission prompt: no cap, no drag", () => {
    expect(cardBox("call", false, 240, 549, 780)).toEqual({
      height: null,
      maxHeight: null,
      scrollsWhole: false,
      draggable: false,
    });
  });
});
