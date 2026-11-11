/**
 * Each chat's keep-warm status as the window holds it (nightshift backlog
 * 582): read when a chat is shown, replaced whenever the backend says it
 * changed (`keep-warm`). In memory only — the switch itself lives in the
 * chat's folder on disk, the schedule in the backend.
 */
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import type { KeepWarmMode, KeepWarmStatus } from "./keepWarm";

export const keepWarm = $state<{ byChat: Record<string, KeepWarmStatus> }>({ byChat: {} });

let listening = false;

/** Start hearing the backend's changes; once. */
export function watchKeepWarm(): void {
  if (listening) return;
  listening = true;
  void listen<KeepWarmStatus>("keep-warm", (e) => {
    if (e.payload?.chat) keepWarm.byChat[e.payload.chat] = e.payload;
  }).catch(() => {
    listening = false;
  });
}

/** Read a chat's status (a chat just shown). Quiet on failure: the
 *  switch then reads off, and a click says what is wrong. */
export async function loadKeepWarm(chat: string): Promise<void> {
  watchKeepWarm();
  try {
    const s = await api.keepWarmStatus(chat);
    if (s) keepWarm.byChat[chat] = s;
  } catch {
    // Not a chat with a folder yet.
  }
}

/** Set a chat's switch. Resolves to the error's words when refused. */
export async function setKeepWarm(chat: string, mode: KeepWarmMode): Promise<string | null> {
  watchKeepWarm();
  try {
    const s = await api.keepWarmSet(chat, mode);
    if (s) keepWarm.byChat[chat] = s;
    return null;
  } catch (e) {
    return String(e);
  }
}

/** A chat's tab was closed: its keep-warm ends. */
export function stopKeepWarm(chat: string): void {
  const s = keepWarm.byChat[chat];
  if (!s || s.mode === "off") return;
  void api.keepWarmStop(chat).catch(() => {});
  keepWarm.byChat[chat] = { ...s, mode: "off", scheduled: false, why: "off", next_ping_ms: null };
}
