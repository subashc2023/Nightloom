/**
 * Scheduled send (nightshift backlog 224, 2026-09-26): a message that
 * sends itself at the five-hour reset, the weekly reset, or a time he
 * picks. This file is the pure half — the times, the one-step clock, the
 * store's shape — so the suite can drive it with a fake clock; the state
 * and the wiring are `scheduled.svelte.ts`.
 *
 * Defaults taken while he slept, each an open blocker in nightshift:
 * 465 (the menu), 466 (one per chat, a chip, persisted like a draft),
 * 467 (reset + 60 s; while still limited, a retry a minute for ten
 * minutes, then "not sent — still limited"), 468 (missed while the app
 * was closed: asked at launch, never sent by itself), 469 (a busy chat
 * queues it; incognito and ephemeral keep it in memory only).
 */

export type ScheduleKind = "five_hour" | "seven_day" | "time";

/**
 * `waiting` — for its time, or past it and retrying a delivery that could
 * not happen yet (the note says why); `retrying` — due, but the usage
 * still reads exhausted; `limited` — gave up after `RETRY_FOR_MS`;
 * `missed` — its time passed while the app was closed; `held` — a missed
 * one he chose to keep, unscheduled.
 */
export type ScheduleState = "waiting" | "retrying" | "limited" | "missed" | "held";

export interface Scheduled {
  /** The chat's id: its draft key. One scheduled message per chat. */
  key: string;
  text: string;
  kind: ScheduleKind;
  /** The moment chosen (ms): the reset itself, or the typed time. */
  at: number;
  state: ScheduleState;
  /** The first check that found the usage still exhausted. */
  firstTryAt: number | null;
  /** Not before this (ms); null goes by `dueAt`. */
  nextTryAt: number | null;
  /** Why it has not gone yet, for the chip. */
  note: string | null;
  /** False in an incognito or ephemeral chat: nothing on disk (blocker 217). */
  persist: boolean;
}

/** After a reset, the margin before sending (item 164's resume margin). */
export const RESET_MARGIN_MS = 60_000;
/** While limited, or while delivery has to wait, the next try. */
export const RETRY_EVERY_MS = 60_000;
/** Limited this long after the first try: stop and say so. */
export const RETRY_FOR_MS = 10 * 60_000;
/** The clock's period while the app runs. */
export const TICK_MS = 15_000;

/** When it goes: a reset's time plus the margin, or the typed time. */
export function dueAt(s: Pick<Scheduled, "kind" | "at">): number {
  return s.kind === "time" ? s.at : s.at + RESET_MARGIN_MS;
}

/** A reset time from the plan reading, or null when unknown or past. */
export function resetTime(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t) || t <= nowMs) return null;
  return t;
}

/**
 * The next `HH:MM` from now: today, or tomorrow when it has passed (or
 * is this very minute). Null for a malformed field.
 */
export function atTime(hhmm: string, nowMs: number): { at: number; tomorrow: boolean } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const d = new Date(nowMs);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= nowMs) {
    d.setDate(d.getDate() + 1);
    return { at: d.getTime(), tomorrow: true };
  }
  return { at: d.getTime(), tomorrow: false };
}

