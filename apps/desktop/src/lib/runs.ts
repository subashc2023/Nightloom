/**
 * Runs of replies (nightshift backlog 121, 2026-09-16).
 *
 * On the Claude Code engine a turn that spans several CLI processes — the
 * deferred-call resumes of backlog 084, the CLI's own multi-message turns —
 * records as several consecutive `assistant_message` events, and the
 * transcript drew each with its own model header, footer and tool row,
 * with the list's full gap between: his screenshot of three `OPUS` boxes
 * each holding one tool call. The log is right (each message keeps its
 * own id, edit, remove and rewind) and only the drawing merges: a reply
 * that follows a reply from the same model with nothing between them is a
 * *continuation* — no header, the blocks back to back, its own one-line
 * footer. A user message, a compaction, or a change of model starts a new
 * run; so does a change in whether the turn was superseded by a rewind,
 * since the dimmed tail reads better under its own header.
 */

export interface RunItem {
  kind: "user" | "assistant" | "compaction";
  /** The reply's model; ignored on other kinds. */
  model?: string;
  superseded: boolean;
}

/** Per item, whether it continues the reply before it. */
export function continuedFlags(items: RunItem[]): boolean[] {
  return items.map((it, i) => {
    if (i === 0 || it.kind !== "assistant") return false;
    const prev = items[i - 1];
    return prev.kind === "assistant" && prev.model === it.model && prev.superseded === it.superseded;
  });
}
