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

/**
 * The Retry whose fork is being made (wave 5 review): `app.busy` is not set
 * until the fork's send starts, so a second press while the fork request is
 * in flight would fork the chat twice. Cleared once the fork is the open
 * chat, or the request fails — not at the turn's end, so a turn sent to the
 * background never blocks a Retry in another chat.
 */
let forking: object | null = null;

export async function retryReply(reply: number): Promise<boolean> {
  if (app.busy || forking) return false;
  const p = retryPrompt(app.events, reply);
  if (!p) {
    addToast("Nothing to retry: no message of yours before this reply");
    return false;
  }
  const project = app.project?.id;
  const mode = app.pendingMode;
  const mine = {};
  forking = mine;
  try {
    return await sendEdit(p.index, p.text, p.images, p.documents, (parent, fork) => {
      if (forking === mine) forking = null;
      carryDraft(draftKey(parent, project, mode), draftKey(fork, project, mode));
    });
  } finally {
    if (forking === mine) forking = null;
  }
}
