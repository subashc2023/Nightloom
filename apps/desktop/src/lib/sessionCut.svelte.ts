/**
 * Item 703: the cut marks in the window's store, read reactively by the
 * transcripts (`sessionCut.ts` holds the rules).
 */
import { cutsOf, noteCut, runningAgents, type Cut } from "./sessionCut";

const cutTick = $state({ n: 0 });

function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** A turn of `chat` ended with these rows: mark it if any still ran. */
export function recordTurnEnd(chat: string | null, rows: readonly { status: string; description: string }[], at = Date.now()): string[] {
  const agents = runningAgents(rows);
  const s = store();
  if (!chat || agents.length === 0 || !s) return agents;
  noteCut(s, chat, agents, at);
  cutTick.n++;
  return agents;
}

/** The chat's cuts, oldest first; reactive to new ones. */
export function cutsFor(chat: string | null): Cut[] {
  void cutTick.n;
  const s = store();
  return s ? cutsOf(s, chat) : [];
}
