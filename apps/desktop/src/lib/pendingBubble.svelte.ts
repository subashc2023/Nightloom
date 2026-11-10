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
 * Stop and resend was not chosen: it would end the reply mid-way. ~~The
 * provider engine has no way into a running turn (no inbox), so there a
 * message waits for the turn's end and offers no Send now.~~ Item 536
 * (2026-11-09, his "there's literally no option to send now, especially on
 * urgent things"): every pending row offers *Send now* while the turn runs
 * (`sendNowPlan` in state.svelte.ts). A row the turn cannot take — the
 * provider engine, a `/` command turn, a file chip, no inbox — is sent by
 * **Stop + send**: the turn stops (the reply so far stays) and the row goes
 * at once as the next message, exactly once, into its own chat. *Let it
 * arrive* no longer hides *Send now*.
 */
import { takeBackInjected } from "./api";
import { clearInjected, dropQueued, readDraft, recordDraft, takeBackQueued, type QueuedMessage } from "./drafts.svelte";
import { requestComposerFocus } from "./rewindDraft.svelte";
import { addToast, handReason, replyToPending, sendNowAny, sendNowPlan, type HandReason, type SendNowPlan } from "./state.svelte";

export type PendingState = "next-step" | "now" | "turn-end" | "waiting" | "replying";

/**
 * Where a queued row stands while the turn runs. `waiting` (item 522,
 * 2026-11-09): the turn is not running at all — a prompt waits on him —
 * so a row no process holds is `waiting`, with a Send now that sends it
 * in place of an answer, never "goes when this turn ends" (the turn
 * cannot end until he answers). `replying`: that send is on its way.
 */
export function pendingState(q: Pick<QueuedMessage, "inject">, waiting = false): PendingState {
  if (q.inject?.reply) return "replying";
  if (!q.inject) return waiting ? "waiting" : "turn-end";
  return q.inject.now ? "now" : "next-step";
}

/** The line beside the pending mark. */
export function pendingLabel(s: PendingState, letArrive = false): string {
  switch (s) {
    case "now":
      return "sending now — Claude was asked to stop the step it is in";
    case "turn-end":
      return "not sent yet — goes when this turn ends, or send it now";
    case "waiting":
      return "not sent yet — Claude is waiting on your answer above; send this instead, or answer and it goes after";
    case "replying":
      return "sending — in place of an answer";
    default:
      return letArrive ? "not sent yet — Claude reads it at its next step" : "not sent yet — Claude reads it at its next step, or send it now";
  }
}

/** Whether the bubble offers *Let it arrive* (it is what happens anyway
 *  to a row handed in; item 536 split it from *Send now*). */
export function offersChoice(s: PendingState, letArrive: boolean): boolean {
  return s === "next-step" && !letArrive;
}

/** Whether the bubble offers *Send now* (item 536): every state but one
 *  already going (`now`, `replying`) or waiting on a prompt (its own
 *  *Send now*, `offersReply`), whenever the plan can do something. */
export function offersSendNow(s: PendingState, plan: SendNowPlan): boolean {
  return (s === "next-step" || s === "turn-end") && (plan === "now" || plan === "hand" || plan === "stop");
}

/** Why a row is not handed in, in his words (item 536). */
export function handNote(r: HandReason | null): string | null {
  switch (r) {
    case "provider":
      return "this engine cannot take a message while it replies";
    case "files":
      return "a file it carries can only go with a new message";
    case "no-inbox":
      return "the running step is not taking messages yet";
    case "error":
      return "handing it to the turn failed";
    default:
      return null;
  }
}

/** The *Send now* tooltip: which of the two it will do (item 536). */
export function sendNowTip(plan: SendNowPlan, why: HandReason | null = null): string {
  if (plan === "now") return "Stop the step Claude is in (a long command, say) and give it this message at once — Claude Code's own send now. The reply so far stays and the turn goes on.";
  const note = handNote(why);
  const stop = "Stop this turn and send this at once as the next message. The reply so far stays.";
  if (plan === "stop") return note ? `${stop} (It cannot go into the running turn: ${note}.)` : stop;
  return `Give it to Claude at once (Claude Code's own send now: the step it is in stops, the turn goes on). If the running turn cannot take messages, Nightloom stops the turn instead — the reply so far stays — and sends this as the next message.${note ? ` Not handed in yet: ${note}.` : ""}`;
}

/** The plan and the reason for the bubble (item 536). */
export function bubblePlan(key: string, qid: number): { plan: SendNowPlan; why: HandReason | null } {
  return { plan: sendNowPlan(key, qid), why: handReason(key, qid) };
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
  const r = await sendNowAny(key, qid);
  if (r === "stopping") addToast("Stopping the turn — the reply so far stays, and your message goes the moment it has stopped.");
}

/** Whether the bubble offers *Send now* as a reply to the prompt that waits (item 522). */
export function offersReply(s: PendingState): boolean {
  return s === "waiting";
}

/** *Send now* while a prompt waits on him (item 522): the row goes in
 *  place of an answer. Says so if it could not; the row is never dropped. */
export async function sendAsReply(key: string, qid: number): Promise<void> {
  const q = readDraft(key).queue.find((r) => r.id === qid);
  if (!q) return;
  const r = await replyToPending(key, q);
  if (r === "none") addToast("Nothing is waiting on you now — the message goes at the turn's next step or its end.");
}

/** *Edit*: the row back into the message box, in front of anything typed there. */
export async function editPending(key: string, qid: number): Promise<boolean> {
  if (!(await unsend(key, qid))) return false;
  if (!takeBackQueued(key, qid)) return false;
  delete letArrive[qid];
  groundFlight(qid);
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
  groundFlight(qid);
  addToast("Cancelled — not sent. Its words are in the message box's history.");
  return true;
}

// ---- Items 548, 549, 547 (2026-11-10): every waiting message as a message ----

/**
 * Item 548: under Filament IV every message of the open chat that waits in
 * its queue is drawn in the transcript as his greyed bubble — while a turn
 * runs (465's rows) and also while none does (held after a Stop or after
 * the wrap-up's turn, the wrap-up Nightloom queued while he was away, no
 * connection yet), so no waiting message is a one-line row with a hover
 * tip of its whole text any more. Classic (item 542) keeps 465's rule: only
 * while a turn runs; the rest stay rows in the tray above the box.
 * `busyHere`: a turn runs in this chat (`app.busy && !app.parked`).
 * Rows a turn already took (`inject.after`) are never drawn.
 */
export function bubbledRows(queue: readonly QueuedMessage[], busyHere: boolean, filament: boolean, busyElsewhere = false): QueuedMessage[] {
  if (busyHere) return pendingRows(queue, true);
  if (!filament || busyElsewhere) return [];
  return queue.filter((q) => q.inject?.after === undefined);
}

/** Why a row waits with no turn running (item 548): `queueHold`'s answer, or plain waiting. */
export type HeldWhy = "stopped" | "wrapped" | "idle";

/** The short state line over a waiting bubble under Filament IV (item 548),
 *  "queued · goes when this turn ends"; the long one (`pendingLabel`) is its tip. */
export function pendingHead(s: PendingState | null, arrive = false, held: HeldWhy | null = null): string {
  if (held === "stopped") return "queued · held — you stopped the turn";
  if (held === "wrapped") return "queued · held — HANDOFF.md is written";
  if (held === "idle") return "queued · waiting to send";
  switch (s) {
    case "now":
      return "sending now · Claude was asked to stop its step";
    case "turn-end":
      return "queued · goes when this turn ends";
    case "waiting":
      return "queued · Claude waits on your answer above";
    case "replying":
      return "sending · in place of an answer";
    default:
      return arrive ? "queued · Claude reads it at its next step" : "queued · goes at Claude's next step";
  }
}

/** The tip of a held bubble's state line (item 548): why it is not going by itself. */
export function heldTip(held: HeldWhy): string {
  if (held === "stopped") return "Not sent: the turn was stopped, so the queue waits for you. Send now sends it as the next message.";
  if (held === "wrapped") return "Not sent: HANDOFF.md is written — continue from the prompt in the reply, or Send now to send it here.";
  return "Not sent yet: it goes as the next message once the chat can send.";
}

/** Which waiting messages he opened past their fold (item 548), this launch. */
export const foldOpen = $state<Record<string, true>>({});

/**
 * *Send now* on a held row (item 548): the composer's own *Send next*, for
 * that row — it goes to the head of the queue and is sent as the next
 * message, through the same `drain` (one path: the wrap-up still starts
 * the hand-off, a failure gives the words back). The chat's composer
 * registers it; nothing registered → nothing sent, said so.
 */
let sendHeldFn: ((qid: number) => Promise<void>) | null = null;
export function registerSendHeld(fn: (qid: number) => Promise<void>): () => void {
  sendHeldFn = fn;
  return () => {
    if (sendHeldFn === fn) sendHeldFn = null;
  };
}
export async function sendHeld(qid: number): Promise<boolean> {
  if (!sendHeldFn) {
    addToast("The message box is not open here — open the chat to send it.");
    return false;
  }
  await sendHeldFn(qid);
  return true;
}

/**
 * Item 547: *Send now* moves the message visibly from its waiting bubble
 * into the running turn. The click marks the row (`flying`); while it is
 * marked, its bubble keeps where it is drawn (`trackFlight`, each frame).
 * When the bubble leaves (the turn took it), the place it was last seen is
 * handed on as a send-motion launch (`sendMotion.ts`, backlog 194's ghost
 * and thread): the delivered bubble inside the reply takes it
 * (`takeMidLanding`), or — when Send now stopped the turn instead — the new
 * turn's bubble does, on the "chat" channel as any send. Edit or Cancel
 * unmarks it. Reduced motion: no flight (`arrive`/`landMid` check).
 */
export const flying = $state<Record<number, true>>({});
interface Seen {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  at: number;
}
const lastSeen = new Map<number, Seen>();
let midLanding: Seen | null = null;
const LANDING_TTL_MS = 1500;
const tnow = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Where the flying row's bubble is now (called each frame while it is drawn). */
export function trackFlight(qid: number, text: string, el: Element): void {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return;
  // A send-motion launch names where the words start (inside the padding),
  // as the box's does; the ghost, padded alike, then starts on the bubble.
  const cs = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
  const pl = cs ? parseFloat(cs.paddingLeft) || 0 : 0;
  const pt = cs ? parseFloat(cs.paddingTop) || 0 : 0;
  lastSeen.set(qid, { text, x: r.left + pl, y: r.top + pt, w: Math.max(0, r.width - 2 * pl), h: r.height, at: tnow() });
}

/** The flying row's bubble left the page: hand its last place on (item 547). */
export function flightLeft(
  qid: number,
  stillQueued: boolean,
  launchChat: (l: { channel: string; at: number; x: number; y: number; w: number; h: number }) => void,
): void {
  const s = lastSeen.get(qid);
  lastSeen.delete(qid);
  if (!flying[qid]) return;
  // Still waiting (he switched chats, the layout changed): no flight; the
  // mark goes, so a later redraw does not fly from a stale place.
  delete flying[qid];
  if (!s || stillQueued) return;
  const at = tnow();
  midLanding = { ...s, at };
  launchChat({ channel: "chat", at, x: s.x, y: s.y, w: s.w, h: s.h });
}

/** Unmark a row (Edit, Cancel). */
export function groundFlight(qid: number): void {
  delete flying[qid];
  lastSeen.delete(qid);
}

const norm = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 400);

/** The delivered bubble `text` takes the landing if it is that message's and fresh. */
export function takeMidLanding(text: string, at: number = tnow()): Seen | null {
  const m = midLanding;
  if (!m) return null;
  if (at - m.at > LANDING_TTL_MS) {
    midLanding = null;
    return null;
  }
  if (norm(m.text) !== norm(text)) return null;
  midLanding = null;
  return m;
}

/** For tests: whether a landing waits. */
export function hasMidLanding(): boolean {
  return midLanding !== null;
}
