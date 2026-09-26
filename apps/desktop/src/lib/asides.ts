/**
 * The aside threads, kept across a relaunch (nightshift backlog 137,
 * 2026-09-17; review E's FE4).
 *
 * An aside (backlog 081) is a side question of the open chat, answered
 * off its cache and written nowhere — not the log, not the CLI's files —
 * which is by design; a thread of them (backlog 130) is kept per chat in
 * a map in `state.svelte.ts`, the way drafts are (backlog 065). The map
 * was in memory only, so a relaunch took every thread with it, and an
 * engine switch nulled the open chat's without stashing it. His reading,
 * gone. Now the map is written to localStorage the way the drafts are:
 * one key, debounced, text only, every access in try/catch, and read once
 * at load. This file is the pure part — what is written and what is read
 * back — so the suite can pin it; `asides.svelte.ts` does the watching.
 *
 * What a stored turn keeps: the question, the answer as he saw it (the
 * partial text stands in for one cut short), the error, the cancelled
 * mark. Not the `seq` (per launch; a loaded turn gets a negative one,
 * unique for the card's keyed list, which no live exchange has) and not
 * `cacheRead`. A turn still asking when the store
 * was written comes back as cancelled with what had arrived, or not at
 * all if nothing had: nothing can still be asking after a relaunch. ~~A
 * draft card (opened from a selection, nothing asked) is not kept.~~
 *
 * Unsent text is kept since backlog 228 (2026-09-26, his "I have some
 * asides drafts that are still a work in progress"; practices §7): a
 * thread's `unsent` — the question typed in a draft card's box, or the
 * follow-up typed under an answered thread — is written with the thread,
 * and a draft card that holds text is kept with its quote and anchor, so
 * it comes back under its passage. A draft card with nothing typed is
 * still not kept: there is nothing of his in it. Whitespace alone counts
 * as nothing.
 *
 * Several threads per chat since backlog 176 (2026-09-23): a chat's entry
 * is a **list** of threads, oldest first, and each thread carries an `id`
 * (`nextAsideId`) that tabs and the side panel address it by. A store
 * written before (one thread object per chat) reads back as a list of one.
 * Past the cap the oldest *chats* go, as before.
 *
 * An incognito or ephemeral chat's threads are never written (blocker
 * 217, his "yes" of 2026-09-24; nightshift backlog 059): their answers are
 * model output about a chat whose promise is that it is written nowhere.
 * They live in the in-memory stash for the window and a relaunch loses
 * them, which is the mode's own rule. The keeper passes `skip`
 * (`isPrivateChat`), so a thread stored before this rule is dropped at the
 * next save once its chat is known to be private.
 */
import type { Aside, AsideTurn } from "./state.svelte";
import type { ChatMode } from "./types";
import type { AsideQuote } from "./asideQuote";
import type { AsideAnchor } from "./asideCard";

export const ASIDES_KEY = "nightloom.asides";
let loadedSeq = 0;
let lastAsideId = 0;
/** A new thread's id (backlog 176): unique for the life of the window,
 *  loaded threads included. Not saved — a relaunch numbers them again. */
export function nextAsideId(): number {
  return ++lastAsideId;
}
/** Chars of JSON the store may take; past it the oldest threads go. */
export const ASIDES_MAX_CHARS = 512 * 1024;

/**
 * The chats seen open in a private mode this window (blocker 217). The
 * listing names an incognito chat's mode, but an ephemeral chat is never
 * listed and a new incognito one is not listed until its first turn — so
 * the keeper records the open chat's mode here while it is open, and the
 * record outlives the switch away. Memory only.
 */
const privateChats = new Set<string>();

/** Note the open chat's mode; a normal one records nothing. */
export function markChatMode(id: string, mode: ChatMode): void {
  if (mode !== "normal") privateChats.add(id);
}

/**
 * Whether a chat's asides stay off disk: its listing row's mode when it is
 * listed (a mode is fixed at birth, so the row is the authority), else
 * whether it was seen open as incognito or ephemeral this window.
 */
export function isPrivateChat(id: string, sessions: readonly { id: string; mode?: ChatMode }[]): boolean {
  const row = sessions.find((s) => s.id === id);
  if (row) return (row.mode ?? "normal") !== "normal";
  return privateChats.has(id);
}

/** For the suite: forget what `markChatMode` recorded. */
export function resetPrivateChats(): void {
  privateChats.clear();
}

interface StoredTurn {
  question: string;
  answer: string;
  error: string | null;
  cancelled: boolean;
}

interface StoredAside {
  quote: AsideQuote | null;
  turns: StoredTurn[];
  /** The passage's place (backlog 141), so a restored thread's card opens
   *  under its passage again; absent for a composer aside. */
  anchor?: AsideAnchor;
  /** Opened from a selection and not yet asked (backlog 228): kept only
   *  when it holds `unsent` text. */
  draft?: true;
  /** Text typed in the thread's box and not sent (backlog 228). */
  unsent?: string;
}

function storeTurn(t: AsideTurn): StoredTurn | null {
  const asking = t.answer === null && t.error === null && !t.cancelled;
  const answer = t.answer ?? t.partial;
  if (asking && !answer.trim()) return null;
  return { question: t.question, answer, error: t.error, cancelled: t.cancelled || asking };
}

/** Unsent text worth keeping: anything but whitespace, kept as typed. */
function unsentOf(a: Aside): string | null {
  const u = a.unsent ?? "";
  return u.trim() ? u : null;
}

