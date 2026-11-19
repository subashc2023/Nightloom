import transcriptSrc from "./Transcript.svelte?raw";
import classicSrc from "./TranscriptClassic.svelte?raw";
import asideSrc from "./AsideTranscript.svelte?raw";
import answeredSrc from "./AskAnswered.svelte?raw";
import msgSrc from "./AssistantMessage.svelte?raw";
import msgClassicSrc from "./AssistantMessageClassic.svelte?raw";
import { describe, expect, it } from "vitest";
import {
  ASK_ANSWER_EVENT,
  ASK_CLOSED_LATER_QUESTION,
  ASK_CLOSED_LATER_WORDS,
  ASK_OPEN_NOTE,
  askBoxState,
  closedAskReason,
  closedPickText,
} from "./askSettled";

// vitest empties CSS imports (codeCopy.test.ts, askLockK.test.ts): app.css is read from disk.
const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(u: URL, enc: string): string };
const appCss = fs.readFileSync(new URL("../app.css", import.meta.url), "utf8");
const files: Record<string, string> = {
  "../app.css": appCss,
  "./Transcript.svelte": transcriptSrc,
  "./TranscriptClassic.svelte": classicSrc,
  "./AsideTranscript.svelte": asideSrc,
  "./AskAnswered.svelte": answeredSrc,
  "./AssistantMessage.svelte": msgSrc,
  "./AssistantMessageClassic.svelte": msgClassicSrc,
};
const src = (p: string) => files[p];

describe("859: a reply's question box is in one state, never a dead end", () => {
  const base = { said: null, last: true, cardDrawn: false, laterWords: false };
  it("answered: a message of his follows (851's card)", () =>
    expect(askBoxState({ ...base, said: "Yes", cardDrawn: true })).toEqual({ state: "answered", note: "" }));
  it("live: the card is drawn for it — the box hides, so the question shows once", () =>
    expect(askBoxState({ ...base, cardDrawn: true })).toEqual({ state: "live", note: "" }));
  it("open: no answer, no card (an aside) — filled, options send", () =>
    expect(askBoxState(base)).toEqual({ state: "open", note: ASK_OPEN_NOTE }));
  it("closed: a later question replaced it, even with a card drawn for the later one", () =>
    expect(askBoxState({ ...base, last: false, cardDrawn: true })).toEqual({ state: "closed", note: ASK_CLOSED_LATER_QUESTION }));
  it("closed: Claude carried on past it", () =>
    expect(askBoxState({ ...base, laterWords: true })).toEqual({ state: "closed", note: ASK_CLOSED_LATER_WORDS }));
  it("the live card wins over later words in the same reply", () =>
    expect(askBoxState({ ...base, cardDrawn: true, laterWords: true }).state).toBe("live"));
  it("every closed note says it closed without his answer, and how to answer now", () => {
    for (const n of [ASK_CLOSED_LATER_QUESTION, ASK_CLOSED_LATER_WORDS]) {
      expect(n).toMatch(/^Closed without your answer — /);
      expect(n).toMatch(/Pick one to send it now\.$/);
    }
  });
});

describe("859: the CLI's question card that closed without his answer", () => {
  it("still waiting: not closed", () => expect(closedAskReason({}, false, true, true)).toBeNull());
  it("answered: not closed", () => expect(closedAskReason({ result: { content: "x" } }, true, false, true)).toBeNull());
  it("streaming, no result yet: not closed", () => expect(closedAskReason({}, false, false, false)).toBeNull());
  it("turned down or timed out", () => expect(closedAskReason({ denied: true }, false, false, false)).toMatch(/turned down or timed out/));
  it("returned with no answer", () =>
    expect(closedAskReason({ result: { content: "no answer" } }, false, false, true)).toMatch(/returned with no answer/));
  it("the turn ended first", () => expect(closedAskReason({}, false, false, true)).toMatch(/turn ended before you answered/));
  it("a pick sends the label, or Header: label among several", () => {
    expect(closedPickText("Scope", "Small", false)).toBe("Small");
    expect(closedPickText("Scope", "Small", true)).toBe("Scope: Small");
  });
});

describe("859: wiring", () => {
  it("the box is hidden while live, and filled while open or closed", () => {
    const css = src("../app.css");
    expect(css).toMatch(/\.nl-ask\[data-state="live"\] \{\s*display: none;/);
    expect(css).toMatch(/\.nl-ask:is\(\[data-state="open"\], \[data-state="closed"\]\) \{\s*background: var\(--raised\);/);
    expect(css).toMatch(/\.nl-ask\[data-note\]::after \{\s*content: attr\(data-note\);/);
  });
  it("both transcripts take a pick and send it as his next message", () => {
    for (const f of ["./Transcript.svelte", "./TranscriptClassic.svelte"]) {
      const s = src(f);
      expect(s).toContain("v.addEventListener(ASK_ANSWER_EVENT, take)");
      expect(s).toContain("void answerTurnAsk(askTarget(), d.ask, d.answer)");
      expect(s).toContain("e.defaultPrevented");
    }
    expect(src("./Transcript.svelte")).toContain("void src.actions.answer(d.answer)");
  });
  it("an aside sends a pick as its follow-up", () => {
    const s = src("./AsideTranscript.svelte");
    expect(s).toContain("answer: answerPick,");
    expect(s).toMatch(/async function answerPick[\s\S]*?followUpAside\(words, aside/);
  });
  it("the CLI's card is filled when settled, and told when its turn ended, in both layouts", () => {
    expect(src("./AskAnswered.svelte")).toMatch(/\.aa \{[\s\S]*?background: var\(--raised\);/);
    for (const f of ["./AssistantMessage.svelte", "./AssistantMessageClassic.svelte"])
      expect(src(f).split("<AskAnswered call={seg.call} ended={!streaming} />").length - 1).toBe(2);
  });
  it("one event name", () => expect(ASK_ANSWER_EVENT).toBe("nl-ask-answer"));
});
