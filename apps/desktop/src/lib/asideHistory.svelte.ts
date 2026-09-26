/**
 * The past asides' keeper (nightshift item 229, night batch B): holds each
 * chat's closed threads as reactive state, loaded once at launch, hears a
 * thread closed (`onAsideClosed` in `state.svelte.ts`) and keeps it, and
 * writes the history to localStorage, debounced, skipping a private chat
 * (blocker 474). `asideHistory.ts` is the pure part. Imported by
 * `AsideLayer.svelte`, which every transcript draws.
 */
import { app, onAsideClosed, reopenAside } from "./state.svelte";
import type { Aside } from "./state.svelte";
import { isPrivateChat } from "./asides";
import { deletePast, loadPast, recordPast, savePast, takePast, type PastMap } from "./asideHistory";

export const pastAsides = $state({
  byChat: (typeof localStorage === "undefined" ? {} : loadPast(localStorage)) as PastMap,
  /** Threads the cap pushed out this window, per chat — the list's one
   *  line about it (blocker 472). Memory only. */
  pruned: {} as Record<string, number>,
});

const SAVE_DELAY_MS = 400;
let timer: ReturnType<typeof setTimeout> | null = null;

export function flushPast(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (typeof localStorage === "undefined") return;
  savePast($state.snapshot(pastAsides.byChat) as PastMap, localStorage, (chat) => isPrivateChat(chat, app.sessions));
}

function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flushPast, SAVE_DELAY_MS);
}

/** A closed thread, kept under its chat (the `onAsideClosed` listener). */
export function keepClosed(chat: string, a: Aside, now: number = Date.now()): void {
  const pruned = recordPast(pastAsides.byChat, chat, $state.snapshot(a) as Aside, now);
  if (pruned === null) return;
  if (pruned > 0) pastAsides.pruned[chat] = (pastAsides.pruned[chat] ?? 0) + pruned;
  schedule();
}

/** The open chat's past thread back as a card, whole; null if it is gone
 *  or no chat is open. */
export function reopenPast(key: string): Aside | null {
  const chat = app.activeSessionId;
  if (chat === null) return null;
  const a = takePast(pastAsides.byChat, chat, key);
  if (!a) return null;
  schedule();
  return reopenAside(a);
}

/** Delete one for good, after `confirm` says yes (practices §7). */
export function deletePastAside(chat: string, key: string, confirm: () => boolean): boolean {
  const done = deletePast(pastAsides.byChat, chat, key, confirm);
  if (done) schedule();
  return done;
}

/** A chat's past threads, oldest first. */
export function pastOf(chat: string | null): PastMap[string] {
  return chat === null ? [] : (pastAsides.byChat[chat] ?? []);
}

onAsideClosed((chat, a) => keepClosed(chat, a));
if (typeof window !== "undefined") window.addEventListener("pagehide", flushPast);
