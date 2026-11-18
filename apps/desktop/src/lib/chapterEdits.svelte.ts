/**
 * ~~His renames and removals live here alone~~ — since item 842 (2026-11-18)
 * the chat's log holds them (`chapter_edit` lines, read by `logEdits`), so
 * the phone and every window read the same names; this store is the
 * window's copy of an edit not yet in the log it reads: written at once,
 * sent to the log (`syncChapterEdits`; refused while a turn holds the chat,
 * sent again after), and dropped once the log says the same. An aside has
 * no log of its own (its scope is `aside:<id>`), so its edits stay here.
 *
 * His renames and removals of chapters (item 799), kept in localStorage
 * under one key, per chat and chapter key (`chapters.ts`). His own words,
 * so never evicted the way `viewState`'s least-recent keys are: only a
 * chat's whole entry goes, and only past `MAX_CHATS` chats, oldest touched
 * first.
 *
 * A removal hides the chapter's divider and moves it to the contents'
 * Removed list, where Restore brings it back — nothing is dropped. A rename
 * saves on every way out of its field; Reset name brings back the code's.
 */
import { untrack } from "svelte";
import { setChapterEdit } from "./api";
import { logEdits, type Chapter, type ChapterEdit } from "./chapters";
import type { SessionEvent } from "./types";

export { withEdits, type ChapterEdit, type ShownChapter } from "./chapters";

export const CHAPTER_EDITS_KEY = "nightloom.chapterEdits.v1";
export const MAX_CHATS = 300;

type Store = Record<string, { t: number; edits: Record<string, ChapterEdit> }>;

function load(): Store {
  try {
    const raw = globalThis.localStorage?.getItem(CHAPTER_EDITS_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Store) : {};
  } catch {
    return {};
  }
}

const state = $state<{ store: Store }>({ store: load() });

function save() {
  try {
    globalThis.localStorage?.setItem(CHAPTER_EDITS_KEY, JSON.stringify(state.store));
  } catch {
    // A full or absent store keeps the edit for this run only.
  }
}

/** Tests: start from a given store (or what localStorage holds). */
export function resetChapterEdits(next: Store | null = null): void {
  state.store = next ?? load();
}

/** A scope whose edits go to a chat's log (every one but an aside's). */
export function logged(chat: string): boolean {
  return !chat.startsWith("aside:");
}

/** Whether two edits say the same (an empty one is "the code's name, shown"). */
function same(a: ChapterEdit | undefined, b: ChapterEdit | undefined): boolean {
  return (a?.title ?? null) === (b?.title ?? null) && !!a?.removed === !!b?.removed;
}

/**
 * His edits of a chat's chapters: the log's (`evs`, when given) with this
 * window's not-yet-logged ones over them. An empty local entry is a cleared
 * name or a restore still on its way to the log.
 */
export function editsFor(chat: string | null, evs: readonly SessionEvent[] | null = null): Record<string, ChapterEdit> {
  if (!chat) return {};
  const out: Record<string, ChapterEdit> = evs ? logEdits(evs) : {};
  for (const [k, e] of Object.entries(state.store[chat]?.edits ?? {})) {
    if (e.title === undefined && !e.removed) delete out[k];
    else out[k] = e;
  }
  return out;
}

function put(chat: string, key: string, edit: ChapterEdit) {
  const cur = state.store[chat]?.edits ?? {};
  const next = { ...cur };
  const clean: ChapterEdit = {};
  if (edit.title !== undefined && edit.title.trim()) clean.title = edit.title.trim();
  if (edit.removed) clean.removed = true;
  // A logged chat keeps an empty edit until the log has it: it may clear a
  // name the log holds. An aside's empty edit is nothing to keep.
  if (clean.title === undefined && !clean.removed && !logged(chat)) delete next[key];
  else next[key] = clean;
  const store = { ...state.store };
  if (Object.keys(next).length === 0) delete store[chat];
  else store[chat] = { t: Date.now(), edits: next };
  const chats = Object.keys(store);
  if (chats.length > MAX_CHATS) {
    chats.sort((a, b) => store[a].t - store[b].t);
    for (const c of chats.slice(0, chats.length - MAX_CHATS)) delete store[c];
  }
  state.store = store;
  save();
  if (logged(chat)) void send(chat, key, clean);
}

