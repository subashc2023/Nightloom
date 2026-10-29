/**
 * "Keep in project" (nightshift item 306), the stateful half: each
 * attachment's keep state for this window, by `keepKey`, and the press.
 * Not persisted: after a restart the chip offers Keep again, and pressing
 * it answers "Kept" with the file already there (the backend finds the
 * same bytes and writes nothing).
 */
import { keepAttachment } from "./api";
import { addToast as toastNow, app, projectFilesChanged, refreshNotes, toggleSidebar } from "./state.svelte";
import type { KeepState } from "./keep";
import type { KeptNotice } from "./notesDrop";

export const keeps = $state<Record<string, KeepState>>({});

/**
 * Item 416: the files kept since the Notes panel last looked, for it to
 * scroll to and flash. `seq` is what it watches; a drop of several files
 * holds the count (`holdKeptNotices`) so they arrive as one batch.
 */
export const keptNotices = $state<{ seq: number; list: KeptNotice[] }>({ seq: 0, list: [] });
let holding = 0;
export function holdKeptNotices(): void {
  holding++;
}
export function releaseKeptNotices(): void {
  holding = Math.max(0, holding - 1);
  if (holding === 0 && keptNotices.list.length > 0) keptNotices.seq++;
}
/** The notices not yet shown, emptied. */
export function takeKeptNotices(): KeptNotice[] {
  return keptNotices.list.splice(0);
}
/** Exported for a zip's entries (item 414), kept without `keepNow`'s
 *  toast per file. */
export function noticeKept(rel: string): void {
  keptNotices.list.push({ rel, at: performance.now() });
  if (holding === 0) keptNotices.seq++;
}

/**
 * Item 459: a kept file's chip, clicked — the Notes panel opens (the
 * sidebar too, if it was folded away) and the kept file's row scrolls into
 * view and flashes, by item 416's own path: the panel watches
 * `keptNotices`, and reads a notice as it mounts. False when the chip's
 * file was not kept here, so the click does nothing new.
 */
export function revealKept(key: string): boolean {
  const k = keepStateOf(key);
  if (k.phase !== "kept" || !k.rel) return false;
  if (app.layout.sidebarCollapsed) toggleSidebar();
  app.leftTab = "notes";
  noticeKept(k.rel);
  return true;
}

export function keepStateOf(key: string): KeepState {
  return keeps[key] ?? { phase: "idle" };
}

/** Press Keep: copy into the open project's files, say where on the chip.
 *  `source` is an office file's own SHA-256 (item 428); `toast` is where the
 *  words go — the Notes panel's own, for a drop on it. */
export async function keepNow(
  key: string,
  name: string,
  mediaType: string,
  from: { data: string } | { path: string },
  opts: { source?: string; toast?: (text: string) => void } = {},
): Promise<void> {
  const addToast = opts.toast ?? toastNow;
  const now = keepStateOf(key);
  if (now.phase !== "idle") return;
  keeps[key] = { phase: "keeping" };
  try {
    const kept = await keepAttachment(name, mediaType, from, undefined, opts.source);
    keeps[key] = { phase: "kept", rel: kept.rel };
    if (!kept.already) projectFilesChanged();
    // Item 392 (his bug, 2026-10-18): the Notes list shows it now — it
    // read the folder only at a turn's end or a reload, so a file kept
    // and its chip removed looked lost though it was on disk.
    const refreshed = refreshNotes().catch(() => {});
    addToast(
      kept.already
        ? `${name} was already in this project's files, as ${kept.rel}`
        : `Kept ${name} in this project's files, as ${kept.rel} — new chats here can read it`,
    );
    // Item 416: once the list holds it, the panel scrolls to its row.
    await refreshed;
    noticeKept(kept.rel);
  } catch (e) {
    delete keeps[key];
    addToast(`Could not keep ${name}: ${String(e)}`);
  }
}
