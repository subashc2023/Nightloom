// The checkpoint helpers fork from (nightshift backlog 104, pass 3): the
// pure half of the transcript's marker and "fork from here" button.
import type { Checkpoint } from "./types";

/**
 * Which user turn owns the checkpoint: the checkpoint's `index` is a log
 * event (his message or the reply), and a fork starts after the exchange
 * it belongs to — so the owner is the last user message at or before it.
 * `userIndexes` are the log indexes of the user messages, ascending. Null
 * with no checkpoint or one before the first message.
 */
export function checkpointOwner(userIndexes: readonly number[], cp: Checkpoint | null): number | null {
  if (!cp) return null;
  let owner: number | null = null;
  for (const i of userIndexes) {
    if (i <= cp.index) owner = i;
    else break;
  }
  return owner;
}

/**
 * The marker's words. Short on the row; `long` for the hover, saying what
 * it means and how it got there.
 */
export function checkpointLine(cp: Checkpoint, long: boolean): string {
  const who = cp.set_by === "user" ? "moved here by you" : "set at the first exchange";
  const state = cp.uuid ? "" : " · not yet in Claude Code's history";
  if (!long) return `helpers fork from here${cp.uuid ? "" : " · pending"}`;
  return (
    `Helpers fork from the end of this exchange (${who}${state}): a long-research helper ` +
    "starts with the chat up to here, at cache-read cost, and none of the later turns. " +
    "Move it with the branch button on another message."
  );
}
