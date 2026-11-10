/**
 * The running list, by project and by chat (items 556 and 558,
 * 2026-11-10). His words: "the four running tasks [aren't] sorted by
 * project so I can't easily see which are all of the agents or whatever
 * tasks that are running within the project that I'm in", and "[nothing]
 * says anything about whether the current chat is running".
 *
 * Pure: it reads `RunEntry` rows (`running.ts`, the one list of everything
 * running) and returns
 *  - `groupRuns`: project → chat → its runs, the open project first, so the
 *    Running-tasks panel (and the phone's sheet) show his project at the top
 *    and the rest folded with counts;
 *  - `chatRun`: one chat's own state — running, waiting on him, or idle —
 *    for the sign on the open chat's top bar.
 */
import type { RunEntry } from "./running";

/** One chat's runs: its turn (or council) and what runs inside it. */
export interface ChatRuns {
  /** Stable for keyed lists. */
  key: string;
  /** The chat to open; null for app-wide work (memory, Nightshift). */
  session: string | null;
  /** The chat's name; for app-wide work, the kind of the first row. */
  chat: string;
  /** The turn's own row, when the chat's turn runs. */
  turn: RunEntry | null;
  /** Everything else running in it: subagents, seats, asides. */
  parts: RunEntry[];
  /** The earliest start among its rows. */
  startedAt: number | null;
  waiting: boolean;
  onScreen: boolean;
}

/** One project's runs. */
export interface ProjectRuns {
  key: string;
  project: string | null;
  /** The project's name as the rows give it ("unfiled chats", "memory"). */
  where: string;
  /** The project open now. */
  here: boolean;
  chats: ChatRuns[];
  /** Every row in it, so the groups add up to the badge's count. */
  count: number;
  waiting: boolean;
}

const t = (x: number | null) => x ?? Infinity;
const earliest = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));

/** A project's key: its id, or its name for rows filed under none. */
function projectKey(r: RunEntry): string {
  return r.project !== null ? `p:${r.project}` : `w:${r.where}`;
}

/**
 * Group `runs` by project, then by chat. Order: the open project first
 * (`openProject`; null is "unfiled chats", the project of a chat opened with
 * none), then the rest by their earliest start. In a project, the chat on
 * screen first, then by start; app-wide rows (no chat) last. In a chat, its
 * turn is the head and the other rows follow by start.
 */
export function groupRuns(runs: readonly RunEntry[], openProject: string | null): ProjectRuns[] {
  const projects = new Map<string, ProjectRuns>();
  const chatsBy = new Map<string, Map<string, ChatRuns>>();
  for (const r of runs) {
    const pk = projectKey(r);
    let p = projects.get(pk);
    if (!p) {
      // "unfiled chats" is the open project when none is open; memory and
      // Nightshift rows (no project, no chat) never are.
      const here = r.project !== null ? r.project === openProject : openProject === null && r.session !== null;
      p = { key: pk, project: r.project, where: r.where, here, chats: [], count: 0, waiting: false };
      projects.set(pk, p);
      chatsBy.set(pk, new Map());
    }
    const chats = chatsBy.get(pk)!;
    // App-wide work has no chat: each row stands alone.
    const ck = r.session !== null ? `c:${r.session}` : r.kind === "turn" || r.kind === "council" ? "c:new" : `x:${r.id}`;
    let c = chats.get(ck);
    if (!c) {
      c = { key: `${pk}/${ck}`, session: r.session, chat: r.chat || r.kind, turn: null, parts: [], startedAt: null, waiting: false, onScreen: false };
      chats.set(ck, c);
    }
    if ((r.kind === "turn" || r.kind === "council") && c.turn === null) c.turn = r;
    else c.parts.push(r);
    c.startedAt = earliest(c.startedAt, r.startedAt);
    c.waiting ||= r.waiting;
    c.onScreen ||= r.onScreen;
    if (r.chat) c.chat = r.chat;
    p.count++;
    p.waiting ||= r.waiting;
  }
  for (const [pk, p] of projects) {
    const list = [...chatsBy.get(pk)!.values()];
    for (const c of list) c.parts.sort((a, b) => t(a.startedAt) - t(b.startedAt) || a.id.localeCompare(b.id));
    list.sort(
      (a, b) =>
        Number(b.onScreen) - Number(a.onScreen) ||
        Number(a.session === null && !a.turn) - Number(b.session === null && !b.turn) ||
        t(a.startedAt) - t(b.startedAt) ||
        a.key.localeCompare(b.key),
    );
    p.chats = list;
  }
  const first = (p: ProjectRuns) => p.chats.reduce<number | null>((m, c) => earliest(m, c.startedAt), null);
  return [...projects.values()].sort(
    (a, b) => Number(b.here) - Number(a.here) || t(first(a)) - t(first(b)) || a.key.localeCompare(b.key),
  );
}

/** One chat's own state, for the sign on its top bar. */
export interface ChatRunState {
  state: "running" | "waiting" | "idle";
  /** When its turn started; null when idle or unknown. */
  startedAt: number | null;
  /** Its subagents (and council seats) running now. */
  agents: number;
  /** What the turn is doing now, in a few words. */
  doing: string;
}

/**
 * Chat `session`'s state: its turn's row, if it has one, says running or
 * waiting on him. `session` null is the new chat on screen (no id yet),
 * whose turn row is the on-screen one with no session. An aside running in
 * the chat is not its turn: it does not make the chat "running".
 */
export function chatRun(runs: readonly RunEntry[], session: string | null): ChatRunState {
  const mine = (r: RunEntry) => (session !== null ? r.session === session : r.session === null && r.onScreen);
  const turn = runs.find((r) => (r.kind === "turn" || r.kind === "council") && mine(r));
  if (!turn) return { state: "idle", startedAt: null, agents: 0, doing: "" };
  const agents = runs.filter((r) => (r.kind === "subagent" || r.kind === "council seat") && mine(r)).length;
  return { state: turn.waiting ? "waiting" : "running", startedAt: turn.startedAt, agents, doing: turn.doing };
}

/** A project's folded line: `2 chats · 5 running`. */
export function projectSummary(p: ProjectRuns): string {
  const chats = p.chats.filter((c) => c.session !== null || c.turn !== null).length;
  const parts = [chats > 0 ? `${chats} chat${chats === 1 ? "" : "s"}` : null, `${p.count} running`];
  return parts.filter(Boolean).join(" · ");
}
