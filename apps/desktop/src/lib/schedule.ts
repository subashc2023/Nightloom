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

import type { Attachment } from "./types";

export type ScheduleKind = "five_hour" | "seven_day" | "time";

/**
 * `waiting` — for its time, or past it and retrying a delivery that could
 * not happen yet (the note says why); `retrying` — due, but the usage
 * still reads exhausted; `limited` — gave up after `RETRY_FOR_MS`;
 * `missed` — its time passed while the app was closed; `held` — a missed
 * one he chose to keep, unscheduled.
 */
export type ScheduleState = "waiting" | "retrying" | "limited" | "missed" | "held";

/** Where a chat lives: its project's id and name; `id: null` is the
 *  unfiled chats. */
export interface ChatProject {
  id: string | null;
  name: string | null;
}

export interface Scheduled {
  /** The chat's id: its draft key. One scheduled message per chat. */
  key: string;
  /**
   * The project its chat lives in (backlog 535), set at the pick: delivery
   * goes into this project's chat whatever is open. Absent on an entry
   * made before 535 — found once from the chat's log (`TickDeps.home`).
   */
  project?: ChatProject;
  /**
   * A delivery was tried while the app ran and could not happen yet
   * (backlog 535). Such a message is not "missed while the app was
   * closed": after a relaunch it keeps trying by itself.
   */
  tried?: boolean;
  /**
   * A tick or Send now is delivering it right now (backlog 535; never
   * stored). Set before the first await of a delivery and read by every
   * other path, so one message is never sent twice.
   */
  claimed?: boolean;
  /** Cancelled or edited away while a delivery of it was in flight (never
   *  stored): that delivery stops before it sends — the words are back in
   *  the box. */
  gone?: boolean;
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
  /**
   * The box's files and images at the pick (backlog 531). Each one's bytes
   * are kept on disk by `stash` (the drafts' `stash_draft_file` copy, item
   * 491) and the store holds the chip without them; read back after a
   * relaunch (`pending` until then). A chip whose copy could not be made
   * keeps its bytes in the store instead. Absent on an entry made before
   * 531 — read as none.
   */
  attachments?: Attachment[];
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
  /** Where the chat `key` lives, from its log on disk; null when no
   *  project has it (backlog 535: an entry from before it carried one). */
  home?(key: string): Promise<ChatProject | null>;
  /** Tell the clock that outlives the page's timers when the next check
   *  is (`wake.rs`); null when nothing waits (backlog 535). */
  arm?(atMs: number | null): void;
  /** Called for every entry on every tick, due or not: the app keeps what
   *  a later send off screen needs (the chat's agent spec, backlog 535). */
  keep?(s: Scheduled): void;
  /** A line for the schedule log (`<config dir>/logs/schedule.log`). */
  log?(text: string): void;
}

/** When the clock should next look: the earliest check among the entries
 *  that still go by themselves; null when none does (backlog 535). */
export function nextCheckAt(map: Record<string, Scheduled>): number | null {
  let at: number | null = null;
  for (const s of Object.values(map)) {
    if (s.state !== "waiting" && s.state !== "retrying") continue;
    const t = s.nextTryAt ?? dueAt(s);
    if (at === null || t < at) at = t;
  }
  return at;
}

/**
 * One check of one scheduled message. Mutates `s`; `"sent"` means it left
 * (the caller drops the entry — the words are in the chat or its queue).
 * Never a loop: a limited or undeliverable message waits `RETRY_EVERY_MS`
 * for its next check, and a limited one stops after `RETRY_FOR_MS`.
 */
