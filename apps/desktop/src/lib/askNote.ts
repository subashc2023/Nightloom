// Where the note typed on an interruption card goes (nightshift backlog
// 084 pass 2, the boards' "the note goes with either").
//
// The card — a permission prompt, the model's question, a plan — has one
// optional note field and two kinds of button. With the *refusing* one
// (Deny, Skip, Keep planning) the note is the reason: the CLI's hook hands
// it to the model as the deny reason, which the model reads before its
// next step. With the *accepting* one (Allow, Allow for this chat, Answer,
// Approve) nothing rides with the call that the model reads — an allow's
// reason is shown to the user only — so the note becomes his next message,
// held in the composer's queue (backlog 089) and sent when the turn ends,
// takeable back until then. One rule on all three cards; the field's `?`
// says it.

import type { ApprovalDecision } from "./types";

export interface NoteRoute {
  /** The deny reason, for a refusing decision. */
  reason?: string;
  /** The message to hold for the next turn, for an accepting decision. */
  enqueue?: string;
}

/**
 * `fallback` is the card's own sentence for a refusal with no note ("the
 * user skipped the question; decide yourself"), so the model is never
 * refused in silence; an accepting decision has no fallback, since an
 * empty note is simply no message.
 */
export function routeNote(decision: ApprovalDecision, note: string, fallback?: string): NoteRoute {
  const text = note.trim();
  if (decision === "deny") {
    const reason = text || fallback;
    return reason ? { reason } : {};
  }
  return text ? { enqueue: text } : {};
}
