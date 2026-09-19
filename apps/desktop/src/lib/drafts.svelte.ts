/**
 * The composer's draft, per chat (nightshift backlog 065, 2026-09-15).
 *
 * Until today the text and the attachments were state inside
 * `Composer.svelte`, and the component outlives a chat switch — so a draft
 * typed in one chat was still in the box after clicking another, which is
 * the bug he reported ("chat drafts seem to be universal"). Now the draft
 * lives here, keyed by the chat it belongs to: the open chat's id, or
 * ~~`"new"` while no chat is open~~ — since 2026-09-16 (nightshift backlog
 * 094) `new:<project id>:<kind>` while no chat is open (the pending chat,
 * backlog 061), `unfiled` standing in for no project. One literal key for
 * the pending chat was one slot for the whole app: a draft typed into one
 * project's New chat was still in the box after ⌘O into another project,
 * and an incognito draft showed in an ordinary new chat. The kind is part
 * of the key for the same reason the pending kind is held on both sides
 * (blocker 061): the draft belongs to the chat it will make, and that chat
 * has a project and a kind before it has an id. The composer binds to the
 * entry for the current key and nothing else; the key changing is what
 * swaps the box.
 *
 * The pending chat's draft follows the chat it creates: the first send
 * lands a `session_created` line, `send` picks the id off it, and the one
 * line there calls `moveDraft(pendingKey, id)` with the key it computed at
 * the moment of the send — so anything typed *during* the first turn (the
 * box is not locked while a reply streams) is under the new id when the
 * key changes to it, rather than left behind under the pending key.
 *
 * A store written before 094 has its pending draft under the bare `"new"`;
 * `loadDrafts` reads that entry once as `new:unfiled:normal` (there is no
 * record of which project it was typed in) and the next save writes the
 * new shape. Nothing stored is dropped.
 *
 * Persisted to localStorage, best-effort, the way the transcript prefs
 * are: one key, written debounced, read at load, every access in
 * try/catch. Text always; an attachment only when it is small enough to be
 * worth the storage — the store as a whole has a few megabytes and a pasted
 * screenshot is often most of one, so an attachment over
 * `PERSIST_ATTACHMENT_MAX` base64 chars (or past `PERSIST_TOTAL_MAX` for
 * the whole store) stays in memory only, and a relaunch keeps the text and
 * drops that chip. Said here because it is the one place a draft is not
 * whole across a relaunch.
 *
 * Clearing: sending clears that chat's entry. Nothing else does — not a
 * switch, not Escape, not a delete of the chat (the entry outlives the
 * row, harmlessly). The never-lose-work rule.
 *
 * The queue (nightshift backlog 089, 2026-09-16): a message sent while a
 * turn is running is held here, in the same entry as the draft, under
 * `queue` — oldest first — and the composer sends the oldest as the next
 * turn when the running one ends. It lives with the draft because it is
 * the same kind of thing: words he typed that have not reached the model.
 * Same key, so the pending chat's queue moves to the chat it makes; same
 * store, so a relaunch keeps it (attachments under the same caps); and a
 * send clears the box but never the queue, which is why `clearDraft`
 * keeps the entry while a queue remains. The engine does not matter:
 * `send` is one path for both.
 *
 * The in-place edit (nightshift backlog 137, 2026-09-17): the editor open
 * on a past turn is the same kind of thing — words he typed that have not
 * gone anywhere — and it lived inside `Transcript.svelte`, which since
 * the tabs (099) unmounts far more often than it used to: a note tab in
 * the same pane, the live tab dragged to the other pane, a turn started
 * from the phone. Each of those lost the draft. So the open edit, one per
 * chat, is stashed here (`stashEdit` / `takeEdit`), keyed by the chat, the
 * turn's index inside; the transcript writes it on a switch, on unmount
 * and when a turn starts, and reads it back on mount, on the switch back
 * and when the turn ends. In memory only for now — it is not in the
 * localStorage entry, so a relaunch is the one thing that drops it.
 *
 * The draft history (nightshift backlog 158, 2026-09-18): an 11k-character
 * draft was queued during a turn, taken back into the box (↑ in an empty
 * box takes back the newest held message — silently), and then replaced
 * by a paste that carried a screenshot instead of the words. Nothing in
 * the store was wrong; the store simply held only the newest text. So
 * every composer key keeps a ring of the last `HISTORY_PER_KEY` texts of
 * `HISTORY_MIN_CHARS` or more that *left the box*: a send, a queue, and a
 * replacement that dropped more than half of what was there in one change
 * (a select-all paste, a cut — never a keystroke, which keeps all but one
 * character). A second store, `nightloom.draft-history`, written the same
 * way as the drafts; `HISTORY_TOTAL_MAX` across every key, oldest dropped
 * first. It follows `moveDraft` as the draft does. A send never erases it.
 *
 * And a held message is never dropped by the app (only by his ×): a queued
 * message whose send failed goes back into the box when the box is empty,
 * and to the head of the queue when it is not (`requeueFront`) — before
 * 158 it was dropped in the second case.
 */
