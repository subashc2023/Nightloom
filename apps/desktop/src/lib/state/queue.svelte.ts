// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import * as api from "../api";
import { draftKey, clearInjected, queueAfterTurn, ranKey, shiftQueue, requeueFront, type QueuedMessage, markInjected, markSendNow, readDraft, dropQueued } from "../drafts.svelte";
import { midTurnWire, sendNowToast, type SendNowResult } from "../midTurn";
import { carriesAlone, FOLLOWS, pendingFor, type ReplyResult } from "../askReply";
import type { Attachment } from "../types";
import { app, fg, turnWasStopped, cancelTurn, resolveApproval, addToast } from "../state.svelte";

/** The "still running" asks already toasted (backlog 329), by turn and tasks. */
export const stillRunningAsked = new Set<string>();

/**
 * A message he queued while the chat on screen runs a turn, sent into that
 * turn (nightshift backlog 328): the CLI takes it at the turn's next step,
 * as Claude Code does, instead of holding it for the turn's end. ~~Text only
 * — a row with files waits for the next turn as before (backlog 089).~~
 * Since backlog 339 (2026-10-11) its images and documents go too, as the
 * opening line's content blocks; only a `file` chip, or one still
 * converting, waits for the turn's end (`midTurnWire`). The row stays in
 * the queue, marked, until the turn takes it; one the turn never takes is
 * sent as the next message (`settleInjected`).
 */
export async function injectIntoTurn(key: string, q: { id: number; text: string; attachments: Attachment[] }): Promise<void> {
  // Item 536: every return that leaves the row un-handed says why
  // (`handWhy`), so its bubble and its Send now know — before, each was
  // silent and the row just read "goes when this turn ends".
  const turn = fg;
  if (!turn) return noteHand(key, q.id, "no-turn");
  if (!app.busy) return noteHand(key, q.id, "not-busy");
  if (app.parked) return noteHand(key, q.id, "parked");
  // Only into the row's own chat's turn (375 review): a caller holding a
  // stale key (a composer torn down by a chat or project switch) must not
  // hand another chat's row to the turn on screen.
  if (!turnOwnsKey(turn, key)) return noteHand(key, q.id, "other-chat");
  // The provider engine has no inbox (item 536): nothing to hand in to.
  if (turn.provider) return noteHand(key, q.id, "provider");
  // A prompt waits on him (item 522): no process runs to take a message,
  // and the turn only goes on by an answer — so the message is the answer.
  if (pendingFor(app.pendingApprovals, app.connection?.engine)) {
    await replyToPending(key, q);
    return;
  }
  const wire = midTurnWire(q.attachments);
  if (!wire) return noteHand(key, q.id, "files");
  if (!q.text.trim() && wire.images.length + wire.documents.length === 0) return noteHand(key, q.id, "empty");
  const id = crypto.randomUUID();
  // Marked first: a delivery event can come back before the call does.
  markInjected(key, q.id, { id, turn: turn.key });
  let sent = false;
  let threw = false;
  try {
    sent = await api.injectMessage(turn.key, id, q.text, wire.images, wire.documents);
  } catch {
    sent = false;
    threw = true;
  }
  if (sent) noteHand(key, q.id, null);
  if (!sent && readDraft(key).queue.find((r) => r.id === q.id)?.inject?.id === id) {
    clearInjected(key, q.id);
    noteHand(key, q.id, threw ? "error" : "no-inbox");
    // No process with a stdin runs now — a question waiting on his answer,
    // say (backlog 374): tried again when the turn's next process starts,
    // ~~and only then~~ — item 536: and on the turn's next event and every
    // `RETRY_HAND_MS` while it runs, not at its end.
    const later = injectLater.get(turn.key) ?? [];
    if (!later.some((r) => r.key === key && r.qid === q.id)) later.push({ key, qid: q.id });
    injectLater.set(turn.key, later);
    retryHandSoon(turn.key);
  }
}

/**
 * Why a row sent while a turn runs is not handed to it (item 536), by
 * `handKey(key, qid)`: which return of `injectIntoTurn` fired. `no-inbox`
 * and `error` are retried while the turn runs; the rest cannot be handed
 * in, and their Send now is Stop + send.
 */
