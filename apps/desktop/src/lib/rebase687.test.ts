// Item 687 (his bug, 2026-11-13): typing above typed maths keeps its offer
// (the bar no longer hides per key, so the new-chat page stops jumping), and
// a paste's lost images are said in one note.
import { describe, expect, it } from "vitest";
import { findTypedMath, rebaseTypedMath } from "./typedMath";
import { lostImagesNote, preparePaste } from "./pasteImages";
import { dialEase } from "./newChatShader";

describe("rebaseTypedMath", () => {
  const prev = "Some words\nthe area is s^2 here";
  const spans = findTypedMath(prev);
  it("finds a span to move", () => expect(spans.length).toBeGreaterThan(0));
  it("moves spans after a key typed above them", () => {
    const next = "X" + prev;
    const moved = rebaseTypedMath(prev, next, spans);
    expect(moved.length).toBe(spans.length);
    for (const s of moved) expect(next.slice(s.from, s.to)).toBe(s.src);
  });
  it("moves them after a deletion above", () => {
    const next = prev.slice(1);
    const moved = rebaseTypedMath(prev, next, spans);
    expect(moved.length).toBe(spans.length);
    for (const s of moved) expect(next.slice(s.from, s.to)).toBe(s.src);
  });
  it("keeps the same array when the edit is after them", () => {
    expect(rebaseTypedMath(prev, prev + "!", spans)).toBe(spans);
  });
  it("drops a span the edit cut into", () => {
    const at = spans[0].from + 1;
    const next = prev.slice(0, at) + prev.slice(at + 1);
    expect(rebaseTypedMath(prev, next, spans).some((s) => s.src === spans[0].src && s.from === spans[0].from)).toBe(false);
  });
});

describe("lostImagesNote", () => {
  const why = "[image: could not be fetched (the site wants your sign-in)]";
  it("spells out one shared reason", () =>
    expect(lostImagesNote(8, 10, Array(8).fill(why))).toBe(
      "8 of the 10 images from the paste were not attached: could not be fetched (the site wants your sign-in).",
    ));
  it("points at the text for several reasons", () =>
    expect(lostImagesNote(2, 2, [why, "[image: timed out]"])).toBe(
      "All 2 images from the paste were not attached; each one's place in the text says why.",
    ));
  it("says nothing with none lost", () => expect(lostImagesNote(0, 3, [])).toBe(""));
  it("preparePaste returns each loss's marker", () => {
    const r = preparePaste({ text: "[image 1]", images: [{ n: 1, src: "blob:x" }] }, 1e6);
    expect(r.whys.length).toBe(1);
    expect(r.text).toBe(r.whys[0]);
  });
});

describe("dialEase", () => {
  it("is 0 at no time, about 63% at 0.25 s, near 1 at 1 s", () => {
    expect(dialEase(0)).toBe(0);
    expect(dialEase(0.25)).toBeCloseTo(1 - Math.exp(-1), 5);
    expect(dialEase(1)).toBeGreaterThan(0.98);
  });
});

// Item 688: a Markdown table row offers no maths (its pipes are cells, not |x|).
describe("typed maths skips Markdown table rows", () => {
  it("offers nothing on a pasted table", () => {
    const t = "| # | Asked | Answer | Why |\n|---|---|---|---|\n| 3.2 | A2 | 10010 | rt = $s2 = 18 |";
    expect(findTypedMath(t)).toEqual([]);
  });
  it("still offers maths on the line after it", () => {
    const t = "| a | b |\n|---|---|\n| 1 | 2 |\nthe area is s^2";
    expect(findTypedMath(t).length).toBeGreaterThan(0);
  });
});

// Item 687 follow-up: MIPS registers are not offered as open formulas.
describe("typed maths skips MIPS registers", () => {
  it("offers nothing on a line of MIPS", () => {
    expect(findTypedMath("addi $t0, $t0, 1\njr $ra").filter((s) => /\$/.test(s.src))).toEqual([]);
  });
  it("still offers a closed formula", () => {
    expect(findTypedMath("the area is $s^2").length).toBeGreaterThan(0);
  });
});