export async function tickOne(s: Scheduled, deps: TickDeps): Promise<"sent" | "kept"> {
  if (s.state !== "waiting" && s.state !== "retrying") return "kept";
  // Being delivered by another path right now (Send now, an earlier tick
  // still in flight): that path owns it (backlog 535).
  if (s.claimed) return "kept";
  const now = deps.now();
  if ((s.nextTryAt ?? dueAt(s)) > now) return "kept";
  // Claimed before the first await, so nothing else delivers it meanwhile.
  s.claimed = true;
  try {
    if (await deps.limited()) {
      s.tried = true;
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
    if (s.gone) return "kept";
    const r = await deliverSafely(s, deps);
    if (r.ok) return "sent";
    if (s.gone) return "kept";
    // Cannot go yet: tried again at every tick while the cause can clear
    // (backlog 535; a minute before it, which read as stuck).
    s.state = "waiting";
    s.firstTryAt = null;
    s.tried = true;
    s.nextTryAt = deps.now() + TICK_MS;
    s.note = r.why;
    return "kept";
  } finally {
    s.claimed = false;
  }
}

/** `deps.deliver`, with a throw read as "cannot go yet" — a failed
 *  delivery is a reason in the row, never an error in some other chat. */
export async function deliverSafely(s: Scheduled, deps: Pick<TickDeps, "deliver">): Promise<Delivery> {
  try {
    return await deps.deliver(s);
  } catch (e) {
    return { ok: false, why: `waiting — ${String(e)}` };
  }
}

/** What delivery needs to know and do; the app's, or a test's. Every
 *  step names the entry's own chat (and through `ready`/`start` its
 *  project) — none reads "the open chat" (backlog 535). */
export interface DeliverEnv {
  /** Whether a turn runs in chat `key` now, on screen or off. */
  running: (key: string) => boolean;
  /** Into chat `key`'s own queue, behind its running turn. */
  enqueue: (key: string, text: string, attachments: Attachment[]) => void;
  /** Whether the entry's chat can take a send now, wherever it is; else
   *  the real cause, in words for the row. Sends nothing. */
  ready: (s: Scheduled) => Promise<Delivery>;
  /** Start the turn in the entry's chat, in its project. Returns once the
   *  message has left the scheduler's hands. */
  start: (s: Scheduled) => void;
}

/**
 * Put a due message into its own chat (backlog 535): behind that chat's
 * running turn when it has one (its queue, which that turn's end sends),
 * else sent at once in that chat — on screen if it is the chat he is
 * looking at, in the background otherwise. Nothing here opens a chat or a
 * project, and nothing here reads which chat is open. Waits, with the
 * real reason, when the chat cannot take it yet.
 */
export async function deliverTo(s: Scheduled, env: DeliverEnv): Promise<Delivery> {
  // A chip still being read back from its copy on disk (backlog 531) goes
  // with its bytes or not at all.
  if ((s.attachments ?? []).some((a) => a.pending || !a.data))
    return { ok: false, why: "waiting — its files are being read back" };
  if (env.running(s.key)) {
    env.enqueue(s.key, s.text, s.attachments ?? []);
    return { ok: true };
  }
  const r = await env.ready(s);
  if (!r.ok) return r;
  // Cancelled while that was asked: the words are back in the box.
  if (s.gone) return { ok: false, why: "cancelled" };
  // A turn began in it while that was asked: behind it, as above.
  if (env.running(s.key)) {
    env.enqueue(s.key, s.text, s.attachments ?? []);
    return { ok: true };
  }
  env.start(s);
  return { ok: true };
}

/**
 * The store read at launch. A malformed entry costs that entry; one whose
 * time passed while the app was closed comes back `missed` — asked about,
 * never sent by itself (blocker 468). One whose delivery was already being
 * tried while the app ran (`tried`; before 535, a "waiting — …" note or
 * the limit's retry) was not missed: it comes back waiting and goes by
 * itself (backlog 535 — his row stuck on "could not be opened").
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
    if (typeof m.text !== "string") continue;
    if (typeof m.at !== "number") continue;
    const attachments = readChips(m.attachments);
    if (!m.text && attachments.length === 0) continue;
    const kind: ScheduleKind =
      m.kind === "five_hour" || m.kind === "seven_day" || m.kind === "time" ? m.kind : "time";
    const states: ScheduleState[] = ["waiting", "retrying", "limited", "missed", "held"];
    let state: ScheduleState = states.includes(m.state as ScheduleState) ? (m.state as ScheduleState) : "waiting";
    let note = typeof m.note === "string" ? m.note : null;
    const tried = m.tried === true || state === "retrying" || (state === "waiting" && !!note && note.startsWith("waiting"));
    if ((state === "waiting" || state === "retrying") && dueAt({ kind, at: m.at }) <= nowMs) {
      if (tried) {
        state = "waiting";
      } else {
        state = "missed";
        note = null;
      }
    }
    const project = readProject(m.project);
    out[k] = {
      key: k,
      text: m.text,
      kind,
      at: m.at,
      state,
      firstTryAt: null,
      nextTryAt: null,
      note,
      persist: true,
      attachments,
      ...(project ? { project } : {}),
      ...(tried ? { tried: true } : {}),
    };
  }
  return out;
}

/** A stored entry's project; undefined when absent or malformed (it is
 *  then found again from the chat's log). */
function readProject(v: unknown): ChatProject | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const p = v as Record<string, unknown>;
  if (p.id !== null && typeof p.id !== "string") return undefined;
  return { id: p.id, name: typeof p.name === "string" ? p.name : null };
}

