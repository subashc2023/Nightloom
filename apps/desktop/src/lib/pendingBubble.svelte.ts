/**
 * A message he sends while a turn runs, drawn as his own bubble (nightshift
 * item 465, 2026-10-28; his words: "it should just be like a normal message
 * … grayed out to show that it hasn't actually send yet with like buttons
 * for like send now versus like letting it send whenever … the claude model
 * naturally reads it").
 *
 * ~~One yellow monospace line, "Delivered after the reply — Claude is reading
 * it now: “…”" (`deliveredNotice`, backlog 366)~~ — now:
 * - **Pending** (still in the composer's queue while the turn runs): a
 *   greyed bubble at the transcript's foot with a small pending mark and
 *   what will happen; *Send now* and *Let it arrive* while the turn could
 *   still take it either way; *Edit* (back into the box) and *Cancel*
 *   (confirmed; the words go to the box's draft history) until it is taken.
 * - **Delivered** (the turn took it): an ordinary bubble at its place in the
 *   reply; at the turn's end the log has it as his message as before.
 *
 * *Send now* is the Claude Code CLI's own `priority: "now"` (backlog 339,
 * `sendNowRow`): it stops the step Claude is in — a long command, say — and
 * gives it the message at once; the turn and its reply so far go on. A full
 * Stop and resend was not chosen: it would end the reply mid-way. The
 * provider engine has no way into a running turn (no inbox), so there a
 * message waits for the turn's end and offers no Send now.
 */
import { takeBackInjected } from "./api";
import { clearInjected, dropQueued, readDraft, recordDraft, takeBackQueued, type QueuedMessage } from "./drafts.svelte";
import { requestComposerFocus } from "./rewindDraft.svelte";
import { addToast, sendNowRow } from "./state.svelte";

export type PendingState = "next-step" | "now" | "turn-end";

/** Where a queued row stands while the turn runs. */
export function pendingState(q: Pick<QueuedMessage, "inject">): PendingState {
  if (!q.inject) return "turn-end";
  return q.inject.now ? "now" : "next-step";
}

/** The line beside the pending mark. */
export function pendingLabel(s: PendingState, letArrive = false): string {
  switch (s) {
    case "now":
      return "sending now — Claude was asked to stop the step it is in";
    case "turn-end":
      return "not sent yet — goes when this turn ends";
    default:
      return letArrive ? "not sent yet — Claude reads it at its next step" : "not sent yet — Claude reads it at its next step, or send it now";
  }
}

/** Whether the bubble offers *Send now* and *Let it arrive*. */
export function offersChoice(s: PendingState, letArrive: boolean): boolean {
  return s === "next-step" && !letArrive;
}

/** The rows drawn as pending bubbles: the open chat's queue while its turn runs. */
export function pendingRows(queue: readonly QueuedMessage[], busy: boolean): QueuedMessage[] {
  return busy ? queue.filter((q) => q.inject?.after === undefined) : [];
}

/** The rows he chose *Let it arrive* for (this launch; the default anyway). */
export const letArrive = $state<Record<number, true>>({});

/** Ask the running turn to give the row back, if it was handed in; false
 *  when the turn already took it (it is sent). As the composer's own. */
async function unsend(key: string, qid: number): Promise<boolean> {
  const inj = readDraft(key).queue.find((r) => r.id === qid)?.inject;
  if (!inj) return true;
  if (inj.after !== undefined) {
    addToast(`already reached the turn ${inj.after}`);
    return false;
  }
  let r: "cancelled" | "delivered" = "cancelled";
  try {
    r = await takeBackInjected(inj.turn, inj.id);
  } catch {
    r = "delivered";
  }
  if (r === "delivered") {
    addToast("already reached the turn");
    return false;
  }
  clearInjected(key, qid);
  return true;
}

export async function sendNow(key: string, qid: number): Promise<void> {
  await sendNowRow(key, qid);
}

/** *Edit*: the row back into the message box, in front of anything typed there. */
export async function editPending(key: string, qid: number): Promise<boolean> {
  if (!(await unsend(key, qid))) return false;
  if (!takeBackQueued(key, qid)) return false;
  delete letArrive[qid];
  requestComposerFocus();
  return true;
}

/** *Cancel* (after its confirm): the row leaves the queue unsent; its words
 *  go to the box's draft history first, so nothing is lost. */
export async function cancelPending(key: string, qid: number): Promise<boolean> {
  const q = readDraft(key).queue.find((r) => r.id === qid);
  if (!q) return false;
  if (!(await unsend(key, qid))) return false;
  recordDraft(key, q.text, new Date().toISOString(), 1);
  dropQueued(key, qid);
  delete letArrive[qid];
  addToast("Cancelled — not sent. Its words are in the message box's history.");
  return true;
}
