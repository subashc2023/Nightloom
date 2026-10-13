/**
 * The drawer's Recents and the Projects list (item 300, rows A4, A23, A28;
 * blocker 1090's default: the Claude app's shape). Pure, so the order the
 * phone shows is tested rather than hoped for.
 */
import type { ChatRow, ProjectRow } from "./client";

/** The id the host gives chats outside any project. */
export const UNFILED = "unfiled";

/** A chat in Recents: the chat, and the project it lives in. */
export interface RecentRow {
  chat: ChatRow;
  /** The key it was listed under: a project's id (`UNFILED` for No
   *  project), or an old host's `""` for its open project. */
  pid: string;
  /** The project's name, or null for No project (no tag is drawn). */
  project: string | null;
}

/** When a chat was last used, for ordering and its row's time (300 B8):
 *  his last message, not the file's time, which a rename moves. An older
 *  host sends no message time: the file's time, as before. */
export function lastActive(c: ChatRow): string {
  return c.last_message ?? c.modified;
}

const when = (c: ChatRow): number => {
  const t = Date.parse(lastActive(c));
  return Number.isFinite(t) ? t : 0;
};

/** Every loaded chat, newest first, each with its project: one stable list
 *  whatever project the host has open (A23). `chatsBy` is keyed by project
 *  id; a key no project names (an old host's `""`) counts as No project. */
export function recentRows(projects: ProjectRow[], chatsBy: Record<string, ChatRow[]>): RecentRow[] {
  const names = new Map(projects.map((p) => [p.id, p.id === UNFILED ? null : p.name] as const));
  const seen = new Set<string>();
  const out: RecentRow[] = [];
  for (const [pid, list] of Object.entries(chatsBy)) {
    // A project forgotten since its chats were read is not listed.
    if (pid !== "" && projects.length > 0 && !names.has(pid)) continue;
    // An old host lists the open project under `""` as well as its id: keep
    // the first copy of each chat only.
    for (const chat of list) {
      if (seen.has(chat.id)) continue;
      seen.add(chat.id);
      out.push({ chat, pid, project: names.get(pid) ?? null });
    }
  }
  return out.sort((a, b) => when(b.chat) - when(a.chat) || a.chat.label.localeCompare(b.chat.label));
}

/** A project in the Projects list: its chats' count and last activity
 *  (null until its chats are read). */
export interface ProjectSummary {
  id: string;
  name: string;
  chats: number | null;
  last: string | null;
}

/** The projects with a name (No project is not one), most recently used
 *  first; a project whose chats are not read yet keeps the host's order
 *  after the read ones. */
export function projectSummaries(projects: ProjectRow[], chatsBy: Record<string, ChatRow[]>): ProjectSummary[] {
  const rows = projects
    .filter((p) => p.id !== UNFILED)
    .map((p, i) => {
      const list = chatsBy[p.id];
      const newest = list && list.length > 0 ? list.reduce((a, b) => (when(b) > when(a) ? b : a)) : null;
      return { s: { id: p.id, name: p.name, chats: list ? list.length : null, last: newest ? lastActive(newest) : null }, i, t: newest ? when(newest) : -1 };
    });
  return rows.sort((a, b) => b.t - a.t || a.i - b.i).map((r) => r.s);
}

/** "1 chat", "3 chats". */
export function chatCount(n: number): string {
  return `${n} chat${n === 1 ? "" : "s"}`;
}
