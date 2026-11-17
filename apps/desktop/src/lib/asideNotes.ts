/**
 * Aside changes reach the main chat (nightshift item 775, 2026-11-16) —
 * the pure part: the note's text, reading it back out of his message, and
 * the stored form. `asideNotes.svelte.ts` holds the pending notes.
 *
 * His ask: "is there any way to like send thsoe updates to the main agent
 * in the next message? like doesnt have to be immediately". An aside is a
 * fork of the chat's session; when it edits files (its edit calls, or a
 * shell command the backend sees by looking at the workspace before and
 * after — `aside_changes.rs`) the main chat never hears of it and goes on
 * from stale contents. So the changes wait, per chat, and the main chat's
 * next message carries them: a short block **at the end** of his words,
 * which is past everything the cache holds (the request's prefix — system,
 * tools, the conversation so far — is unchanged; only the new message
 * grows, and it is written fresh either way). Several asides batch into
 * one block; none changed, no block.
 *
 * The block is in the chat's log as part of his message, so the bubble
 * reads it back out (`splitAsideNote`) and draws a chip in its place —
 * after a relaunch too, with nothing stored but the log itself.
 */

/** One file an aside changed, as `ask_aside` returns it. */
export interface AsideChange {
  path: string;
  added: number | null;
  removed: number | null;
  how: "edited" | "written" | "shell" | "deleted";
}

/** One aside's changes waiting for the main chat's next message. */
export interface PendingAsideNote {
  /** The exchange's own name: its thread's uid and the turn's index. */
  id: string;
  /** His question's first words. */
  question: string;
  changes: AsideChange[];
  /** When the answer ended (ms epoch). */
  at: number;
}

export const ASIDE_NOTE_OPEN = "<nightloom-aside-changes>";
export const ASIDE_NOTE_CLOSE = "</nightloom-aside-changes>";
export const ASIDE_NOTE_KEY = "nightloom.asideNotes";
/** His question's first characters in the note. */
export const QUESTION_CHARS = 60;

/** His question as the note quotes it: one line, its first 60 characters. */
export function questionHead(q: string): string {
  const one = q.replace(/\s+/g, " ").trim();
  return one.length > QUESTION_CHARS ? `${one.slice(0, QUESTION_CHARS - 1)}…` : one;
}

/** One change as the note words it: `path` (+a −b), or what is known. */
export function changeWords(c: AsideChange): string {
  const p = "`" + c.path + "`";
  if (c.how === "deleted") return `${p} (deleted)`;
  if (c.how === "written") return c.added != null ? `${p} (written whole, ${c.added} lines)` : `${p} (written whole)`;
  if (c.added != null && c.removed != null) return `${p} (+${c.added} −${c.removed})`;
  return c.how === "shell" ? `${p} (changed by a shell command)` : `${p} (edited)`;
}

/** The block the main chat's next message ends with, or "" when no aside changed anything. */
export function noteText(notes: readonly PendingAsideNote[]): string {
  const live = notes.filter((n) => n.changes.length > 0);
  if (live.length === 0) return "";
  const head =
    live.length === 1
      ? "Nightloom note: since your last turn, an aside the user asked beside this chat changed files:"
      : `Nightloom note: since your last turn, ${live.length} asides the user asked beside this chat changed files:`;
  const rows = live.map((n) => `- aside "${questionHead(n.question)}": ${n.changes.map(changeWords).join(", ")}`);
  return [ASIDE_NOTE_OPEN, head, ...rows, "Re-read these before relying on their earlier contents.", ASIDE_NOTE_CLOSE].join("\n");
}

/** His words with the block put at their end, past the cached prefix. */
export function withNote(text: string, note: string): string {
  if (!note) return text;
  return text.trim() === "" ? note : `${text}\n\n${note}`;
}

/** One aside's row read back out of a message. */
export interface NoteRow {
  question: string;
  /** Each change as the note worded it, the backticks off. */
  changes: string[];
}

const BLOCK = new RegExp(`(?:\\n\\n)?${ASIDE_NOTE_OPEN}\\n([\\s\\S]*?)\\n${ASIDE_NOTE_CLOSE}\\s*$`);
const ROW = /^- aside "(.*)": (.*)$/;

