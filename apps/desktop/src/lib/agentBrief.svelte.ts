/**
 * Item 591: the agent tab's brief — open, and its dragged height — as one
 * setting for every agent tab, kept across a relaunch. Reactive: a tab kept
 * drawn behind another (App's `keptIn`) follows a change made in the one in
 * front. The arithmetic is `agentBrief.ts`.
 */
import { viewGet, viewSet } from "./viewState";
import { BRIEF_HEIGHT_KEY, BRIEF_OPEN_KEY } from "./agentBrief";

const version = $state({ n: 0 });

export function briefOpen(): boolean {
  void version.n;
  return viewGet(BRIEF_OPEN_KEY, true);
}

export function setBriefOpen(open: boolean): void {
  if (viewGet(BRIEF_OPEN_KEY, true) === open) return;
  viewSet(BRIEF_OPEN_KEY, open, true);
  version.n++;
}

/** The dragged height, 0 when he never dragged it (the default stands). */
export function briefStored(): number {
  void version.n;
  return viewGet(BRIEF_HEIGHT_KEY, 0);
}

export function setBriefStored(h: number): void {
  const v = Math.max(0, Math.round(h));
  if (viewGet(BRIEF_HEIGHT_KEY, 0) === v) return;
  viewSet(BRIEF_HEIGHT_KEY, v, 0);
  version.n++;
}
