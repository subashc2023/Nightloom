/**
 * Item 869: the Notes list follows its folders when they change outside
 * Nightloom (Finder, a script, iCloud). The service watches the open
 * project's notes folder and the knowledge base (`watch_notes`, one OS
 * subscription each) and emits `notes-changed`; this file holds the pure
 * parts — coalescing the re-reads, re-asking for the watch only when the
 * folders moved, and the plain words for a note whose file vanished.
 */

/**
 * A re-read that never runs twice at once: a call while one is in flight
 * asks for exactly one more after it, however many calls arrive. A failed
 * re-read does not stop the next.
 */
export function coalesced(refresh: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          await refresh().catch(() => {});
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}

/**
 * Ask for the watch when `key` (the open project and the vault) differs
 * from the last one asked for. A refused ask (the folder does not exist
 * yet) is forgotten, so the next read asks again.
 */
export function watchWhenMoved(ask: () => Promise<unknown>): (key: string) => void {
  let last: string | null = null;
  return (key) => {
    if (key === last) return;
    last = key;
    ask().catch(() => {
      if (last === key) last = null;
    });
  };
}

/**
 * Whether the open note's file is still there, after a `notes-changed`:
 * false when the read says it vanished, true when it read, null when it
 * failed for another reason (say nothing then).
 */
export async function stillThere(read: () => Promise<unknown>): Promise<boolean | null> {
  try {
    await read();
    return true;
  } catch (e) {
    return noteVanished(String(e)) ? false : null;
  }
}

/** The `notes-changed` payload: which folder, and the batch's paths
 *  relative to it (`""` is the folder itself — a rescan; an absolute path
 *  is one the OS named outside the folder's real path). */
export type NotesChanged = { scope: "project" | "knowledge"; paths: string[] };

/**
 * Review of 869: whether a batch can concern the open note `name` in
 * `scope` — its own path, a folder above it (a folder moved or deleted
 * whole), the folder itself (a rescan) or a path the OS gave outside the
 * folder (cannot tell, so yes). Anything else — a sync landing hundreds of
 * other files — is no reason to read the open file again, which for a PDF
 * is the whole file over the bridge.
 */
export function touchesNote(e: NotesChanged | null | undefined, scope: string, name: string): boolean {
  if (!e || !Array.isArray(e.paths)) return true;
  if (e.scope !== scope) return false;
  return e.paths.some((p) => p === "" || p.startsWith("/") || p === name || name.startsWith(`${p}/`));
}

/** Whether a read failed because the file is no longer there. */
export function noteVanished(error: string): boolean {
  return /\(os error 2\)|No such file or directory|cannot find the (file|path)/i.test(error);
}

/** The plain message for a note whose file vanished, never the os error. */
export function vanishedMessage(name: string, hasDraft: boolean): string {
  const base = name.split("/").pop() || name;
  return hasDraft
    ? `${base} was moved or deleted outside Nightloom. Your unsaved edits are kept below; Save puts them back as this file.`
    : `${base} was moved or deleted outside Nightloom.`;
}
