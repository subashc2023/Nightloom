import { describe, expect, it } from "vitest";
import topBar from "./TopBar.svelte?raw";
import composer from "./Composer.svelte?raw";
import { asidePick, askAsidePick, askIsFor, pickOpenFor } from "./asidePick.svelte";

/**
 * Item 657 (his "the aside * subscription button doesn't do anything in the
 * aside page"): the aside tab's engine chip was a bare span; it is a button
 * that opens the aside's own pickers — its composer's model menu.
 */
const chip = (() => {
  const a = topBar.indexOf('class="ns-chip model aside-kind"');
  const b = topBar.indexOf("</button>", a);
  return topBar.slice(topBar.lastIndexOf("<", a), b);
})();

describe("657: the aside chip opens the aside's pickers", () => {
  it("is a button with a handler, not a span", () => {
    expect(chip.startsWith("<button")).toBe(true);
    expect(chip).toMatch(/onclick=\{asideChipClick\}/);
    expect(chip).toMatch(/onpointerdown=\{asideChipDown\}/);
    expect(chip).toMatch(/aria-expanded=\{asidePickOpen\}/);
    expect(chip).toMatch(/aria-haspopup="menu"/);
  });

  it("asks for its own chat and thread", () => {
    expect(topBar).toMatch(/askAsidePick\(asideChat, aside\.id\)/);
  });

  it("the tab's composer answers the ask with its model menu", () => {
    expect(composer).toMatch(/askIsFor\(asidePick, asideChat, aside\.id, seenPick\)/);
    expect(composer).toMatch(/if \(!aside \|\| !takeFocus\) return;\n\s+if \(!askIsFor/);
    expect(composer).toMatch(/if \(menu !== "model"\) openMenu\("model"\)/);
  });

  it("an ask is for one thread of one chat, once", () => {
    const before = asidePick.n;
    askAsidePick("s1", 7);
    expect(asidePick.n).toBe(before + 1);
    expect(askIsFor(asidePick, "s1", 7, before)).toBe(true);
    expect(askIsFor(asidePick, "s1", 7, asidePick.n)).toBe(false); // seen
    expect(askIsFor(asidePick, "s1", 8, before)).toBe(false); // another thread
    expect(askIsFor(asidePick, "s2", 7, before)).toBe(false); // another chat
    expect(askIsFor(asidePick, null, 7, before)).toBe(false);
  });

  it("reads open only for the thread whose picker is open", () => {
    expect(pickOpenFor({ openChat: "s1", openThread: 7 }, "s1", 7)).toBe(true);
    expect(pickOpenFor({ openChat: "s1", openThread: 7 }, "s1", 8)).toBe(false);
    expect(pickOpenFor({ openChat: null, openThread: null }, "s1", 7)).toBe(false);
    expect(pickOpenFor({ openChat: null, openThread: null }, null, null)).toBe(false);
  });
});
