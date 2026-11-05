import { describe, expect, it } from "vitest";
import { HOLD_TEXT, PROSE_BLOCKS, nearestDelta, proseHolds, settledTop, type BlockEl, type Hold } from "./readingPlace";

// Item 493: the reader's place across a reply's end. A fake block: a tag,
// its text, its box, and which selectors it sits inside.
function block(tag: string, text: string, top: number, height = 60, inside: string[] = [".assistant"]): BlockEl {
  return {
    tagName: tag,
    textContent: text,
    getBoundingClientRect: () => ({ top, bottom: top + height, height }),
    closest: (sel: string) => (inside.includes(sel) ? {} : null),
  };
}
const view = { top: 100, bottom: 839, height: 739 };
const live = (el: BlockEl) => !!el.closest(".assistant") && !el.closest("[data-turn]");
const P1 = "Point 1. The replay set is sized from the cut-run numbers";
const P2 = "Point 2. Each round of the proxy evaluator is scored";

describe("proseHolds", () => {
  it("skips the thinking and tool rows, which are relabelled once recorded (the 746 px jump)", () => {
    const holds = proseHolds(
      [block("DIV", "thought for 1 s ▸ Let me look at the cut-run numbers", 102, 80, [".assistant", ".activity"]), block("P", P1, 190)],
      view,
      live,
    );
    expect(holds.map((h) => h.text)).toEqual([P1]);
  });

  it("takes the block straddling the top edge first, then the ones below it, in order", () => {
    const holds = proseHolds([block("P", "above", -40, 60), block("P", P1, 70, 80), block("P", P2, 160)], view, live);
    expect(holds.map((h) => [h.text, h.top])).toEqual([
      [P1, 70],
      [P2, 160],
    ]);
  });

  it("keeps to the live reply when its lines start in the top half (131: not the half-visible bubble)", () => {
    const bubble = block("P", "Size the replay set", 90, 40, [".user-turn", "[data-turn]"]);
    const holds = proseHolds([bubble, block("P", P1, 200)], view, live);
    expect(holds.map((h) => h.text)).toEqual([P1]);
  });

  it("falls back to any prose in view when the live reply is not in the top half", () => {
    const earlier = block("P", "Earlier answer 2.", 120, 60, [".assistant", "[data-turn]"]);
    const holds = proseHolds([earlier, block("P", P1, 700)], view, live);
    expect(holds.map((h) => h.text)).toEqual(["Earlier answer 2.", P1]);
  });

  it("drops empty and zero-height blocks, and caps the list", () => {
    const many = Array.from({ length: 9 }, (_, i) => block("P", `Point ${i}`, 110 + i * 70));
    expect(proseHolds([block("P", "  ", 110), block("DIV", "x", 120, 0), ...many], view, live)).toHaveLength(4);
  });

  it("identifies a block by the start of its text", () => {
    const long = "x".repeat(HOLD_TEXT + 50);
    expect(proseHolds([block("P", `  ${long}  `, 150)], view, live)[0].text).toHaveLength(HOLD_TEXT);
  });

  it("selects the markdown's top-level blocks and list items", () => {
    expect(PROSE_BLOCKS).toContain(".markdown > p");
    expect(PROSE_BLOCKS).toContain(".markdown > pre");
    expect(PROSE_BLOCKS).toContain(".markdown > ul > li");
  });
});

describe("nearestDelta", () => {
  const hold: Hold = { tag: "P", text: P1, top: 190 };
  it("finds the same paragraph after the swap and says how far it moved", () => {
    expect(nearestDelta(hold, [block("P", P2, 300), block("P", P1, 214.5)])).toBe(24.5);
  });
  it("picks the nearest of repeated paragraphs", () => {
    expect(nearestDelta(hold, [block("P", P1, -1500), block("P", P1, 180)])).toBe(-10);
  });
  it("is null when nothing has that tag and text — the word span the recorded reply does not have", () => {
    expect(nearestDelta({ tag: "SPAN", text: "numbers,", top: 102 }, [block("P", "numbers, and more", 102)])).toBeNull();
  });
});

describe("settledTop", () => {
  // WebKit left the view at 331 (the foot of his question) as the ghost went.
  const holds: Hold[] = [
    { tag: "DIV", text: "thought for 1 s", top: 102 },
    { tag: "P", text: P1, top: 190 },
  ];
  it("moves by the first hold found again, skipping one that is gone", () => {
    const d = (h: Hold) => (h.tag === "P" ? 855 : null);
    expect(settledTop(holds, 1188, 331, d)).toBe(1186);
  });
  it("returns to the position before the swap when no hold is found — never the clamp", () => {
    expect(settledTop(holds, 1188, 331, () => null)).toBe(1188);
  });
  it("leaves a view already in place", () => {
    expect(settledTop(holds, 1188, 1188, () => 0.4)).toBeNull();
    expect(settledTop([], 1188, 1188.5, () => null)).toBeNull();
  });
});
