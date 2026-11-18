/**
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
import type { Chapter } from "./chapters";

export const CHAPTER_EDITS_KEY = "nightloom.chapterEdits.v1";
export const MAX_CHATS = 300;

export interface ChapterEdit {
  title?: string;
  removed?: boolean;
}

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

export function editsFor(chat: string | null): Record<string, ChapterEdit> {
  if (!chat) return {};
  return state.store[chat]?.edits ?? {};
}

function put(chat: string, key: string, edit: ChapterEdit) {
  const cur = state.store[chat]?.edits ?? {};
  const next = { ...cur };
  const clean: ChapterEdit = {};
  if (edit.title !== undefined && edit.title.trim()) clean.title = edit.title.trim();
  if (edit.removed) clean.removed = true;
  if (clean.title === undefined && !clean.removed) delete next[key];
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
}

/** A rename; an empty or unchanged title clears it (the code's title again). */
export function renameChapter(chat: string, c: Pick<Chapter, "key" | "title">, title: string): void {
  const cur = editsFor(chat)[c.key] ?? {};
  const t = title.replace(/\s+/g, " ").trim();
  put(chat, c.key, { ...cur, title: t && t !== c.title ? t : undefined });
}

export function setChapterRemoved(chat: string, key: string, removed: boolean): void {
  const cur = editsFor(chat)[key] ?? {};
  put(chat, key, { ...cur, removed });
}

/** A chapter as he sees it: his title if renamed, and whether he removed it. */
export interface ShownChapter extends Chapter {
  shown: string;
  renamed: boolean;
  removed: boolean;
}

export function withEdits(chapters: readonly Chapter[], edits: Record<string, ChapterEdit>): ShownChapter[] {
  return chapters.map((c) => {
    const e = edits[c.key];
    return { ...c, shown: e?.title ?? c.title, renamed: !!e?.title, removed: !!e?.removed };
  });
}
