/**
 * "Left it?" — the state (nightshift item 771; the rules are `leftBehind.ts`). One store in localStorage: the
 * transcript's read marks, the settled and snoozed chats, what was asked when, today's picks and the corner
 * card's day. Home's "Left behind?" block (B) and the corner card (C) both read `leftBehind.rows`; the
 * sidebar reads `settledChat` for its Settled section.
 */
import * as api from "./api";
import { isHome } from "./home";
import type { Hold } from "./readingPlace";
import { leaveScroll, recallScroll } from "./scroll.svelte";
import { addToast, app, liveChats, openSession, useProject } from "./state.svelte";
import {
  UNDO_MS,
  candidates,
  dayKey,
  isSettled,
  parseStore,
  pickToday,
  pruned,
  todayRows,
  type Answer,
  type Chat,
  type Row,
  type Store,
} from "./leftBehind";

export const LEFT_BEHIND_KEY = "nightloom.leftBehind.v1";

function load(): Store {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEFT_BEHIND_KEY);
  } catch {
    /* no storage: a fresh store, kept in memory */
  }
  return parseStore(raw, Date.now());
}

export const leftBehind = $state<{ store: Store; chats: Chat[]; listed: boolean; now: number; undo: Record<string, number> }>({
  store: load(),
  chats: [],
  listed: false,
  now: Date.now(),
  /** Chat id → until when its Left it can be undone. */
  undo: {},
});

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function save(soon = false): void {
  clearTimeout(saveTimer);
  const write = () => {
    try {
      localStorage.setItem(LEFT_BEHIND_KEY, JSON.stringify($state.snapshot(leftBehind.store)));
    } catch {
      /* full or missing storage: the marks stay in memory this launch */
    }
  };
  if (soon) write();
  else saveTimer = setTimeout(write, 1500);
}
if (typeof window !== "undefined") window.addEventListener("pagehide", () => save(true));

/** A chat key the marks are kept for: a real chat's id, never the pending chat's or an aside's. */
function isChatKey(id: string | null | undefined): id is string {
  return !!id && id !== "new" && !id.includes(":");
}

/** The chat's mark, made when missing — read back through the store, so a write lands in the proxied state. */
function markOf(id: string) {
  if (!leftBehind.store.marks[id]) leftBehind.store.marks[id] = {};
  return leftBehind.store.marks[id];
}

/** The chat is in front of him now (its open, or his leaving it). */
export function noteOpened(id: string | null | undefined): void {
  if (!isChatKey(id)) return;
  const m = markOf(id);
  m.opened = Date.now();
  save();
}

/** Its foot is in view now. Written at most every 20 s while he sits there. */
export function noteFoot(id: string | null | undefined): void {
  if (!isChatKey(id)) return;
  const now = Date.now();
  const m = markOf(id);
  if (m.foot && now - m.foot < 20_000 && (m.opened ?? 0) <= m.foot) return;
  m.foot = now;
  m.opened = Math.max(m.opened ?? 0, now);
  save();
}

/** He left it: opened now, the foot seen now when he was at it, and where he stopped. */
export function noteLeft(id: string | null | undefined, atFoot: boolean, place: { top: number; holds?: Hold[] } | null): void {
  if (!isChatKey(id)) return;
  const now = Date.now();
  const m = markOf(id);
  m.opened = now;
  if (atFoot) m.foot = now;
  if (place) {
    m.top = Math.max(0, Math.round(place.top));
    m.holds = place.holds?.slice(0, 4);
  }
  save();
}

/** Settled (Left it), and not written in since. */
export function settledChat(id: string, lastMessage?: string | null): boolean {
  return isSettled(leftBehind.store.settled[id], lastMessage);
}

/** What never shows: a running chat, the one in front, Home's own chats. */
function skipSet(): Set<string> {
  const s = new Set<string>();
  for (const c of liveChats()) if (c.session) s.add(c.session);
  if (app.activeSessionId) s.add(app.activeSessionId);
  return s;
}

/** Today's rows, live. */
export function rowsNow(): Row[] {
  const today = dayKey(leftBehind.now);
  return todayRows(leftBehind.store, leftBehind.chats, leftBehind.now, today, skipSet());
}