import type { Attachment, ChatMode } from "./types";
import type { EditState } from "./edit";

export interface Draft {
  text: string;
  attachments: Attachment[];
  /** Messages sent during a turn, oldest first; empty when none. */
  queue: QueuedMessage[];
}

/** One held message: what a send would have carried, plus a row id. */
export interface QueuedMessage {
  id: number;
  text: string;
  attachments: Attachment[];
}

/**
 * The pending chat's key before backlog 094: one literal for the whole app.
 * Kept for the one-time read in `loadDrafts`; nothing writes it any more.
 */
export const LEGACY_NEW_DRAFT_KEY = "new";
/** The prefix of every pending-chat key; a chat id never starts with it. */
export const NEW_DRAFT_PREFIX = "new:";
/** What stands for "no project" in a pending-chat key. */
export const UNFILED = "unfiled";

const KEY = "nightloom.drafts";
const SAVE_DELAY_MS = 400;
/** The draft history's store (backlog 158). */
const HISTORY_KEY = "nightloom.draft-history";
/** A text shorter than this is not worth a ring slot. */
export const HISTORY_MIN_CHARS = 200;
/** Snapshots kept per composer key, newest first. */
export const HISTORY_PER_KEY = 10;
/** Characters of text across every key's ring; the oldest go first. */
export const HISTORY_TOTAL_MAX = 200 * 1024;
/** Base64 chars; ~384 KB of file. */
export const PERSIST_ATTACHMENT_MAX = 512 * 1024;
/** Base64 chars across every persisted attachment. */
export const PERSIST_TOTAL_MAX = 3 * 1024 * 1024;

/** What the composer binds to while a chat has no entry yet. Frozen: a
 *  write goes through `draftFor`, which makes the entry. */
const EMPTY: Draft = Object.freeze({
  text: "",
  attachments: Object.freeze([]) as unknown as Attachment[],
  queue: Object.freeze([]) as unknown as QueuedMessage[],
});

/**
 * The pending chat's key: `new:<project id>:<kind>`, `unfiled` for no
 * project. A pending chat has a project and a kind before it has an id,
 * and the draft belongs to the chat it will make.
 */
export function newDraftKey(projectId: string | null | undefined, mode: ChatMode = "normal"): string {
  return `${NEW_DRAFT_PREFIX}${projectId ?? UNFILED}:${mode}`;
}

/** The open chat's id, or the pending chat's key while none is open. */
export function draftKey(
  activeSessionId: string | null,
  projectId: string | null | undefined = null,
  mode: ChatMode = "normal",
): string {
  return activeSessionId ?? newDraftKey(projectId, mode);
}

