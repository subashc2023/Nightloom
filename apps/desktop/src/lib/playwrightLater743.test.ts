import { describe, expect, it } from "vitest";
import playwrightSource from "./PlaywrightCard.svelte?raw";
import promptSource from "./ApprovalPrompt.svelte?raw";

/*
 * Nightshift item 743: the Mac's Playwright card gets "Not now — carry on", the same words, hover text and
 * `later` reply as ApprovalPrompt's call cards (approvalLater743.test.ts covers resolveApproval("later") itself).
 */
describe("743: Not now — carry on on the Mac's Playwright card", () => {
  it("the card carries the button, sending `later` through its own decide (the note routed like Allow)", () => {
    const buttons = playwrightSource.match(/<button[^>]*data-act="later"[^>]*onclick=\{\(\) => decide\("later"\)\}>Not now — carry on<\/button>/g) ?? [];
    expect(buttons.length).toBe(1);
  });

  it("it is off once the card is answered, like the other three", () => {
    expect(playwrightSource).toMatch(/data-act="later" disabled=\{done\}/);
  });

  it("same hover text as the approval card's", () => {
    const tipOf = (src: string) => src.match(/const LATER_TIP = "([^"]+)";/)?.[1];
    expect(tipOf(playwrightSource)).toBeDefined();
    expect(tipOf(playwrightSource)).toBe(tipOf(promptSource));
  });
});
