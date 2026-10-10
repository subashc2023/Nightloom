/**
 * The Retry action (nightshift item 333): the rules are `retry.ts`.
 *
 * Practices §7, never lose his work: what is half-typed in the box when he
 * presses Retry follows him into the fork (`carryDraft`) — the fork is the
 * chat he lands in, and an empty box there would read as his words gone.
 * Held messages stay queued in the chat they were meant for.
 */
import { app, addToast, sendEdit } from "./state.svelte";
import { carryDraft, draftKey } from "./drafts.svelte";
import { retryPrompt } from "./retry";

export async function retryReply(reply: number): Promise<boolean> {
  if (app.busy) return false;
  const p = retryPrompt(app.events, reply);
  if (!p) {
    addToast("Nothing to retry: no message of yours before this reply");
    return false;
  }
  const project = app.project?.id;
  const mode = app.pendingMode;
  return sendEdit(p.index, p.text, p.images, p.documents, (parent, fork) => {
    carryDraft(draftKey(parent, project, mode), draftKey(fork, project, mode));
  });
}
