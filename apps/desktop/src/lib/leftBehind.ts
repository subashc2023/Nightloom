/**
 * "Left it?" (nightshift item 771; his answer on blocker 2344, his pick B + C on blocker 2362). An occasional
 * nudge for a chat he has not gone back to: *high* when a reply came and he never opened the chat since, *low*
 * when he opened it after the reply but never read it to the bottom. A chat he read gets none; a running or a
 * settled chat never shows. At most three a day, high first; each reply at most twice; Not now holds a chat
 * for a week; Left it settles it (the sidebar's Settled, with a 10 s Undo).
 *
 * Pure over plain data so the suite can pin every rule; `leftBehind.svelte.ts` holds the state and the store.
 *
 * The signals (none existed before 771): the reply's time is the listing's `last_reply` (the newest reply
 * line's `at`, `store.rs`), not the file's time, which a rename or a thread binding also moves. When he
 * opened a chat and when he last had its foot in view are recorded by the transcript (`noteOpened`,
 * `noteFoot`) into this module's marks, kept in localStorage — the scroll memory beside them (065) is in
 * memory only, and a nudge days later needs them across launches.
 */
import type { Hold } from "./readingPlace";

export const DAY_MS = 86_400_000;
/** A reply never opened counts after this long. */
export const HIGH_AFTER_MS = 2 * DAY_MS;
/** A reply opened but not read to the end counts after this long. */
export const LOW_AFTER_MS = 4 * DAY_MS;
/** Not now: the chat is not asked about again for a week. */
export const SNOOZE_MS = 7 * DAY_MS;
/** At most this many chats a day. */
export const PER_DAY = 3;
/** One reply is asked about on at most this many days. */
export const PER_REPLY = 2;
/** Left it's Undo, in the row and the toast. */
export const UNDO_MS = 10_000;
/** The corner card stays open this long, then tucks itself away (his "opens for a couple seconds"). */
export const CARD_OPEN_MS = 4_000;
/** After the pointer leaves the card, it stays this much longer. */
export const CARD_LINGER_MS = 1_500;
/** The card waits this long after launch (or after a reply he reads ends) before it opens. */
export const CARD_DELAY_MS = 20_000;

export type Level = "high" | "low";

/** What the transcript recorded for one chat (epoch ms). */
export interface Mark {
  /** The last time the chat was open in front of him (its open, and its leaving). */
  opened?: number;
  /** The last time its foot was in view. */
  foot?: number;
  /** Where he left it (item 504's holds), for "Open where I stopped" after a relaunch. */
  top?: number;
  holds?: Hold[];
}

/** A chat as the nudge reads it: the every-project listing's row. */
export interface Chat {
  id: string;
  project: { id: string; name: string } | null;
  title: string | null;
  first_user: string | null;
  mode?: string;
  /** ISO8601, the newest reply (771). */
  last_reply?: string;
  /** ISO8601, his newest message (item 300 B8). */
  last_message?: string;
}

/** Today's answer for a chat it showed. */
export type Answer = "opened" | "settled" | "snoozed";

export interface Store {
  /** When the nudge first ran: a reply older than this is never asked about (no flood of old chats). */
  since: number;
  marks: Record<string, Mark>;
  /** Left it: when; a message he writes there afterwards takes it back to the list. */
  settled: Record<string, number>;
  /** Not now: asked again only after this time. */
  snoozed: Record<string, number>;
  /** Per chat, the reply asked about and the days it was. */
  asked: Record<string, { reply: number; days: string[] }>;
  /** Today's picks, frozen for the day, and his answers to them. */
  day: { key: string; ids: string[]; done: Record<string, Answer> } | null;
  /** The day the corner card last opened. */
  cardDay: string | null;
}

export function emptyStore(now: number): Store {
  return { since: now, marks: {}, settled: {}, snoozed: {}, asked: {}, day: null, cardDay: null };
}

/** The local calendar day of `ms`, `2026-11-27`. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ms(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Settled and still settled: a message he wrote after settling it takes it back. */
export function isSettled(settledAt: number | undefined, lastMessage: string | null | undefined): boolean {
  return !!settledAt && !(ms(lastMessage) > settledAt);
}

/** The chat's level now, or null when it is read, too new, or older than the nudge. */
export function levelOf(lastReply: number, mark: Mark | undefined, since: number, now: number): Level | null {
  if (!lastReply || lastReply <= since) return null;
  if ((mark?.foot ?? 0) >= lastReply) return null;
  if ((mark?.opened ?? 0) < lastReply) return now - lastReply >= HIGH_AFTER_MS ? "high" : null;
  return now - lastReply >= LOW_AFTER_MS ? "low" : null;
}

export interface Candidate {
  chat: Chat;
  level: Level;
  /** The reply's time, ms. */
  reply: number;
}

/**
 * Every chat that may be asked about now, high first, then the longest left first. `skip`: chats that never
 * show (running, in front, Home's own). Incognito chats are left out: they write nothing about him.
 */
export function candidates(chats: readonly Chat[], st: Store, now: number, today: string, skip: ReadonlySet<string>): Candidate[] {
  const out: Candidate[] = [];
  for (const c of chats) {
    if (skip.has(c.id) || c.mode === "incognito" || c.mode === "ephemeral") continue;
    if (isSettled(st.settled[c.id], c.last_message)) continue;
    if ((st.snoozed[c.id] ?? 0) > now) continue;
    const reply = ms(c.last_reply);
    const level = levelOf(reply, st.marks[c.id], st.since, now);
    if (!level) continue;
    const a = st.asked[c.id];
    if (a && a.reply === reply && a.days.length >= PER_REPLY && !a.days.includes(today)) continue;
    out.push({ chat: c, level, reply });
  }
  return out.sort((x, y) => (x.level === y.level ? x.reply - y.reply : x.level === "high" ? -1 : 1));
}

