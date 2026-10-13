/**
 * The Remove control on a message (nightshift item 356, 2026-10-13): the
 * words of its tooltip and of the confirmation it asks first. Pure, so the
 * test reads exactly what he sees.
 *
 * Remove takes a message out of what the model reads from the next turn on
 * — on Claude Code by a rewritten copy of the CLI's history — and keeps it
 * in the log, greyed, with Restore on the placeholder. The undo toast
 * offers the same restore right after.
 */

export type RemoveKind = "message" | "reply";

/** The hover text on the trash button. */
export function removeTip(kind: RemoveKind): string {
  return kind === "message"
    ? "Remove this message from the chat history: the model no longer sees it from the next turn. It stays in the log, greyed, with Restore."
    : "Remove this reply from the chat history: the model no longer sees its words from the next turn (its tool calls stay). It stays in the log, greyed, with Restore.";
}

/** A message's first line, cut to `max` characters, for the dialog. */
export function removeSnippet(text: string, max = 80): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  if (line.length === 0) return "(no text)";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface RemoveAsk {
  title: string;
  lead: string;
  facts: [string, string][];
  confirmLabel: string;
}

/** What the confirmation says before a Remove. */
export function removeAsk(kind: RemoveKind, text: string, onClaudeCode: boolean): RemoveAsk {
  const what = kind === "message" ? "message" : "reply";
  const lead =
    `The model stops seeing this ${what} from the next turn. It stays in the log, greyed, ` +
    "and Undo or Restore puts it back." +
    (onClaudeCode ? " On Claude Code the next turn resumes a rewritten copy of its history; the original file is kept." : "");
  return {
    title: `Remove this ${what} from the chat history?`,
    lead,
    facts: [[what, removeSnippet(text)]],
    confirmLabel: "Remove",
  };
}
