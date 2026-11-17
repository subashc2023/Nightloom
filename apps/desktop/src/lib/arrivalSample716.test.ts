// Item 716 part 5: the Thinking block arrival cards play each look on the real reply's thinking
// block (ThinkingArrivalSample), not on a stand-in drawing.
import { describe, expect, it } from "vitest";
import settingsSrc from "./SettingsModal.svelte?raw";
import sampleSrc from "./ThinkingArrivalSample.svelte?raw";

describe("Thinking block arrival previews (item 716 part 5)", () => {
  it("hold the real reply component, Classic's under Classic", () => {
    expect(sampleSrc).toContain('import AssistantMessage from "./AssistantMessage.svelte"');
    expect(sampleSrc).toContain('import AssistantMessageClassic from "./AssistantMessageClassic.svelte"');
    expect(sampleSrc).toMatch(/kind: "thinking"[^}]*done: false/);
    // Begun past FRESH_MS, so the reply's own arrival does not also fire at mount.
    expect(sampleSrc).toContain("Date.now() - FRESH_MS - ");
  });
  it("play each card's look on the block's .activity; the stand-in is gone", () => {
    const card = settingsSrc.slice(settingsSrc.indexOf('aria-label="Thinking block arrival"'), settingsSrc.indexOf("<!-- Item 610 (his ask"));
    expect(card).toContain("<ThinkingArrivalSample />");
    expect(card).not.toContain('class="anim-block"');
    expect(settingsSrc).toContain('arrivalBlock[style]?.querySelector<HTMLElement>(".activity")');
    expect(settingsSrc).not.toContain("  .anim-block {");
  });
});
