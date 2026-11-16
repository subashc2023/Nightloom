/**
 * Item 703 (2026-11-15, his "clicking send now … seem to have caused the
 * session to get cut out … there should be like a visual notice … that
 * tells me when a session got cut and resumed afterwards"): what a turn's
 * end cut, and what Send now says when agents run. Pure, for the suite;
 * the store is a plain `Storage`.
 *
 * Every subagent runs inside the turn's Claude Code process, so a turn
 * that ends — a Stop, Send now's Stop + send (item 536), a crash, a
 * limit — ends whatever of them still runs (backlog 331). Such an end is
 * marked under the chat (`noteCut`), and the transcript draws a yellow
 * Nightloom notice there naming them; a later turn (which starts a new
 * process) adds "resumed".
 */

/** One cut: when the turn ended (ms) and the agents it ended. */
export interface Cut {
  at: number;
  agents: string[];
}

export const CUTS_KEY = "nightloom.cuts";
/** Kept per chat; older ones go. */
export const CUTS_PER_CHAT = 20;

/** The descriptions of the rows still running, in order, blanks named. */
export function runningAgents(rows: readonly { status: string; description: string }[]): string[] {
  return rows.filter((r) => r.status === "running").map((r) => r.description.trim() || "a subagent");
}

/** A name cut to `max` characters on a word, with an ellipsis. */
export function shortName(name: string, max = 28): string {
  const n = name.trim();
  if (n.length <= max) return n;
  const cut = n.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,.;:—-]+$/, "") + "…";
}

/** "2 agents were stopped: Resolve enterprise…, Critical review…" */
export function cutText(agents: readonly string[]): string {
  const n = agents.length;
  const who = n === 1 ? "1 agent was stopped" : `${n} agents were stopped`;
  return `Session cut — ${who}: ${agents.map((a) => shortName(a)).join(", ")}`;
}

/** The line under a cut once a later turn ran in the chat. */
export const RESUMED_TEXT = "resumed — the next message started a new Claude Code process";

/**
 * What Send now says when it would have stopped running agents (item 703:
 * it never does now). `handed`: the message went into the running turn
 * without a stop — Claude reads it at its next step (at once while only
 * the agents run, measured in 374). `held`: it could not go in, and a
 * Stop would end them, so it waits for the turn's end.
 */
export function besideAgentsToast(agents: readonly string[], how: "handed" | "held"): string {
  const n = agents.length;
  const them = `${n === 1 ? "1 agent is" : `${n} agents are`} running (${agents.map((a) => `“${shortName(a)}”`).join(", ")})`;
  return how === "handed"
    ? `Sent into the turn without stopping it — ${them}, and a stop would end them. Claude reads it at its next step.`
    : `Held, not sent now — ${them}, and stopping the turn would end them. It goes when the turn ends, after they report.`;
}

type Store = Pick<Storage, "getItem" | "setItem">;

function readAll(store: Store): Record<string, Cut[]> {
  try {
    const v = JSON.parse(store.getItem(CUTS_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, Cut[]>) : {};
  } catch {
    return {};
  }
}

/** Mark that chat `chat`'s turn ended at `at` with `agents` still running. */
export function noteCut(store: Store, chat: string, agents: readonly string[], at: number): void {
  if (agents.length === 0) return;
  const all = readAll(store);
  const list = (all[chat] ?? []).filter((c) => c && typeof c.at === "number" && Array.isArray(c.agents));
  list.push({ at, agents: [...agents] });
  all[chat] = list.slice(-CUTS_PER_CHAT);
  try {
    store.setItem(CUTS_KEY, JSON.stringify(all));
  } catch {
    // A full store loses the mark, never the turn.
  }
}

/** The chat's cuts, oldest first. */
export function cutsOf(store: Store, chat: string | null): Cut[] {
  if (!chat) return [];
  return (readAll(store)[chat] ?? []).filter((c) => c && typeof c.at === "number" && Array.isArray(c.agents));
}

/**
 * Where each cut is drawn: before the first of his messages sent after
 * it (`before`, by that message's item index — the next turn's start, so
 * it reads "resumed"), or at the transcript's end (`tail`) when none was.
 * `users` are his messages' item indexes and times, in order.
 */
export function placeCuts(
  cuts: readonly Cut[],
  users: readonly { index: number; at: string | null | undefined }[],
): { before: Map<number, Cut[]>; tail: Cut[] } {
  const before = new Map<number, Cut[]>();
  const tail: Cut[] = [];
  const times = users.map((u) => ({ index: u.index, ms: u.at ? Date.parse(u.at) : NaN }));
  for (const c of cuts) {
    const next = times.find((u) => Number.isFinite(u.ms) && u.ms >= c.at);
    if (!next) {
      tail.push(c);
      continue;
    }
    const list = before.get(next.index) ?? [];
    list.push(c);
    before.set(next.index, list);
  }
  return { before, tail };
}
