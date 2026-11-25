/**
 * The Needs-you view's store (nightshift item 753): what the pure rows
 * (`needsYou.ts`) are built from, and what a row's answer does.
 *
 * Kept here, in localStorage: the turns that ended while he was not looking
 * at their chat (a finish to review; a question still open), his half-typed
 * replies by row, and the groups he folded. Everything else is read from the
 * app as it is — the running list, the chat on screen's log — or from the
 * Nightshift projects' files (open blockers, shipped items), re-read when
 * the view opens and every few minutes for the badge.
 */
import { untrack } from "svelte";
import { app, sendInChat, chatRuns, injectIntoTurn, openNotice } from "./state.svelte";
import { enqueueMessage, readDraft } from "./drafts.svelte";
import { addToast } from "./state/toasts.svelte";
import { allRunning } from "./running.svelte";
import * as api from "./api";
import { chatName, turnEndListeners, windowFocused, type TurnEnded } from "./notify";
import { answeredWhen, extractAsk, pendingAsk, type Ask } from "./askTag";
import { followUpTitle, homeNeeds, isHeld, needRows, parseEnded, seenNow, trimEnded, type HomeNeeds, type EndedTurn, type NeedRow, type OpenBlocker, type PendingProposal, type ShippedItem } from "./needsYou";
import { proposalNoticeId } from "./centre";

export const ENDED_KEY = "nightloom.needsYou.ended";
export const DRAFTS_KEY = "nightloom.needsYou.drafts";
export const FOLDS_KEY = "nightloom.needsYou.folds";

function read<T>(key: string, parse: (raw: string | null) => T): T {
  try {
    return parse(localStorage.getItem(key));
  } catch {
    return parse(null);
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // best-effort
  }
}
function record(raw: string | null): Record<string, string> {
  try {
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export const needs = $state({
  ended: read(ENDED_KEY, parseEnded),
  /** His unsent words, by row id: they survive closing the view and a restart. */
  drafts: read(DRAFTS_KEY, record),
  /** Groups he folded ("1"). */
  folds: read(FOLDS_KEY, record),
  blockers: [] as OpenBlocker[],
  shipped: [] as ShippedItem[],
  loading: false,
  loadedAt: 0,
  problem: null as string | null,
  /** Rows whose answer is on its way. */
  sending: {} as Record<string, boolean>,
  /** The list's scroll, kept across closing and reopening the view. */
  scroll: 0,
});

function saveEnded(rows: EndedTurn[]): void {
  needs.ended = trimEnded(rows);
  write(ENDED_KEY, needs.ended);
}
export function setDraft(row: string, text: string): void {
  if (text) needs.drafts[row] = text;
  else delete needs.drafts[row];
  write(DRAFTS_KEY, needs.drafts);
}
export function setFold(state: string, folded: boolean): void {
  if (folded) needs.folds[state] = "1";
  else delete needs.folds[state];
  write(FOLDS_KEY, needs.folds);
}

function projectName(id: string | null): string | null {
  return id ? (app.projects.find((p) => p.id === id)?.name ?? (app.project?.id === id ? app.project.name : null)) : null;
}

/** A turn ended: keep it unless he is looking at that chat (a question is
 *  kept either way — it waits until answered). */
function onTurnEnd(e: TurnEnded): void {
  if (!e.chat || e.stopped) return;
  const ask = e.failed ? null : extractAsk(e.text);
  const looking = app.activeSessionId === e.chat && app.view === "chat" && windowFocused();
  const rest = needs.ended.filter((x) => x.chat !== e.chat);
  if (looking && !ask) return saveEnded(rest);
  saveEnded([...rest, { chat: e.chat, name: e.name, project: e.project, projectName: projectName(e.project), at: Date.now(), failed: e.failed, ask }]);
}
turnEndListeners.add(onTurnEnd);

/** Forget what is kept of `chat` (he answered, replied, or it runs again). */
export function dropEnded(chat: string): void {
  if (needs.ended.some((x) => x.chat === chat)) saveEnded(needs.ended.filter((x) => x.chat !== chat));
}

/** The chat on screen, as an answer's target. */
export function hereTarget(): { chat: string; name: string; project: string | null; projectName: string | null } | null {
  const id = app.activeSessionId;
  if (!id) return null;
  const row = app.sessions.find((s) => s.id === id);
  return { chat: id, name: chatName(row?.title, row?.first_user), project: app.project?.id ?? null, projectName: app.project?.name ?? null };
}

/** The question the chat on screen waits on him with; null while it runs. */
export function hereAsk(): { ask: Ask; index: number } | null {
  const id = app.activeSessionId;
  if (!id || app.view !== "chat" || chatRuns(id)) return null;
  return pendingAsk(app.events);
}

// He opened a chat: its finished turn is looked at; a kept question the log
// shows answered (he wrote after it, here or on the phone) is dropped.
// Item 945: "looked at" needs the window in front, and coming back to the
// window counts — a reply that landed while Nightloom was behind another app,
// read when he came back and left for another chat, used to stay listed.
function lookedAt(): void {
  const id = app.activeSessionId;
  if (!id || app.view !== "chat") return;
  const answered = app.events.length > 0 && !chatRuns(id) && pendingAsk(app.events) === null;
  const kept = needs.ended.find((x) => x.chat === id);
  if (seenNow(kept, { onScreen: true, focused: windowFocused(), answered })) dropEnded(id);
}
$effect.root(() => {
  $effect(() => {
    void app.activeSessionId;
    void app.events;
    void app.view;
    untrack(lookedAt);
  });
});
if (typeof window !== "undefined") {
  window.addEventListener("focus", lookedAt);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") lookedAt();
  });
}

