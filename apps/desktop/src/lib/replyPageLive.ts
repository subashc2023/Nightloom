/**
 * Item 770: how many reply pages hold a live frame at once. A long chat can carry dozens of pages, each a
 * document with its own scripts; a frame is made only when its card nears the viewport, and past `MAX_LIVE`
 * the one farthest from the viewport — never one that is near it — is put to sleep (its card stays, its
 * frame is rebuilt, scrolled where it was, when he comes back to it).
 */
export const MAX_LIVE = 6;

export interface LivePage {
  /** Whether the card is near the viewport now. */
  near: () => boolean;
  /** How far the card is from the viewport's middle, in px. */
  distance: () => number;
  /** Drop the frame. */
  sleep: () => void;
}

const live: LivePage[] = [];

/** Which of `pages` to put to sleep so at most `max` stay, farthest first, never a near one. Pure. */
export function toSleep<T extends { near: boolean; distance: number }>(pages: T[], max = MAX_LIVE): T[] {
  const over = pages.length - max;
  if (over <= 0) return [];
  return pages
    .filter((p) => !p.near)
    .sort((a, b) => b.distance - a.distance)
    .slice(0, over);
}

/** A card made its frame. */
export function wake(page: LivePage): void {
  if (!live.includes(page)) live.push(page);
  const snap = live.map((p) => ({ p, near: p === page || p.near(), distance: p.distance() }));
  for (const { p } of toSleep(snap)) {
    live.splice(live.indexOf(p), 1);
    p.sleep();
  }
}

/** A card dropped its frame (collapsed, source shown, destroyed). */
export function rest(page: LivePage): void {
  const i = live.indexOf(page);
  if (i >= 0) live.splice(i, 1);
}
