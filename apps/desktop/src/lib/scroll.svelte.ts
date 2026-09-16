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
