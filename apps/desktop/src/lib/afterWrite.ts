import type { ChatKind, ChatMode, Note, SessionMeta } from "./types";

/**
 * What a write does to the lists on screen, without waiting on a re-read
 * of the disk (nightshift backlog 211).
 *
 * On 2026-09-25 Save on a model's instructions file wrote the file and then
 * sat on `refreshNotes()` / `refreshProjects()` — a listing that hung on an
 * iCloud folder after sleep — before it showed Saved, cleared the draft or
 * went back to Settings; Save looked dead though the file was written. And a
 * New chat's row appeared only when its turn ended and the list was re-read,
 * so he lost sight of the chat he had just sent. The rule since: the UI
 * acknowledges when the write returns, from what the app already knows; the
 * re-reads follow in the background, under a time limit, and a failure is
 * logged rather than blocking anything.
 */

/** How long a background re-read may run before it is reported as hung. */
export const REFRESH_LIMIT_MS = 10_000;

export type RefreshEnd = "done" | "failed" | "timed-out";

/**
 * Run `steps` together and settle within `limitMs`, whatever they do: a
 * step that throws is `failed`, one still running at the limit is
 * `timed-out` (it is not cancelled — a late answer still lands, and it was
 * read after the write, so it is no staler than the list it replaces).
 * Either is logged with `why`, so a hang is visible in the console instead
 * of being a Save button that does nothing.
 */
export async function refreshWithin(
  why: string,
  steps: (() => Promise<unknown>)[],
  limitMs: number = REFRESH_LIMIT_MS,
  log: (msg: string) => void = (m) => console.warn(m),
): Promise<RefreshEnd> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<RefreshEnd>((resolve) => {
    timer = setTimeout(() => resolve("timed-out"), limitMs);
  });
  const run = Promise.all(steps.map((s) => Promise.resolve().then(s))).then(
    (): RefreshEnd => "done",
    (e: unknown): RefreshEnd => {
      log(`refresh after ${why} failed: ${String(e)}`);
      return "failed";
    },
  );
  const end = await Promise.race([run, limit]);
  clearTimeout(timer);
  if (end === "timed-out") log(`refresh after ${why} still running after ${limitMs} ms — left to finish in the background`);
  return end;
}

/**
 * The list with `note` in it: replaced where a note of that name is, else
 * added at the head. What a save shows in the sidebar before any re-read.
 */
export function withNote(list: Note[], note: Note): Note[] {
  const at = list.findIndex((n) => n.name === note.name);
  if (at === -1) return [note, ...list];
  const next = list.slice();
  next[at] = note;
  return next;
}

/** The list without the note called `name`. */
export function withoutNote(list: Note[], name: string): Note[] {
  return list.filter((n) => n.name !== name);
}

/**
 * The sidebar's row for a chat whose first turn has just started, before
 * any listing has read its log: `first_user` is what was sent, and the
 * next re-read replaces the row with the disk's. Null when the list has it
 * already, and for an ephemeral chat, which has no log and is never listed.
 */
export function madeChatRow(
  list: SessionMeta[],
  id: string,
  sent: string | null,
  mode: ChatMode | undefined,
  kind: ChatKind | undefined,
  now: Date = new Date(),
): SessionMeta | null {
  if (!id || mode === "ephemeral" || list.some((s) => s.id === id)) return null;
  return {
    id,
    path: "",
    modified: now.toISOString(),
    user_turns: 1,
    first_user: sent,
    title: null,
    ...(mode && mode !== "normal" ? { mode } : {}),
    ...(kind && kind !== "build" ? { kind } : {}),
  };
}
