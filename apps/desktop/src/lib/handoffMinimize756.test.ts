// Item 756: the hand-off card minimizes to one line and opens again (click or ⌘Z), its state kept on disk.
import { describe, expect, it } from "vitest";
import { cardMinimized, carryGoal, miniText, setCardMinimized, setCarryGoal } from "./handoffButton";
import buttonSrc from "./handoffButton.ts?raw";
import liveSrc from "./liveHtml.ts?raw";
import transcriptSrc from "./Transcript.svelte?raw";
import classicSrc from "./TranscriptClassic.svelte?raw";

const files: Record<string, string> = {
  "./handoffButton.ts": buttonSrc,
  "./liveHtml.ts": liveSrc,
  "./Transcript.svelte": transcriptSrc,
  "./TranscriptClassic.svelte": classicSrc,
};
const src = (p: string) => files[p];

describe("756: the minimized flag", () => {
  it("is kept per card, apart from the goal and ticks", () => {
    expect(cardMinimized("c756", 4)).toBe(false);
    setCarryGoal("c756", 4, "my typed goal");
    setCardMinimized("c756", 4, true);
    expect(cardMinimized("c756", 4)).toBe(true);
    expect(cardMinimized("c756", 6)).toBe(false);
    expect(carryGoal("c756", 4)).toBe("my typed goal");
    setCardMinimized("c756", 4, false);
    expect(cardMinimized("c756", 4)).toBe(false);
    expect(carryGoal("c756", 4)).toBe("my typed goal");
  });
  it("is written to the persisted view state, so a relaunch keeps it", () => {
    const s = src("./handoffButton.ts");
    // viewSet's third argument is the default: no `session` lifetime, so it persists.
    expect(s).toMatch(/viewSet\(minKey\(chat, index\), on, false\)/);
  });
});

describe("756: the one line's text", () => {
  const prompt = "Goal: finish the scorer\n\nRead HANDOFF.md first.";
  it("is the goal he typed, else the card's goal, else the prompt's first line", () => {
    expect(miniText({ chat: "c756b", index: 1, prompt, carry: null })).toBe("finish the scorer");
    expect(miniText({ chat: "c756b", index: 1, prompt, carry: { goal: "the carry goal" } as never })).toBe("the carry goal");
    setCarryGoal("c756b", 1, "typed on the card");
    expect(miniText({ chat: "c756b", index: 1, prompt, carry: { goal: "the carry goal" } as never })).toBe("typed on the card");
  });
});

describe("756: wiring", () => {
  it("liveHtml leaves the – button and the line alone", () => {
    const s = src("./liveHtml.ts");
    expect(s).toContain('n.classList.contains("handoff-mini")');
    expect(s).toContain('n.classList.contains("handoff-min")');
  });
  it("both transcripts put a minimize on the chat's undo stack", () => {
    for (const f of ["./Transcript.svelte", "./TranscriptClassic.svelte"]) {
      const s = src(f);
      expect(s).toContain("onFold: (minimized, undo, redo)");
      expect(s).toMatch(/pushUndo\(from, \{/);
    }
  });
  it("minimized, the card hides its parts rather than removing them", () => {
    // app.css's rules: vitest empties CSS imports, so they are measured in WebKit
    // (nightshift-code notes/runner-design/minimize-harness/).
    const s = src("./handoffButton.ts");
    expect(s).toMatch(/function paintCard[\s\S]*classList\.toggle\(MINIMIZED_CLASS, on\)/);
  });
});
