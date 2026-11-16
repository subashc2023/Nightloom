import { describe, expect, it } from "vitest";
import { answeredWhen, askTag, extractAsk, parseAsk, pendingAsk } from "./askTag";
import { Marked } from "marked";
import markdownSrc from "./markdown.ts?raw";
import type { SessionEvent } from "./types";
import askQuestions from "./AskQuestions.svelte?raw";
import turnAsk from "./TurnAsk.svelte?raw";

const reply = (text: string): SessionEvent =>
  ({ event: "assistant_message", model: "m", blocks: [{ type: "text", text }], stop_reason: "end_turn", usage: {} }) as unknown as SessionEvent;
const mine = (text: string): SessionEvent => ({ event: "user_message", text, at: "2026-11-16T17:00:00Z" });

const ASK = "Done with the merge.\n\n<ask>\nRoll the release now,\nor after lunch?\n- Roll it now\n- **After lunch**\n</ask>\n";

describe("the turn-end question (753)", () => {
  it("reads the question and its answers, the default first", () => {
    expect(parseAsk("Which one?\n- A\n- B\n")).toEqual({ question: "Which one?", options: ["A", "B"] });
    expect(extractAsk(ASK)).toEqual({ question: "Roll the release now, or after lunch?", options: ["Roll it now", "After lunch"] });
    // No answers offered: he types one.
    expect(extractAsk("<ask>\nWhat should it be called?\n</ask>")).toEqual({ question: "What should it be called?", options: [] });
  });

  it("is text inside a fence, unclosed, or without a question; the last block wins", () => {
    expect(extractAsk("```\n<ask>\nQ?\n- A\n</ask>\n```\n")).toBeNull();
    expect(extractAsk("<ask>\nQ?\n- A\n")).toBeNull();
    expect(extractAsk("<ask>\n- A\n</ask>")).toBeNull();
    expect(extractAsk("<ask>\nFirst?\n</ask>\n\ntext\n\n<ask>\nSecond?\n- Yes\n</ask>")?.question).toBe("Second?");
  });

  it("waits until he writes: the last reply's ask is pending, a message after it answers it", () => {
    expect(pendingAsk([mine("go"), reply(ASK)])).toEqual({ ask: extractAsk(ASK), index: 1 });
    expect(pendingAsk([mine("go"), reply(ASK), mine("Roll it now")])).toBeNull();
    expect(pendingAsk([mine("go"), reply(ASK), mine("x"), reply("ok")])).toBeNull();
    expect(pendingAsk([])).toBeNull();
  });

  it("shows in the reply as a box, never as raw tags", () => {
    // (The reply renderer uses this extension; DOMPurify needs a DOM, so the extension is run alone.)
    expect(markdownSrc).toContain("replyMarked.use(askTag)");
    const html = new Marked().use(askTag).parse(ASK, { async: false }) as string;
    expect(html).toContain('class="nl-ask"');
    expect(html).toContain("Roll the release now, or after lunch?");
    expect(html).toContain("<li>After lunch</li>");
    expect(html).not.toContain("&lt;ask&gt;");
  });

  it("dates the blocker in 12-hour time", () => {
    expect(answeredWhen(new Date(2026, 10, 16, 9, 5))).toBe("2026-11-16 9:05 AM");
    expect(answeredWhen(new Date(2026, 10, 16, 0, 30))).toBe("2026-11-16 12:30 AM");
    expect(answeredWhen(new Date(2026, 10, 16, 15, 0))).toBe("2026-11-16 3:00 PM");
  });

  it("is 712's card, extended: the host hands AskQuestions a click that sends", () => {
    expect(askQuestions).toContain("onquick");
    expect(turnAsk).toContain("<AskQuestions");
    expect(turnAsk).toContain("{onquick}");
    // 712's comment on an option goes out with the answer.
    expect(turnAsk).toContain("answerText(");
    expect(turnAsk).toContain("onnote=");
  });
});
