/**
 * Edits as versions (nightshift backlog 299, 2026-10-04): his "make main"
 * and Claude's ‹ 1/2 › arrows over the edit-and-send forks that already
 * exist (backlog 062). Pure, so the suite pins every rule without a DOM;
 * `versions.svelte.ts` holds the stored map and the loader.
 *
 * Two ideas, kept apart:
 *
 * - **Main.** Editing and sending still makes a fork, indented under the
 *   chat it came from (backlog 207). *Make main* on that fork records, in a
 *   small stored map, that the chat it came from gave its place to it: the
 *   fork is drawn in the original's row, in the original's place, the
 *   original's forks under it, and the original is no longer a row of its
 *   own. Nothing is written to either log and nothing is deleted — a map
 *   lost or cleared puts the original back as a row. The map is
 *   `hidden id → the id it gave its place to`; a chain (a fork of the fork
 *   made main later) resolves to its end, and an entry whose target is no
 *   longer listed (deleted, trashed) is ignored, so the original comes
 *   back rather than vanish with it.
 *
 * - **Versions.** The versions of one message are the chats that carry a
 *   different text at that turn: the chat, each edit-and-send fork cut at
 *   that message, each fork of those cut at the same message again, and
 *   so on — a connected set of (chat, event index) points, one edge per
 *   edit fork: (fork, the fork's first own message) ↔ (parent, the cut).
 *   The fork's side of the edge needs its log (the cut index is the
 *   parent's numbering; the fork's copy renumbers), which the loader reads
 *   with `peek_session`; here it is `cut`. The order is the original first,
 *   then the forks by when they were made — Claude's 1/N … N/N.
 */
import type { SessionEvent, SessionMeta } from "./types";

/** `hidden id → the id it gave its place to`. */
export type VersionMap = Record<string, string>;

export const VERSIONS_KEY = "nightloom.versionsMain";

/** An edit-and-send fork: a parent and no reason (a hand-off has one). */
export function isEditFork(m: SessionMeta | undefined): boolean {
  return !!m?.forked_from && !m.forked_from.reason;
}

/**
 * The chat `id` is drawn as: itself, or the end of its chain of entries
 * whose targets are listed. A cycle (never written, cheap to survive)
 * stops where it would repeat.
 */
export function mainOf(id: string, map: VersionMap, listed: ReadonlySet<string>): string {
  let cur = id;
  const seen = new Set([cur]);
  for (;;) {
    const next = map[cur];
    if (!next || !listed.has(next) || seen.has(next)) return cur;
    seen.add(next);
    cur = next;
  }
}

/** Whether `id` is a version kept off the sidebar (another chat has its place). */
export function isHidden(id: string, map: VersionMap, listed: ReadonlySet<string>): boolean {
  return mainOf(id, map, listed) !== id;
}

/**
 * The list the sidebar draws its rows from (`sidebarRows`): each chat made
 * main stands where the first chat of its group stood — the list is
 * newest-first, so where the newest of them stands, and the chat he goes
 * on using rises as the original's row would have (blocker 1062), lineage rewritten
 * so its own forks and the hidden chats' forks hang under it, and the
 * hidden chats left out. Everything not touched by the map is returned as
 * it was, the same objects in the same order.
 */
export function sidebarSessions(sessions: SessionMeta[], map: VersionMap): SessionMeta[] {
  if (Object.keys(map).length === 0) return sessions;
  const listed = new Set(sessions.map((s) => s.id));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const main = (id: string) => mainOf(id, map, listed);
  const emitted = new Set<string>();
  const out: SessionMeta[] = [];
  for (const s of sessions) {
    const m = main(s.id);
    if (emitted.has(m)) continue;
    const meta = byId.get(m)!;
    emitted.add(m);
    // Its parent as drawn: walk up past every chat of its own group (the
    // chat it replaced, the one that one replaced…) to the first parent
    // outside it, then draw that parent as whatever has its place.
    let from = meta.forked_from;
    const seen = new Set([m]);
    while (from && main(from.session) === m && !seen.has(from.session)) {
      seen.add(from.session);
      from = byId.get(from.session)?.forked_from;
    }
    if (from && main(from.session) === m) from = undefined;
    const drawnFrom = from && from.session !== main(from.session) ? { ...from, session: main(from.session) } : from;
    if (m === s.id && drawnFrom === meta.forked_from) out.push(meta);
    else {
      const copy: SessionMeta = { ...meta };
      if (drawnFrom) copy.forked_from = drawnFrom;
      else delete copy.forked_from;
      out.push(copy);
    }
  }
  return out;
}

/**
 * The chat whose row `id` would take on *Make main*: what has the place
 * of its parent (an edit fork not yet main), or what has its own place
 * (a hidden version being put back). Null when there is nothing to take.
 */
export function replacedBy(sessions: SessionMeta[], map: VersionMap, id: string): string | null {
  const listed = new Set(sessions.map((s) => s.id));
  if (!listed.has(id)) return null;
  const own = mainOf(id, map, listed);
  if (own !== id) return own;
  const meta = sessions.find((s) => s.id === id);
  if (!isEditFork(meta)) return null;
  const parent = meta!.forked_from!.session;
  if (!listed.has(parent)) return null;
  const m = mainOf(parent, map, listed);
  return m === id ? null : m;
}