/** The write to the log (a test swaps it). */
type Writer = (chat: string, key: string, edit: ChapterEdit) => Promise<void>;
let writer: Writer = (chat, key, edit) => setChapterEdit(chat, key, edit.title ?? null, !!edit.removed);

export function setChapterWriter(w: Writer): void {
  writer = w;
}

/** Edits on their way to the log, and the last refusal's time, per `chat|key`. */
const inflight = new Set<string>();
const refused = new Map<string, number>();
/** What each `chat|key` last wrote to the log, so a sync does not write it twice. */
const sent = new Map<string, string>();
/** A refused write (a turn holds the chat) is tried again at most this often (ms). */
export const RETRY_MS = 5000;

async function send(chat: string, key: string, edit: ChapterEdit): Promise<void> {
  const id = `${chat}|${key}`;
  if (inflight.has(id)) return;
  inflight.add(id);
  try {
    await writer(chat, key, edit);
    refused.delete(id);
    // The log has it now; the window's copy stays until the log it reads
    // shows the same (`syncChapterEdits`), so the name never flickers back.
    const cur = state.store[chat]?.edits?.[key];
    if (cur && same(cur, edit)) sent.set(id, JSON.stringify(edit));
  } catch {
    refused.set(id, Date.now());
  } finally {
    inflight.delete(id);
  }
}

/**
 * Bring a chat's log and this window's edits together (item 842): an edit
 * the log already says is dropped here; one it does not is sent (again
 * after a refusal, at most every `RETRY_MS`). Run whenever the chat's log
 * changes — that is also how 799's edits, kept here before 842, reach the log.
 */
export function syncChapterEdits(chat: string | null, evs: readonly SessionEvent[], now = Date.now()): void {
  if (!chat || !logged(chat)) return;
  untrack(() => {
    const local = state.store[chat]?.edits;
    if (!local) return;
    const log = logEdits(evs);
    const keep: Record<string, ChapterEdit> = {};
    let dropped = false;
    for (const [k, e] of Object.entries(local)) {
      if (same(log[k], e)) {
        dropped = true;
        sent.delete(`${chat}|${k}`);
        continue;
      }
      keep[k] = e;
      const id = `${chat}|${k}`;
      if (sent.get(id) === JSON.stringify(e)) continue;
      const r = refused.get(id);
      if (r !== undefined && now - r < RETRY_MS) continue;
      void send(chat, k, e);
    }
    if (!dropped) return;
    const store = { ...state.store };
    if (Object.keys(keep).length === 0) delete store[chat];
    else store[chat] = { t: store[chat].t, edits: keep };
    state.store = store;
    save();
  });
}

/** What a chapter's edit is now: from the chapter as drawn (log and window
 *  together) when the caller has it, else this window's copy alone. */
type Edited = Pick<Chapter, "key" | "title"> & { shown?: string; renamed?: boolean; removed?: boolean };
function current(chat: string, c: Edited | string): ChapterEdit {
  if (typeof c === "string" || c.renamed === undefined) return editsFor(chat)[typeof c === "string" ? c : c.key] ?? {};
  return { ...(c.renamed && c.shown ? { title: c.shown } : {}), ...(c.removed ? { removed: true } : {}) };
}

/** A rename; an empty or unchanged title clears it (the code's title again). */
export function renameChapter(chat: string, c: Edited, title: string): void {
  const cur = current(chat, c);
  const t = title.replace(/\s+/g, " ").trim();
  put(chat, c.key, { ...cur, title: t && t !== c.title ? t : undefined });
}

/** Remove or restore; `c` is the chapter as drawn (its name kept) or a bare key. */
export function setChapterRemoved(chat: string, c: Edited | string, removed: boolean): void {
  const cur = current(chat, c);
  put(chat, typeof c === "string" ? c : c.key, { ...cur, removed });
}
