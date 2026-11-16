// Item 712: a comment on each option of a question card, sent with a picked one.
import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import AskQuestions from "./AskQuestions.svelte";
import promptSrc from "./ApprovalPrompt.svelte?raw";
import remoteSrc from "../remote/Remote.svelte?raw";
import { answerParts, answerText, buildAnswer, withNote } from "./askQuestions";
import { questionAnswer } from "../remote/client";
import type { AskQuestion } from "./types";

const single: AskQuestion = { question: "Which store?", header: "Store", multiSelect: false, options: [{ label: "SQLite", description: "" }, { label: "Files", description: "" }] } as AskQuestion;
const multi: AskQuestion = { question: "Which checks?", header: "Checks", multiSelect: true, options: [{ label: "vitest", description: "" }, { label: "clippy", description: "" }] } as AskQuestion;

describe("the answer carries the comment (712)", () => {
  it("a picked option with a comment reads `Label (note: …)`, one line; an unpicked option's comment is not sent", () => {
    expect(withNote("SQLite", "  but keep\n the WAL ")).toBe("SQLite (note: but keep the WAL)");
    expect(withNote("SQLite", "   ")).toBe("SQLite");
    expect(answerText(["SQLite"], "", { SQLite: "keep the WAL", Files: "no" })).toBe("SQLite (note: keep the WAL)");
  });

  it("single and multi-select, with Other, on the desktop and the phone alike", () => {
    const picks = { 0: ["Files"], 1: ["vitest", "clippy"] };
    const others = { 1: "and fmt" };
    const notes = { 0: { Files: "one per chat" }, 1: { clippy: "both steps" } };
    const want = { "Which store?": "Files (note: one per chat)", "Which checks?": "vitest, clippy (note: both steps), and fmt" };
    expect((buildAnswer({ questions: [single, multi] }, [single, multi], picks, others, notes) as { answers: unknown }).answers).toEqual(want);
    expect((questionAnswer({ questions: [single, multi] }, picks, others, notes) as { answers: unknown }).answers).toEqual(want);
    // No comments: the answer is what it always was.
    expect((buildAnswer({}, [multi], { 0: ["vitest"] }, {}) as { answers: Record<string, string> }).answers["Which checks?"]).toBe("vitest");
  });

  it("the answered table keeps a commented label as one chip", () => {
    expect(answerParts("vitest, clippy (note: both steps), and fmt", ["vitest", "clippy"])).toEqual(["vitest", "clippy (note: both steps)", "and fmt"]);
    expect(answerParts("Files (note: one, per chat)", ["SQLite", "Files"])).toEqual(["Files (note: one, per chat)"]);
  });
});

describe("the card (712)", () => {
  const base = { questions: [single], idBase: "c1", picks: {}, others: {}, ontoggle: () => {}, onother: () => {} };
  it("each option has a comment button when the host takes comments; none without", () => {
    const { body } = render(AskQuestions, { props: { ...base, onnote: () => {} } });
    expect(body.match(/class="aq-cb/g)?.length).toBe(2);
    expect(body).toContain('aria-label="comment on SQLite"');
    expect(render(AskQuestions, { props: base }).body).not.toContain("aq-cb");
  });
  it("an option holding a comment shows it, open, its button lit", () => {
    const { body } = render(AskQuestions, { props: { ...base, picks: { 0: ["SQLite"] }, notes: { 0: { SQLite: "keep the WAL" } }, onnote: () => {} } });
    expect(body).toMatch(/class="aq-cb[^"]*has/);
    expect(body).toContain("keep the WAL");
    expect(body.match(/class="aq-cmin[ "]/g)?.length).toBe(1);
  });
  it("both hosts own the comments and send them", () => {
    expect(promptSrc).toContain("buildAnswer(req.input, questions, picks, others, notes)");
    expect(promptSrc).toContain("onnote={(i, label, v) =>");
    expect(remoteSrc).toContain("optNotes[req.id] ?? {}))}>Answer</button>");
  });
});
