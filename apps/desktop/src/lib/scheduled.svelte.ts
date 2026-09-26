/**
 * The scheduled messages, one per chat (nightshift backlog 224; blockers
 * 465–469). Held the way a draft is (`drafts.svelte.ts`): app state plus
 * one localStorage key, written debounced and on page hide, every access
 * in try/catch — so a scheduled message survives a chat switch and a
 * relaunch. An incognito or ephemeral chat's entry is never written
 * (`persist: false`, blocker 217's rule) and a relaunch forgets it.
 *
 * Nothing here drops his words: the entry leaves only by being sent (into
 * the chat or its queue) or by his Cancel/Edit, which put the text back in
 * the box in front of anything typed there since.
 *
 * The clock (`startScheduleClock`) ticks every `TICK_MS` and again when the
 * window becomes visible, so a Mac that slept past the time sends on wake.
 * What a tick needs from the app — the plan reading, opening a chat, the
 * composer's queue — comes in as `TickDeps` (see `scheduleRuntime.ts`), so
 * this file stays testable without the backend.
 */
import { readDraft, setDraftText } from "./drafts.svelte";
import {
  RETRY_EVERY_MS,
  TICK_MS,
  readScheduled,
  tickOne,
  writeScheduled,
  type Delivery,
  type ScheduleKind,
  type Scheduled,
  type TickDeps,
} from "./schedule";

const KEY = "nightloom.scheduled";
const SAVE_DELAY_MS = 400;

function readInitial(): Record<string, Scheduled> {
  try {
    if (typeof localStorage === "undefined") return {};
    return readScheduled(localStorage.getItem(KEY), Date.now());
  } catch {
    return {};
  }
}

export const scheduled: Record<string, Scheduled> = $state(readInitial());

/** Re-read the store as a launch would (the suite's relaunch). */
export function reloadScheduled(raw: string | null, nowMs: number): void {
  for (const k of Object.keys(scheduled)) delete scheduled[k];
  Object.assign(scheduled, readScheduled(raw, nowMs));
}

let timer: ReturnType<typeof setTimeout> | null = null;
function save(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flushScheduled, SAVE_DELAY_MS);
}

/** Write now: on the debounce and when the page goes away. */
export function flushScheduled(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(KEY, writeScheduled(scheduled));
  } catch {
    // best-effort, like the drafts
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushScheduled);
}

export function scheduledFor(key: string): Scheduled | null {
  return scheduled[key] ?? null;
}

/**
 * Hold `text` for `at`. One per chat: false (and nothing changed) when
 * this chat already has one — the caller leaves the words in the box.
 */
export function scheduleSend(key: string, text: string, kind: ScheduleKind, at: number, persist: boolean): boolean {
  if (scheduled[key] || !text.trim()) return false;
  scheduled[key] = { key, text, kind, at, state: "waiting", firstTryAt: null, nextTryAt: null, note: null, persist };
  save();
  return true;
}

/**
 * Cancel (or Edit): the entry goes and its words go back into the box, in
 * front of anything typed since — the queue's take-back rule.
 */
export function cancelScheduled(key: string): string | null {
  const s = scheduled[key];
  if (!s) return null;
  const typed = readDraft(key).text;
  setDraftText(key, typed ? `${s.text}\n${typed}` : s.text);
  delete scheduled[key];
  save();
  return s.text;
}

/** A missed one, kept unscheduled (blocker 468's *Keep*). */
export function keepScheduled(key: string): void {
  const s = scheduled[key];
  if (!s) return;
  s.state = "held";
  s.note = null;
  save();
}

let deps: TickDeps | null = null;
let ticking = false;

/** One pass over every waiting entry. Overlapping calls are one call. */
export async function runScheduleTick(d: TickDeps | null = deps): Promise<void> {
  if (!d || ticking) return;
  ticking = true;
  try {
    for (const k of Object.keys(scheduled)) {
      const s = scheduled[k];
      if (!s) continue;
      const before = `${s.state}|${s.note}`;
      const r = await tickOne(s, d);
      if (r === "sent") {
        if (scheduled[k] === s) delete scheduled[k];
        save();
      } else if (`${s.state}|${s.note}` !== before) {
        save();
      }
    }
  } finally {
    ticking = false;
  }
}

/**
 * *Send now*: his explicit choice, so no limit check — straight to
 * delivery; when delivery must wait, the entry waits and retries.
 */
export async function sendScheduledNow(key: string, d: TickDeps | null = deps): Promise<Delivery | null> {
  const s = scheduled[key];
  if (!s || !d) return null;
  const r = await d.deliver(s);
  if (r.ok) {
    if (scheduled[key] === s) delete scheduled[key];
  } else {
    s.state = "waiting";
    s.firstTryAt = null;
    s.nextTryAt = d.now() + RETRY_EVERY_MS;
    s.note = r.why;
  }
  save();
  return r;
}

let clock: ReturnType<typeof setInterval> | null = null;

/** Start the clock once; later calls only swap the app's hooks in. */
export function startScheduleClock(d: TickDeps): void {
  deps = d;
  if (clock !== null) return;
  clock = setInterval(() => void runScheduleTick(), TICK_MS);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void runScheduleTick();
    });
  }
  void runScheduleTick();
}