/** The chips of a stored entry: a malformed one costs that chip; one kept
 *  by its copy on disk comes back `pending`, to be read back. */
function readChips(v: unknown): Attachment[] {
  if (!Array.isArray(v)) return [];
  const out: Attachment[] = [];
  for (const c of v) {
    if (c === null || typeof c !== "object") continue;
    const a = c as Record<string, unknown>;
    if (typeof a.id !== "number" || typeof a.media_type !== "string" || typeof a.name !== "string") continue;
    if (a.kind !== "image" && a.kind !== "document" && a.kind !== "file") continue;
    const data = typeof a.data === "string" ? a.data : "";
    const stash = typeof a.stash === "string" && /^[0-9a-f]{64}$/i.test(a.stash) ? a.stash : undefined;
    if (!data && !stash) continue;
    out.push({
      id: a.id,
      kind: a.kind,
      media_type: a.media_type,
      name: a.name,
      data,
      ...(typeof a.label === "string" ? { label: a.label } : {}),
      ...(a.pasted === true ? { pasted: true } : {}),
      ...(typeof a.pages === "number" ? { pages: a.pages } : {}),
      ...(a.whole === true ? { whole: true } : {}),
      ...(typeof a.source_sha256 === "string" ? { source_sha256: a.source_sha256 } : {}),
      ...(stash ? { stash } : {}),
      ...(!data ? { pending: true } : {}),
    });
  }
  return out;
}

/** A chip as the store keeps it: without its bytes when a copy is on disk
 *  (or, with `bare`, always — the over-quota retry), never `pending`. */
function writeChip(a: Attachment, bare: boolean): Attachment | null {
  const data = a.stash || bare ? "" : a.data;
  if (!data && !a.stash) return null;
  return {
    id: a.id,
    kind: a.kind,
    media_type: a.media_type,
    name: a.name,
    data,
    ...(a.label ? { label: a.label } : {}),
    ...(a.pasted ? { pasted: true } : {}),
    ...(a.pages ? { pages: a.pages } : {}),
    ...(a.whole ? { whole: true } : {}),
    ...(a.source_sha256 ? { source_sha256: a.source_sha256 } : {}),
    ...(a.stash ? { stash: a.stash } : {}),
  };
}

/** The store as written: only the entries that may touch the disk. */
export function writeScheduled(map: Record<string, Scheduled>, bare = false): string {
  const out: Record<
    string,
    Pick<Scheduled, "text" | "kind" | "at" | "state" | "note" | "attachments" | "project" | "tried">
  > = {};
  for (const [k, s] of Object.entries(map)) {
    if (!s.persist) continue;
    const attachments = (s.attachments ?? []).map((a) => writeChip(a, bare)).filter((a): a is Attachment => a !== null);
    out[k] = {
      text: s.text,
      kind: s.kind,
      at: s.at,
      state: s.state,
      note: s.note,
      attachments,
      ...(s.project ? { project: { id: s.project.id, name: s.project.name } } : {}),
      ...(s.tried ? { tried: true } : {}),
    };
  }
  return JSON.stringify(out);
}

/** The chip's first line (ScheduledChip, the waiting page): what it is
 *  waiting for, or why it has not gone. */
export function scheduleHead(s: Scheduled, when: (ms: number) => string): string {
  const at = when(dueAt(s));
  if (s.claimed) return `scheduled · ${at} · sending…`;
  switch (s.state) {
    case "missed":
      return `was due ${at} — the app was closed`;
    case "held":
      return s.note ? `held — ${s.note}` : "held — not scheduled";
    case "limited":
      return "not sent — still limited";
    case "retrying":
      return s.note ?? "still limited";
    default:
      return s.note ? `scheduled · ${at} · ${s.note}` : `scheduled · ${at} · ${kindText(s.kind)}`;
  }
}

/**
 * A chat made by Send later has no message yet, so the list would call it
 * by the untitled fallback (backlog 532). Until it is sent, its row's
 * first message is the scheduled one — what the list will read once it
 * goes (a first send's title is its first message). Rows with a title or a
 * first message, and rows with nothing scheduled, come back unchanged.
 */
export function nameScheduledRows<T extends { id: string; title?: string | null; first_user?: string | null }>(
  rows: T[],
  map: Record<string, Pick<Scheduled, "text" | "attachments">>,
): T[] {
  return rows.map((r) => {
    if (r.title || r.first_user) return r;
    const s = map[r.id];
    if (!s) return r;
    const name = s.text.trim() || (s.attachments ?? []).map((a) => a.name).join(", ");
    return name ? { ...r, first_user: name } : r;
  });
}