export type HandReason = "no-turn" | "not-busy" | "parked" | "other-chat" | "provider" | "files" | "empty" | "no-inbox" | "error";
export const handWhy = $state<Record<string, HandReason>>({});
export function handKey(key: string, qid: number): string {
  return `${key}#${qid}`;
}
function noteHand(key: string, qid: number, r: HandReason | null): void {
  const k = handKey(key, qid);
  if (r === null) delete handWhy[k];
  else if (handWhy[k] !== r) handWhy[k] = r;
}
/** The reason the row is not handed in, if one was recorded (item 536). */
export function handReason(key: string, qid: number): HandReason | null {
  return handWhy[handKey(key, qid)] ?? null;
}

/** How often an un-handed row is tried again while its turn runs (536). */
export const RETRY_HAND_MS = 1500;
const handTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Try the turn's held-back rows again shortly — once per turn at a time. */
function retryHandSoon(turnKey: string): void {
  if (handTimers.has(turnKey)) return;
  handTimers.set(
    turnKey,
    setTimeout(() => {
      handTimers.delete(turnKey);
      if (fg?.key === turnKey && app.busy && !app.parked) retryInjects(turnKey);
    }, RETRY_HAND_MS),
  );
}
/** A turn event on screen (item 536): rows it could not take yet are
 *  tried again soon, rather than at the turn's end. */
export function nudgeInjects(turnKey: string): void {
  if (injectLater.has(turnKey)) retryHandSoon(turnKey);
}

/**
 * His message in place of an answer (nightshift item 522, 2026-11-09): the
 * prompt waiting in the chat on screen — the model's question, a plan, a
 * permission or browser prompt — is refused with the queued row's words as
 * the reason, so the model reads them in the call's result and the turn
 * goes on (`askReply.ts`). The row stays in the queue, marked, until the
 * turn reports it delivered; a resume that fails leaves it an ordinary
 * held message, and an answer that cannot be given puts the card back.
 * A row with files cannot ride in a reason: the call is refused saying a
 * message follows, and the row is handed to the resumed process whole.
 */
export async function replyToPending(key: string, q: { id: number; text: string; attachments: Attachment[] }): Promise<ReplyResult> {
  const turn = fg;
  if (!turn || !app.busy || app.parked || !turnOwnsKey(turn, key)) return "none";
  const req = pendingFor(app.pendingApprovals, app.connection?.engine);
  if (!req) return "none";
  if (carriesAlone(q)) {
    const id = crypto.randomUUID();
    markInjected(key, q.id, { id, turn: turn.key, reply: true });
    const ok = await resolveApproval(req.id, req.name, "deny", undefined, undefined, undefined, undefined, { text: q.text.trim(), id });
    if (!ok) {
      clearInjected(key, q.id);
      return "failed";
    }
    return "sent";
  }
  // With files: handed in at the resumed process's `init` (as 374's
  // rows). A chip no running turn can take (a file by path, one still
  // converting) leaves the row for the turn's end, which the refusal
  // brings on — the model is told a message follows and to wait for it.
  if (midTurnWire(q.attachments)) {
    const later = injectLater.get(turn.key) ?? [];
    if (!later.some((r) => r.key === key && r.qid === q.id)) later.push({ key, qid: q.id });
    injectLater.set(turn.key, later);
  }
  const ok = await resolveApproval(req.id, req.name, "deny", FOLLOWS, undefined, undefined, undefined, undefined, "replied");
  return ok ? "follows" : "failed";
}

/**
 * Whether a queued row under draft key `key` belongs to `turn`'s chat
 * (nightshift backlog 375, review 2026-10-18): the turn's chat id, or —
 * for a New chat's first turn — its pending key or the chat that key
 * became. Anything else is another chat's message.
 */
export function turnOwnsKey(turn: { chat: string | null; pendingKey?: string | null }, key: string): boolean {
  if (turn.chat !== null && turn.chat === key) return true;
  const p = turn.pendingKey;
  return p != null && (p === key || ranKey(p) === key);
}

/** The open chat's draft key, read from the app now (375). */
export function openChatKey(): string {
  return draftKey(app.activeSessionId, app.project?.id, app.pendingMode, app.pendingThread);
}

