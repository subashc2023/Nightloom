// The Sort inbox sheet's state (nightshift backlog 488), kept in app state
// rather than in the sheet: closing the sheet keeps his instruction and his
// edits to the plan, and reopening offers them back. Only Start over (which
// asks) or a finished Apply clears them.

import * as api from "./inboxSort";
import { runningTurn } from "./noteEdit.svelte";
import { app, followNoteMove, noteDraftKey, refreshNotes } from "./state.svelte";
import type { InboxDigest, InboxScope, Moved, Proposal } from "./inboxSort";

export type SortPhase = "idle" | "running" | "plan" | "applying" | "done";

export const inboxSort = $state({
  open: false,
  scope: "project" as InboxScope,
  instruction: "",
  phase: "idle" as SortPhase,
  digest: null as InboxDigest | null,
  rows: [] as Proposal[],
  folders: [] as string[],
  cost: "",
  error: "",
  results: [] as Moved[],
});

/** Open the sheet on `scope`'s inbox; a plan already made is offered back. */
export async function openInboxSort(scope: InboxScope): Promise<void> {
  if (inboxSort.scope !== scope && inboxSort.phase !== "running" && inboxSort.phase !== "applying") {
    resetSort();
  }
  inboxSort.scope = scope;
  inboxSort.open = true;
  inboxSort.error = "";
  if (inboxSort.phase === "idle" || inboxSort.phase === "done") await reloadInbox();
}

export function closeInboxSort(): void {
  inboxSort.open = false;
}

export async function reloadInbox(): Promise<void> {
  try {
    inboxSort.digest = await api.listInbox(inboxSort.scope);
    inboxSort.folders = inboxSort.digest.folders;
    // `listInbox` makes `Inbox/`; the panel shows it at once.
    void refreshNotes();
  } catch (e) {
    inboxSort.error = String(e);
  }
}

/** Ask the cheap model for a plan. */
export async function runSort(): Promise<void> {
  if (inboxSort.phase === "running" || inboxSort.phase === "applying") return;
  if (app.draft.engine !== "claude-code") {
    inboxSort.error = "Sort inbox runs on the Claude Code engine — switch to it in Settings.";
    return;
  }
  inboxSort.phase = "running";
  inboxSort.error = "";
  inboxSort.results = [];
  try {
    const plan = await api.planSort({
      scope: inboxSort.scope,
      instruction: inboxSort.instruction.trim() || undefined,
      binary: app.draft.agentBinary.trim() || undefined,
      safeMode: app.draft.agentSafeMode,
    });
    if (plan.interrupted) {
      inboxSort.phase = inboxSort.rows.length ? "plan" : "idle";
      return;
    }
    inboxSort.rows = plan.proposals;
    inboxSort.folders = plan.folders;
    inboxSort.cost = api.costWords(plan);
    inboxSort.phase = "plan";
  } catch (e) {
    inboxSort.error = String(e);
    inboxSort.phase = inboxSort.rows.length ? "plan" : "idle";
  }
}

export async function stopSort(): Promise<void> {
  try {
    await api.cancelSort();
  } catch {
    // Nothing was running.
  }
}

/** Move the ticked rows; tabs and drafts follow each moved entry. */
export async function applyPlan(): Promise<void> {
  if (inboxSort.phase !== "plan") return;
  const scope = inboxSort.scope;
  const list = scope === "project" ? app.notes : app.vault;
  const moves = api.movesOf(inboxSort.rows, inboxSort.folders).filter((m) => {
    // A note an edit-by-prompt turn is writing stays put (item 471's rule).
    const inside = list.filter((n) => n.name === m.item || n.name.startsWith(m.item + "/"));
    return !inside.some((n) => runningTurn(noteDraftKey(scope, n.name)));
  });
  if (!moves.length) {
    inboxSort.error = "Nothing is ticked with a folder to move to.";
    return;
  }
  inboxSort.phase = "applying";
  inboxSort.error = "";
  let results: Moved[];
  try {
    results = await api.applySort(scope, moves);
  } catch (e) {
    inboxSort.error = String(e);
    inboxSort.phase = "plan";
    return;
  }
  for (const r of results) if (r.landed && r.landed !== r.item) followNoteMove(scope, r.item, r.landed);
  inboxSort.results = results;
  // What did not move stays on the plan, ticked, so he can retry or edit it.
  const failed = new Set(results.filter((r) => !r.landed).map((r) => r.item));
  const moved = new Set(results.filter((r) => r.landed).map((r) => r.item));
  inboxSort.rows = inboxSort.rows.filter((r) => !moved.has(r.item) || failed.has(r.item));
  inboxSort.phase = inboxSort.rows.some((r) => r.tick) ? "plan" : "done";
  await refreshNotes();
  await reloadInbox();
}

/** Forget the plan and the instruction (the sheet asks first). */
export function resetSort(): void {
  inboxSort.phase = "idle";
  inboxSort.rows = [];
  inboxSort.instruction = "";
  inboxSort.cost = "";
  inboxSort.error = "";
  inboxSort.results = [];
}
