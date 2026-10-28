/**
 * The chats' previews (nightshift item 430), as the window knows them: the
 * list read once, then kept by the backend's `preview-changed` events (a
 * start, the port answering, an exit, a stop). The log is read on demand
 * while the chip's log is open.
 */
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import type { PreviewSnapshot } from "./api";
import { applyPreviewChange } from "./preview";

export const previews = $state({
  byChat: {} as Record<string, PreviewSnapshot>,
  /** Why previews are not served in this app process (item 444), or null. */
  unavailable: null as string | null,
  /** He dismissed that notice for this run. */
  unavailableDismissed: false,
});

let started = false;

/** Listen, then read the list; every caller after the first is a no-op. */
export async function startPreviews(): Promise<void> {
  if (started) return;
  started = true;
  try {
    await listen<{ chat: string; preview: PreviewSnapshot | null }>("preview-changed", (e) => {
      previews.byChat = applyPreviewChange(previews.byChat, e.payload.chat, e.payload.preview);
    });
    try {
      previews.unavailable = await api.previewUnavailable();
    } catch {
      previews.unavailable = null;
    }
    const all = await api.previewList();
    let map: Record<string, PreviewSnapshot> = {};
    for (const p of all) map = applyPreviewChange(map, p.chat, p);
    previews.byChat = { ...map, ...previews.byChat };
  } catch {
    // Outside the app (the harness without its stub): no previews.
  }
}

/** Re-read one chat's preview, its newest log lines included. */
export async function refreshPreview(chat: string): Promise<void> {
  try {
    const p = await api.previewGet(chat);
    previews.byChat = applyPreviewChange(previews.byChat, chat, p);
  } catch {
    // Kept as it was; the next event or tick reads again.
  }
}

/** His Restart on an ended preview (item 445). */
export async function restartPreview(chat: string): Promise<void> {
  const p = await api.previewRestart(chat);
  previews.byChat = applyPreviewChange(previews.byChat, chat, p);
}

export async function stopPreview(chat: string): Promise<void> {
  await api.previewStop(chat);
  previews.byChat = applyPreviewChange(previews.byChat, chat, null);
}
