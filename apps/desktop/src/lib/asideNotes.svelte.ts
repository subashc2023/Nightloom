/**
 * The aside changes waiting for each chat's next message (nightshift item
 * 775) — `asideNotes.ts` has the design and the pure part. Kept in
 * localStorage, so a relaunch between the aside and his next message
 * loses nothing; a private (incognito or ephemeral) chat's are kept for
 * the window only, as its asides are (blocker 217).
 */
import { loadNotes, noteText, saveNotes, type AsideChange, type PendingAsideNote } from "./asideNotes";

function store(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

/** By chat id; reactive, so the aside's line follows a send. */
export const pendingNotes: Record<string, PendingAsideNote[]> = $state(loadNotes(store() ?? { getItem: () => null }));

let skipChat: (chat: string) => boolean = () => false;
/** Which chats are private (set by the state module, which knows the sessions). */
export function setNoteSkip(fn: (chat: string) => boolean): void {
  skipChat = fn;
}

function save(): void {
  const s = store();
  if (s) saveNotes($state.snapshot(pendingNotes), s, skipChat);
}

/** An aside's answer came back having changed files: they wait for `chat`'s next message. */
export function addAsideNote(chat: string, id: string, question: string, changes: AsideChange[], at = Date.now()): void {
  if (!chat || changes.length === 0) return;
  // A new list goes in whole: `??=` would hand back the raw array, not the
  // state's proxy, and a push onto it is never seen.
  const list = pendingNotes[chat] ?? [];
  const note = { id, question, changes: changes.map((c) => ({ ...c })), at };
  pendingNotes[chat] = [...list.filter((n) => n.id !== id), note];
  save();
}

/** The block for `chat`'s message now going out, and the notes it carries
 *  (taken off the pending list; `restoreAsideNotes` puts them back when
 *  nothing was sent). Null when no aside of it changed anything. */
export function takeAsideNote(chat: string | null): { text: string; notes: PendingAsideNote[] } | null {
  if (!chat) return null;
  const notes = pendingNotes[chat];
  if (!notes || notes.length === 0) return null;
  const text = noteText(notes);
  const taken = $state.snapshot(notes) as PendingAsideNote[];
  delete pendingNotes[chat];
  save();
  return text ? { text, notes: taken } : null;
}

/** A send refused before anything went: its notes wait again, ahead of any newer. */
export function restoreAsideNotes(chat: string, notes: PendingAsideNote[]): void {
  if (notes.length === 0) return;
  const newer = (pendingNotes[chat] ?? []).filter((n) => !notes.some((m) => m.id === n.id));
  pendingNotes[chat] = [...notes, ...newer];
  save();
}

/** Whether an exchange's changes still wait for the main chat's next
 *  message (else they went out in one). Any chat: a tab may show a thread
 *  of a chat not open. */
export function noteWaiting(id: string): boolean {
  return Object.values(pendingNotes).some((list) => list.some((n) => n.id === id));
}