let reading: Promise<void> | null = null;
let readAt = 0;
/** A refresh within this long of the last one only re-reads the day (Home's views mount the rail often). */
const REREAD_MS = 60_000;
/**
 * Re-read every project's chats and make today's picks when the day has none yet. Home's chats are never
 * asked about (Home's own work, not his). A failed read keeps the last listing.
 */
export function refreshLeftBehind(): Promise<void> {
  if (reading) return reading;
  const fresh = Date.now() - readAt < REREAD_MS && leftBehind.listed;
  const run = async () => {
    if (!fresh) {
      readAt = Date.now();
      try {
        const all = await api.listEverySession();
        const home = new Set(app.projects.filter(isHome).map((p) => p.id));
        leftBehind.chats = all.filter((c) => !(c.project && home.has(c.project.id)));
        leftBehind.listed = true;
      } catch {
        /* the last listing stays */
      }
    }
    const now = Date.now();
    leftBehind.now = now;
    const today = dayKey(now);
    const st = pruned(leftBehind.store, leftBehind.listed ? new Set(leftBehind.chats.map((c) => c.id)) : null, now);
    leftBehind.store = pickToday(st, candidates(leftBehind.chats, st, now, today, skipSet()), today);
    save();
  };
  const p = run().finally(() => {
    if (reading === p) reading = null;
  });
  reading = p;
  return p;
}

function answer(id: string, a: Answer): void {
  const d = leftBehind.store.day;
  if (d) d.done[id] = a;
}

/** Open: at the reply when he never opened it, else where he stopped. */
export async function openLeft(r: Row): Promise<void> {
  answer(r.chat.id, "opened");
  save(true);
  const here = app.project?.id ?? null;
  const there = r.chat.project?.id ?? null;
  if (here !== there) await useProject(there);
  const m = leftBehind.store.marks[r.chat.id];
  if (r.level === "low" && m?.holds?.length && !recallScroll(r.chat.id)) leaveScroll(r.chat.id, m.top ?? 0, undefined, m.holds);
  if (r.level === "high") requestReplyJump(r.chat.id);
  await openSession(r.chat.id);
}

/** Left it: to Settled, with an Undo for 10 s (the row's and a toast's). */
export function settleLeft(id: string, name: string): void {
  leftBehind.store.settled[id] = Date.now();
  answer(id, "settled");
  leftBehind.undo[id] = Date.now() + UNDO_MS;
  setTimeout(() => delete leftBehind.undo[id], UNDO_MS + 50);
  save(true);
  addToast(`Moved “${name}” to Settled`, { label: "Undo", run: () => undoSettle(id) }, UNDO_MS);
}

export function undoSettle(id: string): void {
  delete leftBehind.store.settled[id];
  delete leftBehind.undo[id];
  const d = leftBehind.store.day;
  if (d?.done[id] === "settled") delete d.done[id];
  save(true);
}

/** The sidebar's Settle / Back to chats. */
export function setSettled(id: string, on: boolean): void {
  if (on) leftBehind.store.settled[id] = Date.now();
  else delete leftBehind.store.settled[id];
  save(true);
}

/** Not now: a week's quiet for this chat. */
export function snoozeLeft(id: string): void {
  leftBehind.store.snoozed[id] = Date.now() + 7 * 86_400_000;
  answer(id, "snoozed");
  save(true);
}

/** The corner card's day: opened once a day. */
export function cardDue(): boolean {
  return leftBehind.store.cardDay !== dayKey(Date.now());
}
export function markCardShown(): void {
  leftBehind.store.cardDay = dayKey(Date.now());
  save(true);
}

// ---- "at the reply": a one-shot jump the chat's transcript takes once its log is drawn ----
const jump = $state<{ chat: string | null; at: number }>({ chat: null, at: 0 });
export function requestReplyJump(chat: string): void {
  jump.chat = chat;
  jump.at = Date.now();
}
/** The chat asked to open at its newest reply, if it is `chat` and asked in the last 15 s. Reactive. */
export function peekReplyJump(chat: string | null): boolean {
  return !!chat && jump.chat === chat && Date.now() - jump.at < 15_000;
}
export function takeReplyJump(): void {
  jump.chat = null;
}

/** For the suite. */
export function resetLeftBehind(now = Date.now()): void {
  leftBehind.store = parseStore(null, now);
  leftBehind.chats = [];
  leftBehind.listed = false;
  leftBehind.now = now;
  leftBehind.undo = {};
  jump.chat = null;
  readAt = 0;
}
