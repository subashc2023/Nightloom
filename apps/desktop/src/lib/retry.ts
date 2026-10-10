/**
 * Retry on a reply (nightshift item 333, 2026-10-09): run the prompt that
 * reply answered again. It is edit-and-send (backlog 062) with the words
 * unchanged — a fork of the chat cut before that prompt, the prompt sent
 * as the fork's first turn — so the reply retried is never touched: it
 * stays in the chat it is in, and the fork reads as its other version
 * (‹ 1/2 › under the prompt, *Make main*, backlog 299). One mechanism for
 * the last reply and an earlier one alike (blocker 1330). Pure here; the
 * action is `retry.svelte.ts`.
 */
import { editTexts } from "./edit";
import { liveFlags } from "./state.svelte";
import type { DocumentInput, ImageInput, SessionEvent } from "./types";

/** The prompt a Retry sends again, and where its fork cuts. */
export interface RetryPrompt {
  /** The user message's log index — what `sendEdit` forks before. */
  index: number;
  /** Its words as they read now: the latest live edit, else the original. */
  text: string;
  images: ImageInput[];
  documents: DocumentInput[];
}

/**
 * The prompt the reply at `reply` answered: the nearest live user message
 * before it. Null when `reply` is not a live reply or no prompt precedes
 * it (a chat that opens with a carried reply).
 */
export function retryPrompt(events: SessionEvent[], reply: number): RetryPrompt | null {
  const live = liveFlags(events);
  if (events[reply]?.event !== "assistant_message" || !live[reply]) return null;
  const edited = editTexts(events);
  for (let i = reply - 1; i >= 0; i--) {
    const e = events[i];
    if (!live[i] || e.event !== "user_message") continue;
    return {
      index: i,
      text: edited[i] ?? e.text,
      images: e.images ?? [],
      documents: e.documents ?? [],
    };
  }
  return null;
}

/**
 * Which drawn turns carry Retry: a reply that ends its turn — the last
 * reply before the next prompt (or a compaction, or the end) — so a turn
 * of several tool-step replies shows one button, on its last. A rewound
 * turn is not drawn and is skipped: what follows a reply is the next turn
 * still standing.
 */
export function endsTurn(items: { kind: "user" | "assistant" | "compaction"; superseded: boolean }[]): boolean[] {
  const out = items.map(() => false);
  let next: string | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.superseded) continue;
    out[i] = it.kind === "assistant" && next !== "assistant";
    next = it.kind;
  }
  return out;
}
