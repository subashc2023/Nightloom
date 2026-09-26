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
 * project) stays a top-level row as before. Forks of a fork are flattened
 * under the topmost origin present in the list, one indent level, each
 * keeping its own "from X" line when X is not that origin (nightshift
 * blocker 430, default taken). A chat with no forks is a plain row.
 */
import type { SessionMeta } from "./types";

export interface SidebarRow {
  meta: SessionMeta;
  /** 0 for a top-level row, 1 for a fork listed under its origin. */
  depth: 0 | 1;
  /** On an origin row: how many chats are grouped under it (0 = none). */
  forks: number;
  /** On an origin row: its forks are listed right after it. */
  expanded: boolean;
  /** On a fork row: true when its direct parent is not the origin it sits
   *  under (a fork of a fork), so its "from X" line still says something. */
  fromOther: boolean;
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
 * `sessions`, and, when its id is in `open` (or `reveal` is one of its
 * forks), its forks right after it in `sessions`' order. `reveal` is the
 * active chat: a closed group holding it is shown open so the open chat
 * always has a row — not stored, so it closes again when he moves on.
 */
export function sidebarRows(
  sessions: SessionMeta[],
  open: ReadonlySet<string>,
  reveal: string | null = null,
): SidebarRow[] {
  const origins = originsOf(sessions);
  const children = new Map<string, SessionMeta[]>();
  for (const s of sessions) {
    const o = origins.get(s.id);
    if (!o) continue;
    const list = children.get(o) ?? [];
    list.push(s);
    children.set(o, list);
  }
  const rows: SidebarRow[] = [];
  for (const s of sessions) {
    if (origins.has(s.id)) continue;
    const kids = children.get(s.id) ?? [];
    const show =
      kids.length > 0 && (open.has(s.id) || (reveal !== null && kids.some((k) => k.id === reveal)));
    rows.push({ meta: s, depth: 0, forks: kids.length, expanded: show, fromOther: false });
    if (!show) continue;
    for (const k of kids)
      rows.push({
        meta: k,
        depth: 1,
        forks: 0,
        expanded: false,
        fromOther: k.forked_from?.session !== s.id,
      });
  }
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
