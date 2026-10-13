/**
 * What names a turn besides its place in the list (nightshift backlog 364,
 * 2026-10-13). A window names a turn by its index in the log it holds; when
 * that list is out of step with the log, the index names another turn —
 * backlog 361 met it as a Retry that forked seven exchanges early, and fixed
 * edit-and-send, Retry and Rewind by sending his message's send time. Edit's
 * Save, Remove and Restore (and a reply's block edits) send the same: `at`,
 * the send time of his message that opened the turn's exchange, and for a
 * reply `nth`, its place among that exchange's replies (from 0) — a reply
 * has no send time of its own. The backend finds that turn
 * (`Session::aim_turn`) or refuses, changing nothing.
 */
import type { SessionEvent } from "./types";

export interface Aim {
  at: string;
  /** Absent for his own message; a reply's place among its exchange's replies. */
  nth?: number;
}

/** The aim of the turn at `index` in `events`; null when it has none (not a
 *  message, or a reply with no message of his before it), which goes bare. */
export function aimOf(events: readonly SessionEvent[], index: number): Aim | null {
  const e = events[index];
  if (!e) return null;
  if (e.event === "user_message") return e.at ? { at: e.at } : null;
  if (e.event !== "assistant_message") return null;
  let nth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const p = events[i];
    if (p.event === "user_message") return p.at ? { at: p.at, nth } : null;
    if (p.event === "assistant_message") nth += 1;
  }
  return null;
}

/** The aim as a command's arguments: `{ at, nth }`, or nothing when bare. */
export function aimArgs(aim: Aim | null | undefined): { at?: string; nth?: number } {
  if (!aim) return {};
  return aim.nth === undefined ? { at: aim.at } : { at: aim.at, nth: aim.nth };
}
