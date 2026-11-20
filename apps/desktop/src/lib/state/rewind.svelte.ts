// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import * as api from "../api";
import { noteRewound } from "../handoff.svelte";
import { bumpDraft, nextAttachmentId, readDraft, recordDraft, restoreComments, setDraftAttachments, setDraftText, withdrawComments } from "../drafts.svelte";
import { sentComments } from "../sentComments";
import type { PassageComment } from "../passageComments";
import { indexOfAim } from "../aim";
import { dismissRewoundOffer, keepIn, keepsBox, offerRewound, requestComposerFocus, rewoundMessage, swapIn, untouched, type BoxSwap } from "../rewindDraft.svelte";
import { rewoundWrites, setAsideFiles } from "../rewoundFiles";
import { restoreFiles, restoreRewoundFiles, restoredSummary, rewindFiles, split, type RestoreFile } from "../rewindRestore";
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
  const back = here === null ? null : withComments(rewoundMessage(app.events, here, nextAttachmentId));
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
      // Item 724: no popover in a box he is not looking at; a toast says
      // where the message went when that box kept his draft.
      if (back && fillBox(key, back, false).kept && back.text.trim()) addToast("Rewound — the message is in that chat's drafts");
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
  app.rewindRestore = null;
  // Item 765: the files the rewound turns changed, from their snapshots.
  // Where there are none (not a git folder, or turns from before them),
  // the item-259 card stands and says why.
  const gen = ++restoreGen;
  if (here !== null) void offerRestore(here, written, gen);
  let swap = back ? fillBox(key, back) : null;
  // The inverse lifts the marker this call landed — and, after a redo,
  // the marker *that* call lands, which is why the index is a variable.
  let marker = lastMarker("rewind");
  const handle = pushUndo(scope, {
    label: "rewind",
    undo: async () => {
      if (!(await adoptOpen(() => api.unrewind(marker)))) return;
      // A restore plan still on its way is for turns that are back now.
      restoreGen++;
      refill();
      // Item 724: the message is back in the thread; its offer goes.
      dismissRewoundOffer(key);
      // The turn is back; its files were left alone unless he set them
      // aside, and then the card says where they went.
      if (app.rewoundWrites && app.rewoundWrites.done === null) app.rewoundWrites = null;
      if (app.rewindRestore && app.rewindRestore.done === null) app.rewindRestore = null;
      // The box gets back what it held — unless he changed the message
      // since, which then stays (never-lose-work).
      if (swap && untouched(readDraft(key), swap)) {
        setDraftText(key, swap.before.text);
        setDraftAttachments(key, swap.before.attachments);
        // Item 892: the comment chips the rewind put back go with it.
        withdrawComments(key, swap.commentIds ?? []);
      }
    },
    redo: async () => {
      if (!(await adoptOpen(call))) return;
      refill();
      marker = lastMarker("rewind");
      if (back) swap = fillBox(key, back);
    },
  });
  undoToast(
    !back
      ? "Rewound to here"
      : swap?.kept
        ? back.text.trim()
          ? "Rewound — your draft stayed; the message is in drafts, above the box"
          : back.comments.length > 0
            ? "Rewound — your draft stayed; the message's comments joined it"
            : "Rewound — your draft stayed; the message's files joined it"
        : "Rewound — your message is back in the box",
    handle,
  );
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

/** Item 765: each rewind, and each undo of one, bumps this; a plan that
 *  comes back after another bump is for a rewind no longer standing. */
let restoreGen = 0;

/** Item 765: read the rewound turns' snapshots and offer the restore. */
async function offerRestore(to: number, written: import("../rewoundFiles").RewoundWrite[], gen: number): Promise<void> {
  const chat = app.activeSessionId;
  const workspace = app.connection?.workspace ?? null;
  if (!chat || !workspace) return;
  let plan;
  try {
    plan = await rewindFiles(workspace, chat, to);
  } catch {
    return;
  }
  if (app.activeSessionId !== chat || gen !== restoreGen) return;
  if (plan.root && plan.start && plan.end && plan.now && plan.files.length > 0) {
    // This card replaces item 259's: a restore covers what setting aside did.
    app.rewoundWrites = null;
    app.rewindRestore = {
      session: chat,
      chat,
      root: plan.root,
      start: plan.start,
      end: plan.end,
      now: plan.now,
      files: restoreFiles(plan, workspace, written),
      done: null,
      undo: null,
      busy: false,
    };
  } else if (app.rewoundWrites && app.rewoundWrites.session === chat && plan.note && plan.files.length === 0) {
    app.rewoundWrites.note = plan.note;
  }
}

