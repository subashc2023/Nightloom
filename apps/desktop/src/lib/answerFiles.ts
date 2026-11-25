/**
 * Files on a question card's answer (item 975, extending 712; T3 Code's
 * "question attachments", per the 762 survey). Dropped or pasted on a
 * question's free-text answer (Other), they are chips in the drafts store
 * under the card's own key per question — the composer's routes and caps
 * (`acceptFiles`), kept across a chat switch and a relaunch as a draft's
 * are, and apart from the message box's draft. On Answer they are saved in
 * the chat's attachments folder and the answer names their paths: a
 * deferred call's answer is text in its input, so the model opens them
 * with its own tools.
 */
import type { Attachment } from "./types";

/** The drafts-store key of question `i`'s files on card `reqId`. */
export function answerFilesKey(reqId: string, i: number): string {
  return `ask-answer:${reqId}:${i}`;
}

/**
 * Item 983: the drafts-store key of the files on a turn-end question card's answer (`TurnAsk`, by its
 * `idBase`, chat + reply) and on a Needs-you row's reply box (by row id). Those answers go as his next
 * message, so the chips ride that message as the composer's attachments do — nothing is saved first.
 */
export function turnAskFilesKey(idBase: string): string {
  return `turn-ask:${idBase}`;
}
export function needsReplyFilesKey(rowId: string): string {
  return `needs-reply:${rowId}`;
}

/** Item 983: whether a message answer may go with these chips — none still converting. */
export function chipsReady(chips: readonly Attachment[]): boolean {
  return chips.every((c) => !c.pending);
}

/** What `save_answer_files` writes: every chip's name and bytes, whatever
 *  its kind (an image or a PDF too — the model reads them by path). */
export function filesToSave(chips: readonly Attachment[]): { name: string; data: string }[] {
  return chips.filter((c) => !c.pending && c.data).map((c) => ({ name: c.name, data: c.data }));
}

/** An answer with the saved files' note after it; the note alone when he
 *  gave the files and no words. */
export function withFilesNote(answer: string, note: string): string {
  const a = answer.trim();
  const n = note.trim();
  if (!n) return a;
  return a ? `${a}\n\n${n}` : n;
}
