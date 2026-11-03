// The Sort inbox sheet's state (nightshift backlog 488), kept in app state
// rather than in the sheet: closing the sheet keeps his instruction and his
// edits to the plan, and reopening offers them back. Only Start over (which
// asks) or a finished Apply clears them. Since 2026-11-02 (practices §7) the
// unapplied plan and the instruction are also in localStorage, as the drafts
// are, so a quit and relaunch offers them back too.

import * as api from "./inboxSort";
import { runningTurn } from "./noteEdit.svelte";
import { app, followNoteMove, noteDraftKey, refreshNotes } from "./state.svelte";
import { SAVED_KEY, parseSort, serializeSort } from "./inboxSort";
import type { InboxDigest, InboxScope, Moved, Proposal, SavedSort } from "./inboxSort";

export type SortPhase = "idle" | "running" | "plan" | "applying" | "done";

function loadSaved(): SavedSort | null {
  try {
    return parseSort(typeof localStorage === "undefined" ? null : localStorage.getItem(SAVED_KEY));
  } catch {
    return null;
  }
}

const saved = loadSaved();

export const inboxSort = $state({
  open: false,
  scope: (saved?.scope ?? "project") as InboxScope,
  instruction: saved?.instruction ?? "",
  phase: (saved?.rows.length ? "plan" : "idle") as SortPhase,
  digest: null as InboxDigest | null,
  rows: (saved?.rows ?? []) as Proposal[],
  folders: (saved?.folders ?? []) as string[],
  cost: saved?.cost ?? "",
  savedAt: saved?.savedAt ?? "",
  error: "",
  notice: "",
  results: [] as Moved[],
});

/** What a quit right now should bring back. A running sort or Apply is
 *  stored as the plan (or the instruction) it started from. */
export function savedNow(): SavedSort {
  return {
    scope: inboxSort.scope,
    instruction: inboxSort.instruction,
    rows: $state.snapshot(inboxSort.rows) as Proposal[],
    folders: $state.snapshot(inboxSort.folders) as string[],
    cost: inboxSort.cost,
    savedAt: inboxSort.savedAt,
  };
}

/** Write now: on the debounce, and when the page goes away. */
export function flushInboxSort(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (typeof localStorage === "undefined") return;
  try {
    const s = savedNow();
    if (s.rows.length || s.instruction.trim()) localStorage.setItem(SAVED_KEY, serializeSort(s));
    else localStorage.removeItem(SAVED_KEY);
  } catch {
    // Storage unavailable or full: the plan stays for this window.
  }
}

const SAVE_DELAY_MS = 400;
let timer: ReturnType<typeof setTimeout> | null = null;
function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flushInboxSort, SAVE_DELAY_MS);
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flushInboxSort);

// Every edit he makes (a tick, a destination, the instruction) is saved:
// the sheet binds straight into this state, so the save watches it.
$effect.root(() => {
  $effect(() => {
    JSON.stringify(savedNow());
    schedule();
  });
});

/** Open the sheet on `scope`'s inbox; a plan already made is offered back. */
export async function openInboxSort(scope: InboxScope): Promise<void> {
  inboxSort.notice = "";
  inboxSort.error = "";
  if (inboxSort.scope !== scope) {
    const held = inboxSort.rows.length > 0 || inboxSort.instruction.trim() !== "";
    const busy = inboxSort.phase === "running" || inboxSort.phase === "applying";
    if (held || busy) {
      // Never dropped for a switch of section: the kept plan is shown.
      const where = inboxSort.scope === "knowledge" ? "Knowledge" : "Project";
      inboxSort.notice = `Your ${where} sort is kept — apply it or Start over to sort the other inbox.`;
    } else {
      resetSort();
      inboxSort.scope = scope;
    }
  }
  inboxSort.open = true;
  if (inboxSort.phase === "idle" || inboxSort.phase === "done") await reloadInbox();
  else if (inboxSort.phase === "plan") await dropGoneRows();
}

/** A kept plan (after a relaunch, say) may name entries no longer in the
 *  inbox — moved or deleted meanwhile; their rows go, since nothing is left
 *  to move. Kept as is when the inbox cannot be read. */
async function dropGoneRows(): Promise<void> {
  await reloadInbox();
  const d = inboxSort.digest;
  if (!d || inboxSort.error) return;
  const there = new Set(d.items.map((i) => i.path));
  const kept = inboxSort.rows.filter((r) => there.has(r.item));
  if (kept.length !== inboxSort.rows.length) {
    const gone = inboxSort.rows.length - kept.length;
    inboxSort.rows = kept;
    const left = `${gone} ${gone === 1 ? "entry has" : "entries have"} left the inbox since this plan was made.`;
    inboxSort.notice = [inboxSort.notice, left].filter(Boolean).join(" ");
    if (!kept.length) inboxSort.phase = "idle";
  }
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
    inboxSort.savedAt = new Date().toISOString();
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
  // At once, not on the debounce: a quit now must not offer back moved rows.
  flushInboxSort();
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
  inboxSort.savedAt = "";
  inboxSort.error = "";
  inboxSort.notice = "";
  inboxSort.results = [];
  flushInboxSort();
}
