/**
 * Forks under the chat they came from (nightshift backlog 207).
 *
 * A chat carries a parent when its creation line has `forked_from`: an
 * edit-and-send fork (`fork_session`, backlog 062) or a chat that continues
 * a full one after a hand-off (`continue_session`, `reason: "handoff"`,
 * backlog 086). Such a chat is listed under its origin, indented, behind a
 * disclosure control on the origin's row, closed by default; which origins
 * are open is remembered across launches.
 *
 * A chat whose parent is not in the list (deleted, trashed, in another
 * project) stays a top-level row as before. ~~Forks of a fork are flattened
 * under the topmost origin present in the list, one indent level, each
 * keeping its own "from X" line when X is not that origin (nightshift
 * blocker 430, default taken).~~ Since blocker 430's answer ("nested is
 * fine", 2026-09-25) a fork of a fork sits under the fork it came from,
 * one indent step further, and that fork has its own disclosure and count,
 * closed by default and remembered in the same open set. A fork row never
 * carries a "from X" line: its parent is the row it is indented under. A
 * chat with no forks is a plain row.
 */
import type { SessionMeta } from "./types";

export interface SidebarRow {
  meta: SessionMeta;
  /** 0 for a top-level row, n for a fork n steps under its top-level origin. */
  depth: number;
  /** How many chats forked directly from this one are listed under it (0 = none). */
  forks: number;
  /** Its forks are listed right after it. */
  expanded: boolean;
}

/**
 * The origin each chat is grouped under, by id — the topmost ancestor
 * reachable through parents that are in the list — or absent for a chat
 * that is top-level. A cycle (never written, but cheap to survive) leaves
 * every chat on it top-level.
 */
export function originsOf(sessions: SessionMeta[]): Map<string, string> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const out = new Map<string, string>();
  for (const s of sessions) {
    let cur = s;
    const seen = new Set<string>([s.id]);
    let cyclic = false;
    for (;;) {
      const pid = cur.forked_from?.session;
      const parent = pid ? byId.get(pid) : undefined;
      if (!parent) break;
      if (seen.has(parent.id)) {
        cyclic = true;
        break;
      }
      seen.add(parent.id);
      cur = parent;
    }
    if (!cyclic && cur.id !== s.id) out.set(s.id, cur.id);
  }
  return out;
}

/**
 * The sidebar's rows in order: each top-level chat where it stands in
 * `sessions`, and, when its id is in `open` (or `reveal` is somewhere
 * under it), the chats forked directly from it right after it in
 * `sessions`' order — each of those in turn followed by its own forks
 * when it is open, one depth further. `reveal` is the active chat: every
 * closed group on the way down to it is shown open so the open chat
 * always has a row — not stored, so they close again when he moves on.
 */
export function sidebarRows(
  sessions: SessionMeta[],
  open: ReadonlySet<string>,
  reveal: string | null = null,
): SidebarRow[] {
  const origins = originsOf(sessions);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  // A chat's parent, when it is grouped at all: `originsOf` has already
  // checked that the whole chain up is listed and acyclic, so the direct
  // parent is listed too.
  const parentOf = (s: SessionMeta): string | undefined =>
    origins.has(s.id) ? s.forked_from?.session : undefined;
  const children = new Map<string, SessionMeta[]>();
  for (const s of sessions) {
    const p = parentOf(s);
    if (!p) continue;
    const list = children.get(p) ?? [];
    list.push(s);
    children.set(p, list);
  }
  const onPath = new Set<string>();
  for (let cur = reveal ? byId.get(reveal) : undefined; cur; ) {
    const p = parentOf(cur);
    if (!p) break;
    onPath.add(p);
    cur = byId.get(p);
  }
  const rows: SidebarRow[] = [];
  const walk = (s: SessionMeta, depth: number): void => {
    const kids = children.get(s.id) ?? [];
    const show = kids.length > 0 && (open.has(s.id) || onPath.has(s.id));
    rows.push({ meta: s, depth, forks: kids.length, expanded: show });
    if (show) for (const k of kids) walk(k, depth + 1);
  };
  for (const s of sessions) if (!origins.has(s.id)) walk(s, 0);
  return rows;
}

export const FORKS_OPEN_KEY = "nightloom.forksOpen";

/** The stored set of open origins; empty when absent or malformed. */
export function parseOpen(raw: string | null): Set<string> {
  if (raw == null) return new Set();
  try {
    const v: unknown = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function loadOpen(): Set<string> {
  try {
    return parseOpen(localStorage.getItem(FORKS_OPEN_KEY));
  } catch {
    return new Set();
  }
}

export function saveOpen(open: ReadonlySet<string>): void {
  try {
    localStorage.setItem(FORKS_OPEN_KEY, JSON.stringify([...open]));
  } catch {
    // best-effort, like the zoom and the transcript prefs
  }
}

/** `open` with `id` flipped, as a new set. */
export function toggled(open: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(open);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