function readQueue(v: unknown): QueuedMessage[] {
  if (!Array.isArray(v)) return [];
  const out: QueuedMessage[] = [];
  for (const q of v) {
    if (q === null || typeof q !== "object") continue;
    const m = q as Record<string, unknown>;
    const text = typeof m.text === "string" ? m.text : "";
    const attachments = Array.isArray(m.attachments) ? m.attachments.filter(isAttachment) : [];
    if (!text && attachments.length === 0) continue;
    out.push({ id: typeof m.id === "number" ? m.id : 0, text, attachments });
  }
  return out;
}

function isAttachment(v: unknown): v is Attachment {
  if (v === null || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.id === "number" &&
    (a.kind === "image" || a.kind === "document") &&
    typeof a.media_type === "string" &&
    typeof a.name === "string" &&
    typeof a.data === "string"
  );
}

/** Read the store. A malformed entry costs that entry, not the store. */
export function loadDrafts(storage: Pick<Storage, "getItem"> = localStorage): Record<string, Draft> {
  const out: Record<string, Draft> = {};
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return out;
    for (const [raw_k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === null || typeof v !== "object") continue;
      const d = v as Record<string, unknown>;
      const text = typeof d.text === "string" ? d.text : "";
      const attachments = Array.isArray(d.attachments) ? d.attachments.filter(isAttachment) : [];
      const queue = readQueue(d.queue);
      if (!text && attachments.length === 0 && queue.length === 0) continue;
      // The pre-094 pending key, read once into the unfiled ordinary slot.
      // Appended if that slot is already in the store, so neither is lost.
      const k = raw_k === LEGACY_NEW_DRAFT_KEY ? newDraftKey(null) : raw_k;
      const prior = out[k];
      if (!prior) {
        out[k] = { text, attachments, queue };
      } else {
        prior.text = prior.text ? (text ? `${prior.text}\n${text}` : prior.text) : text;
        prior.attachments.push(...attachments);
        prior.queue.push(...queue);
      }
    }
  } catch {
    // A broken store reads as no drafts; the next save rewrites it.
  }
  return out;
}

/**
 * The store as it is written: empty entries dropped, attachments kept
 * only under the caps above. Pure, so the test can pin what a big paste
 * does to the file without a storage at all.
 */
export function serializeDrafts(map: Record<string, Draft>): string {
  let budget = PERSIST_TOTAL_MAX;
  const keep = (list: Attachment[]): Attachment[] => {
    const kept: Attachment[] = [];
    for (const a of list) {
      if (a.data.length > PERSIST_ATTACHMENT_MAX || a.data.length > budget) continue;
      budget -= a.data.length;
      kept.push({ id: a.id, kind: a.kind, media_type: a.media_type, name: a.name, data: a.data });
    }
    return kept;
  };
  const out: Record<string, Draft> = {};
  for (const [k, d] of Object.entries(map)) {
    const queue = d.queue ?? [];
    if (!d.text && d.attachments.length === 0 && queue.length === 0) continue;
    out[k] = {
      text: d.text,
      attachments: keep(d.attachments),
      queue: queue.map((q) => ({ id: q.id, text: q.text, attachments: keep(q.attachments) })),
    };
  }
  return JSON.stringify(out);
}

export function saveDrafts(
  map: Record<string, Draft>,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(KEY, serializeDrafts(map));
  } catch {
    // Over quota, most likely. Try once more with the text alone: the text
    // is the part that cannot be re-pasted.
    try {
      const bare: Record<string, Draft> = {};
      for (const [k, d] of Object.entries(map))
        bare[k] = {
          text: d.text,
          attachments: [],
          queue: (d.queue ?? []).map((q) => ({ id: q.id, text: q.text, attachments: [] })),
        };
      storage.setItem(KEY, serializeDrafts(bare));
    } catch {
      // best-effort
    }
  }
}

function readInitial(): Record<string, Draft> {
  return typeof localStorage === "undefined" ? {} : loadDrafts();
}

export const drafts: Record<string, Draft> = $state(readInitial());

