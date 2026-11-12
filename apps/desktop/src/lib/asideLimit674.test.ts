import { describe, expect, it } from "vitest";
import { asideEvents } from "./asideTranscript";
import { pauseLabel } from "./limit";
import type { AsideTurn } from "./state.svelte";
import asideTranscriptSrc from "./AsideTranscript.svelte?raw";
import transcriptSrc from "./Transcript.svelte?raw";

/** Item 674 follow-up: the usage-limit card, shared by the chat and an aside. */
const pause = { session: null, resetsAtMs: Date.UTC(2026, 10, 12, 15, 35), window: "five_hour", text: "You've hit your session limit", subagents: [], agents: [], hitAtMs: 0 };
const turn = (over: Partial<AsideTurn> = {}): AsideTurn => ({
  seq: 1,
  question: "q",
  partial: "a",
  answer: "a",
  error: null,
  cancelled: false,
  cacheRead: 0,
  ...over,
});

describe("674: an aside's limit card", () => {
  it("the card's line names what happens at the reset", () => {
    const before = pause.resetsAtMs - 60_000;
    expect(pauseLabel(pause, before)).toMatch(/^paused by the 5-hour limit · resumes at /);
    expect(pauseLabel(pause, before, "ask again")).toMatch(/^paused by the 5-hour limit · ask again at /);
  });

  it("the last answer's limit is the card, not an error note too; an earlier one keeps its note", () => {
    const err = "You've hit your session limit";
    const last = asideEvents({ turns: [turn({ seq: 1 }), turn({ seq: 2, error: err, limit: pause })] });
    expect([...last.notes.values()].flat().filter((n) => n.kind === "error")).toEqual([]);
    const earlier = asideEvents({ turns: [turn({ seq: 1, error: err, limit: pause }), turn({ seq: 2 })] });
    expect([...earlier.notes.values()].flat().map((n) => n.text)).toEqual([err]);
  });

  it("one card in the transcript, read from the source; the aside builds its own with Ask again", () => {
    expect(transcriptSrc).toMatch(/\{#if src\.limit\}/);
    expect(transcriptSrc).not.toMatch(/app\.limitPause/);
    expect(asideTranscriptSrc).toMatch(/limit: limitCard,/);
    expect(asideTranscriptSrc).toMatch(/"Ask again"/);
  });
});
