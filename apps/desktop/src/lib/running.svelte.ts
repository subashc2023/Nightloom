/**
 * The running list's live half (nightshift backlogs 308 and 309): every
 * row `runningWork()` reads from the store, plus the note edits (whose store
 * imports the main one, so they join here), and the quit guard's window
 * side — the lines Rust holds, the dialog's state, *Quit anyway*.
 *
 * See `running.ts` for the row and why the list is read, not kept.
 */
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { app, runningWork } from "./state.svelte";
import { noteEdits } from "./noteEdit.svelte";
import { UNFILED } from "./drafts.svelte";
import { quitLines, quoteLine, sortRuns, type RunEntry } from "./running";

/** A note edit's key is `noteDraftKey`'s: `<project>:<scope>:<name>` for a
 *  project's notes and instructions, `<scope>:<name>` for the rest. */
export function noteEditHome(
  key: string,
  projects: readonly { id: string; name: string }[],
): { project: string | null; where: string; note: string } {
  const parts = key.split(":");
  if (parts.length >= 3 && (parts[1] === "project" || parts[1] === "instructions")) {
    const project = parts[0] === UNFILED ? null : parts[0];
    const name = projects.find((p) => p.id === project)?.name;
    return { project, where: name ?? (project === null ? "unfiled chats" : "another project"), note: parts.slice(2).join(":") };
  }
  return { project: null, where: parts[0] ?? "", note: parts.slice(1).join(":") };
}

/** Each note whose edit-by-prompt turn runs (backlog 151). */
export function noteEditRuns(): RunEntry[] {
  const out: RunEntry[] = [];
  for (const [key, t] of Object.entries(noteEdits)) {
    const last = t.turns[t.turns.length - 1];
    if (!last || last.status !== "running") continue;
    const home = noteEditHome(key, app.projects);
    const at = Date.parse(last.at);
    out.push({
      id: `note:${key}:${last.id}`,
      kind: "note edit",
      project: home.project,
      where: home.where,
      session: null,
      chat: home.note,
      doing: quoteLine(last.request),
      startedAt: Number.isNaN(at) ? null : at,
      onScreen: false,
      waiting: false,
      survivesQuit: false,
    });
  }
  return out;
}

/** Everything running now, in every project: the one list both the
 *  Running-tasks panel and the quit guard read. */
export function allRunning(now: number = Date.now()): RunEntry[] {
  return sortRuns([...runningWork(now), ...noteEditRuns()]);
}

/** The quit dialog (308): open while a quit waits on his answer. */
export const quitAsk = $state({ open: false, quitting: false });

let pushed: string | null = null;
/** Tell Rust what a quit would stop, when that changed. */
export function pushQuitLines(runs: readonly RunEntry[]): void {
  const lines = quitLines(runs);
  const key = JSON.stringify(lines);
  if (key === pushed) return;
  pushed = key;
  void api.setRunningWork(lines).catch(() => {
    // Outside the app (the suite, the phone page): nothing to tell.
    pushed = null;
  });
}

/** Rust cancelled a quit because work runs: put the dialog up. */
export async function listenForQuit(): Promise<void> {
  await listen<string[]>("quit-requested", () => {
    quitAsk.open = true;
    quitAsk.quitting = false;
    void api.quitDialogShown().catch(() => {});
  });
}

/** *Cancel*: the app and every run go on. */
export function cancelQuit(): void {
  quitAsk.open = false;
}

/**
 * *Quit anyway*. Every store that saves on a debounce saves on `pagehide`
 * (drafts, tabs, asides, note edits, clips); a quit's page teardown is not
 * promised to fire it, so it is fired here first, and the writes get a
 * moment to leave the page before the app goes — no draft that a quit kept
 * before is lost to this one (practices §7).
 */
export async function quitAnyway(): Promise<void> {
  quitAsk.quitting = true;
  if (typeof window !== "undefined") window.dispatchEvent(new Event("pagehide"));
  await new Promise((r) => setTimeout(r, 250));
  try {
    await api.quitNow();
  } catch {
    quitAsk.quitting = false;
  }
}
