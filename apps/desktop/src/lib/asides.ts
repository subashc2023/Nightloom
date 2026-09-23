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
 * all if nothing had: nothing can still be asking after a relaunch. A
 * draft card (opened from a selection, nothing asked) is not kept.
 *
 * Several threads per chat since backlog 176 (2026-09-23): a chat's entry
 * is a **list** of threads, oldest first, and each thread carries an `id`
 * (`nextAsideId`) that tabs and the side panel address it by. A store
 * written before (one thread object per chat) reads back as a list of one.
 * Past the cap the oldest *chats* go, as before.
 */
import type { Aside, AsideTurn } from "./state.svelte";
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
}

function storeTurn(t: AsideTurn): StoredTurn | null {
  const asking = t.answer === null && t.error === null && !t.cancelled;
  const answer = t.answer ?? t.partial;
  if (asking && !answer.trim()) return null;
  return { question: t.question, answer, error: t.error, cancelled: t.cancelled || asking };
}

function storeAside(a: Aside): StoredAside | null {
  if (a.draft) return null;
  const turns = a.turns.map(storeTurn).filter((t): t is StoredTurn => t !== null);
  if (turns.length === 0) return null;
  return a.anchor ? { quote: a.quote, turns, anchor: a.anchor } : { quote: a.quote, turns };
}

/**
 * The store as it is written: threads by chat id, insertion order (the
 * oldest first), trimmed from the front past the cap so the newest
 * threads are the ones kept. Pure.
 */
export function serializeAsides(map: ReadonlyMap<string, readonly Aside[]>): string {
  const entries: [string, StoredAside[]][] = [];
  for (const [k, list] of map) {
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
  if (turns.length === 0) return null;
  return { id: nextAsideId(), quote, draft: false, turns, anchor: isAnchor(a.anchor) ? a.anchor : null };
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

export function saveAsides(map: ReadonlyMap<string, readonly Aside[]>, storage: Pick<Storage, "setItem">): void {
  try {
    storage.setItem(ASIDES_KEY, serializeAsides(map));
  } catch {
    // best-effort, as the drafts are
  }
}
