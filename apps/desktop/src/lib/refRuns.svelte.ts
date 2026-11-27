/*
 * A card's action while it runs (993e review, finding 7): the mail past its hold, an RSVP, a draft being saved —
 * one connector call in its own process. Listed with everything else that runs (`allRunning`), so the Running
 * panel shows it and a quit (⌘Q) asks first instead of killing the call with no receipt. A quit anyway leaves the
 * call's journal behind, and the next launch says it may have gone (`ref_unfinished`).
 */
import type { RunEntry } from "./running";

export const refRuns = $state<Record<string, { doing: string; startedAt: number }>>({});

let seq = 0;
/** Mark one action running; call the returned function when it ends. */
export function refRunStart(doing: string, now: number = Date.now()): () => void {
  const id = `ref:${++seq}`;
  refRuns[id] = { doing, startedAt: now };
  return () => {
    delete refRuns[id];
  };
}

export function refRunEntries(): RunEntry[] {
  return Object.entries(refRuns).map(([id, r]) => ({
    id,
    kind: "card action",
    project: null,
    where: "Home",
    session: null,
    chat: r.doing,
    doing: r.doing,
    startedAt: r.startedAt,
    onScreen: false,
    waiting: false,
    survivesQuit: false,
  }));
}
