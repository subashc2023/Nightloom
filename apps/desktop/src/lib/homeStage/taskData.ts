/**
 * The task views' payloads (item 845), pure: what Home put in a task's `data` (the shapes `update_task`'s description
 * gives it), read defensively — the model's words, drawn as text, never run. A field that is missing or the wrong
 * type is dropped, never thrown on; a row without an id gets one from its position and words.
 */

export type Rows = [string, string][];

const str = (v: unknown, max = 300): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : typeof v === "number" ? String(v) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const idOf = (o: Record<string, unknown>, i: number, words: string) => str(o.id, 80) || `${i}:${words.slice(0, 40)}`;

/** A detail as label → value rows: `{ "Who asked": "Priya" }` or `[["Who asked", "Priya"]]`. At most 8 rows. */
export function rowsOf(v: unknown): Rows {
  const out: Rows = [];
  if (Array.isArray(v)) {
    for (const r of v) if (Array.isArray(r) && str(r[0], 40) && str(r[1])) out.push([str(r[0], 40), str(r[1])]);
  } else {
    for (const [k, x] of Object.entries(obj(v))) if (str(k, 40) && str(x)) out.push([str(k, 40), str(x)]);
  }
  return out.slice(0, 8);
}

// ---- time of day ----

/** "14:30", "2:30 PM", "2 pm" → hours (14.5); null when it is not a time. */
export function hoursOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 24) return v;
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?\s*$/i.exec(typeof v === "string" ? v : "");
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59 || h > 24) return null;
  const ap = m[3]?.toLowerCase();
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  if (!ap && !m[2]) return null;
  return h + min / 60;
}

/** 14.5 → "2:30 PM". */
export function hourWords(h: number): string {
  const whole = Math.floor(h);
  const min = Math.round((h - whole) * 60);
  const hh = min === 60 ? whole + 1 : whole;
  return `${((hh + 11) % 12) + 1}:${String(min % 60).padStart(2, "0")} ${hh % 24 < 12 ? "AM" : "PM"}`;
}

// ---- Timeline ----

export interface CalEvent {
  id: string;
  title: string;
  h: number;
  d: number;
  detail: Rows;
}
export interface Change {
  id: string;
  kind: "move" | "add" | "pick";
  title: string;
  /** Where it would go (for a pick: Home's suggested slot). */
  h: number;
  d: number;
  /** A move: where it was. */
  was: number | null;
  why: string;
  /** A pick: the free slots to choose from. */
  slots: number[];
  /** His message asked for it. */
  yours: boolean;
  detail: Rows;
}
export interface Timeline {
  day: string;
  /** The day is today (the now line shows). */
  today: boolean;
  events: CalEvent[];
  changes: Change[];
  /** The hours the track shows. */
  z0: number;
  z1: number;
}

function span(o: Record<string, unknown>): { h: number; d: number } | null {
  const h = hoursOf(o.start);
  if (h === null) return null;
  const e = hoursOf(o.end);
  const d = e !== null && e > h ? e - h : typeof o.minutes === "number" && o.minutes > 0 ? o.minutes / 60 : 0.5;
  return { h, d: Math.min(d, 24 - h) };
}

