import { describe, expect, it } from "vitest";
import { CARD_GAP, CARD_WIDTH, EDGE_MARGIN, MIN_CARD_HEIGHT, chooseSide, placeCard, type Rect } from "./asideCard";

// The floating aside card's geometry (nightshift backlog 141): the card
// opens under the passage and stays on screen; a passage near the
// viewport's foot gets the card above it instead.

const vp: Rect = { top: 100, left: 0, bottom: 800, right: 1000 };
// The scrolled column, 760 wide, centred, starting 40px above the viewport.
const host: Rect = { top: 60, left: 120, bottom: 2000, right: 880 };

function sel(top: number, left = 200, height = 20, width = 300): Rect {
  return { top, left, bottom: top + height, right: left + width };
}

describe("chooseSide", () => {
  it("opens below a passage with room under it", () => {
    expect(chooseSide(sel(300), vp, 120)).toBe("below");
  });

  it("opens above a passage near the viewport's foot", () => {
    // 20px of the passage at 760–780: 8px below leaves nothing for a card.
    expect(chooseSide(sel(760), vp, 120)).toBe("above");
  });

  it("falls back to whichever side has more room when neither fits", () => {
    const short: Rect = { top: 100, left: 0, bottom: 300, right: 1000 };
    expect(chooseSide(sel(150), short, 400)).toBe("below");
    expect(chooseSide(sel(250), short, 400)).toBe("above");
  });
});

describe("placeCard", () => {
  it("sits under the passage, its left edge at the selection's, in the host's frame", () => {
    const p = placeCard(sel(300), host, vp, 120, "below");
    expect(p.top).toBe(300 + 20 + CARD_GAP - host.top);
    expect(p.left).toBe(200 - host.left);
    expect(p.width).toBe(CARD_WIDTH);
    expect(p.side).toBe("below");
  });

  it("keeps the card on screen: the room below is its ceiling", () => {
    const p = placeCard(sel(300), host, vp, 120, "below");
    expect(p.maxHeight).toBe(vp.bottom - EDGE_MARGIN - (320 + CARD_GAP));
    expect(p.top + host.top + p.maxHeight).toBeLessThanOrEqual(vp.bottom);
  });

  it("above: the card's foot is the gap over the passage", () => {
    const p = placeCard(sel(700), host, vp, 120, "above");
    expect(p.top + host.top + 120 + CARD_GAP).toBe(700);
    expect(p.side).toBe("above");
  });

  it("above, taller than the room: the card takes the room and scrolls inside", () => {
    const p = placeCard(sel(400), host, vp, 900, "above");
    const room = 400 - CARD_GAP - (vp.top + EDGE_MARGIN);
    expect(p.maxHeight).toBe(room);
    expect(p.top + host.top).toBe(vp.top + EDGE_MARGIN);
  });

  it("never asks for less than the minimum height", () => {
    const p = placeCard(sel(770), host, vp, 120, "below");
    expect(p.maxHeight).toBe(MIN_CARD_HEIGHT);
  });

  it("a passage out of view gets half the viewport, never more than the viewport", () => {
    // Scrolled far past: the passage is 2,000px above the viewport's top.
    const p = placeCard(sel(-2000), host, vp, 120, "below");
    expect(p.maxHeight).toBe((vp.bottom - vp.top) / 2);
    expect(p.top).toBe(-2000 + 20 + CARD_GAP - host.top);
    // The same above, and the card's foot still sits the gap over it.
    const a = placeCard(sel(3000), host, vp, 120, "above");
    expect(a.maxHeight).toBe((vp.bottom - vp.top) / 2);
    expect(a.top + host.top + 120 + CARD_GAP).toBe(3000);
  });

  it("is clamped inside the host's width", () => {
    const right = placeCard(sel(300, 800), host, vp, 120, "below");
    expect(right.left + right.width).toBe(host.right - host.left);
    const narrow: Rect = { ...host, left: 300, right: 600 };
    const p = placeCard(sel(300, 100), narrow, vp, 120, "below");
    expect(p.left).toBe(0);
    expect(p.width).toBe(300);
  });
});
