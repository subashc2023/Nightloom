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
 * The clock (backlog 535): the page's own timers stop while its window is
 * hidden or covered (a 5-hour-reset message went an hour late, when he
 * touched the Mac), so the time is kept by the backend (`wake.rs`). After
 * every change this file says when it next has something to do
 * (`TickDeps.arm`), and the backend's `wake-due` event runs a tick at that
 * moment (`scheduleRuntime.ts`). `startScheduleClock` still ticks every
 * `TICK_MS` and when the window becomes visible, as a second line. What a
 * tick needs from the app — the plan reading, the chat's project, the send
 * itself — comes in as `TickDeps`, so this file stays testable without the
 * backend.
 *
 * Exactly once (backlog 535): a tick and Send now both claim an entry
 * (`claimed`) before their first await; whoever comes second leaves it
 * alone. The entry is dropped, and the store written at once, the moment
 * the message is handed to its chat.
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
import { readDraftFile, reserveChatAgent, stashDraftFile } from "./api";
import type { Attachment } from "./types";
import {
  TICK_MS,
  deliverSafely,
  nextCheckAt,
  readScheduled,
  tickOne,
  writeScheduled,
  type ChatProject,
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
  /** The project the chat lives in (backlog 535): where it is delivered. */
  project?: ChatProject,
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
    ...(project ? { project: { id: project.id, name: project.name } } : {}),
  };
  save();
  rearm();
  return true;
}

/**
 * A message the scheduler handed to its chat that the chat then refused
 * before anything was sent (backlog 535; rare — the chat was asked first):
 * back as it was, waiting, with the reason, to be tried again. False when
 * the chat has another scheduled message by now; the caller keeps the
 * words some other way (the chat's queue).
 */
export function restoreScheduled(s: Scheduled, why: string, nowMs: number = Date.now()): boolean {
  // The entry still there and claimed is this very message, its delivery
  // not yet returned (the refusal came first): the restored one takes its
  // place, and the delivery's own drop finds another object and leaves it.
  const cur = scheduled[s.key];
  if (cur && !cur.claimed) return false;
  scheduled[s.key] = {
    ...s,
    state: "waiting",
    firstTryAt: null,
    nextTryAt: nowMs + TICK_MS,
    note: why,
    tried: true,
    claimed: false,
    attachments: (s.attachments ?? []).slice(),
  };
  flushScheduled();
  rearm();
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
/** Whether chat `key`'s kept agent spec is still wanted by something other
 *  than a scheduled message — the limit card's resume waiting on it
 *  (`state.svelte` says, `wantSpec`). 535f, the review's 535-4. */
let specWanted: (key: string) => boolean = () => false;
export function wantSpec(fn: (key: string) => boolean): void {
  specWanted = fn;
}

/**
 * Let chat `key`'s kept agent spec go (535f, the review's 535-4): its
 * scheduled message was sent or cancelled, or its resume went. ~~Kept for
 * good~~ — a stale spec (the model, the tools, safe mode of the day it was
 * scheduled) ran a later off-screen send of the chat's queue. Kept while
 * another message is scheduled in the chat or its resume waits.
 */
export function releaseSpec(key: string): void {
  if (scheduled[key] || specWanted(key)) return;
  void reserveChatAgent(key, false).catch(() => {});
}

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
  s.gone = true;
  delete scheduled[key];
  save();
  rearm();
  releaseSpec(key);
  return s.text;
}

/** A missed one, kept unscheduled (blocker 468's *Keep*). */
export function keepScheduled(key: string): void {
  const s = scheduled[key];
  if (!s) return;
  s.state = "held";
  s.note = null;
  save();
  rearm();
}

let deps: TickDeps | null = null;
/** When the tick in flight began; null when none is. */
let tickingSince: number | null = null;
/** A tick still "in flight" after this long is taken for hung, and the
 *  next one runs beside it (the entry it holds stays claimed, so it is
 *  not sent twice; the others go). */
const TICK_HUNG_MS = 120_000;

/** Tell the backend's clock when the next check is (backlog 535). */
function rearm(d: TickDeps | null = deps): void {
  try {
    d?.arm?.(nextCheckAt(scheduled));
  } catch {
    // the page's own interval still ticks
  }
}

function short(key: string): string {
  return key.slice(0, 8);
}

