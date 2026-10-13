// The model's question (`AskUserQuestion`), redesigned by backlog 354 (his pick, 2026-10-13): the tabs of look B
// on top, the questions laid out inline as in look A in one scroll, a Next after each question, the tab following
// the scroll, and once answered B's question → answer table under the call. The pure parts live here.
//
// Option previews: the CLI's own schema (2.1.296, read from the binary 2026-10-13) gives each option an optional
// `preview` — "rendered when this option is focused", markdown in a monospace box (or, for a UI that asks for
// it, an HTML fragment), single-select questions only. Nightloom draws it as preformatted text, never as HTML.
import type { AskQuestion } from "./types";

/** The question has previews to show: single-select, and at least one option carries one. */
export function hasPreviews(q: AskQuestion): boolean {
  return !q.multiSelect && q.options.some((o) => typeof o.preview === "string" && o.preview.trim() !== "");
}

/** Which option's preview to show: the one under the pointer or focus, else the picked one, else the first. */
export function previewOption(q: AskQuestion, picked: string[], hover: string | null): AskQuestion["options"][number] {
  const by = (l: string | null | undefined) => (l ? q.options.find((o) => o.label === l) : undefined);
  return by(hover) ?? by(picked[0]) ?? q.options[0];
}

/** The question is answered: an option picked or Other typed. */
export function isAnswered(picks: string[] | undefined, other: string | undefined): boolean {
  return (picks?.length ?? 0) > 0 || (other ?? "").trim() !== "";
}

/** One question's answer as the CLI takes it: the picked labels, then Other as typed, joined with ", ". */
export function answerText(picks: string[] | undefined, other: string | undefined): string {
  const chosen = [...(picks ?? [])];
  const o = (other ?? "").trim();
  if (o) chosen.push(o);
  return chosen.join(", ");
}

/**
 * The answer the card sends: the input plus `answers`, question text → answer (the shape the resumed tool
 * echoed on 2026-09-16, unchanged by 354).
 */
export function buildAnswer(
  input: unknown,
  questions: AskQuestion[],
  picks: Record<number, string[]>,
  others: Record<number, string>,
): unknown {
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    answers[q.question] = answerText(picks[i], others[i]);
  });
  return { ...(input as object), answers };
}

/**
 * Scroll-spy: the question whose tab is lit. `tops` are each question's top relative to the scroll box's
 * visible top (negative = scrolled past); a question is reached once its top is within `line` px of that top.
 * At the end of the scroll the last question is lit, however short, so its tab can be reached by scrolling —
 * unless the first question has not been reached yet (the card sits whole at the foot of a transcript scrolled
 * to its end, the usual case on the phone).
 */
export function spyIndex(tops: number[], line: number, atEnd: boolean): number {
  if (tops.length === 0) return 0;
  if (tops[0] > line) return 0;
  if (atEnd) return tops.length - 1;
  let at = 0;
  tops.forEach((t, i) => {
    if (t <= line) at = i;
  });
  return at;
}

/** The option a number key picks: 1…n are the options, n+1 is Other; anything else is null. */
export function keyPick(key: string, optionCount: number): { option: number } | { other: true } | null {
  if (!/^[1-9]$/.test(key)) return null;
  const n = Number(key);
  if (n <= optionCount) return { option: n - 1 };
  if (n === optionCount + 1) return { other: true };
  return null;
}

/** One row of the answered table. */
export interface AnsweredRow {
  header: string;
  question: string;
  answer: string;
}

/** The table's rows from the questions and the answers map (question text → answer). */
export function answeredRows(questions: AskQuestion[], answers: Record<string, string>): AnsweredRow[] {
  return questions
    .map((q, i) => ({ header: q.header || `Question ${i + 1}`, question: q.question, answer: answers[q.question] }))
    .filter((r) => typeof r.answer === "string" && r.answer !== "");
}

/**
 * The answers read back out of the tool's result, for a call answered elsewhere (the phone) or before 354: the
 * CLI writes `"question"="answer"` pairs ("Your questions have been answered: "Q"="A", …"). Unknown wording
 * reads as no answers, and the table is simply not drawn.
 */
export function answersFromResult(content: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!content) return out;
  const re = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
  for (const m of content.matchAll(re)) out[m[1].replace(/\\"/g, '"')] = m[2].replace(/\\"/g, '"');
  return out;
}