/** Item 765: put the ticked files back as they were before the rewound
 *  turns; files they made move aside. The card then says what happened,
 *  with an Undo. */
export async function restoreRewound(ticked: (f: RestoreFile) => boolean): Promise<void> {
  const r = app.rewindRestore;
  if (!r || r.busy || r.done !== null) return;
  const { paths, added } = split(r.files, ticked);
  if (paths.length + added.length === 0) return;
  r.busy = true;
  try {
    const out = await restoreRewoundFiles(r.chat, r.root, r.start, r.end, paths, added);
    const { text, undoPaths } = restoredSummary(r.root, out);
    r.done = text;
    r.undo = out.after && undoPaths.length ? { from: r.now, guard: out.after, paths: undoPaths } : null;
  } catch (e) {
    addToast(`Could not restore the files: ${String(e)}`);
  } finally {
    r.busy = false;
  }
}

/** Item 765: put the files back as they were just before the restore;
 *  anything changed since the restore is left alone. */
export async function undoRestore(): Promise<void> {
  const r = app.rewindRestore;
  if (!r?.undo || r.busy) return;
  r.busy = true;
  try {
    const out = await restoreRewoundFiles(r.chat, r.root, r.undo.from, r.undo.guard, r.undo.paths, []);
    const left = [...out.skipped, ...out.aside.skipped].map((s) => `${s.path}: ${s.why}`);
    const back = out.restored.length + out.aside.moved.length;
    r.done = `Restore undone: ${back === 1 ? "1 file" : `${back} files`} as they were before it${out.aside.folder ? ` (brought-back files moved to ${out.aside.folder})` : ""}${left.length ? ` · left alone: ${left.join("; ")}` : ""}`;
    r.undo = null;
  } catch (e) {
    addToast(`Could not undo the restore: ${String(e)}`);
  } finally {
    r.busy = false;
  }
}

/** Item 765: keep the files as the rewound turns left them. */
export function keepRewindFiles(): void {
  app.rewindRestore = null;
}

/** Leave the rewound turn's files where they are (item 259). */
export function keepRewound(): void {
  app.rewoundWrites = null;
}

/** A rewound message into the box (backlog 247, blocker 581): what was
 *  half-typed goes to the top of the draft history, with a toast saying
 *  so; its chips stay after the message's own. */
function fillBox(key: string, back: Back, offer = true): BoxSwap & { commentIds?: number[] } {
  const box = readDraft(key);
  // Item 892: its comments come back as chips, before any in the box —
  // into the box in both cases, as its file chips do (724's rule).
  const commentIds = restoreComments(key, back.comments);
  // Item 724: a draft in the box stays there; the message goes to the
  // drafts, offered alone above the drafts button, and its chips join his.
  if (keepsBox(box)) {
    const kept = keepIn(box, back);
    if (back.attachments.length > 0) setDraftAttachments(key, kept.after.attachments);
    if (back.text.trim()) {
      bumpDraft(key, back.text);
      if (offer) offerRewound(key, back.text);
    }
    return { ...kept, commentIds };
  }
  const swap = swapIn(box, back);
  if (swap.stashed) {
    recordDraft(key, swap.before.text, undefined, 1);
    addToast("Your half-typed message is in drafts, under the box");
  }
  setDraftText(key, swap.after.text);
  setDraftAttachments(key, swap.after.attachments);
  requestComposerFocus();
  return { ...swap, commentIds };
}

/** A rewound message as the box takes it back (item 892). */
type Back = { text: string; attachments: Attachment[]; comments: PassageComment[] };

/** Item 892: a message sent with passage comments comes back as what he
 *  typed plus its comments (`sentComments.ts`); any other as it reads. */
function withComments(m: { text: string; attachments: Attachment[] } | null): Back | null {
  if (!m) return null;
  const sc = sentComments(m.text);
  return sc ? { text: sc.typed, attachments: m.attachments, comments: sc.comments } : { ...m, comments: [] };
}

/** The log index of the newest event of `kind` — the marker an operation
 *  just recorded, for its inverse to name. */
function lastMarker(kind: SessionEvent["event"]): number {
  for (let i = app.events.length - 1; i >= 0; i--) {
    if (app.events[i].event === kind) return i;
  }
  return -1;
}
