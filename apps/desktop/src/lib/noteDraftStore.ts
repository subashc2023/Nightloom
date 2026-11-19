/**
 * Item 871: unsaved note edits survive a quit (practices §7: drafts live in
 * app state and are offered back). `app.noteDrafts` — every scope: project
 * notes, the vault, AGENTS.md, memory, model and Chat instructions — and
 * 870's baselines (a hash of the text each draft was typed against) are
 * written to localStorage the way the composer's drafts are
 * (`drafts.svelte.ts`, `nightloom.drafts`): WebKit's own store under
 * ~/Library, never an iCloud folder, one `setItem` per write, which the
 * store commits whole or not at all — a crash mid-write leaves the last
 * good entry. Read back at launch; an entry that does not parse is skipped,
 * never a throw.
 */

export const NOTE_DRAFTS_KEY = "nightloom.note-drafts";

/** A draft's baseline: hashes of the draft it belongs to and of the file
 *  text it was typed against. */
export type DraftBase = { draft: string; base: string };

export type StoredNoteDrafts = {
  drafts: Record<string, string>;
  bases: Record<string, DraftBase>;
};

/** A short stable hash (cyrb53) — enough to tell "the file changed". */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length.toString(36)}-${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

export function serializeNoteDrafts(drafts: Record<string, string>, bases: Record<string, DraftBase>): string {
  const kept: Record<string, DraftBase> = {};
  for (const [k, b] of Object.entries(bases)) if (drafts[k] !== undefined) kept[k] = b;
  return JSON.stringify({ v: 1, drafts, bases: kept });
}

export function loadNoteDrafts(storage: Pick<Storage, "getItem">): StoredNoteDrafts {
  const out: StoredNoteDrafts = { drafts: {}, bases: {} };
  let raw: unknown;
  try {
    const text = storage.getItem(NOTE_DRAFTS_KEY);
    if (!text) return out;
    raw = JSON.parse(text);
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object") return out;
  const r = raw as { drafts?: unknown; bases?: unknown };
  if (r.drafts && typeof r.drafts === "object")
    for (const [k, v] of Object.entries(r.drafts as Record<string, unknown>)) if (typeof v === "string") out.drafts[k] = v;
  if (r.bases && typeof r.bases === "object")
    for (const [k, v] of Object.entries(r.bases as Record<string, unknown>)) {
      const b = v as { draft?: unknown; base?: unknown } | null;
      if (out.drafts[k] !== undefined && b && typeof b.draft === "string" && typeof b.base === "string")
        out.bases[k] = { draft: b.draft, base: b.base };
    }
  return out;
}

export function saveNoteDrafts(
  drafts: Record<string, string>,
  bases: Record<string, DraftBase>,
  storage: Pick<Storage, "setItem"> = localStorage,
): boolean {
  try {
    storage.setItem(NOTE_DRAFTS_KEY, serializeNoteDrafts(drafts, bases));
    return true;
  } catch {
    // Over quota, most likely: the last good entry stays.
    return false;
  }
}

/**
 * The write schedule, apart from Svelte so it can be tested: `changed()` on
 * every change (the composer drafts' debounce — 400 ms, never past ~1 s of
 * steady typing, `saveDelay`), `flush()` at once (the page going away).
 * `read` takes the maps as they are at write time.
 */
export function noteDraftsWriter(
  read: () => { drafts: Record<string, string>; bases: Record<string, DraftBase> },
  delay: (since: number, now: number) => number,
  storage: Pick<Storage, "setItem"> = localStorage,
): { changed: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let since: number | null = null;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    since = null;
    const { drafts, bases } = read();
    saveNoteDrafts(drafts, bases, storage);
  };
  const changed = () => {
    const now = Date.now();
    if (since === null) since = now;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, delay(since, now));
  };
  return { changed, flush };
}
