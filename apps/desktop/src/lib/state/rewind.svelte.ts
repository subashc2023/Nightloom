// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import * as api from "../api";
import { noteRewound } from "../handoff.svelte";
import { nextAttachmentId, readDraft, recordDraft, setDraftAttachments, setDraftText } from "../drafts.svelte";
import { indexOfAim } from "../aim";
import { requestComposerFocus, rewoundMessage, swapIn, untouched, type BoxSwap } from "../rewindDraft.svelte";
import { rewoundWrites, setAsideFiles } from "../rewoundFiles";
import type { Attachment, SessionEvent } from "../types";
import { chatScope, pushUndo, undoToast, contextUsed } from "./edits.svelte";
import { openChatKey } from "./queue.svelte";
import { adoptOpen } from "./sessions.svelte";
import { app, addToast, liveFlags } from "../state.svelte";

/**
 * Rewind to the turn at log index `to`.
 *
 * Refused mid-turn: the running turn holds the session and would record its
 * reply after the rewind landed, stitching the turn being undone onto the
 * history it was removed from.
 */
export async function rewindTo(to: number, aim: boolean | string = false): Promise<void> {
  if (app.busy) return;
  // From the window's own transcript, the message's send time rides with
  // its place, as `sendEdit`'s does (backlog 361; wave 8b review): the
  // backend rewinds to the message meant, or refuses. The phone's index is
  // its own list's: since backlog 364 it sends the send time from that
  // list (a string here); a phone that sends none goes bare, as before.
  const meant = aim === true ? app.events[to] : undefined;
  const at = typeof aim === "string" ? aim : meant?.event === "user_message" ? meant.at : undefined;
  const call = () => (at ? api.rewind(to, at) : api.rewind(to));
  // 364 review: the phone's `to` is its own list's; what follows is read
  // where its aimed rewind lands in this window's list, and nothing is
  // offered when this list does not have that message.
  const here = typeof aim === "string" ? indexOfAim(app.events, { at: aim }, to) : to;
  // His message at `to`, read before the rewind supersedes it (backlog 247).
  const back = here === null ? null : rewoundMessage(app.events, here, nextAttachmentId);
  // What the removed turns wrote, read before the rewind supersedes them
  // (item 259): offered to be set aside, since the next run reads them.
  const written = here === null ? [] : rewoundWrites(app.events, liveFlags(app.events), here);
  // 535f (534-1): the chat's box and stack, named before the round trip.
  const key = openChatKey();
  const scope = chatScope();
  try {
    if (!(await adoptOpen(call))) {
      // He opened another chat meanwhile: the rewind is on disk in this
      // one; its message goes back in its own box, and nothing here (the
      // view, the size, the files card, the undo) is the chat now open.
      if (back) fillBox(key, back);
      return;
    }
    app.error = null;
  } catch (e) {
    app.error = String(e);
    return;
  }
  // Item 390: fewer turns, less context — the hand-off notice reads it now.
  const refill = () => noteRewound(app.activeSessionId, contextUsed(), app.connection?.contextLimit ?? null);
  refill();
  app.rewoundWrites =
    written.length > 0
      ? {
          session: app.activeSessionId,
          workspace: app.connection?.workspace ?? null,
          files: written,
          done: null,
        }
      : null;
  let swap = back ? fillBox(key, back) : null;
  // The inverse lifts the marker this call landed — and, after a redo,
  // the marker *that* call lands, which is why the index is a variable.
  let marker = lastMarker("rewind");
  const handle = pushUndo(scope, {
    label: "rewind",
    undo: async () => {
      if (!(await adoptOpen(() => api.unrewind(marker)))) return;
      refill();
      // The turn is back; its files were left alone unless he set them
      // aside, and then the card says where they went.
      if (app.rewoundWrites && app.rewoundWrites.done === null) app.rewoundWrites = null;
      // The box gets back what it held — unless he changed the message
      // since, which then stays (never-lose-work).
      if (swap && untouched(readDraft(key), swap)) {
        setDraftText(key, swap.before.text);
        setDraftAttachments(key, swap.before.attachments);
      }
    },
    redo: async () => {
      if (!(await adoptOpen(call))) return;
      refill();
      marker = lastMarker("rewind");
      if (back) swap = fillBox(key, back);
    },
  });
  undoToast(back ? "Rewound — your message is back in the box" : "Rewound to here", handle);
}

/**
 * Set aside the rewound turn's files he ticked (item 259): moved into a
 * dated folder outside the project, never deleted. The card then names
 * the folder and anything that could not move.
 */
export async function setAsideRewound(paths: string[]): Promise<void> {
  const w = app.rewoundWrites;
  if (!w || paths.length === 0) return;
  try {
    const out = await setAsideFiles(w.session, w.workspace, paths);
    const skipped = out.skipped.map((s) => `${s.path}: ${s.why}`);
    w.done = out.folder
      ? `Moved ${out.moved.length} to ${out.folder}${skipped.length ? ` · not moved: ${skipped.join("; ")}` : ""}`
      : `Nothing moved${skipped.length ? `: ${skipped.join("; ")}` : ""}`;
  } catch (e) {
    addToast(`Could not set the files aside: ${String(e)}`);
  }
}

/** Leave the rewound turn's files where they are (item 259). */
export function keepRewound(): void {
  app.rewoundWrites = null;
}

/** A rewound message into the box (backlog 247, blocker 581): what was
 *  half-typed goes to the top of the draft history, with a toast saying
 *  so; its chips stay after the message's own. */
function fillBox(key: string, back: { text: string; attachments: Attachment[] }): BoxSwap {
  const swap = swapIn(readDraft(key), back);
  if (swap.stashed) {
    recordDraft(key, swap.before.text, undefined, 1);
    addToast("Your half-typed message is in drafts, under the box");
  }
  setDraftText(key, swap.after.text);
  setDraftAttachments(key, swap.after.attachments);
  requestComposerFocus();
  return swap;
}

/** The log index of the newest event of `kind` — the marker an operation
 *  just recorded, for its inverse to name. */
function lastMarker(kind: SessionEvent["event"]): number {
  for (let i = app.events.length - 1; i >= 0; i--) {
    if (app.events[i].event === kind) return i;
  }
  return -1;
}