/** `14:05`. */
export function clockText(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** `Mon 14:05`. */
export function dayClockText(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString([], { weekday: "short" })} ${clockText(ms)}`;
}

/** The chip's name for what it waits for. */
export function kindText(kind: ScheduleKind): string {
  return kind === "five_hour" ? "5-hour reset" : kind === "seven_day" ? "weekly reset" : "set time";
}

/** The plan reading, as far as this file needs it. */
export interface PlanReading {
  five_hour: number | null;
  seven_day: number | null;
  five_hour_resets_at: string | null;
  seven_day_resets_at: string | null;
}

/**
 * Still limited: a window reads 100 % *and* its own reset is still ahead.
 * A reading taken before the reset says 100 % with a reset time now past,
 * and that is not "still limited" — it is old.
 */
export function isLimited(p: PlanReading | null | undefined, nowMs: number): boolean {
  if (!p) return false;
  const ex = (pct: number | null, iso: string | null) =>
    pct != null && pct >= 100 && resetTime(iso, nowMs) !== null;
  return ex(p.five_hour, p.five_hour_resets_at) || ex(p.seven_day, p.seven_day_resets_at);
}

/** Delivery's answer: it went (sent or queued), or why it must wait. */
export type Delivery = { ok: true } | { ok: false; why: string };

export interface TickDeps {
  now(): number;
  /** Re-read the plan and say whether a window is still exhausted. */
  limited(): Promise<boolean>;
  deliver(s: Scheduled): Promise<Delivery>;
}

/**
 * One check of one scheduled message. Mutates `s`; `"sent"` means it left
 * (the caller drops the entry — the words are in the chat or its queue).
 * Never a loop: a limited or undeliverable message waits `RETRY_EVERY_MS`
 * for its next check, and a limited one stops after `RETRY_FOR_MS`.
 */
export async function tickOne(s: Scheduled, deps: TickDeps): Promise<"sent" | "kept"> {
  if (s.state !== "waiting" && s.state !== "retrying") return "kept";
  const now = deps.now();
  if ((s.nextTryAt ?? dueAt(s)) > now) return "kept";
  if (await deps.limited()) {
    if (s.firstTryAt === null) s.firstTryAt = now;
    if (now - s.firstTryAt >= RETRY_FOR_MS) {
      s.state = "limited";
      s.nextTryAt = null;
      s.note = "not sent — still limited";
      return "kept";
    }
    s.state = "retrying";
    s.nextTryAt = now + RETRY_EVERY_MS;
    s.note = `still limited — trying each minute until ${clockText(s.firstTryAt + RETRY_FOR_MS)}`;
    return "kept";
  }
  const r = await deps.deliver(s);
  if (r.ok) return "sent";
  s.nextTryAt = now + RETRY_EVERY_MS;
  s.note = r.why;
  return "kept";
}

/** What delivery needs to know and do; the app's, or a test's. */
export interface DeliverEnv {
  connected: () => boolean;
  /** The open chat's key. */
  activeKey: () => string | null;
  busy: () => boolean;
  open: (key: string) => Promise<void>;
  enqueue: (key: string, text: string) => void;
  /** Send the open chat's queue now (the composer's drain). */
  drain: () => Promise<void>;
}

/**
 * Put a due message into its chat: open the chat when nothing runs (the
 * phone's rule), then into the chat's queue — behind a running turn when
 * there is one, else sent at once through the composer's drain, which
 * gives the words back to the box if the send fails. Waits, with a
 * reason, when there is no engine or another chat's turn is running.
 */
export async function deliverTo(s: Scheduled, env: DeliverEnv): Promise<Delivery> {
  if (!env.connected()) return { ok: false, why: "waiting — no engine is connected" };
  if (env.activeKey() !== s.key) {
    if (env.busy()) return { ok: false, why: "waiting — another chat is running a turn" };
    await env.open(s.key);
    if (env.activeKey() !== s.key) return { ok: false, why: "waiting — this chat could not be opened" };
  }
  env.enqueue(s.key, s.text);
  if (!env.busy()) await env.drain();
  return { ok: true };
}

/**
 * The store read at launch. A malformed entry costs that entry; one whose
 * time passed while the app was closed comes back `missed` — asked about,
 * never sent by itself (blocker 468).
 */
export function readScheduled(raw: string | null, nowMs: number): Record<string, Scheduled> {
  const out: Record<string, Scheduled> = {};
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== "object") return out;
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v === null || typeof v !== "object") continue;
    const m = v as Record<string, unknown>;
    if (typeof m.text !== "string" || !m.text) continue;
    if (typeof m.at !== "number") continue;
    const kind: ScheduleKind =
      m.kind === "five_hour" || m.kind === "seven_day" || m.kind === "time" ? m.kind : "time";
    const states: ScheduleState[] = ["waiting", "retrying", "limited", "missed", "held"];
    let state: ScheduleState = states.includes(m.state as ScheduleState) ? (m.state as ScheduleState) : "waiting";
    let note = typeof m.note === "string" ? m.note : null;
    if ((state === "waiting" || state === "retrying") && dueAt({ kind, at: m.at }) <= nowMs) {
      state = "missed";
      note = null;
    }
    out[k] = { key: k, text: m.text, kind, at: m.at, state, firstTryAt: null, nextTryAt: null, note, persist: true };
  }
  return out;
}

/** The store as written: only the entries that may touch the disk. */
export function writeScheduled(map: Record<string, Scheduled>): string {
  const out: Record<string, Pick<Scheduled, "text" | "kind" | "at" | "state" | "note">> = {};
  for (const [k, s] of Object.entries(map)) {
    if (!s.persist) continue;
    out[k] = { text: s.text, kind: s.kind, at: s.at, state: s.state, note: s.note };
  }
  return JSON.stringify(out);
}