/** Whether the ⋯ menus offer *Make main* on `id`. */
export function canMakeMain(sessions: SessionMeta[], map: VersionMap, id: string): boolean {
  return replacedBy(sessions, map, id) !== null;
}

/**
 * The map after *Make main* on `id`: every chat of the group whose place
 * it takes now points at it, and its own entry is gone. Null when it
 * cannot be made main. Entries are flattened to the new main, so a later
 * Make main on any of them moves the whole group again.
 */
export function makeMain(sessions: SessionMeta[], map: VersionMap, id: string): VersionMap | null {
  const replaced = replacedBy(sessions, map, id);
  if (!replaced) return null;
  const listed = new Set(sessions.map((s) => s.id));
  const next: VersionMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (!listed.has(k)) {
      next[k] = v; // a chat not listed here (another project): kept as it was
      continue;
    }
    const m = mainOf(k, map, listed);
    next[k] = m === replaced ? id : v;
  }
  next[replaced] = id;
  delete next[id];
  return next;
}

/** The stored map; empty when absent or malformed. */
export function parseVersions(raw: string | null): VersionMap {
  if (raw == null) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: VersionMap = {};
    for (const [k, t] of Object.entries(v as Record<string, unknown>)) if (typeof t === "string") out[k] = t;
    return out;
  } catch {
    return {};
  }
}

/** What the loader keeps of a fork's log. */
export interface ForkInfo {
  /** The fork's own first message — the edited one — or null before it lands. */
  cut: number | null;
  /** When the chat was made (its creation line). */
  created: string;
}

/**
 * The index of the first message a fork recorded itself: the first user
 * message newer than the creation line. The carried events keep their
 * own times, all older than the fork.
 */
export function forkInfo(events: SessionEvent[]): ForkInfo | null {
  const first = events[0];
  if (first?.event !== "session_created") return null;
  const born = Date.parse(first.at);
  let cut: number | null = null;
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    if (e.event === "user_message" && Date.parse(e.at) >= born) {
      cut = i;
      break;
    }
  }
  return { cut, created: first.at };
}

/**
 * The chats whose fork info the arrows need for chat `id`: every edit
 * fork in its lineage tree (the topmost listed ancestor and all under it).
 */
export function lineageForks(sessions: SessionMeta[], id: string): string[] {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const top = (sid: string): string => {
    let cur = sid;
    const seen = new Set([cur]);
    for (;;) {
      const p = byId.get(cur)?.forked_from?.session;
      if (!p || !byId.has(p) || seen.has(p)) return cur;
      seen.add(p);
      cur = p;
    }
  };
  const root = top(id);
  return sessions.filter((s) => isEditFork(s) && s.id !== root && top(s.id) === root).map((s) => s.id);
}

/**
 * The versions of the message at event `index` of chat `id`, in order
 * (the original first, then by when each was made), or null when it has
 * only the one. `info` holds what the loader read of each edit fork.
 */
export function versionsAt(
  sessions: SessionMeta[],
  info: ReadonlyMap<string, ForkInfo>,
  id: string,
  index: number,
): string[] | null {
  const key = (s: string, i: number) => `${s}\u0000${i}`;
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    adj.set(a, [...(adj.get(a) ?? []), b]);
    adj.set(b, [...(adj.get(b) ?? []), a]);
  };
  const listed = new Set(sessions.map((s) => s.id));
  for (const s of sessions) {
    if (!isEditFork(s) || !listed.has(s.forked_from!.session)) continue;
    const cut = info.get(s.id)?.cut;
    if (cut == null) continue;
    link(key(s.id, cut), key(s.forked_from!.session, s.forked_from!.index));
  }
  const start = key(id, index);
  if (!adj.has(start)) return null;
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const n of adj.get(queue.shift()!) ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  const members = [...seen].map((k) => k.split("\u0000")[0]);
  if (members.length < 2) return null;
  // The original: the one member whose own edge does not lead into the set
  // (it is not a fork cut at this message). First; the rest by birth.
  const inSet = new Set([...seen]);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const isRoot = (k: string) => {
    const sid = k.split("\u0000")[0];
    const m = byId.get(sid);
    const cut = info.get(sid)?.cut;
    if (!isEditFork(m) || cut == null || key(sid, cut) !== k) return true;
    return !inSet.has(key(m!.forked_from!.session, m!.forked_from!.index));
  };
  const born = (sid: string) => info.get(sid)?.created ?? "";
  return [...seen]
    .sort((a, b) => {
      const ra = isRoot(a) ? 0 : 1;
      const rb = isRoot(b) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return born(a.split("\u0000")[0]).localeCompare(born(b.split("\u0000")[0]));
    })
    .map((k) => k.split("\u0000")[0]);
}

/** Where the versions of chat `id`'s message at `index` put it: `n` of `total`. */
export function versionPlace(list: string[] | null, id: string): { n: number; total: number } | null {
  if (!list) return null;
  const at = list.indexOf(id);
  return at < 0 ? null : { n: at + 1, total: list.length };
}
