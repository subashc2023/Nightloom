/**
 * The fork mark (nightshift backlog 379, blocker 1428): a chat that is a
 * fork — a Retry or an edit-and-send, `forked_from` with no hand-off
 * reason — shows `⑂` before its title in its tab and its sidebar row, and
 * the mark's hover names the chat it came from. On 2026-10-13 a fork and
 * its parent sat in two tabs with the same title, and the reply he was
 * after read as gone.
 *
 * A hand-off continuation (`reason: "handoff"`, backlog 086) is not a
 * fork: it carries on a full chat, and TopBar's lineage line already says
 * so — no mark. A version made main (backlog 299) is drawn in its
 * original's row with the lineage `sidebarSessions` rewrites, so the row
 * gets the mark only when the group it stands for is itself a fork; its
 * tab, which shows the chat as it is, keeps the mark it has as a fork.
 */
import type { SessionMeta } from "./types";

export const FORK_GLYPH = "⑂";

export interface ForkMark {
  /** The parent's name as its own row shows it, or null when it is no
   *  longer listed (deleted, trashed, in another project). */
  parent: string | null;
  /** The hover: "Fork of ‹parent›", or "Fork of a deleted chat". */
  tip: string;
}

type Named = Pick<SessionMeta, "id" | "title" | "first_user">;

/** The mark for `meta`, or null when it is not a fork. */
export function forkMark(
  meta: Pick<SessionMeta, "forked_from"> | undefined,
  sessions: Named[],
  max = 60,
): ForkMark | null {
  const from = meta?.forked_from;
  if (!from || from.reason === "handoff") return null;
  const p = sessions.find((s) => s.id === from.session);
  if (!p) return { parent: null, tip: "Fork of a deleted chat" };
  const raw = (p.title ?? p.first_user ?? "").replace(/\s+/g, " ").trim() || from.session.slice(0, 8);
  const name = raw.length > max ? raw.slice(0, max - 1) + "…" : raw;
  return { parent: name, tip: `Fork of ${name}` };
}