// Attachment ids are per launch and only have to be unique among the
// chips on screen; restored ones are counted so a new paste cannot reuse
// one of theirs.
let attachSeq = 0;
// Queue row ids likewise: per launch, unique among the rows on screen.
let queueSeq = 0;
for (const d of Object.values(drafts)) {
  for (const a of d.attachments) attachSeq = Math.max(attachSeq, a.id);
  for (const q of d.queue) {
    queueSeq = Math.max(queueSeq, q.id);
    for (const a of q.attachments) attachSeq = Math.max(attachSeq, a.id);
  }
}

export function nextAttachmentId(): number {
  return ++attachSeq;
}

export function nextQueueId(): number {
  return ++queueSeq;
}

let timer: ReturnType<typeof setTimeout> | null = null;

/** Write soon. Debounced: a keystroke is not worth a synchronous write. */
function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flushDrafts, SAVE_DELAY_MS);
}

/** Write now. Called on the debounce and when the page is going away. */
export function flushDrafts(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (typeof localStorage === "undefined") return;
  saveDrafts(drafts);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushDrafts);
}

/** The entry for a key, or the frozen empty draft. Never inserts. */
export function readDraft(key: string): Draft {
  return drafts[key] ?? EMPTY;
}

/** The entry for a key, made if missing. For writes. */
export function draftFor(key: string): Draft {
  let d = drafts[key];
  if (!d) {
    d = { text: "", attachments: [], queue: [] };
    drafts[key] = d;
    d = drafts[key]!;
  }
  return d;
}

/** Non-empty text, at least one chip, or a held message: what earns the
 *  row its mark. */
export function hasDraft(key: string): boolean {
  const d = drafts[key];
  return d !== undefined && (d.text.trim().length > 0 || d.attachments.length > 0 || d.queue.length > 0);
}

export function setDraftText(key: string, text: string): void {
  if (!drafts[key] && !text) return;
  const d = draftFor(key);
  // A change that drops more than half of what was there (a select-all
  // paste, a cut) is a replacement; the old words go to the ring first.
  if (d.text.length >= HISTORY_MIN_CHARS && retained(d.text, text) * 2 < d.text.length) recordDraft(key, d.text);
  d.text = text;
  schedule();
}

export function addAttachment(key: string, a: Attachment): void {
  draftFor(key).attachments.push(a);
  schedule();
}

export function removeAttachment(key: string, id: number): void {
  const d = drafts[key];
  if (!d) return;
  const i = d.attachments.findIndex((a) => a.id === id);
  if (i >= 0) d.attachments.splice(i, 1);
  schedule();
}

export function setDraftAttachments(key: string, attachments: Attachment[]): void {
  if (!drafts[key] && attachments.length === 0) return;
  draftFor(key).attachments = attachments;
  schedule();
}

/** Sending is the one thing that clears a draft — the box, never the
 *  queue: a held message is not the one that just went. */
export function clearDraft(key: string): void {
  const d = drafts[key];
  if (!d) return;
  recordDraft(key, d.text);
  if (d.queue.length === 0) {
    delete drafts[key];
  } else {
    d.text = "";
    d.attachments = [];
  }
  schedule();
}

/** Hold a message for the next turn, after any already held. */
export function enqueueMessage(key: string, text: string, attachments: Attachment[]): QueuedMessage {
  const q: QueuedMessage = { id: nextQueueId(), text, attachments };
  draftFor(key).queue.push(q);
  recordDraft(key, text);
  schedule();
  return q;
}

/**
 * A held message back at the head of the queue (backlog 158): what a
 * failed send does with the words it took when the box already holds
 * others. It keeps its row id, so the strip shows the same row again.
 */
export function requeueFront(key: string, q: QueuedMessage): void {
  if (!q.text && q.attachments.length === 0) return;
  draftFor(key).queue.unshift(q);
  schedule();
}

/** The oldest held message, removed: what goes as the next turn. */
export function shiftQueue(key: string): QueuedMessage | null {
  const d = drafts[key];
  if (!d || d.queue.length === 0) return null;
  const q = d.queue.shift()!;
  if (!d.text && d.attachments.length === 0 && d.queue.length === 0) delete drafts[key];
  schedule();
  return q;
}

