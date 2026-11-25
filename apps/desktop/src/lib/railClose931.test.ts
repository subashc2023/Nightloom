/*
 * Item 931 (his words, 2026-11-24): the right column's close button "looks different from how the one on the left side
 * looks", reads as "a drop down … of the fable five point two text", and should stay put while the column scrolls,
 * as the sidebar's does. It is now the sidebar's round edge button (`.side-toggle`), drawn by App outside the
 * column's scroll, and the column's heading holds only the model name. Jarvis and Classic both.
 */
import { describe, expect, it } from "vitest";
import appSrc from "../App.svelte?raw";
import rail from "./RightRail.svelte?raw";
import railClassic from "./RightRailClassic.svelte?raw";

describe("the right column's close button (item 931)", () => {
  it("is the sidebar's round edge button, outside the column", () => {
    expect(appSrc).toMatch(/class="side-toggle rail-toggle"\s+style:right="\{railPx - 11\}px"/);
    expect(appSrc).toContain('aria-label="Hide the right column"');
    expect(appSrc).toContain("onclick={toggleRailFold}");
    expect(appSrc).toContain("{#if railColumn && !app.asidePanel && !railFold.folded && !railFold.sliding}");
  });
  it("is gone from the heading beside the model name, in both looks", () => {
    for (const s of [rail, railClassic]) {
      expect(s).not.toContain("{@render foldButton(false)}");
      expect(s).toContain("{@render foldButton(true)}");
      expect(s).toMatch(/\.col\.folded \.fold \{[^}]*border-radius: 50%/);
    }
  });
});
