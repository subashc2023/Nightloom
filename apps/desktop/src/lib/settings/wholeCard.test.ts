// Item 719: a click anywhere on any option card in Settings picks it.
import { describe, expect, it } from "vitest";
import settingsModal from "../SettingsModal.svelte?raw";
import { clickPicksCard, type CardNode } from "./wholeCard";

/** A stand-in element: a tag, its attributes, its parent. `closest` matches the selector list wholeCard uses. */
function el(tag: string, attrs: Record<string, string> = {}, parent: CardNode | null = null): CardNode {
  const node: CardNode = {
    getAttribute: (n) => attrs[n] ?? null,
    closest(sel) {
      const isControl =
        ["button", "input", "select", "textarea", "label"].includes(tag) ||
        (tag === "a" && "href" in attrs) ||
        attrs.role === "radio" ||
        attrs.role === "button";
      if (sel.includes("button") && isControl) return node;
      return parent ? parent.closest(sel) : null;
    },
  };
  return node;
}

describe("a click anywhere on an option card picks it (item 719)", () => {
  const card = el("div", { class: "anim" }, el("div", { role: "radiogroup" }));
  it("picks on the preview: the stage, a canvas inside it, the new-chat background's wheel, the foot", () => {
    const stage = el("div", { class: "anim-stage" }, card);
    expect(clickPicksCard(stage)).toBe(true);
    expect(clickPicksCard(el("canvas", {}, el("div", { class: "gp" }, card)))).toBe(true);
    expect(clickPicksCard(el("span", { class: "gp-wheel" }, el("div", { class: "gp" }, card)))).toBe(true);
    expect(clickPicksCard(el("div", { class: "mini-bubble" }, el("div", { class: "mini-view" }, stage)))).toBe(true);
    expect(clickPicksCard(el("div", { class: "anim-foot" }, card))).toBe(true);
    expect(clickPicksCard(card)).toBe(true);
  });
  it("leaves the pick's own click and Preview alone", () => {
    const pick = el("button", { role: "radio" }, card);
    expect(clickPicksCard(pick)).toBe(false);
    expect(clickPicksCard(el("span", { class: "anim-name" }, pick))).toBe(false);
    expect(clickPicksCard(el("button", { class: "ns-btn" }, el("div", { class: "anim-foot" }, card)))).toBe(false);
  });
  it("every option card group in Settings carries it", () => {
    const groups = [
      'aria-label="Thinking block arrival"',
      'aria-label="Thinking motion"',
      'aria-label="Reply text"',
      "aria-label={mk.title}", // Rewind, Delete, … (MOTION_KINDS)
      'aria-label="New-chat background"',
    ];
    for (const g of groups) {
      const at = settingsModal.indexOf(g);
      expect(at, g).toBeGreaterThan(0);
      const next = settingsModal.indexOf('class="anim"', at);
      expect(settingsModal.slice(next, next + 60), g).toContain("use:wholeCardPicks");
    }
    const cards = settingsModal.match(/<div class="anim"[^>]*>/g) ?? [];
    expect(cards.length).toBe(groups.length);
    expect(cards.every((c) => c.includes("use:wholeCardPicks"))).toBe(true);
  });
});
