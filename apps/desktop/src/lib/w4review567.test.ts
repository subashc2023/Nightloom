import { describe, expect, it } from "vitest";
import viewSrc from "./ClaudeBrowserView.svelte?raw";
import { stopHolds } from "./browserSteps";

describe("567 Stop Claude's pressed look (w4 review)", () => {
  it("holds while the turn it was pressed on runs", () => {
    expect(stopHolds({ at: 100 }, { startedAt: 100 })).toBe(true);
  });
  it("clears for the chat's next turn, which starts later", () => {
    expect(stopHolds({ at: 100 }, { startedAt: 250 })).toBe(false);
  });
  it("clears when no turn runs, and is off before a press", () => {
    expect(stopHolds({ at: 100 }, null)).toBe(false);
    expect(stopHolds(null, { startedAt: 100 })).toBe(false);
  });
  it("the view reads it, with no effect left to clear it", () => {
    expect(viewSrc).toMatch(/stopHolds\(pressedOn, turnRow\)/);
    expect(viewSrc).not.toMatch(/if \(!turnRow\) stopping = false/);
  });
});