/**
 * Today's picks: the day's frozen set when it is today's and holds any, else the first `PER_DAY` candidates — recorded as
 * asked today (a new reply restarts its count). Returns the new store; the same object when nothing changed.
 */
export function pickToday(st: Store, cands: readonly Candidate[], today: string): Store {
  // A day with no picks yet picks again later (a reply may pass its two days this afternoon).
  if (st.day?.key === today && st.day.ids.length > 0) return st;
  const ids = cands.slice(0, PER_DAY).map((c) => c.chat.id);
  if (ids.length === 0 && (st.day === null || st.day.key === today)) return st;
  const asked = { ...st.asked };
  for (const c of cands.slice(0, PER_DAY)) {
    const a = asked[c.chat.id];
    const days = a && a.reply === c.reply ? a.days : [];
    asked[c.chat.id] = { reply: c.reply, days: days.includes(today) ? days : [...days, today] };
  }
  return { ...st, asked, day: { key: today, ids, done: {} } };
}

/** One row of today's block: a pick still worth showing, with its level now, or the answer he gave it today. */
export interface Row {
  chat: Chat;
  level: Level;
  /** Days since the reply, at least 1. */
  days: number;
  done: Answer | null;
}

/**
 * Today's rows: each pick still in the listing (a deleted chat drops out) that is still left behind — or that
 * he answered today, which stays, dimmed, with its answer. A chat read meanwhile, or now running, drops out.
 */
export function todayRows(st: Store, chats: readonly Chat[], now: number, today: string, skip: ReadonlySet<string>): Row[] {
  if (st.day?.key !== today) return [];
  const by = new Map(chats.map((c) => [c.id, c]));
  const out: Row[] = [];
  for (const id of st.day.ids) {
    const c = by.get(id);
    if (!c) continue;
    const done = st.day.done[id] ?? null;
    const reply = ms(c.last_reply);
    const level = levelOf(reply, st.marks[id], st.since, now);
    if (!done && (!level || skip.has(id) || isSettled(st.settled[id], c.last_message))) continue;
    out.push({ chat: c, level: level ?? "low", days: Math.max(1, Math.floor((now - reply) / DAY_MS)), done });
  }
  return out;
}

/** Why the row is there, in his words. */
export function whyLine(r: Row): string {
  return r.level === "high" ? "Not opened since the reply came" : "Opened, not read to the end";
}

/** What the row says once answered. */
export function doneLine(a: Answer): string {
  return a === "settled" ? "✓ settled" : a === "snoozed" ? "✓ not now · back in 7 days" : "✓ opened";
}

export function chatName(c: Chat): string {
  const t = (c.title ?? c.first_user ?? "").trim().replace(/\s+/g, " ");
  return t.length > 80 ? `${t.slice(0, 79)}…` : t || "Untitled chat";
}

/**
 * The sidebar's rows split into the list and Settled: a settled top-level row takes its forks (the deeper rows
 * right after it) with it.
 */
export function splitSettled<R extends { depth: number; meta: { id: string } }>(rows: readonly R[], settled: (id: string) => boolean): { live: R[]; settled: R[] } {
  const live: R[] = [];
  const gone: R[] = [];
  let into = live;
  for (const r of rows) {
    if (r.depth === 0) into = settled(r.meta.id) ? gone : live;
    into.push(r);
  }
  return { live, settled: gone };
}

/** The stored state, read leniently: anything unreadable starts afresh from now. */
export function parseStore(raw: string | null, now: number): Store {
  if (!raw) return emptyStore(now);
  try {
    const v = JSON.parse(raw) as Partial<Store>;
    if (typeof v !== "object" || v === null || typeof v.since !== "number") return emptyStore(now);
    const obj = <T>(x: unknown): Record<string, T> => (x && typeof x === "object" ? (x as Record<string, T>) : {});
    return {
      since: v.since,
      marks: obj<Mark>(v.marks),
      settled: obj<number>(v.settled),
      snoozed: obj<number>(v.snoozed),
      asked: obj<{ reply: number; days: string[] }>(v.asked),
      day: v.day && typeof v.day.key === "string" && Array.isArray(v.day.ids) ? { key: v.day.key, ids: v.day.ids, done: obj<Answer>(v.day.done) } : null,
      cardDay: typeof v.cardDay === "string" ? v.cardDay : null,
    };
  } catch {
    return emptyStore(now);
  }
}

/** Old entries dropped so the store stays small: snoozes past, asks for replies long gone, marks of chats not listed. */
export function pruned(st: Store, listed: ReadonlySet<string> | null, now: number): Store {
  const keep = <T>(r: Record<string, T>, ok: (id: string, v: T) => boolean) => Object.fromEntries(Object.entries(r).filter(([k, v]) => ok(k, v)));
  return {
    ...st,
    snoozed: keep(st.snoozed, (_, until) => until > now),
    asked: keep(st.asked, (id, a) => (listed ? listed.has(id) : true) && now - a.reply < 60 * DAY_MS),
    // A chat made in the last day may not be listed yet.
    marks: listed ? keep(st.marks, (id, m) => listed.has(id) || now - Math.max(m.opened ?? 0, m.foot ?? 0) < DAY_MS) : st.marks,
    settled: listed ? keep(st.settled, (id) => listed.has(id)) : st.settled,
  };
}
