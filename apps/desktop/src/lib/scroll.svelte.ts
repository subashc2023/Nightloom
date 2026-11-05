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

import type { Hold } from "./readingPlace";

export interface ScrollEntry {
  /** `scrollTop` of the viewport, in px. */
  top: number;
  /** Following the foot; `top` is irrelevant while this is true. */
  pinned: boolean;
  /** Item 482: the first message drawn when `top` was measured (the
   *  transcript's render window, `transcriptWindow.svelte.ts`), so a switch
   *  back draws the same ones and `top` lands on the same line. */
  from?: number;
  /** Item 504: the lines in view when he left, found again by their text on
   *  return: a reply that ended meanwhile folds and relabels rows above them,
   *  so `top` alone can name another line. */
  holds?: Hold[];
}

/** The pending chat's key while no chat is open. */
export const NEW_SCROLL_KEY = "new";

const positions = new Map<string, ScrollEntry>();

export function scrollKey(activeSessionId: string | null): string {
  return activeSessionId ?? NEW_SCROLL_KEY;
}

export function rememberScroll(key: string, top: number, pinned: boolean, from?: number): void {
  positions.set(key, from === undefined ? { top: Math.max(0, top), pinned } : { top: Math.max(0, top), pinned, from });
}

/**
 * He left this chat (item 504): the entry is the place he left, never "the
 * foot". A chat left held at the foot mid-reply used to come back at the new
 * foot, past everything written meanwhile, for him to scroll back up. The
 * transcript sets `pinned` again on return if the place is still the foot.
 */
export function leaveScroll(key: string, top: number, from: number | undefined, holds?: Hold[]): void {
  positions.set(key, { top: Math.max(0, top), pinned: false, from, holds });
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

/** An aside card's place (item 502), apart from the same thread's tab. */
export function asideCardScrollKey(session: string, thread: number): string {
  return `aside-card:${session}:${thread}`;
}

/**
 * An aside's entry on return (item 504, the chat's rule): held at the foot
 * stays held only if that is still the foot; an answer that grew while he
 * was away leaves him on the line he left.
 */
export function returnEntry(entry: ScrollEntry | null, scrollHeight: number, clientHeight: number): ScrollEntry | null {
  if (!entry?.pinned) return entry;
  return entry.top >= scrollHeight - clientHeight - 8 ? entry : { ...entry, pinned: false };
}

/** How long a mounting view is put back while it draws, in ms (487's span). */
export const PUT_BACK_MS = 1500;
const PUT_BACK_AT = [0, 50, 150, 300, 600, 1000];

/**
 * Put a view back where `entry` says while its content draws (item 502):
 * at once, on every change under it, and on a few timers, until he
 * scrolls, clicks or types in it, or `PUT_BACK_MS` has gone. A remembered
 * top is set only once the view has room for it — one tick after mount
 * the aside's thread was still short, so the top was cut to near 0 and
 * the scroll that cut made recorded the cut place over his. `busy()` is
 * true meanwhile: the view must not record its own scroll events as his.
 */
export function putBack(el: HTMLElement, entry: ScrollEntry | null): { busy: () => boolean; cancel: () => void } {
  if (!entry) return { busy: () => false, cancel: () => {} };
  let live = true;
  const attempt = (last = false) => {
    if (!live) return;
    const end = Math.max(0, el.scrollHeight - el.clientHeight);
    if (!entry.pinned && !last && end < entry.top - 1) return;
    const top = restoreTop(entry, el.scrollHeight, el.clientHeight);
    if (top !== null && Math.abs(el.scrollTop - top) > 1) el.scrollTop = top;
  };
  const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => attempt());
  mo?.observe(el, { childList: true, subtree: true, characterData: true });
  const timers = PUT_BACK_AT.map((ms) => setTimeout(() => attempt(), ms));
  timers.push(setTimeout(() => (attempt(true), stop()), PUT_BACK_MS));
  const input = ["wheel", "pointerdown", "keydown", "touchstart"] as const;
  function stop() {
    if (!live) return;
    live = false;
    mo?.disconnect();
    for (const t of timers) clearTimeout(t);
    for (const ev of input) el.removeEventListener(ev, stop, true);
  }
  for (const ev of input) el.addEventListener(ev, stop, true);
  attempt();
  return { busy: () => live, cancel: stop };
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
