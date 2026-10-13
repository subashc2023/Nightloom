/**
 * Item 300, wave 8D (A16/B2): which chat a "the turn ended" notice is for.
 * The page used to ask the host's "current chat" at the moment the notice
 * landed; a send that moved the host's current chat (a new chat, a held
 * message delivered elsewhere) left the page's copy naming the old one, so
 * a reply on screen came with "Reply ready in <another chat>". The page now
 * remembers the chat whose turn it started (or saw start) and asks that.
 */

/** A turn the phone started for a new chat whose id the host has not named. */
export const NEW_CHAT_TURN = "\u0000new";

/** The chat a toast should open for the turn that just ended, or `null`
 *  for no toast (the reply is on screen, or nothing is known).
 *  `turnChat`: the chat the turn was started in (`NEW_CHAT_TURN` for a new
 *  chat the phone sent), `null` when the page did not see it start;
 *  `hostChat`: the host's current chat as the page last read it;
 *  `onScreen`: the chat on screen (`null`: a new chat); `newPending`: the
 *  new chat on screen was sent and its id is not yet known. */
export function turnEndedFor(turnChat: string | null, hostChat: string | null, onScreen: string | null, newPending: boolean): string | null {
  if (turnChat === NEW_CHAT_TURN) return null; // the new chat he sent: on screen, or he left it on purpose
  const ran = turnChat ?? hostChat;
  if (!ran || ran === onScreen) return null;
  // A turn the page did not see start, while the new chat he sent waits for
  // its id: the host's current chat is that new chat.
  if (turnChat === null && newPending) return null;
  return ran;
}

/** 300 review 2: a turn whose end the page's state read saw before the
 *  host's "the turn ended" notice came. A held message may start the next
 *  turn in between (`drainQueue`), so the late notice is judged by this,
 *  not by the turn running now. */
export interface EndedTurn {
  /** The page's `turnChat` for it (`null`: not seen to start). */
  turn: string | null;
  /** The host's current chat as the read that saw it end had it. */
  host: string | null;
  at: number;
}

/** How long a notice may come after the read that saw its turn end. */
export const LATE_NOTICE_MS = 5000;

/** What a "the turn ended" notice is judged by: a turn seen ending in the
 *  last `LATE_NOTICE_MS` and not yet noticed (`late`), else the running
 *  turn's chat and the host's current one. */
export function noticeFor(
  ended: EndedTurn | null,
  turnChat: string | null,
  hostChat: string | null,
  now: number,
): { turn: string | null; host: string | null; late: boolean } {
  if (ended && now - ended.at <= LATE_NOTICE_MS) return { turn: ended.turn, host: ended.host, late: true };
  return { turn: turnChat, host: hostChat, late: false };
}
