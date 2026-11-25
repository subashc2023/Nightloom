/**
 * Item 928 (his report, 2026-11-23: an open .md tab "showed no changes" for
 * minutes after the model said it edited the file, and was right only after he
 * left the tab and came back). The cause: a file tab (`FileView`, a file outside
 * the notes folder — his `research/…/Application-Master-List.md`) read the file
 * once, when it mounted, and again only on Reload; nothing told it the file
 * changed. The model's edits were on disk at 11:45 PM (python and sed through
 * Bash), four minutes before his wrap-up — the tab just never looked again.
 *
 * Now an open file tab reads its file again (and redraws only when it changed):
 * - after any chat's tool result that may write (every tool but the read-only
 *   ones below — the edits that night were Bash, so no edit-tool list would
 *   have caught them), text files only, so a PDF is not re-sent per tool;
 * - when any turn ends (every kind of file);
 * - when the window comes back to the front (an outside editor's save).
 */
import type { TurnEvent } from "./types";

export const fileFollow = $state({ tools: 0, turns: 0 });

/** Tools that never write a file: their results are no reason to re-read. */
const READ_ONLY = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "TodoRead",
  "ToolSearch",
  "read_note",
  "list_notes",
  "search_notes",
]);

/** Whether a turn event is a tool result that may have written a file. */
export function mayHaveWritten(ev: TurnEvent): boolean {
  const r = ev.type === "subagent" ? ev.event : ev;
  return r.type === "tool_result" && !READ_ONLY.has(r.name);
}

/** Any chat's live event (on screen, background, a subagent's or an aside's). */
export function followFileTools(ev: TurnEvent): void {
  if (mayHaveWritten(ev)) fileFollow.tools++;
}

/** A turn ended, or the notes were re-read for another reason. */
export function followFileTurns(): void {
  fileFollow.turns++;
}

/** Whether a fresh read differs from what the tab shows. Pure. */
export function fileChanged<T extends { text: string | null; data: string | null; size: number; kind: string }>(
  shown: T | null,
  fresh: T,
): boolean {
  return !shown || shown.kind !== fresh.kind || shown.size !== fresh.size || shown.text !== fresh.text || shown.data !== fresh.data;
}