/**
 * A held message back into the box (its row gone): the words go in
 * front of anything already typed, the chips after the ones there, so
 * nothing on either side is lost. `id` omitted takes the newest, which
 * is what ↑ in an empty box does (the CLI's rule, backlog 089).
 */
export function takeBackQueued(key: string, id?: number): QueuedMessage | null {
  const d = drafts[key];
  if (!d || d.queue.length === 0) return null;
  const i = id === undefined ? d.queue.length - 1 : d.queue.findIndex((q) => q.id === id);
  if (i < 0) return null;
  const [q] = d.queue.splice(i, 1);
  d.text = d.text ? (q!.text ? `${q!.text}\n${d.text}` : d.text) : q!.text;
  d.attachments.push(...q!.attachments);
  schedule();
  return q!;
}

/** Drop a held message. His click, not the app's. */
export function dropQueued(key: string, id: number): void {
  const d = drafts[key];
  if (!d) return;
  const i = d.queue.findIndex((q) => q.id === id);
  if (i >= 0) d.queue.splice(i, 1);
  if (!d.text && d.attachments.length === 0 && d.queue.length === 0) delete drafts[key];
  schedule();
}

/**
 * The pending chat's draft becomes the created chat's. Anything already
 * under `to` (a fork's key, say) is kept and the moved text appended
 * after it, so neither side's words are lost.
 */
export function moveDraft(from: string, to: string): void {
  if (from === to) return;
  const src = drafts[from];
  if (!src) return;
  const dst = drafts[to];
  if (!dst) {
    drafts[to] = { text: src.text, attachments: src.attachments.slice(), queue: src.queue.slice() };
  } else {
    dst.text = dst.text ? (src.text ? `${dst.text}\n${src.text}` : dst.text) : src.text;
    dst.attachments.push(...src.attachments);
    dst.queue.push(...src.queue);
  }
  delete drafts[from];
  schedule();
  moveHistory(from, to);
}

// ---- the draft history, per chat (backlog 158) ------------------------------

/** One text that left a box, and when. */
export interface DraftSnapshot {
  text: string;
  /** ISO time. */
  at: string;
}

/** Read the history store. A malformed entry costs that entry. */
export function loadDraftHistory(
  storage: Pick<Storage, "getItem"> = localStorage,
): Record<string, DraftSnapshot[]> {
  const out: Record<string, DraftSnapshot[]> = {};
  try {
    const raw = storage.getItem(HISTORY_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return out;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const ring: DraftSnapshot[] = [];
      for (const s of v) {
        if (s === null || typeof s !== "object") continue;
        const m = s as Record<string, unknown>;
        if (typeof m.text !== "string" || !m.text) continue;
        ring.push({ text: m.text, at: typeof m.at === "string" ? m.at : "" });
      }
      if (ring.length > 0) out[k] = ring.slice(0, HISTORY_PER_KEY);
    }
  } catch {
    // A broken store reads as no history; the next save rewrites it.
  }
  return out;
}

/**
 * The history as it is written: `HISTORY_PER_KEY` per key, and past
 * `HISTORY_TOTAL_MAX` characters overall the oldest snapshots across every
 * key go first. Pure, for the test.
 */
export function serializeDraftHistory(map: Record<string, DraftSnapshot[]>): string {
  const all: { k: string; s: DraftSnapshot }[] = [];
  for (const [k, ring] of Object.entries(map)) for (const s of ring.slice(0, HISTORY_PER_KEY)) all.push({ k, s });
  // Newest first overall; the budget is spent from the newest down.
  all.sort((a, b) => (a.s.at < b.s.at ? 1 : a.s.at > b.s.at ? -1 : 0));
  let budget = HISTORY_TOTAL_MAX;
  const out: Record<string, DraftSnapshot[]> = {};
  for (const { k, s } of all) {
    if (s.text.length > budget) continue;
    budget -= s.text.length;
    (out[k] ??= []).push({ text: s.text, at: s.at });
  }
  return JSON.stringify(out);
}

