/**
 * The hand-off card's Minimize (backlog 383): a chat's card folds to one
 * line above the box. Kept per chat for the app's run, so a chat switch
 * keeps it folded; keyed by the stage it was folded at, so the next stage
 * (the notice becomes "HANDOFF.md written") opens in full once.
 */
import type { HandoffStage } from "./handoff.svelte";

const folded = $state<{ at: Record<string, HandoffStage>; stayedFrom: Record<string, HandoffStage> }>({
  at: {},
  stayedFrom: {},
});

/** Which card a *Stay here* closed, so *Hand off* reopens the same one.
 *  A *Stay here* also ends any fold: the card's next showing (the re-ask
 *  past the mark, or *Hand off*) is a fresh ask and opens in full (review
 *  2026-10-18: a notice folded, then wrapped up from the folded line and
 *  stayed past, came back folded at the re-ask). */
export function noteStay(chat: string | null, stage: HandoffStage): void {
  if (chat === null) return;
  folded.stayedFrom[chat] = stage;
  delete folded.at[chat];
}

export function stayedFromWrapped(chat: string | null): boolean {
  return chat !== null && folded.stayedFrom[chat] === "wrapped";
}

export function isFolded(chat: string | null, stage: HandoffStage): boolean {
  return chat !== null && folded.at[chat] === stage;
}

export function fold(chat: string | null, stage: HandoffStage): void {
  if (chat !== null) folded.at[chat] = stage;
}

export function unfold(chat: string | null): void {
  if (chat !== null) delete folded.at[chat];
}
