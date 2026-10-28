/**
 * Files for him (nightshift backlog 377), the pure part: which rows are
 * new since he last looked, and the "last looked" per project, kept in
 * `localStorage` (a convenience — losing it only re-shows the dot). The
 * state, the polling and the opening are `forYou.svelte.ts`.
 */

/** One file or folder the model marked for him (`for_you.rs`'s `ForYou`). */
export interface ForYouRow {
  path: string;
  /** The path inside the chat's folder it was marked in. */
  rel: string;
  folder: boolean;
  title: string | null;
  /** RFC 3339, when it was marked. */
  at: string;
}

export const SEEN_KEY = "nightloom.forYou.seen";

/** The key a project's "last looked" is kept under; the unfiled chats share one. */
export function projectKey(id: string | null | undefined): string {
  return id ?? "(unfiled)";
}

/** How many rows were marked after `seen` (none seen: all of them). */
export function unseenCount(rows: ForYouRow[], seen: string | undefined): number {
  if (!seen) return rows.length;
  const t = Date.parse(seen);
  return rows.filter((r) => Date.parse(r.at) > t).length;
}

/** The newest row's time, which becomes "last looked" when the list opens. */
export function newestAt(rows: ForYouRow[]): string | null {
  let best: string | null = null;
  for (const r of rows) if (!best || Date.parse(r.at) > Date.parse(best)) best = r.at;
  return best;
}

type Store = Pick<Storage, "getItem" | "setItem">;

export function loadSeen(store: Store | undefined): Record<string, string> {
  try {
    const raw = store?.getItem(SEEN_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveSeen(store: Store | undefined, seen: Record<string, string>): void {
  try {
    store?.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Storage full or blocked: the dot comes back next launch, nothing lost.
  }
}

/** The file's name, for a row's first line. */
export function baseName(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}