function storeAside(a: Aside): StoredAside | null {
  const unsent = unsentOf(a);
  let out: StoredAside;
  if (a.draft) {
    // A draft card with nothing typed holds nothing of his (backlog 228).
    if (unsent === null) return null;
    out = { quote: a.quote, turns: [], draft: true };
  } else {
    const turns = a.turns.map(storeTurn).filter((t): t is StoredTurn => t !== null);
    if (turns.length === 0) return null;
    out = { quote: a.quote, turns };
  }
  if (a.anchor) out.anchor = a.anchor;
  if (unsent !== null) out.unsent = unsent;
  return out;
}

/** Whether the store keeps this thread (a draft with no text is not; nor
 *  a thread whose only turn was still asking with nothing arrived). The
 *  tab store numbers aside tabs by their place among these. */
export function asideKept(a: Aside): boolean {
  return storeAside(a) !== null;
}

/**
 * The store as it is written: threads by chat id, insertion order (the
 * oldest first), trimmed from the front past the cap so the newest
 * threads are the ones kept. A chat `skip` names (an incognito or
 * ephemeral one, blocker 217) is left out. Pure.
 */
export function serializeAsides(
  map: ReadonlyMap<string, readonly Aside[]>,
  skip: (chat: string) => boolean = () => false,
): string {
  const entries: [string, StoredAside[]][] = [];
  for (const [k, list] of map) {
    if (skip(k)) continue;
    const s = list.map(storeAside).filter((a): a is StoredAside => a !== null);
    if (s.length > 0) entries.push([k, s]);
  }
  let out = JSON.stringify(Object.fromEntries(entries));
  while (out.length > ASIDES_MAX_CHARS && entries.length > 1) {
    entries.shift();
    out = JSON.stringify(Object.fromEntries(entries));
  }
  return out;
}

function isAnchor(v: unknown): v is AsideAnchor {
  if (v === null || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a.turn === "number" &&
    typeof a.block === "number" &&
    typeof a.start === "number" &&
    typeof a.end === "number" &&
    (a.side === "below" || a.side === "above")
  );
}

function isQuote(v: unknown): v is AsideQuote {
  if (v === null || typeof v !== "object") return false;
  const q = v as Record<string, unknown>;
  return typeof q.text === "string" && (q.role === "assistant" || q.role === "user") && typeof q.ordinal === "number";
}

/** Read the store back into threads. A malformed entry costs that entry. */
function loadAside(v: unknown): Aside | null {
  if (v === null || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  const quote = isQuote(a.quote) ? a.quote : null;
  const turns: AsideTurn[] = [];
  for (const t of Array.isArray(a.turns) ? a.turns : []) {
    if (t === null || typeof t !== "object") continue;
    const m = t as Record<string, unknown>;
    const question = typeof m.question === "string" ? m.question : "";
    const answer = typeof m.answer === "string" ? m.answer : "";
    if (!question && !answer) continue;
    turns.push({
      seq: --loadedSeq,
      question,
      partial: answer,
      answer,
      error: typeof m.error === "string" ? m.error : null,
      cancelled: m.cancelled === true,
      cacheRead: 0,
    });
  }
  const anchor = isAnchor(a.anchor) ? a.anchor : null;
  const unsent = typeof a.unsent === "string" && a.unsent.trim() ? a.unsent : null;
  // A draft card kept for its unsent question (backlog 228).
  if (a.draft === true) {
    if (unsent === null) return null;
    return { id: nextAsideId(), quote, draft: true, turns: [], anchor, unsent };
  }
  if (turns.length === 0) return null;
  const out: Aside = { id: nextAsideId(), quote, draft: false, turns, anchor };
  if (unsent !== null) out.unsent = unsent;
  return out;
}

export function loadAsides(storage: Pick<Storage, "getItem">): Map<string, Aside[]> {
  const out = new Map<string, Aside[]>();
  try {
    const raw = storage.getItem(ASIDES_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return out;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      // A list since backlog 176; one thread object before it.
      const list = (Array.isArray(v) ? v : [v]).map(loadAside).filter((a): a is Aside => a !== null);
      if (list.length > 0) out.set(k, list);
    }
  } catch {
    // A broken store reads as no threads; the next save rewrites it.
  }
  return out;
}

export function saveAsides(
  map: ReadonlyMap<string, readonly Aside[]>,
  storage: Pick<Storage, "setItem">,
  skip?: (chat: string) => boolean,
): void {
  try {
    storage.setItem(ASIDES_KEY, serializeAsides(map, skip));
  } catch {
    // best-effort, as the drafts are
  }
}

// ---- Night batch B (item 229, 2026-09-26): the past asides' hooks ----
// Additions only (agent AS edits the code above tonight). A closed thread
// is kept in `asideHistory.ts` under its own key in the same stored form a
// thread has here, so these two wrappers are the whole interface.

/** A thread's stored form, as `nightloom.asides` writes it. */
export type StoredAsideForm = StoredAside;

/** One thread in its stored form; null for a draft or a thread with
 *  nothing to keep (the rule `serializeAsides` applies).
 *  Merge (2026-09-26, AS's 228 × B's 229): the store now keeps a draft
 *  and a thread's `unsent` text; a *closed* thread keeps neither — every
 *  close with text went through the Discard confirmation, so the text was
 *  dropped on purpose and must not come back when the past aside reopens. */
export function storedAsideOf(a: Aside): StoredAsideForm | null {
  const out = storeAside(a);
  if (out === null || out.draft) return null;
  delete out.unsent;
  return out;
}

/** A stored thread read back as a live one, with a fresh id; null when
 *  malformed or empty (and, since the 228 merge, for a draft), and never
 *  with `unsent` text. */
export function asideFromStored(v: unknown): Aside | null {
  const a = loadAside(v);
  if (a === null || a.draft) return null;
  delete a.unsent;
  return a;
}
