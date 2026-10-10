/**
 * Send near the bottom jumps to the bottom (nightshift backlog 313,
 * 2026-10-05). A Send leaves the reader's place alone when they are
 * reading further up — his "I generally like that" — but from close to the
 * foot he means to see the foot, so the view lands there and follows the
 * reply.
 *
 * "Close" is within `SEND_JUMP_SCREENS` viewport heights of the bottom,
 * measured just before the sent turn is drawn: the distance is
 * `scrollHeight - scrollTop - clientHeight` of the transcript's scroll box.
 * At the foot (distance 0) the view is pinned already and the jump changes
 * nothing.
 */

/** How many viewport heights above the foot a Send still jumps from. */
export const SEND_JUMP_SCREENS = 1;

/** Whether a Send from `distance` px above the foot, in a view `viewport`
 *  px tall, lands at the bottom (true) or keeps the place (false). */
export function sendJumps(distance: number, viewport: number): boolean {
  if (!Number.isFinite(distance) || !Number.isFinite(viewport) || viewport <= 0) return false;
  return Math.max(0, distance) <= SEND_JUMP_SCREENS * viewport;
}

/**
 * The distance the view would have had with the message box at rest (313
 * review). A tall paste grows the box and shrinks the transcript's view by
 * the same amount, so read at Send the view is `grown` px shorter and the
 * foot `grown` px further — a paste of ten lines put a Send from half a
 * screen up out of range. The box shrinks back a frame after the Send; with
 * the view's height then (`nowHeight`) and `scrollTop` unchanged, the
 * reader's distance is the Send-time distance less what the view grew by.
 */
export function restDistance(
  preDistance: number,
  preHeight: number,
  nowHeight: number,
): { distance: number; viewport: number } {
  const grown = Math.max(0, nowHeight - preHeight);
  return { distance: Math.max(0, preDistance - grown), viewport: Math.max(preHeight, nowHeight) };
}
