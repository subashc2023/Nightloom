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
import { loadFold, loadFoldRecords, storedFold, type AsideFold, type FoldRecord } from "./asideFold";
import type { Attachment } from "./types";

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
  /** The chips the question carried (backlog 283): names and kinds only —
   *  the bytes stay in memory, under the store's cap. */
  files?: { kind: Attachment["kind"]; name: string; media_type: string }[];
  model?: string;
}

// ---- Backlog 283 (2026-10-02): the aside's composer is the chat's ----

/** The prefix of an aside's key in the drafts store: its composer's text,
 *  chips and held messages live there as a chat's do. */
export const ASIDE_DRAFT_PREFIX = "aside:";

/** A thread's stable name, written with it; random, so two windows or a
 *  reopened past thread never meet another's drafts entry. */
export function newAsideUid(): string {
  const r = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return r.replace(/-/g, "").slice(0, 16);
}

/** The drafts-store key of a thread's composer. A thread made before
 *  283 (no `uid` yet) is keyed by its window id until the keeper gives it
 *  one — `ensureAsideUid` runs wherever a thread is opened. */
export function asideDraftKey(a: { uid?: string; id: number }): string {
  return `${ASIDE_DRAFT_PREFIX}${a.uid ?? `w${a.id}`}`;
}

/** Give a thread its `uid` if it has none. Not from a `$derived`. */
export function ensureAsideUid<T extends { uid?: string }>(a: T): T {
  if (!a.uid) a.uid = newAsideUid();
  return a;
}

function cleanUid(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(v) ? v : null;
}
function cleanPick(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= 80 ? t : null;
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
  /** The name he gave the thread (item 265); absent when unnamed. */
  name?: string;
  /** *Fold into thread* under way (backlog 282): the picker or the text
   *  to review, his edit included; never a running turn. */
  fold?: AsideFold;
  /** The folds already appended (282), for the "already folded" line. */
  foldedInto?: FoldRecord[];
  /** Backlog 283: the drafts-store name, and his model / effort picks. */
  uid?: string;
  model?: string;
  effort?: string;
}

function storeTurn(t: AsideTurn): StoredTurn | null {
  const asking = t.answer === null && t.error === null && !t.cancelled;
  const answer = t.answer ?? t.partial;
  if (asking && !answer.trim()) return null;
  const out: StoredTurn = { question: t.question, answer, error: t.error, cancelled: t.cancelled || asking };
  if (t.attachments && t.attachments.length > 0)
    out.files = t.attachments.map((x) => ({ kind: x.kind, name: x.name, media_type: x.media_type }));
  if (t.model) out.model = t.model;
  return out;
}

/** Unsent text worth keeping: anything but whitespace, kept as typed. */
function unsentOf(a: Aside): string | null {
  const u = a.unsent ?? "";
  return u.trim() ? u : null;
}

/**
 * Whether a thread's composer holds something besides its text — chips or
 * held messages in the drafts store (backlog 283). The keeper sets it
 * (`setAsideHeld`), so this file stays pure; a draft card holding only a
 * chip is then kept, as one holding text is.
 */
let heldElsewhere: (a: Aside) => boolean = () => false;
export function setAsideHeld(fn: (a: Aside) => boolean): void {
  heldElsewhere = fn;
}

