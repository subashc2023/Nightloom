/**
 * Home (nightshift item 763, H1–H3), as data: the pinned project, its feed,
 * and the pieces of one continuous chat — a date divider where two messages'
 * local days differ, a hand-off divider where the chat handed off in place
 * (blocker 2021's answer), and the morning scan drawn as a card. Pure: the
 * store is `home.svelte.ts`; `home763.test.ts` pins these.
 */
import type { SessionEvent } from "./types";

/** The `source` of the project that is Home (`~/.nightloom/home/`). */
export const HOME_SOURCE = "nightloom:home";
/** The first line of the morning scan's message; the facts follow it. */
export const SCAN_LINE = "Morning scan — write today's Home page.";

export interface HomeInfo {
  project_id: string;
  /** Today's Home chat; null before the first one. */
  chat_id: string | null;
  folder: string;
  brief: string;
  /** The scan's time in words, "every day at 8:00 AM". */
  scan_words: string;
  scan_job_id: string | null;
}

export type FeedKind =
  | "done"
  | "failed"
  | "limit"
  | "question"
  | "approval"
  | "changes"
  | "stuck"
  | "job_done"
  | "job_failed"
  | "scan"
  | "hand_off";

export interface FeedRow {
  /** RFC 3339. */
  at: string;
  kind: FeedKind;
  label: string | null;
  chat: string | null;
  project: string | null;
  line: string;
}

export interface HomeFeed {
  rows: FeedRow[];
  seen_at: string | null;
}

// ---- Item 804: what Home can reach ----

export type ReachKind = "mail" | "calendar" | "files" | "other";
export type ReachStatus = "connected" | "needs_sign_in" | "failed";

/** One connector Claude Code listed — for a service with several accounts, one row per account. */
export interface ReachAccount {
  /** Claude Code's name for it; what turning it on or off takes. */
  connector: string;
  service: string;
  kind: ReachKind;
  /** The account's address, once a scan has read it. */
  address: string | null;
  /** Which account of its service, from 1, when there are several. */
  nth: number | null;
  status: ReachStatus;
  on: boolean;
  claude_ai: boolean;
  in_scan: boolean;
}

export interface HomeReach {
  /** RFC 3339; null before the first check. */
  checked_at: string | null;
  error: string | null;
  accounts: ReachAccount[];
  /** What macOS keeps on this Mac that Home does not read, with why. */
  locals: { name: string; why: string }[];
}

export const REACH_GROUPS: { kind: ReachKind; title: string }[] = [
  { kind: "mail", title: "Mail" },
  { kind: "calendar", title: "Calendars" },
  { kind: "files", title: "Files and documents" },
  { kind: "other", title: "Other tools" },
];

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth"];

/** A row's name: the address when known, else the service and which account. */
export function reachName(a: ReachAccount): string {
  if (a.address) return a.address;
  if (a.nth === null) return a.service;
  return `${a.service} · ${ORDINALS[a.nth - 1] ?? `#${a.nth}`} account`;
}

/** Under the name: the service when the name is an address, and what Home does with it. */
export function reachNote(a: ReachAccount): string {
  const service = a.address ? `${a.service} · ` : "";
  if (a.status === "needs_sign_in") return `${service}Not reachable — sign in to it at claude.ai, under Settings, Connectors.`;
  if (a.status === "failed") return `${service}Not reachable — it did not answer the last check.`;
  if (!a.on) return `${service}Turned off for Home.`;
  if (a.in_scan) return `${service}Read by the morning scan and Home's chat.`;
  if (!a.claude_ai) return `${service}One of your own tools; Home's chat can use it.`;
  return `${service}Home's chat can read it; the scan does not.`;
}

export function reachStatusWords(s: ReachStatus): string {
  return s === "connected" ? "Connected" : s === "needs_sign_in" ? "Needs sign-in" : "Not answering";
}

/** "3 mail accounts and 2 calendars are read each morning", or why none is. */
export function reachSummary(r: HomeReach | null): string {
  if (!r || r.checked_at === null) return "Not checked yet.";
  const n = (k: ReachKind) => r.accounts.filter((a) => a.in_scan && a.kind === k).length;
  const mail = n("mail");
  const cal = n("calendar");
  if (mail + cal === 0) return "The morning scan reads no mail or calendar yet.";
  const part = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;
  const parts = [mail ? part(mail, "mail account", "mail accounts") : "", cal ? part(cal, "calendar", "calendars") : ""].filter(Boolean);
  return `The morning scan reads ${parts.join(" and ")}.`;
}

/** Whether a project is Home: by its source, never its name (he may rename it). */
export function isHome(p: { source?: string | null } | null | undefined): boolean {
  return p?.source === HOME_SOURCE;
}

/** The projects with Home first and the rest in their own order. */
export function homeFirst<T extends { source?: string | null }>(ps: readonly T[]): T[] {
  const home = ps.filter(isHome);
  return home.length === 0 ? [...ps] : [...home, ...ps.filter((p) => !isHome(p))];
}

