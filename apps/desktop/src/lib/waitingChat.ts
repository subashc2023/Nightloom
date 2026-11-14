/**
 * A chat waiting for its scheduled first message (nightshift backlog 532),
 * pure: what the page that chooses Welcome vs chat, the composer and the
 * scheduled chip share. A chat made by Send later from a New chat has a
 * log with only its creation in it; by the Welcome test (`App.svelte`'s
 * `blank`) it is blank, and before 532 it showed the New chat screen with
 * the scheduled row floating over it. Now a blank chat that holds a
 * scheduled message is a chat page whose only content is that message.
 */
import type { Attachment, SessionEvent } from "./types";
import { clockText } from "./schedule";
import { chatLabel, nameLine } from "./chatLabel";

/** No message in it yet: the Welcome test (review round 1, 2026-09-13). */
export function hasNoTurns(events: readonly SessionEvent[], live: boolean): boolean {
  return (
    !live &&
    !events.some((e) => e.event === "user_message" || e.event === "assistant_message" || e.event === "compaction")
  );
}

/**
 * Which page the open chat gets: `welcome` (nothing in it, nothing
 * waiting), `waiting` (nothing in it but a scheduled message), or `chat`.
 */
export function chatPage(
  events: readonly SessionEvent[],
  live: boolean,
  activeId: string | null,
  scheduledHere: boolean,
): "welcome" | "waiting" | "chat" {
  if (!hasNoTurns(events, live)) return "chat";
  return activeId !== null && scheduledHere ? "waiting" : "welcome";
}

/** `8:31 PM` today, else `Tue 8:31 PM`. */
export function scheduleWhen(ms: number, nowMs: number = Date.now()): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date(nowMs).toDateString();
  return sameDay ? clockText(ms) : `${d.toLocaleDateString([], { weekday: "short" })} ${clockText(ms)}`;
}

/** The chip naming a scheduled message's files: the one name, or a count;
 *  `all` for its hover. Null when there are none. */
export function chipNames(list: readonly Pick<Attachment, "name">[]): { short: string; all: string } | null {
  if (list.length === 0) return null;
  const all = list.map((a) => a.name).join("\n");
  return { short: list.length === 1 ? list[0].name : `${list.length} files`, all };
}

/**
 * A sidebar row's name (backlog 532): its title, else its first message,
 * else — a chat with nothing sent yet — the message scheduled in it, else
 * the words in its box, else "New chat". Before 532 every chat made ahead
 * of its first turn (Send later, prompt layers, kind, folders or a thread
 * set on a New chat) read "empty session".
 */
export function rowName(
  s: { title?: string | null; first_user?: string | null },
  scheduledText: string | null,
  draftText: string | null,
): string {
  return chatLabel(s, "") || nameLine(scheduledText ?? "") || nameLine(draftText ?? "") || "New chat";
}