/**
 * The row a background send takes from chat `key` (blocker 1467): only
 * when the ended turn owns that key (`turnOwnsKey`, 375) — its own chat's
 * queue, never the open one's. `null`: nothing goes.
 */
export function takeQueuedFor(turn: { chat: string | null; pendingKey?: string | null }, key: string): QueuedMessage | null {
  if (!turnOwnsKey(turn, key)) return null;
  return shiftQueue(key);
}

/**
 * The queued row a drain sends next (nightshift backlog 375): taken from
 * the **open** chat's queue — `send()` goes to the open chat, so the row
 * must come from the same place — never from `composerKey`, which a
 * composer torn down by a chat or project switch holds stale (Svelte
 * 5.56: a derived read after its owner is destroyed returns its last
 * value, `derived_inert`; measured 2026-10-18). An aside's key is its own
 * and stable. After a turn (`from`, the key the turn left from), only when
 * that turn was the open chat's. `null`: nothing goes.
 */
export function takeQueued(composerKey: string, aside: boolean, from?: string): QueuedMessage | null {
  const live = aside ? composerKey : openChatKey();
  if (from !== undefined && queueAfterTurn(from, live) === null) return null;
  return shiftQueue(live);
}

/**
 * Rows the running turn could not take when he queued them, by turn key
 * (backlog 374): no process with a stdin was running — the deferred
 * question's wait, before its resume (which takes messages since 374), or
 * a `/command` turn on argv. Each is tried again at the turn's next
 * `agent_init` (every CLI process, and every command in one, sends one).
 */
export const injectLater = new Map<string, { key: string; qid: number }[]>();

/** Send the turn's held-back rows into it now (374); a row taken back,
 *  sent, or already handed in meanwhile is skipped. */
export function retryInjects(turnKey: string): void {
  const rows = injectLater.get(turnKey);
  if (!rows) return;
  injectLater.delete(turnKey);
  for (const { key, qid } of rows) {
    const q = readDraft(key).queue.find((r) => r.id === qid);
    if (q && !q.inject) void injectIntoTurn(key, q);
  }
}

/**
 * Send now (nightshift backlog 339): a row already sent into the running
 * turn is re-sent with the CLI's `priority: "now"`, which stops the step
 * it is in — a long Bash, say — and delivers it at once, the turn going
 * on (measured on CLI 2.1.296). Without it the row goes at the next step,
 * as before. Returns what he is told.
 */
export async function sendNowRow(key: string, qid: number, sayNotRunning = true): Promise<SendNowResult> {
  const inj = readDraft(key).queue.find((r) => r.id === qid)?.inject;
  if (!inj) return "not_running";
  if (inj.after !== undefined) return "delivered";
  if (inj.now) return "sent";
  let r: SendNowResult = "not_running";
  try {
    r = await api.sendNowInjected(inj.turn, inj.id);
  } catch {
    r = "not_running";
  }
  if (r === "sent") markSendNow(key, qid);
  // Item 536: a caller that falls back to Stop + send says so itself.
  const toast = r === "not_running" && !sayNotRunning ? null : sendNowToast(r);
  if (toast) addToast(toast);
  return r;
}

/**
 * What *Send now* on a pending row does (item 536 — his "there's
 * literally no option to send now"): `now`, Claude Code's own send now on
 * a row already handed in; `hand`, hand it in first and then that — and
 * Stop + send if the turn cannot take it; `stop`, Stop the turn (the
 * reply so far stays) and send the row at once as the next message — the
 * provider engine, a row with a file chip, any turn with no inbox;
 * `reply`, in place of the answer a prompt waits on (522); `none`, nothing
 * to do (already going, or this row is not the running turn's chat's).
 */
export type SendNowPlan = "now" | "hand" | "stop" | "reply" | "none";
export function sendNowPlan(key: string, qid: number): SendNowPlan {
  const q = readDraft(key).queue.find((r) => r.id === qid);
  if (!q || !app.busy || app.parked) return "none";
  const inj = q.inject;
  if (inj && (inj.reply || inj.now || inj.after !== undefined)) return "none";
  const turn = fg;
  // Never another chat's turn: a Stop here would end a turn that is not
  // this row's, and the row would go nowhere sooner.
  if (!turn || !turnOwnsKey(turn, key)) return "none";
  if (pendingFor(app.pendingApprovals, app.connection?.engine)) return "reply";
  if (inj) return "now";
  if (turn.provider || !midTurnWire(q.attachments)) return "stop";
  const why = handReason(key, qid);
  return why === "provider" || why === "files" || why === "empty" ? "stop" : "hand";
}