/**
 * The ⌘P palette's number keys (item 763 finish): every other project keeps
 * the number it had before Home existed (his muscle memory) — their own
 * order, 1–9 — and Home, listed first, takes the next free number, or none
 * past 9. `ids` in the palette's order (Home first); the key for each.
 */
export function paletteKeys<T extends { id: string; source?: string | null }>(ps: readonly T[]): Map<string, string> {
  const keys = new Map<string, string>();
  const others = ps.filter((p) => !isHome(p));
  others.forEach((p, i) => keys.set(p.id, i < 9 ? String(i + 1) : ""));
  const next = others.length + 1;
  for (const p of ps.filter(isHome)) keys.set(p.id, next <= 9 ? String(next) : "");
  return keys;
}

/** Home's model and effort (blocker 2041): Opus 5.5 at low effort for the
 *  scan and his messages alike, so his first message reads the scan's warm
 *  cache. A default only — he can switch a Home chat like any. */
export const HOME_MODEL = "claude-opus-5-5";
export const HOME_EFFORT = "low";

/** The sidebar's count beside Home: "3 need you", or nothing at none. */
export function homeCount(n: number): string {
  return n <= 0 ? "" : `${n} need${n === 1 ? "s" : ""} you`;
}

// ---- the scan card ----

/** Whether a user message is the morning scan (its first line is the scan line). */
export function isScanMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  const first = text.trimStart().split("\n", 1)[0].trim();
  return first === SCAN_LINE;
}

/** The facts under the scan line, as code collected them. */
export function scanFacts(text: string): string {
  const t = text.trimStart();
  const nl = t.indexOf("\n");
  return nl < 0 ? "" : t.slice(nl + 1).trim();
}

/** The card's fold line: "42 lines of facts". */
export function factsWords(facts: string): string {
  if (!facts) return "no facts";
  const n = facts.split("\n").filter((l) => l.trim()).length;
  return `${n} line${n === 1 ? "" : "s"} of facts`;
}

// ---- time words ----