export function saveDraftHistory(
  map: Record<string, DraftSnapshot[]>,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(HISTORY_KEY, serializeDraftHistory(map));
  } catch {
    // best-effort
  }
}

export const draftHistory: Record<string, DraftSnapshot[]> = $state(
  typeof localStorage === "undefined" ? {} : loadDraftHistory(),
);

let historyTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleHistory(): void {
  if (historyTimer !== null) clearTimeout(historyTimer);
  historyTimer = setTimeout(flushDraftHistory, SAVE_DELAY_MS);
}

/** Write the history now. On the debounce and when the page goes away. */
export function flushDraftHistory(): void {
  if (historyTimer !== null) clearTimeout(historyTimer);
  historyTimer = null;
  if (typeof localStorage === "undefined") return;
  saveDraftHistory(draftHistory);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushDraftHistory);
}

/** A key's ring, newest first; empty when none. Never inserts. */
export function historyFor(key: string): DraftSnapshot[] {
  return draftHistory[key] ?? [];
}

/**
 * How many characters of `before` survive in `after` at its two ends:
 * the common prefix plus the common suffix, never more than either
 * length. A keystroke anywhere keeps all but one; a select-all paste
 * keeps none.
 */
export function retained(before: string, after: string): number {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before[p] === after[p]) p++;
  let s = 0;
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return p + s;
}

/**
 * A text into the key's ring, newest first — when it is long enough and
 * not what the ring already has on top (a queue followed by a clear
 * offers the same words twice). Ten per key.
 */
export function recordDraft(key: string, text: string, at: string = new Date().toISOString()): void {
  if (text.length < HISTORY_MIN_CHARS) return;
  const ring = (draftHistory[key] ??= []);
  if (ring.some((s) => s.text === text)) return;
  ring.unshift({ text, at });
  if (ring.length > HISTORY_PER_KEY) ring.length = HISTORY_PER_KEY;
  scheduleHistory();
}

/**
 * A snapshot back into the box, in front of anything typed there (the
 * take-back's rule): nothing on either side is lost. The ring keeps it —
 * a restore is not a use.
 */
export function restoreDraft(key: string, index: number): DraftSnapshot | null {
  const s = historyFor(key)[index];
  if (!s) return null;
  const d = draftFor(key);
  d.text = d.text ? `${s.text}\n${d.text}` : s.text;
  schedule();
  return s;
}

/** The pending chat's ring follows its draft to the chat it made. */
function moveHistory(from: string, to: string): void {
  const src = draftHistory[from];
  if (!src) return;
  const dst = (draftHistory[to] ??= []);
  for (const s of src) if (!dst.some((x) => x.text === s.text)) dst.push(s);
  dst.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  if (dst.length > HISTORY_PER_KEY) dst.length = HISTORY_PER_KEY;
  delete draftHistory[from];
  scheduleHistory();
}

// ---- the in-place edit, per chat (backlog 137) ------------------------------

/** An open editor as the transcript holds it: the reducer's state and the
 *  cache line as it read when the editor opened. */
export interface EditStash {
  editing: NonNullable<EditState>;
  line: string;
}

const edits = new Map<string, EditStash>();

/** Keep a chat's open edit; `null` forgets it (a cancel, a save). */
export function stashEdit(key: string, entry: EditStash | null): void {
  if (entry) edits.set(key, entry);
  else edits.delete(key);
}

/** A chat's open edit, if one is held. Left in place: the transcript
 *  forgets it through `stashEdit(key, null)` when the edit ends. */
export function takeEdit(key: string): EditStash | null {
  return edits.get(key) ?? null;
}

/** Whether a chat has an edit open somewhere — held here or, when the
 *  transcript is mounted on it, in the transcript (which stashes on the
 *  way out). For the tests. */
export function hasEdit(key: string): boolean {
  return edits.has(key);
}