/**
 * Find the project of every entry that carries none (backlog 535: one
 * made before it, or by a build that lost it) from its chat's log, and
 * keep it. An entry whose chat no project has says so in its row.
 */
async function findHomes(d: TickDeps): Promise<void> {
  if (!d.home) return;
  for (const k of Object.keys(scheduled)) {
    const s = scheduled[k];
    if (!s || s.project) continue;
    let home: ChatProject | null = null;
    try {
      home = await d.home(k);
    } catch {
      continue; // asked again at the next tick
    }
    if (scheduled[k] !== s) continue;
    if (home) {
      s.project = home;
      d.log?.(`home ${short(k)} project=${home.id ?? "unfiled"}`);
      save();
    }
  }
}

/** One pass over every waiting entry. Overlapping calls are one call. */
export async function runScheduleTick(d: TickDeps | null = deps): Promise<void> {
  if (!d) return;
  const began = d.now();
  if (tickingSince !== null && began - tickingSince < TICK_HUNG_MS) return;
  tickingSince = began;
  try {
    await (restoring ?? Promise.resolve());
    await findHomes(d);
    for (const k of Object.keys(scheduled)) {
      const s = scheduled[k];
      if (!s) continue;
      try {
        d.keep?.(s);
      } catch {
        // best-effort
      }
      const before = `${s.state}|${s.note}`;
      const r = await tickOne(s, d);
      if (r === "sent") {
        if (scheduled[k] === s) delete scheduled[k];
        // At once, not on the debounce: a message that has left must not
        // come back from the store after a crash.
        flushScheduled();
        d.log?.(`sent ${short(k)} due=${new Date(s.kind === "time" ? s.at : s.at + 60_000).toISOString()}`);
      } else if (`${s.state}|${s.note}` !== before) {
        save();
        d.log?.(`kept ${short(k)} ${s.state} ${s.note ?? ""}`);
      }
    }
  } finally {
    if (tickingSince === began) tickingSince = null;
    rearm(d);
  }
}

/**
 * *Send now*: his explicit choice, so no limit check — straight to
 * delivery; when delivery must wait, the entry waits and retries. An
 * entry a tick (or an earlier Send now) is delivering this moment is left
 * to it: `null`, nothing sent a second time (backlog 535).
 */
export async function sendScheduledNow(key: string, d: TickDeps | null = deps): Promise<Delivery | null> {
  const s = scheduled[key];
  if (!s || !d || s.claimed) return null;
  // Claimed before the first await: a tick that starts now skips it.
  s.claimed = true;
  let r: Delivery;
  try {
    await (restoring ?? Promise.resolve());
    if (!s.project && d.home) {
      try {
        const home = await d.home(key);
        if (home) s.project = home;
      } catch {
        // delivery says what is missing
      }
    }
    if (s.gone || scheduled[key] !== s) return null;
    r = await deliverSafely(s, d);
  } finally {
    s.claimed = false;
  }
  if (s.gone) return null;
  if (r.ok) {
    if (scheduled[key] === s) delete scheduled[key];
    flushScheduled();
    d.log?.(`sent-now ${short(key)}`);
  } else {
    s.state = "waiting";
    s.firstTryAt = null;
    s.tried = true;
    s.nextTryAt = d.now() + TICK_MS;
    s.note = r.why;
    save();
    d.log?.(`kept-now ${short(key)} ${r.why}`);
  }
  rearm(d);
  return r;
}

let clock: ReturnType<typeof setInterval> | null = null;
/** The debug timing probe (item 535m) logs every tick of the page's own
 *  interval, to tell it from the backend's `wake-due`. */
let logIntervalTicks = false;
export function logEveryIntervalTick(on: boolean): void {
  logIntervalTicks = on;
}

/** Start the clock once; later calls only swap the app's hooks in. */
export function startScheduleClock(d: TickDeps): void {
  deps = d;
  if (clock !== null) return;
  // A relaunch's scheduled files come back from disk first (backlog 531).
  void restoreScheduledFiles();
  rearm();
  clock = setInterval(() => {
    if (logIntervalTicks) deps?.log?.("tick interval");
    void runScheduleTick();
  }, TICK_MS);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void runScheduleTick();
    });
  }
  void runScheduleTick();
}