/** Split a message's text into his words and the note's rows (null: no note). */
export function splitAsideNote(text: string): { text: string; rows: NoteRow[] | null; files: number } {
  const m = BLOCK.exec(text);
  if (!m) return { text, rows: null, files: 0 };
  const rows: NoteRow[] = [];
  for (const line of m[1]!.split("\n")) {
    const r = ROW.exec(line);
    if (!r) continue;
    // A comma inside a path's backticks is the path's, not a separator.
    const changes = (r[2]!.match(/`[^`]*`(?: \([^)]*\))?/g) ?? []).map((s) => s.replace(/`/g, ""));
    rows.push({ question: r[1]!, changes });
  }
  return { text: text.slice(0, m.index), rows, files: rows.reduce((n, r) => n + r.changes.length, 0) };
}

/** The aside's own line under an answer that changed files: which files,
 *  and whether the main chat has heard yet. */
export function changesLine(changes: readonly AsideChange[], waiting: boolean): string {
  const names = changes.slice(0, 3).map((c) => c.path);
  const more = changes.length > 3 ? ` and ${changes.length - 3} more` : "";
  const what = `Changed ${names.join(", ")}${more}`;
  return waiting
    ? `${what} — the main chat will hear of these changes on its next message`
    : `${what} — the main chat was told of these changes with its next message`;
}

/** The chip's words: "carries N aside changes". */
export function chipWords(files: number): string {
  return `carries ${files} aside ${files === 1 ? "change" : "changes"}`;
}

function cleanChange(v: unknown): AsideChange | null {
  if (v === null || typeof v !== "object") return null;
  const x = v as Record<string, unknown>;
  if (typeof x.path !== "string" || x.path === "") return null;
  const how = x.how === "written" || x.how === "shell" || x.how === "deleted" ? x.how : "edited";
  const n = (y: unknown) => (typeof y === "number" && Number.isFinite(y) && y >= 0 ? y : null);
  return { path: x.path, added: n(x.added), removed: n(x.removed), how };
}

/** The changes an answer came back with, cleaned (an older backend sends none). */
export function cleanChanges(v: unknown): AsideChange[] {
  return Array.isArray(v) ? v.map(cleanChange).filter((c): c is AsideChange => c !== null) : [];
}

/** The pending notes read back from the store, by chat. */
export function loadNotes(storage: Pick<Storage, "getItem">): Record<string, PendingAsideNote[]> {
  const out: Record<string, PendingAsideNote[]> = {};
  try {
    const raw = storage.getItem(ASIDE_NOTE_KEY);
    if (!raw) return out;
    const v = JSON.parse(raw) as unknown;
    if (v === null || typeof v !== "object") return out;
    for (const [chat, list] of Object.entries(v as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const notes: PendingAsideNote[] = [];
      for (const n of list) {
        if (n === null || typeof n !== "object") continue;
        const x = n as Record<string, unknown>;
        const changes = cleanChanges(x.changes);
        if (typeof x.id !== "string" || changes.length === 0) continue;
        notes.push({
          id: x.id,
          question: typeof x.question === "string" ? x.question : "",
          changes,
          at: typeof x.at === "number" ? x.at : 0,
        });
      }
      if (notes.length > 0) out[chat] = notes;
    }
  } catch {
    // A store it cannot read is no notes, never a crash.
  }
  return out;
}

/** Write the pending notes, the chats `skip` names left out (private chats). */
export function saveNotes(
  all: Record<string, PendingAsideNote[]>,
  storage: Pick<Storage, "setItem" | "removeItem">,
  skip: (chat: string) => boolean = () => false,
): void {
  try {
    const kept: Record<string, PendingAsideNote[]> = {};
    for (const [chat, list] of Object.entries(all)) if (list.length > 0 && !skip(chat)) kept[chat] = list;
    if (Object.keys(kept).length === 0) storage.removeItem(ASIDE_NOTE_KEY);
    else storage.setItem(ASIDE_NOTE_KEY, JSON.stringify(kept));
  } catch {
    // Full or refused: the notes stay in memory for the window.
  }
}