function storeAside(a: Aside): StoredAside | null {
  const unsent = unsentOf(a);
  let out: StoredAside;
  if (a.draft) {
    // A draft card with nothing typed holds nothing of his (backlog 228)
    // — unless its composer holds a chip or a held message (283).
    if (unsent === null && !heldElsewhere(a)) return null;
    out = { quote: a.quote, turns: [], draft: true };
  } else {
    const turns = a.turns.map(storeTurn).filter((t): t is StoredTurn => t !== null);
    if (turns.length === 0) return null;
    out = { quote: a.quote, turns };
  }
  if (a.anchor) out.anchor = a.anchor;
  if (unsent !== null) out.unsent = unsent;
  const name = cleanAsideName(a.name);
  if (name !== null) out.name = name;
  // Backlog 282: the fold's text and the folds done ride with the thread,
  // a closed one's too (`storedAsideOf` keeps them), so closing the card
  // never loses a summary he has not appended.
  const fold = a.draft ? null : storedFold(a.fold);
  if (fold) out.fold = fold;
  if (!a.draft && a.foldedInto && a.foldedInto.length > 0) out.foldedInto = a.foldedInto.map((r) => ({ ...r }));
  if (a.uid) out.uid = a.uid;
  const model = cleanPick(a.model);
  if (model !== null) out.model = model;
  if (typeof a.effort === "string") out.effort = a.effort.trim().slice(0, 80);
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
    const turn: AsideTurn = {
      seq: --loadedSeq,
      question,
      partial: answer,
      answer,
      error: typeof m.error === "string" ? m.error : null,
      cancelled: m.cancelled === true,
      cacheRead: 0,
    };
    // Backlog 283: the chips by name — the bytes were never written, so a
    // loaded chip is drawn and not sent again (`data` empty).
    if (Array.isArray(m.files)) {
      const files: Attachment[] = [];
      for (const f of m.files) {
        if (f === null || typeof f !== "object") continue;
        const x = f as Record<string, unknown>;
        if ((x.kind !== "image" && x.kind !== "document" && x.kind !== "file") || typeof x.name !== "string") continue;
        files.push({ id: 0, kind: x.kind, name: x.name, media_type: typeof x.media_type === "string" ? x.media_type : "", data: "" });
      }
      if (files.length > 0) turn.attachments = files;
    }
    if (typeof m.model === "string" && m.model) turn.model = m.model;
    turns.push(turn);
  }
  const anchor = isAnchor(a.anchor) ? a.anchor : null;
  const unsent = typeof a.unsent === "string" && a.unsent.trim() ? a.unsent : null;
  const name = cleanAsideName(a.name);
  // A draft card kept for its unsent question (backlog 228).
  const uid = cleanUid(a.uid) ?? newAsideUid();
  const picks = (x: Aside): Aside => {
    const m = cleanPick(a.model);
    if (m !== null) x.model = m;
    if (typeof a.effort === "string") x.effort = a.effort.trim().slice(0, 80);
    return x;
  };
  if (a.draft === true) {
    // Kept for its text, or (283) for chips its composer holds — the
    // keeper only writes such a draft, so a draft read back is his.
    const d: Aside = { id: nextAsideId(), uid, quote, draft: true, turns: [], anchor };
    if (unsent !== null) d.unsent = unsent;
    if (name !== null) d.name = name;
    return picks(d);
  }
  if (turns.length === 0) return null;
  const out: Aside = picks({ id: nextAsideId(), uid, quote, draft: false, turns, anchor });
  if (unsent !== null) out.unsent = unsent;
  if (name !== null) out.name = name;
  const fold = loadFold(a.fold);
  if (fold) out.fold = fold;
  const done = loadFoldRecords(a.foldedInto);
  if (done.length > 0) out.foldedInto = done;
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
  // A reopened past thread gets a fresh drafts-store name (backlog 283):
  // what its box held was discarded with the close.
  delete out.uid;
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

// ---- Item 265 (2026-09-29): an aside's name ----
// He can name a thread; the name is written with it here (and so with a
// past thread, whose stored form is this one), so it survives a relaunch
// and a close-and-reopen. Unnamed, a thread is called by its first
// question, else its passage — the label every list and tab shows.

/** Chars a name keeps; a longer one is cut. */
export const ASIDE_NAME_MAX = 80;

/** A name as kept: one line, trimmed, capped; null for none. */
export function cleanAsideName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const one = v.replace(/\s+/g, " ").trim();
  if (!one) return null;
  return one.length > ASIDE_NAME_MAX ? one.slice(0, ASIDE_NAME_MAX) : one;
}

/** What a thread is called: its name, else its first question, else a
 *  snippet of its passage, else "Aside". One line, at most `max` chars. */
export function asideLabel(
  a: { name?: string; quote: { text: string } | null; turns: readonly { question: string }[]; unsent?: string },
  max = 60,
): string {
  const pick =
    cleanAsideName(a.name) ??
    cleanAsideName(a.turns[0]?.question) ??
    cleanAsideName(a.quote?.text) ??
    "Aside";
  return pick.length > max ? `${pick.slice(0, max - 1)}…` : pick;
}