/**
 * A Stop pressed for *Send now* (item 536): the row the stopped turn's end
 * sends at once, into its own chat (`key`), whatever the queue's hold
 * after a Stop says. Taken once, by the composer's drain
 * (`takeStopSend`); a row gone by then (taken by the turn, cancelled)
 * sends nothing — never twice.
 */
export const stopSend = $state<{ key: string | null; qid: number | null; at: number }>({ key: null, qid: null, at: 0 });
/** A forced send older than this is stale (he moved on): dropped. */
const STOP_SEND_TTL_MS = 10 * 60 * 1000;
export function stopSendFor(key: string): number | null {
  return stopSend.key === key && stopSend.qid !== null ? stopSend.qid : null;
}
/** The row to send at once in chat `key`, once the turn is over; taken
 *  (cleared) by this call. `null` while a turn runs or for another chat. */
export function takeStopSend(key: string, now = Date.now()): number | null {
  if (app.busy || stopSend.key === null || stopSend.qid === null) return null;
  if (now - stopSend.at > STOP_SEND_TTL_MS) {
    stopSend.key = null;
    stopSend.qid = null;
    return null;
  }
  if (stopSend.key !== key) return null;
  const qid = stopSend.qid;
  stopSend.key = null;
  stopSend.qid = null;
  return qid;
}
/** Row `qid` to the head of chat `key`'s queue, unsent (536); false when
 *  it is not there any more. */
export function frontQueued(key: string, qid: number): boolean {
  const q = readDraft(key).queue.find((r) => r.id === qid);
  if (!q) return false;
  if (q.inject?.after !== undefined) return false;
  dropQueued(key, qid);
  requeueFront(key, { id: q.id, text: q.text, attachments: q.attachments });
  return true;
}

/** Stop the running turn and send row `qid` at once as the next message
 *  (item 536). `stopping` when the Stop went out. */
export async function stopAndSendRow(key: string, qid: number): Promise<"stopping" | "none"> {
  const turn = fg;
  if (!turn || !app.busy || app.parked || !turnOwnsKey(turn, key)) return "none";
  const q = readDraft(key).queue.find((r) => r.id === qid);
  if (!q || q.inject?.after !== undefined || q.inject?.reply) return "none";
  // First in its queue, so whatever sends next sends it; no longer tried
  // into the turn being stopped.
  if (!frontQueued(key, qid)) return "none";
  const later = injectLater.get(turn.key);
  if (later) injectLater.set(turn.key, later.filter((r) => !(r.key === key && r.qid === qid)));
  stopSend.key = key;
  stopSend.qid = qid;
  stopSend.at = Date.now();
  await cancelTurn();
  // The Stop did not go out (its toast says why): nothing is forced.
  if (!turnWasStopped() && app.busy && stopSend.qid === qid) {
    stopSend.key = null;
    stopSend.qid = null;
    return "none";
  }
  return "stopping";
}

/** *Send now* on a pending row, whichever way it can go (item 536). */
export async function sendNowAny(key: string, qid: number): Promise<SendNowResult | "stopping" | "none"> {
  const plan = sendNowPlan(key, qid);
  if (plan === "none" || plan === "reply") return "none";
  if (plan === "now") {
    const r = await sendNowRow(key, qid, false);
    return r === "not_running" ? stopAndSendRow(key, qid) : r;
  }
  if (plan === "hand") {
    const q = readDraft(key).queue.find((r) => r.id === qid);
    if (!q) return "delivered";
    await injectIntoTurn(key, q);
    const after = readDraft(key).queue.find((r) => r.id === qid);
    if (!after) return "delivered";
    if (after.inject?.reply) return "sent";
    if (after.inject) {
      const r = await sendNowRow(key, qid, false);
      return r === "not_running" ? stopAndSendRow(key, qid) : r;
    }
  }
  return stopAndSendRow(key, qid);
}
