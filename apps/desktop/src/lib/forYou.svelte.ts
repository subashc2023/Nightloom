/**
 * Files for him (nightshift backlog 377): the list the top bar's folder
 * button and the + new-tab list draw, kept fresh, and how a row opens.
 *
 * Fresh by a cheap poll (`for_you.rs`'s *Freshness*): every few seconds the
 * manifest's stamp, and the list re-read only when the stamp or the open
 * project moved — so a file the model marks shows within seconds on either
 * engine.
 */
import * as api from "./api";
import { addToast, app, openContent } from "./state.svelte";
import { noteForPath } from "./cards";
import { loadSeen, newestAt, projectKey, saveSeen, unseenCount, type ForYouRow } from "./forYou";

const POLL_MS = 3000;

const storage = (): Storage | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

export const forYou = $state({
  rows: [] as ForYouRow[],
  /** Last looked, per project key. */
  seen: loadSeen(storage()),
});

let stamp: string | null = null;
let loadedFor: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Re-read the list when the manifest or the open project changed; `force` always. */
export async function refreshForYou(force = false): Promise<void> {
  const key = projectKey(app.project?.id);
  let now: string;
  try {
    now = await api.forYouStamp();
  } catch {
    return;
  }
  if (!force && now === stamp && key === loadedFor) return;
  try {
    forYou.rows = await api.forYouFiles();
    stamp = now;
    loadedFor = key;
  } catch {
    // Read again on the next tick.
  }
}

/** Start the poll once; every caller after the first is a no-op. */
export function startForYou(): void {
  if (timer) return;
  void refreshForYou(true);
  timer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    void refreshForYou();
  }, POLL_MS);
}

/** New since he last looked, for the open project. */
export function forYouUnseen(): number {
  return unseenCount(forYou.rows, forYou.seen[projectKey(app.project?.id)]);
}

/** The list was opened: everything in it is seen. */
export function markForYouSeen(): void {
  const at = newestAt(forYou.rows);
  if (!at) return;
  forYou.seen = { ...forYou.seen, [projectKey(app.project?.id)]: at };
  saveSeen(storage(), forYou.seen);
}

/**
 * A path as a Nightloom tab, the file card's rule (backlog 161): a note
 * under the notes folder or the vault in the note view, anything else in a
 * read-only file tab; a kind the tab cannot draw goes to its own
 * application. A refusal is a toast in the backend's words. `chat` vouches
 * for the read when there is one; a file marked for him or opened from the
 * Finder needs none.
 */
export async function openPathAsTab(path: string, chat: string | null = null): Promise<void> {
  const note = noteForPath(path, { project: app.project?.notes_dir, knowledge: app.knowledge?.dir });
  if (note) {
    await openContent({ kind: "note", ...note }, "new");
    return;
  }
  try {
    const f = await api.readFileTab(path, chat);
    if (f.kind === "other") {
      await api.openFile(path);
      return;
    }
    await openContent(chat ? { kind: "file", path, session: chat } : { kind: "file", path }, "new");
  } catch (e) {
    addToast(String(e));
  }
}

/** A row's Finder button. */
export async function revealForYou(path: string): Promise<void> {
  try {
    await api.forYouReveal(path);
  } catch (e) {
    addToast(`Could not show it in the Finder: ${String(e)}`);
  }
}

/** A row's main click: a folder opens in the Finder, a file in a tab. */
export async function openForYou(row: ForYouRow): Promise<void> {
  if (row.folder) await revealForYou(row.path);
  else await openPathAsTab(row.path);
}