/** Item 968: the proposals still pending, as the bell's last read found them (every one, dismissed or not —
 *  a dismissal on the old bell hid the notice, never the proposal). */
export function pendingProposals(): PendingProposal[] {
  return (app.centre.proposals ?? []).map((p) => {
    const at = Date.parse(p.entry.proposal.at ?? "");
    const why = p.entry.proposal.screened ? `Kept for your review: ${p.entry.proposal.screened.why}. ${p.entry.proposal.why}` : p.entry.proposal.why;
    return {
      id: proposalNoticeId(p),
      title: `A change to ${p.project ? `${p.project.name}'s instructions` : "your memory"}`,
      why: why ?? "",
      project: p.project?.id ?? null,
      projectName: p.project?.name ?? null,
      at: Number.isFinite(at) ? at : null,
    };
  });
}

/** Item 968: a proposal row's Review — the bell's own review flow (NoteView in proposal mode). */
export async function reviewProposalRow(row: NeedRow): Promise<void> {
  const p = (app.centre.proposals ?? []).find((x) => proposalNoticeId(x) === row.proposal);
  if (!p) return;
  app.showNeeds = false;
  await openNotice({ kind: "proposal", id: proposalNoticeId(p), title: row.title, detail: row.detail, at: p.entry.proposal.at ?? null, project: p.project, proposal: p });
}

/** Every row of the view, now. */
export function needsNow(): NeedRow[] {
  const here = hereAsk();
  const target = here ? hereTarget() : null;
  return needRows({
    runs: allRunning(),
    ended: needs.ended,
    here: here && target ? { ...target, ask: here.ask } : null,
    blockers: needs.blockers,
    shipped: needs.shipped,
    proposals: pendingProposals(),
    running: chatRuns,
  });
}

/** Item 945: Home's own list — what waits on him in his chats; Nightshift's rows counted, not listed. */
export function homeNeedsNow(): HomeNeeds {
  return homeNeeds(needsNow());
}

/** Re-read the open blockers and the shipped items of every Nightshift
 *  project; at most once a minute unless `force`. */
export async function refreshBoard(force = false): Promise<void> {
  if (needs.loading || (!force && Date.now() - needs.loadedAt < 60_000)) return;
  needs.loading = true;
  try {
    const projects = (await api.nightshiftProjects()).filter((p) => p.nightshift && p.exists);
    const blockers: OpenBlocker[] = [];
    const shipped: ShippedItem[] = [];
    const problems: string[] = [];
    await Promise.all(
      projects.map(async (p) => {
        try {
          const [bl, items] = await Promise.all([api.nightshiftBlockers(p.id), api.nightshiftItems(p.id)]);
          for (const b of bl.blockers) {
            if (b.status !== "open") continue;
            blockers.push({ project: p.id, projectName: p.name, id: b.id, question: b.question, guess: b.guess, held: isHeld(b.fields), raised: b.raised });
          }
          for (const i of items.items) {
            if (i.status !== "shipped") continue;
            const fields = (i as unknown as { fields?: Record<string, string> }).fields;
            shipped.push({ project: p.id, projectName: p.name, id: i.id, title: i.title, shipped: fields?.shipped ?? "" });
          }
        } catch (e) {
          problems.push(`${p.name}: ${String(e)}`);
        }
      }),
    );
    needs.blockers = blockers;
    needs.shipped = shipped;
    needs.problem = problems.length ? problems.join(" · ") : null;
    needs.loadedAt = Date.now();
  } catch (e) {
    needs.problem = String(e);
  } finally {
    needs.loading = false;
  }
}