/** Today in the page's own time, "YYYY-MM-DD". */
export function todayKey(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function timelineOf(data: unknown, today = todayKey()): Timeline {
  const o = obj(data);
  const events: CalEvent[] = [];
  arr(o.events).forEach((x, i) => {
    const e = obj(x);
    const s = span(e);
    const title = str(e.title, 80) || str(e.name, 80);
    if (s && title) events.push({ id: `e:${idOf(e, i, title)}`, title, ...s, detail: rowsOf(e.detail) });
  });
  const changes: Change[] = [];
  arr(o.changes).forEach((x, i) => {
    const c = obj(x);
    const title = str(c.title, 80) || str(c.name, 80);
    const kind = c.kind === "add" || c.kind === "pick" ? c.kind : "move";
    const slots = arr(c.slots).map(hoursOf).filter((h): h is number => h !== null).slice(0, 6);
    const s = span(c) ?? (slots.length ? { h: slots[0], d: typeof c.minutes === "number" && c.minutes > 0 ? c.minutes / 60 : 0.5 } : null);
    if (!title || !s) return;
    changes.push({ id: `c:${idOf(c, i, title)}`, kind: kind === "pick" && slots.length === 0 ? "add" : kind, title, ...s, was: hoursOf(c.was), why: str(c.why, 160), slots, yours: c.yours === true, detail: rowsOf(c.detail) });
  });
  const hs = [...events.flatMap((e) => [e.h, e.h + e.d]), ...changes.flatMap((c) => [c.h, c.h + c.d, ...(c.was !== null ? [c.was, c.was + c.d] : []), ...c.slots.flatMap((s) => [s, s + c.d])])];
  let z0 = hs.length ? Math.floor(Math.min(...hs)) : 9;
  let z1 = hs.length ? Math.ceil(Math.max(...hs)) : 17;
  // At least six hours shown, so a short day is not a few giant blocks.
  while (z1 - z0 < 6) {
    if (z0 > 7) z0 -= 1;
    if (z1 - z0 < 6 && z1 < 22) z1 += 1;
    if (z0 <= 7 && z1 >= 22) break;
  }
  return { day: str(o.day, 60), today: str(o.date, 10) === today, events, changes, z0, z1 };
}

// ---- To-do ----

export interface TodoItem {
  id: string;
  text: string;
  note: string;
  who: "home" | "you";
  state: "open" | "doing" | "done";
  steps: { text: string; done: boolean }[];
  result: string;
  detail: Rows;
}

export function todoOf(data: unknown): TodoItem[] {
  const out: TodoItem[] = [];
  arr(obj(data).items).forEach((x, i) => {
    const t = obj(x);
    const text = str(t.text, 160) || str(t.title, 160);
    if (!text) return;
    const state = t.state === "doing" || t.state === "done" ? t.state : "open";
    out.push({
      id: `t:${idOf(t, i, text)}`,
      text,
      note: str(t.note, 120),
      who: t.who === "you" ? "you" : "home",
      state,
      steps: arr(t.steps).map((s) => (typeof s === "string" ? { text: str(s, 120), done: false } : { text: str(obj(s).text, 120), done: obj(s).done === true })).filter((s) => s.text).slice(0, 10),
      result: str(t.result, 160),
      detail: rowsOf(t.detail),
    });
  });
  return out.slice(0, 60);
}

// ---- Triage ----

export type Pile = "inbox" | "needs" | "handled" | "later";
export const PILES: { id: Pile; name: string }[] = [
  { id: "inbox", name: "Inbox" },
  { id: "needs", name: "Needs you" },
  { id: "handled", name: "Handled" },
  { id: "later", name: "Later" },
];
export const pileName = (p: Pile) => PILES.find((x) => x.id === p)?.name ?? "Inbox";

export interface Card {
  id: string;
  from: string;
  title: string;
  pile: Pile;
  verdict: string;
  /** Home is reading it now. */
  reading: boolean;
  /** Where it came from: "gmail", "messages", "calendar", … (an icon and a line; nothing acts on it). */
  source: string;
  question: string;
  options: string[];
  /** A Needs-you card that is a real task: its to-do line. */
  todo: string;
  detail: Rows;
}

export function triageOf(data: unknown): Card[] {
  const out: Card[] = [];
  arr(obj(data).cards).forEach((x, i) => {
    const c = obj(x);
    const title = str(c.title, 160);
    if (!title) return;
    const pile = (["inbox", "needs", "handled", "later"] as const).find((p) => p === c.pile) ?? "inbox";
    out.push({
      id: `g:${idOf(c, i, title)}`,
      from: str(c.from, 60) || "Unknown",
      title,
      pile,
      verdict: str(c.verdict, 160),
      reading: c.reading === true,
      source: str(c.source, 20).toLowerCase(),
      question: str(c.question, 300),
      options: arr(c.options).map((s) => str(s, 60)).filter(Boolean).slice(0, 4),
      todo: str(c.todo, 120),
      detail: rowsOf(c.detail),
    });
  });
  return out.slice(0, 80);
}
