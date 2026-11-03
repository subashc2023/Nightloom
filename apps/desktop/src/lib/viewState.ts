/**
 * The small switches of a view, kept past the view (item 495, his rule of
 * 2026-11-02: "if I click on preview … that should be saved so that when I
 * go to another chat and then go back, it still holds which thing I'm on.
 * In general … this should just be a standing rule everywhere").
 *
 * A component's fold, toggle or filter was its own `$state`, so it lived
 * exactly as long as the component: a chat switch (the transcript and the
 * panels under it are drawn afresh), a project switch (its whole workspace
 * is), a singleton tab sent to the back, an overlay closed and opened again,
 * a kept view that fell off its pane's list — each one put it back to its
 * default. This is the one place they are kept instead, by a key that names
 * what the switch is about (`file.plain:<path>`, `runs.drawer`), so the view
 * drawn again reads what he left.
 *
 * Two lifetimes, chosen per key by the caller:
 * - `persist` (the default): written to localStorage, back after a relaunch.
 *   For a choice about how he likes to see a thing — a file's Plain/Rendered,
 *   a panel's open sections.
 * - `session`: kept in memory only, gone at a relaunch. For what would
 *   surprise him days later — a typed filter that hides most of a list.
 *
 * Only a value that differs from the caller's default is stored, so a key
 * costs nothing until he changes it. At most `MAX_KEYS`, the least recently
 * set dropped first — per-item keys (a file, a diff) would otherwise grow
 * without bound. Scroll and caret are not here: `tabPlace.ts` keeps a tab's
 * scroll, and a kept tab (`keptTabs.svelte.ts`) its caret.
 */
export type ViewValue = boolean | string | number;

export const VIEW_STATE_KEY = "nightloom.viewState";
export const MAX_KEYS = 400;

type Store = Pick<Storage, "getItem" | "setItem">;

/** Every value set this run, persisted or not, in the order last set. */
const memory = new Map<string, ViewValue>();
/** The keys of `memory` that are also on disk. */
const persisted = new Set<string>();
let loaded = false;
let storage: Store | null = null;

function store(): Store | null {
  if (storage) return storage;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** For the tests: a fake storage, and everything forgotten. */
export function resetViewState(next: Store | null = null): void {
  memory.clear();
  persisted.clear();
  loaded = false;
  storage = next;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = store()?.getItem(VIEW_STATE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) {
        memory.set(k, v);
        persisted.add(k);
      }
    }
  } catch {
    // A malformed value costs the kept switches, never the view.
  }
}

function save(): void {
  const out: Record<string, ViewValue> = {};
  for (const k of persisted) {
    const v = memory.get(k);
    if (v !== undefined) out[k] = v;
  }
  try {
    store()?.setItem(VIEW_STATE_KEY, JSON.stringify(out));
  } catch {
    // Kept for this run even when it cannot be written.
  }
}

/** `false` → boolean, `"layers"` → string: a default's literal widened. */
export type Widen<T> = T extends boolean ? boolean : T extends string ? string : number;

/** The kept value for `key`, or `fallback` — of the fallback's type only. */
export function viewGet<T extends ViewValue>(key: string, fallback: T): Widen<T> {
  ensureLoaded();
  const v = memory.get(key);
  return (v !== undefined && typeof v === typeof fallback ? v : fallback) as Widen<T>;
}

/**
 * Keep `value` for `key`. Equal to `fallback`, the key is dropped (the
 * default needs no keeping). `session` keeps it in memory only.
 */
export function viewSet<T extends ViewValue>(
  key: string,
  value: Widen<T>,
  fallback: T,
  opts: { session?: boolean } = {},
): void {
  ensureLoaded();
  const wasOnDisk = persisted.has(key);
  if ((value as ViewValue) === fallback) {
    if (!memory.has(key)) return;
    memory.delete(key);
    persisted.delete(key);
    if (wasOnDisk) save();
    return;
  }
  if (memory.get(key) === value && persisted.has(key) === !opts.session) return;
  memory.delete(key);
  memory.set(key, value);
  if (opts.session) persisted.delete(key);
  else persisted.add(key);
  while (memory.size > MAX_KEYS) {
    const oldest = memory.keys().next().value as string;
    memory.delete(oldest);
    persisted.delete(oldest);
  }
  if (!opts.session || wasOnDisk) save();
}

/** A short stable hash of a text, for keys about content with no id (a diff). */
export function textKey(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + ":" + s.length.toString(36);
}

/**
 * Move every key under `prefix` whose rest `rename` maps to a new rest — a
 * per-note switch following the note's move or rename (item 483's
 * `onNoteMove`). A key `rename` returns null for is left alone.
 */
export function viewRenameKeys(prefix: string, rename: (rest: string) => string | null): void {
  ensureLoaded();
  let touched = false;
  for (const k of [...memory.keys()]) {
    if (!k.startsWith(prefix)) continue;
    const next = rename(k.slice(prefix.length));
    if (next === null || next === k.slice(prefix.length)) continue;
    const v = memory.get(k)!;
    const onDisk = persisted.has(k);
    memory.delete(k);
    persisted.delete(k);
    memory.set(prefix + next, v);
    if (onDisk) persisted.add(prefix + next);
    touched ||= onDisk;
  }
  if (touched) save();
}
