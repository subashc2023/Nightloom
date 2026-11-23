/** Item 906: a passage he highlights while a reply streams stays in view —
 *  the pinned view does not follow the stream down while he holds a
 *  selection in the transcript, so the pill (Ask aside, Reply, Comment)
 *  stays over it. The DOM side is measured in the 906 harness. */
import { describe, expect, it } from "vitest";
import logic from "./transcript/logic.svelte.ts?raw";
import { holdsSelection } from "./sendScroll";

const inside = { id: "inside" } as unknown as Node;
const outside = { id: "outside" } as unknown as Node;
const root = { contains: (n: Node | null) => n === inside } as unknown as Element;
const sel = (anchor: Node, focus: Node, collapsed = false, ranges = 1) =>
  ({ isCollapsed: collapsed, rangeCount: ranges, anchorNode: anchor, focusNode: focus }) as unknown as Selection;

describe("holdsSelection (item 906)", () => {
  it("is true when an end of a non-collapsed selection is inside the root", () => {
    expect(holdsSelection(sel(inside, inside), root)).toBe(true);
    expect(holdsSelection(sel(outside, inside), root)).toBe(true);
    expect(holdsSelection(sel(inside, outside), root)).toBe(true);
  });
  it("is false outside the root, collapsed, empty, or with nothing to look in", () => {
    expect(holdsSelection(sel(outside, outside), root)).toBe(false);
    expect(holdsSelection(sel(inside, inside, true), root)).toBe(false);
    expect(holdsSelection(sel(inside, inside, false, 0), root)).toBe(false);
    expect(holdsSelection(null, root)).toBe(false);
    expect(holdsSelection(sel(inside, inside), null)).toBe(false);
  });
});

describe("the streaming reply is a passage (item 906)", () => {
  it("prose in the live reply (outside every turn) counts, as the next reply", () => {
    expect(logic).toContain('prose.closest("[data-nav-live]") && prose.classList.contains("markdown") ? { turn: LIVE_TURN');
    expect(logic).toContain("a.turn !== PLAN_TURN && a.turn !== LIVE_TURN &&");
    expect(logic).toContain("a.turn === LIVE_TURN ? liveOrdinal()");
  });
});

describe("the follow effect (item 906)", () => {
  it("does not jump to the foot while he holds a selection in the transcript", () => {
    const at = logic.indexOf("followStep(pinned, presence.away, atBottom())");
    expect(at).toBeGreaterThan(0);
    const effect = logic.slice(at, logic.indexOf("measureNav();", at));
    expect(effect).toContain('step === "follow" && viewport && !holdsSelection(document.getSelection(), viewport)');
  });
});
