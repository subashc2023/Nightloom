/**
 * Where each chat was scrolled to (nightshift backlog 065, 2026-09-15).
 *
 * `Transcript.svelte` used to remember one thing, whether the view was
 * pinned to the foot, and that across every chat: switching away and back
 * landed at the bottom every time, and a place high up in a long chat had
 * to be found again by hand ("painful", his word). Now each chat has an
 * entry — its `scrollTop` and whether it was pinned — written by the
 * transcript as it scrolls and read back after the switched-to chat's
 * events have rendered. A chat with no entry starts at the bottom, as
 * every chat did.
 *
 * `pinned` is the part that matters during a reply: with it true the
 * transcript follows the stream and `top` is never consulted, so the
 * pin-during-reply behaviour is exactly what it was.
 *
 * Not persisted. A position is in pixels of a layout that a relaunch —
 * a different window size, a font change — redoes; a stale number would
 * land somewhere arbitrary, and the bottom is the honest default.
 *
 * Named `.svelte.ts` for the family it belongs to; nothing here is a rune,
 * because nothing draws from it — the transcript reads an entry once, on a
 * switch, and a reactive map would make the scroll handler re-run effects
 * on every frame.
 */

export interface ScrollEntry {
  /** `scrollTop` of the viewport, in px. */
  top: number;
  /** Following the foot; `top` is irrelevant while this is true. */
  pinned: boolean;
}

/** The pending chat's key while no chat is open. */
export const NEW_SCROLL_KEY = "new";

const positions = new Map<string, ScrollEntry>();

export function scrollKey(activeSessionId: string | null): string {
  return activeSessionId ?? NEW_SCROLL_KEY;
}

export function rememberScroll(key: string, top: number, pinned: boolean): void {
  positions.set(key, { top: Math.max(0, top), pinned });
}

/** The entry, or null for a chat never scrolled in this launch. */
export function recallScroll(key: string): ScrollEntry | null {
  return positions.get(key) ?? null;
}

export function forgetScroll(key: string): void {
  positions.delete(key);
}

/**
 * The pending chat's entry becomes the created chat's: the first turn's
 * key goes from "new" to the id while the same transcript is on screen,
 * and that is not a switch.
 */
export function moveScroll(from: string, to: string): void {
  if (from === to) return;
  const e = positions.get(from);
  if (!e) return;
  positions.set(to, e);
  positions.delete(from);
}

/** For the suite: a fresh map between cases. */
export function resetScroll(): void {
  positions.clear();
}

/**
 * An aside tab's entry (nightshift backlog 237, 2026-09-26: "even in aside
 * chats it should save where exactly I am … instead of each time I'm
 * clicking into that tab, it starts me at the very top"). The same map,
 * keyed by the chat and the thread's id, so it can never collide with a
 * chat's key (a chat id has no `aside:` prefix). Not persisted, as a
 * chat's is not.
 */
export function asideScrollKey(session: string, thread: number): string {
  return `aside:${session}:${thread}`;
}

/**
 * Where to put a view back on mount or on a switch back: nothing for a view
 * never scrolled (it opens where it always did); the foot for one that was
 * held at its foot (an answer that grew meanwhile is followed to its end);
 * else the remembered top, never past the end the content now has.
 */
export function restoreTop(entry: ScrollEntry | null, scrollHeight: number, clientHeight: number): number | null {
  if (!entry) return null;
  const end = Math.max(0, scrollHeight - clientHeight);
  return entry.pinned ? end : Math.min(entry.top, end);
}
