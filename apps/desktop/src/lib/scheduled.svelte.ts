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
 * Files and images (backlog 531): the box's chips go with the message.
 * At the pick each one's bytes are copied to disk the way a draft's long
 * PDF is (`stash_draft_file`, item 491: `~/.nightloom/draft-files/<sha>`),
 * and the store keeps the chip without them, so a screenshot does not
 * fill localStorage; a relaunch reads them back (`restoreScheduledFiles`)
 * before anything is delivered. Cancel and Edit put them back in the box
 * with the words. A copy gone from disk is never silently skipped: the
 * entry is held, with a note naming the file, for his Send now or Cancel.
 *
 * The clock (`startScheduleClock`) ticks every `TICK_MS` and again when the
 * window becomes visible, so a Mac that slept past the time sends on wake.
 * What a tick needs from the app — the plan reading, opening a chat, the
 * composer's queue — comes in as `TickDeps` (see `scheduleRuntime.ts`), so
 * this file stays testable without the backend.
 */
import {
  draftFileIdsIn,
  draftFor,
  nextAttachmentId,
  readDraft,
  setDraftAttachments,
  setDraftText,
  settleStashed,
  stashedChips,
} from "./drafts.svelte";
import { readDraftFile, stashDraftFile } from "./api";
import type { Attachment } from "./types";
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
    // Over quota, most likely (a chip whose disk copy failed keeps its
    // bytes here): once more without any chip's bytes, so the words and
    // the times are kept whatever happens. Best-effort, like the drafts.
    try {
      localStorage.setItem(KEY, writeScheduled(scheduled, true));
    } catch {
      // best-effort
    }
  }
}

/** The disk copies (`stash` ids) the scheduled messages name, saved and in
 *  memory: kept by the drafts' prune (`pruneDraftCopies`). */
export function scheduledFileIds(): string[] {
  let saved: string[] = [];
  try {
    if (typeof localStorage !== "undefined") saved = draftFileIdsIn(localStorage.getItem(KEY)) ?? [];
  } catch {
    // the live ones below still count
  }
  const live = Object.values(scheduled).flatMap((s) => (s.attachments ?? []).map((a) => a.stash?.toLowerCase()));
  return [...new Set([...saved, ...live].filter((x): x is string => !!x))];
}

/**
 * The box's chips as a scheduled message keeps them (backlog 531): each
 * one's bytes copied to disk and named by `stash`. Copies, so the box's
 * own chips are untouched; a chip already copied (a long PDF, item 491)
 * keeps its copy; one whose copy fails keeps its bytes for the store.
 */
export async function stashChips(
  chips: Attachment[],
  stash: (data: string) => Promise<string> = stashDraftFile,
): Promise<Attachment[]> {
  return Promise.all(
    chips.map(async (c) => {
      const a: Attachment = { ...c };
      delete a.pending;
      if (a.stash || !a.data) return a;
      try {
        a.stash = await stash(a.data);
      } catch {
        // kept with its bytes
      }
      return a;
    }),
  );
}

/** Fill, or with `null` give up on, every chip — scheduled or given back
 *  to a box — that waits for the disk copy `id`. */
function settleCopy(id: string, data: string | null): void {
  for (const s of Object.values(scheduled)) {
    const lost: string[] = [];
    s.attachments = (s.attachments ?? []).filter((a) => {
      if (a.stash !== id || a.data) return true;
      if (data === null) {
        lost.push(a.name);
        return false;
      }
      a.data = data;
      delete a.pending;
      return true;
    });
    if (lost.length > 0) {
      // Never sent without a file he attached: held for him to decide.
      s.state = "held";
      s.nextTryAt = null;
      s.note = `${lost.join(", ")} could not be read back after the restart — attach it again`;
    }
  }
  for (const { chip } of stashedChips())
    if (chip.stash === id) settleStashed(chip, data === null ? null : { data, pending: false });
  save();
}

let restoring: Promise<void> | null = null;

/**
 * After a relaunch, the scheduled chips kept by their disk copy get their
 * bytes back; once a launch (and again for any entry added unread, which
 * cannot happen today). Delivery waits on it.
 */
export function restoreScheduledFiles(read: (id: string) => Promise<string> = readDraftFile): Promise<void> {
  const ids = new Set<string>();
  for (const s of Object.values(scheduled))
    for (const a of s.attachments ?? []) if (a.stash && !a.data) ids.add(a.stash);
  if (ids.size === 0) return restoring ?? Promise.resolve();
  const job = Promise.all(
    [...ids].map((id) =>
      read(id).then(
        (data) => settleCopy(id, data),
        () => settleCopy(id, null),
      ),
    ),
  ).then(() => {});
  restoring = job;
  return job;
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
export function scheduleSend(
  key: string,
  text: string,
  kind: ScheduleKind,
  at: number,
  persist: boolean,
  attachments: Attachment[] = [],
): boolean {
  if (scheduled[key] || (!text.trim() && attachments.length === 0)) return false;
  scheduled[key] = {
    key,
    text,
    kind,
    at,
    state: "waiting",
    firstTryAt: null,
    nextTryAt: null,
    note: null,
    persist,
    attachments: attachments.slice(),
  };
  save();
  return true;
}

/**
 * Cancel (or Edit): the entry goes and its words go back into the box, in
 * front of anything typed since — the queue's take-back rule — and its
 * files and images back among the box's chips, before any added since
 * (backlog 531), with fresh ids (a chip read back after a relaunch carries
 * an id of the launch before). A chip still being read back from disk goes
 * in `pending`, and `track` (the composer's `trackPending`) is given the
 * read, so Send waits for it as for a conversion.
 */
export function cancelScheduled(key: string, track?: (id: number, job: Promise<void>) => void): string | null {
  const s = scheduled[key];
  if (!s) return null;
  const typed = readDraft(key).text;
  if (s.text) setDraftText(key, typed ? `${s.text}\n${typed}` : s.text);
  const back = (s.attachments ?? []).map((a) => ({ ...a, id: nextAttachmentId() }));
  if (back.length > 0) {
    setDraftAttachments(key, [...back, ...draftFor(key).attachments]);
    if (track && restoring) for (const a of back) if (a.pending) track(a.id, restoring);
  }
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
    await (restoring ?? Promise.resolve());
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
  if (!scheduled[key] || !d) return null;
  await (restoring ?? Promise.resolve());
  const s = scheduled[key];
  if (!s) return null;
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
  // A relaunch's scheduled files come back from disk first (backlog 531).
  void restoreScheduledFiles();
  clock = setInterval(() => void runScheduleTick(), TICK_MS);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void runScheduleTick();
    });
  }
  void runScheduleTick();
}