/**
 * Item 922: an answer given while its chat runs (a turn, or a subagent's work the reply continues after) is
 * queued as the composer's Queue queues a message, and the card keeps it: by chat, the held row's id, his
 * words, and the question it answered (the card is drawn from it while the chat runs and `hereAsk` is null).
 */
export interface QueuedAnswer {
  id: number;
  answer: string;
  ask: Ask;
  index: number;
}
export const queuedAnswers = $state<Record<string, QueuedAnswer>>({});

/** The queued answer of chat `chat` while its row is still held; a row gone (sent, or removed from the
 *  queue strip) reads as none, so a removed answer shows the card unanswered again. */
export function queuedAnswerOf(chat: string | null): QueuedAnswer | null {
  const q = chat ? queuedAnswers[chat] : undefined;
  return q && readDraft(chat as string).queue.some((r) => r.id === q.id) ? q : null;
}

/** Send `text` as his next message in `chat`: sent, or queued when the chat runs (it goes when the running
 *  work allows, as a Queue click does); false (and a toast) when it could not go. */
function sendTo(t: { chat: string; project: string | null; projectName: string | null }, text: string): { queued: number | null } | false {
  if (chatRuns(t.chat)) {
    const row = enqueueMessage(t.chat, text, []);
    // Into the running turn at its next step when it is the chat on screen (the composer's own rule); a row
    // the turn does not take goes as the next message, off screen too (takeQueuedFor).
    if (t.chat === app.activeSessionId && app.busy && !app.parked) void injectIntoTurn(t.chat, row);
    addToast("Queued — your answer goes when the running work allows.");
    return { queued: row.id };
  }
  let refused = false;
  sendInChat(t.chat, { id: t.project, name: t.projectName }, text, [], (why) => {
    refused = true;
    addToast(`Not sent: ${why}`);
  });
  return refused ? false : { queued: null };
}

/**
 * Answer a turn-end question: his answer goes out as his next message in
 * that chat (queued when the chat runs, item 922), and is filed as an
 * answered blocker in his words where the project keeps blockers. True
 * when sent or queued.
 */
export async function answerAsk(
  t: { chat: string; name: string; project: string | null; projectName: string | null } | null,
  ask: Ask,
  answer: string,
): Promise<boolean> {
  const text = answer.trim();
  if (!t || !text) return false;
  const how = sendTo(t, text);
  if (!how) return false;
  if (how.queued !== null) {
    const index = (t.chat === app.activeSessionId ? pendingAsk(app.events)?.index : undefined) ?? -1;
    queuedAnswers[t.chat] = { id: how.queued, answer: text, ask, index };
  }
  dropEnded(t.chat);
  if (t.project) {
    try {
      const filed = await api.askFileAnswer(t.project, { question: ask.question, answer: text, options: ask.options, chat: t.name, when: answeredWhen() });
      if (filed) addToast(`Your answer is filed as blocker ${filed.id}, answered.`);
    } catch (e) {
      addToast(`Your answer was ${how.queued !== null ? "queued" : "sent"}; the blocker was not filed — ${String(e)}`);
    }
  }
  return true;
}

/** What a row's reply box (or one of its answer buttons) does. True when
 *  taken — the caller clears the draft. */
export async function replyTo(row: NeedRow, words: string): Promise<boolean> {
  const text = words.trim();
  if (!text || needs.sending[row.id]) return false;
  needs.sending[row.id] = true;
  try {
    const target = row.chat ? { chat: row.chat, name: row.title, project: row.project, projectName: projectName(row.project) } : null;
    if (row.reply === "answer-ask" && row.ask) return await answerAsk(target, row.ask, text);
    if (row.reply === "message" && target) {
      if (!sendTo(target, text)) return false;
      dropEnded(target.chat);
      return true;
    }
    if (row.reply === "answer-blocker" && row.project && row.blocker) {
      await api.nightshiftAnswerBlocker(row.project, row.blocker, text);
      needs.blockers = needs.blockers.filter((b) => !(b.project === row.project && b.id === row.blocker));
      addToast(`Blocker ${row.blocker} is answered.`);
      return true;
    }
    if (row.reply === "follow-up" && row.project && row.item) {
      const id = await api.nightshiftNewItem(row.project, followUpTitle(row.item, row.title, text), "build");
      addToast(`Filed as item ${id}.`);
      return true;
    }
    return false;
  } catch (e) {
    addToast(String(e));
    return false;
  } finally {
    delete needs.sending[row.id];
  }
}