function asDate(at: string | Date): Date | null {
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A local day as `YYYY-MM-DD`; null for a time that does not parse. */
export function localDay(at: string | Date): string | null {
  const d = asDate(at);
  if (!d) return null;
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "Tuesday, November 17"; the year is added only when it is not this year's. */
export function dateLabel(at: string | Date, now: Date = new Date()): string {
  const d = asDate(at);
  if (!d) return "";
  const base = `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** "4:12 AM" — local, 12-hour. */
export function clock(at: string | Date): string {
  const d = asDate(at);
  if (!d) return "";
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

/** A context size in words: 212345 → "212k", 999 → "999", 1.2M → "1.2M". */
export function kTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

// ---- dividers: one continuous chat ----

export interface HandOff {
  /** The event's place in the log (its fold is kept under it). */
  index: number;
  brief: string;
  context: number;
  reason: "soft" | "hard";
  at: string;
}

export type Divider =
  | { kind: "date"; day: string; label: string }
  | ({ kind: "hand_off" } & HandOff);

/** "Handed off in place · 212k → fresh · 4:12 AM". */
export function handOffLine(h: Pick<HandOff, "context" | "at">): string {
  const t = clock(h.at);
  return `Handed off in place · ${kTokens(h.context)} → fresh${t ? ` · ${t}` : ""}`;
}

/** The divider's tooltip: two short lines, numbers first. A soft hand-off happens only once the
 *  chat's cache has gone cold (item 792), so its line says that. */
export function handOffTip(h: Pick<HandOff, "context" | "reason">): string {
  return `${kTokens(h.context)} of context → a fresh start\n${h.reason === "hard" ? "At the hard limit" : "After the cache went cold"} · click for the brief`;
}

/** One run-log entry a hand-off carried (items 789 and 791: `chain.rs` writes them as `### <stamp> · <who>`). */
export interface CarriedEntry {
  /** When it was written, ISO; null when the heading carries no stamp (he edited it). */
  at: string | null;
  /** "by the model", "run failed · by code", … */
  who: string;
  body: string;
}

/** The run-log entries a hand-off's brief carried, oldest first; none for a brief from before the run log. */
export function carriedEntries(brief: string): CarriedEntry[] {
  const out: CarriedEntry[] = [];
  let inLog = false;
  let cur: CarriedEntry | null = null;
  for (const line of brief.split("\n")) {
    if (line.startsWith("## ")) {
      inLog = line.startsWith("## Run log");
      cur = null;
      continue;
    }
    if (!inLog) continue;
    if (line.startsWith("### ")) {
      const head = line.slice(4).trim();
      const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC(?: · (.*))?$/.exec(head);
      cur = { at: m ? `${m[1]}T${m[2]}Z` : null, who: m ? (m[3] ?? "") : head, body: "" };
      out.push(cur);
      continue;
    }
    // The section's closing note ("(3 older entries …)") is not part of an entry.
    if (cur && !/^\(\d+ older entr/.test(line)) cur.body += (cur.body ? "\n" : "") + line;
  }
  for (const e of out) e.body = e.body.trim();
  return out;
}

/** The newest entry a hand-off carried — what happened in the slice above its divider. */
export function lastCarried(brief: string): CarriedEntry | null {
  const all = carriedEntries(brief);
  return all.length ? all[all.length - 1] : null;
}

/** "Run log · 8:03 AM" or "Run failed · 8:03 AM": the divider's label for that entry. */
export function carriedLabel(e: CarriedEntry): string {
  const t = e.at ? clock(e.at) : "";
  const what = /failed/.test(e.who) ? "Run failed" : "Run log";
  return t ? `${what} · ${t}` : what;
}

/** The `hand_off` events of a log, with their places. */
export function handOffsOf(evs: readonly SessionEvent[]): HandOff[] {
  const out: HandOff[] = [];
  evs.forEach((e, index) => {
    if (e.event === "hand_off") {
      out.push({ index, brief: e.brief ?? "", context: e.context ?? 0, reason: e.reason === "hard" ? "hard" : "soft", at: e.at });
    }
  });
  return out;
}

/** One drawn item as the dividers see it: its log index, and its time (null: not dated, as a rewound turn). */
export interface DatedItem {
  index: number;
  at: string | null;
}

export interface DividerPlaces {
  /** Dividers drawn before the item at this position, in order. */
  before: Map<number, Divider[]>;
  /** Dividers after the last item (a hand-off at the log's end). */
  tail: Divider[];
}

/**
 * Where the dividers go. Each hand-off sits before the first item logged
 * after it; a date divider sits before any dated element (a message or a
 * hand-off) whose local day differs from the previous dated element's —
 * between two, never before the first.
 */
export function placeDividers(items: readonly DatedItem[], handOffs: readonly HandOff[]): DividerPlaces {
  const before = new Map<number, Divider[]>();
  const tail: Divider[] = [];
  let lastDay: string | null = null;
  let h = 0;
  const dated = (into: Divider[], at: string | null) => {
    const day = at ? localDay(at) : null;
    if (!day) return;
    if (lastDay !== null && day !== lastDay) into.push({ kind: "date", day, label: dateLabel(at as string) });
    lastDay = day;
  };
  items.forEach((it, i) => {
    const here: Divider[] = [];
    while (h < handOffs.length && handOffs[h].index < it.index) {
      const ho = handOffs[h++];
      dated(here, ho.at);
      here.push({ kind: "hand_off", ...ho });
    }
    dated(here, it.at);
    if (here.length) before.set(i, here);
  });
  while (h < handOffs.length) {
    const ho = handOffs[h++];
    dated(tail, ho.at);
    tail.push({ kind: "hand_off", ...ho });
  }
  return { before, tail };
}

// ---- Done since you looked ----

/** The feed rows newer than `seenAt`, newest first; all of them when he has never looked. */
export function doneSince(rows: readonly FeedRow[], seenAt: string | null): FeedRow[] {
  const seen = seenAt ? Date.parse(seenAt) : NaN;
  return rows
    .filter((r) => Number.isNaN(seen) || Date.parse(r.at) > seen)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The few words on a feed row's left. */
export const FEED_TAG: Record<FeedKind, string> = {
  done: "finished",
  failed: "failed",
  limit: "hit a limit",
  question: "question",
  approval: "approval",
  changes: "changes",
  stuck: "stuck",
  job_done: "job ran",
  job_failed: "job failed",
  scan: "morning scan",
  hand_off: "handed off",
};

export function feedTag(kind: string): string {
  return (FEED_TAG as Record<string, string>)[kind] ?? kind.replace(/_/g, " ");
}

/** Item 763 H6: the Home row's figure, "0.3%" of the week today; "" before
 *  any spend. `paused` when the spend guard holds its runs. Pure. */
export function todayFigure(t: { points: number; stop: string | null } | null): { text: string; paused: boolean } {
  if (!t) return { text: "", paused: false };
  const text = t.points > 0 ? `${Math.round(t.points * 10) / 10}%` : "";
  return { text, paused: t.stop != null };
}

/** The Home row's tooltip: the scan's time, then today's spend — two short lines. */
export function homeTip(scanWords: string | null | undefined, t: { points: number; cap: number; stop: string | null } | null): string {
  const first = scanWords ? `Morning scan ${scanWords}` : "Today's Home chat";
  if (!t) return first;
  const pct = (n: number) => `${Math.round(n * 10) / 10}%`;
  const second = t.stop ? `Runs paused: ${t.stop}` : `Today ${pct(t.points)} of the week, cap ${pct(t.cap)}`;
  return `${first}\n${second}`;
}
