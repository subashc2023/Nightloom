/**
 * The past asides of each chat (nightshift item 229, night batch B,
 * 2026-09-26; blockers 472–474). Before this the card's × deleted a thread:
 * `dismissAside` took it out of the chat's list and the next save of
 * `nightloom.asides` wrote the list without it. Now a closed thread that
 * had at least one exchange is kept here, per chat, newest last, and can
 * be reopened with its whole thread; only an explicit Delete (which the
 * list confirms first) removes one. A draft with nothing asked is not
 * kept — there is nothing to lose.
 *
 * Kept under its own key, `nightloom.asides.past`, in the stored form the
 * thread store uses (`storedAsideOf` / `asideFromStored` in `asides.ts`),
 * so this file needs no change to that store's code (blocker 472). The
 * same rules as there: text only, every access in try/catch, a size cap
 * past which the oldest chats go, and a private chat (incognito or
 * ephemeral, blocker 217) never written — its past ones live in memory
 * for the window (blocker 474). This file is the pure part; the watching
 * is `asideHistory.svelte.ts`.
 */
import type { Aside } from "./state.svelte";
import { asideFromStored, storedAsideOf, type StoredAsideForm } from "./asides";

export const PAST_KEY = "nightloom.asides.past";
/** Past threads kept per chat; past it the oldest go (blocker 472). */
export const PAST_CAP = 50;
/** Chars of JSON the store may take; past it the oldest chats go. */
export const PAST_MAX_CHARS = 512 * 1024;

export interface PastAside {
  /** Unique within the store; what a row, a reopen and a delete name. */
  key: string;
  /** When it was closed, ms since the epoch. */
  closedAt: number;
  thread: StoredAsideForm;
}

/** Chat id → its past threads, oldest first. */
export type PastMap = Record<string, PastAside[]>;

let keySeq = 0;
function newKey(now: number): string {
  return `${now.toString(36)}-${(++keySeq).toString(36)}`;
}

/**
 * Keep a closed thread under its chat. Returns how many old ones the cap
 * pushed out (0 when none), or null when there was nothing to keep.
 */
export function recordPast(map: PastMap, chat: string, a: Aside, now: number = Date.now()): number | null {
  const thread = storedAsideOf(a);
  if (!thread) return null;
  const list = map[chat] ?? [];
  list.push({ key: newKey(now), closedAt: now, thread });
  let pruned = 0;
  while (list.length > PAST_CAP) {
    list.shift();
    pruned++;
  }
  map[chat] = list;
  return pruned;
}

function remove(map: PastMap, chat: string, key: string): PastAside | null {
  const list = map[chat];
  if (!list) return null;
  const i = list.findIndex((p) => p.key === key);
  if (i < 0) return null;
  const [p] = list.splice(i, 1);
  if (list.length === 0) delete map[chat];
  return p ?? null;
}

/** Take a past thread out of the history as a live thread (fresh id), for
 *  reopening; null when it is not there or cannot be read. */
export function takePast(map: PastMap, chat: string, key: string): Aside | null {
  const p = (map[chat] ?? []).find((q) => q.key === key);
  if (!p) return null;
  const a = asideFromStored(p.thread);
  if (!a) return null;
  remove(map, chat, key);
  return a;
}

/**
 * Delete a past thread for good — only after `confirm` says yes (practices
 * §7: Delete confirms). Returns whether it was removed.
 */
export function deletePast(map: PastMap, chat: string, key: string, confirm: () => boolean): boolean {
  if (!(map[chat] ?? []).some((p) => p.key === key)) return false;
  if (!confirm()) return false;
  return remove(map, chat, key) !== null;
}

/** The store as written: chats in insertion order, a private one left
 *  out, the oldest chats trimmed past the size cap. Pure. */
export function serializePast(map: PastMap, skip: (chat: string) => boolean = () => false): string {
  const entries = Object.entries(map).filter(([k, list]) => !skip(k) && list.length > 0);
  let out = JSON.stringify(Object.fromEntries(entries));
  while (out.length > PAST_MAX_CHARS && entries.length > 1) {
    entries.shift();
    out = JSON.stringify(Object.fromEntries(entries));
  }
  return out;
}

function isPast(v: unknown): v is PastAside {
  if (v === null || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return typeof p.key === "string" && typeof p.closedAt === "number" && asideFromStored(p.thread) !== null;
}

export function loadPast(storage: Pick<Storage, "getItem">): PastMap {
  const out: PastMap = {};
  try {
    const raw = storage.getItem(PAST_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return out;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const list = (Array.isArray(v) ? v : []).filter(isPast).slice(-PAST_CAP);
      if (list.length > 0) out[k] = list;
    }
  } catch {
    // A broken store reads as no history; the next save rewrites it.
  }
  return out;
}

export function savePast(map: PastMap, storage: Pick<Storage, "setItem">, skip?: (chat: string) => boolean): void {
  try {
    storage.setItem(PAST_KEY, serializePast(map, skip));
  } catch {
    // best-effort, as the threads are
  }
}

/** A row's first line: the quoted passage, shortened, or where it came
 *  from when there is none. */
export function quoteSnippet(text: string | null | undefined, max = 60): string {
  if (!text) return "From the composer";
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
