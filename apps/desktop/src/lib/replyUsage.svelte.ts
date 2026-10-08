/**
 * The per-reply plan figures (item 323), per chat, as read from the
 * backend's `turn-usage.jsonl`. A turn's line is written when the next
 * reading after it arrives — the next turn's first response, or the plan
 * chip's refresh — so the transcript re-reads on a chat switch, when a
 * turn ends and when the plan reading changes (`Transcript.svelte`).
 */
import { turnUsage } from "./api";
import { byTarget, type TurnUsageLine } from "./replyUsage";

const lines = $state<Record<string, Map<number, TurnUsageLine>>>({});
const EMPTY = new Map<number, TurnUsageLine>();
const seen: Record<string, string> = {};

/** The chat's lines by reply index; empty before the first read. */
export function replyUsageOf(session: string | null | undefined): Map<number, TurnUsageLine> {
  return (session && lines[session]) || EMPTY;
}

/** Re-read the chat's lines; a failed read keeps what was there. */
export async function loadReplyUsage(session: string | null | undefined): Promise<void> {
  if (!session) return;
  try {
    const got = await turnUsage(session);
    // Unchanged: no new map, so no footer redraws.
    const key = JSON.stringify(got);
    if (seen[session] === key) return;
    seen[session] = key;
    lines[session] = byTarget(got);
  } catch {
    // Not in the app (a harness), or the read failed: nothing new to show.
  }
}
