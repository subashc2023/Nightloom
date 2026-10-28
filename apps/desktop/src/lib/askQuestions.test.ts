import { describe, expect, it } from "vitest";
import {
  answerText,
  answeredRows,
  answersFromResult,
  buildAnswer,
  hasPreviews,
  isAnswered,
  keyPick,
  previewOption,
  spyIndex,
} from "./askQuestions";
import { questionAnswer } from "../remote/client";
import type { AskQuestion } from "./types";

const help: AskQuestion = {
  question: "Which help style?",
  header: "Help style",
  options: [{ label: "Write the tests" }, { label: "Sketch the cases" }],
};
const cover: AskQuestion = {
  question: "Which structures?",
  header: "Coverage",
  multiSelect: true,
  options: [{ label: "AVL tree" }, { label: "Hash map" }, { label: "Priority queue" }],
};
const layout: AskQuestion = {
  question: "Layout?",
  options: [
    { label: "Per structure", preview: "tests/\n  a.cpp" },
    { label: "One file", preview: "// one" },
    { label: "Starter" },
  ],
};

describe("354 answers (nothing about answering lost)", () => {
  it("joins the picks and Other as typed, the shape the CLI takes", () => {
    expect(answerText(["AVL tree", "Priority queue"], "  the skip list ")).toBe("AVL tree, Priority queue, the skip list");
    expect(answerText(undefined, "")).toBe("");
    const out = buildAnswer({ questions: [help, cover] }, [help, cover], { 0: ["Sketch the cases"], 1: ["AVL tree"] }, { 1: "Trie" });
    expect(out).toEqual({
      questions: [help, cover],
      answers: { "Which help style?": "Sketch the cases", "Which structures?": "AVL tree, Trie" },
    });
  });

  it("sends exactly what the phone sends (the two cards must not drift)", () => {
    const picks = { 0: ["Write the tests"], 1: ["Hash map", "AVL tree"] };
    const others = { 1: "x" };
    const input = { questions: [help, cover] };
    expect(buildAnswer(input, [help, cover], picks, others)).toEqual(questionAnswer(input, picks, others));
  });

  it("counts a question answered by a pick or by Other alone, not by blank Other", () => {
    expect(isAnswered(["a"], "")).toBe(true);
    expect(isAnswered([], " x ")).toBe(true);
    expect(isAnswered([], "   ")).toBe(false);
    expect(isAnswered(undefined, undefined)).toBe(false);
  });
});

describe("354 previews (the CLI's option `preview`, single-select only)", () => {
  it("shows previews only for a single-select question with one", () => {
    expect(hasPreviews(layout)).toBe(true);
    expect(hasPreviews(help)).toBe(false);
    expect(hasPreviews({ ...layout, multiSelect: true })).toBe(false);
    expect(hasPreviews({ question: "q", options: [{ label: "a", preview: "  " }] })).toBe(false);
  });

  it("previews the hovered or focused option, else the picked one, else the first", () => {
    expect(previewOption(layout, [], null).label).toBe("Per structure");
    expect(previewOption(layout, ["One file"], null).label).toBe("One file");
    expect(previewOption(layout, ["One file"], "Starter").label).toBe("Starter");
    expect(previewOption(layout, ["gone"], "also gone").label).toBe("Per structure");
  });
});

describe("354 scroll-spy", () => {
  it("lights the last question whose top has reached the line under the strip", () => {
    expect(spyIndex([0, 300, 600], 28, false)).toBe(0);
    expect(spyIndex([-320, 20, 300], 28, false)).toBe(1);
    expect(spyIndex([-700, -400, 10], 28, false)).toBe(2);
  });
  it("lights the last question at the end of the scroll, so a short last question still gets its tab", () => {
    expect(spyIndex([-500, -100, 200], 28, true)).toBe(2);
  });
  it("keeps the first lit while the card sits whole below the top (the phone, scrolled to its end)", () => {
    expect(spyIndex([120, 400, 700], 28, true)).toBe(0);
  });
  it("is safe with no questions", () => {
    expect(spyIndex([], 28, true)).toBe(0);
  });
});

describe("354 number keys", () => {
  it("maps 1…n to the options and n+1 to Other; nothing else", () => {
    expect(keyPick("1", 3)).toEqual({ option: 0 });
    expect(keyPick("3", 3)).toEqual({ option: 2 });
    expect(keyPick("4", 3)).toEqual({ other: true });
    expect(keyPick("5", 3)).toBeNull();
    expect(keyPick("0", 3)).toBeNull();
    expect(keyPick("a", 3)).toBeNull();
    expect(keyPick("12", 3)).toBeNull();
  });
});

describe("354 answered table", () => {
  it("lists header → answer in question order, skipping unanswered ones, a missing header numbered by place", () => {
    const rows = answeredRows([help, { ...cover, header: "" }, layout], {
      "Which help style?": "Sketch the cases",
      "Layout?": "One file",
    });
    expect(rows).toEqual([
      { header: "Help style", question: "Which help style?", answer: "Sketch the cases" },
      { header: "Question 3", question: "Layout?", answer: "One file" },
    ]);
  });

  it("reads the answers back out of the CLI's result text", () => {
    const content =
      'Your questions have been answered: "Which help style?"="Sketch the cases", "Which structures?"="AVL tree, Trie". You can now continue.';
    expect(answersFromResult(content)).toEqual({
      "Which help style?": "Sketch the cases",
      "Which structures?": "AVL tree, Trie",
    });
  });

  it("reads unknown wording, or none, as no answers", () => {
    expect(answersFromResult("The user skipped the question")).toEqual({});
    expect(answersFromResult(null)).toEqual({});
  });
});
