/**
 * The chat list's pure half (item 534, Filament IV stage 3): the dated
 * sections under ruled headings (Today · Yesterday · Previous 7 days ·
 * Earlier), each row's clock, its context reading, and the live row's
 * line. `Sidebar.svelte` draws them; the suite pins them here.
 */
import type { SidebarRow } from "./forkTree";

export type DayKey = "today" | "yesterday" | "week" | "earlier";

export const DAY_LABEL: Record<DayKey, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Previous 7 days",
  earlier: "Earlier",
};

const ORDER: DayKey[] = ["today", "yesterday", "week", "earlier"];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Which heading a chat last touched at `iso` sits under. An unreadable
 *  date, or one in the future, counts as today. */
export function dayOf(iso: string, now: number): DayKey {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "today";
  const today = startOfDay(now);
  if (t >= today) return "today";
  const y = new Date(today);
  y.setDate(y.getDate() - 1);
  if (t >= y.getTime()) return "yesterday";
  const w = new Date(today);
  w.setDate(w.getDate() - 7);
  if (t >= w.getTime()) return "week";
  return "earlier";
}

export interface DaySection {
  key: DayKey;
  label: string;
  /** Top-level chats in it (forks under them are not counted). */
  count: number;
  rows: SidebarRow[];
}

/**
 * The rows cut into dated sections. A fork (depth > 0) stays under the row
 * it follows, in that row's section, so a group never splits; the sections
 * keep the list's own order inside them and come out in day order, empty
 * ones left out.
 */
export function daySections(rows: readonly SidebarRow[], now: number): DaySection[] {
  const by = new Map<DayKey, DaySection>();
  let cur: DaySection | null = null;
  for (const r of rows) {
    if (r.depth === 0 || cur === null) {
      const key = dayOf(r.meta.modified, now);
      cur = by.get(key) ?? null;
      if (!cur) {
        cur = { key, label: DAY_LABEL[key], count: 0, rows: [] };
        by.set(key, cur);
      }
      cur.count++;
    }
    cur.rows.push(r);
  }
  return ORDER.flatMap((k) => (by.has(k) ? [by.get(k)!] : []));
}

/** `2:10 PM` — always the 12-hour clock (his rule), whatever the locale. */
export function clock12(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The row's time, as short as its heading allows: `2:10 PM` today and
 *  yesterday, `Mon 2:10 PM` in the last week, `Nov 3` this year, else
 *  `Nov 3, 2025`. */
export function rowClock(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const day = dayOf(iso, now);
  if (day === "today" || day === "yesterday") return clock12(t);
  const d = new Date(t);
  if (day === "week") return `${DAYS[d.getDay()]} ${clock12(t)}`;
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${md}, ${d.getFullYear()}`;
}

/** `840`, `84k`, `1.2M` — the size on a row: whole thousands, as drawn. */
export function ctxText(n: number): string {
  if (n >= 1_000_000) return `${parseFloat((n / 1_000_000).toFixed(1))}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.max(0, Math.round(n)));
}

export interface CtxLook {
  /** Share of the window, 0..1. */
  fill: number;
  /** Past the chat's hand-off mark. */
  past: boolean;
}

/** The row's bar: its share of the window and whether that is past the
 *  hand-off mark (`mark`, 0..1); null when the window is unknown. */
export function ctxLook(used: number, limit: number | null | undefined, mark: number): CtxLook | null {
  if (!limit || limit <= 0 || !Number.isFinite(used)) return null;
  const fill = Math.max(0, Math.min(used / limit, 1));
  return { fill, past: fill >= mark };
}

/** The live row's clock: `0:41`, `12:05`, `1:02:09`. */
export function liveClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** How many tool calls the live reply has made so far. */
export function toolCount(segments: readonly { kind: string }[] | null | undefined): number {
  return segments ? segments.filter((s) => s.kind === "tool").length : 0;
}
