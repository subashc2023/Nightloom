/**
 * Item 747: the carry of the reply whose card has *Continue with this
 * prompt*, read from the chat's log as the transcript holds it. Kept apart
 * from `handoffCarry.ts` (pure) and `handoffButton.ts` (the card) because it
 * needs the app's own reading of a log — what a rewind superseded, what he
 * edited or removed. One result is remembered: the transcript asks again on
 * every change to its rows, and the answer changes only with the log.
 */
import { editTexts, elideFlags } from "./edit";
import { buildCarry, type Carry } from "./handoffCarry";
import { liveFlags } from "./state.svelte";
import type { SessionEvent } from "./types";

let last: { key: string; carry: Carry } | null = null;

export function carryFor(chat: string, events: SessionEvent[], reply: number, prompt: string): Carry {
  const key = `${chat}|${events.length}|${reply}|${prompt.length}`;
  if (last?.key === key) return last.carry;
  const carry = buildCarry({
    events,
    live: liveFlags(events),
    reply,
    prompt,
    edited: editTexts(events),
    elided: elideFlags(events),
  });
  last = { key, carry };
  return carry;
}
