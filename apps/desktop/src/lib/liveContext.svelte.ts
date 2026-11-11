/**
 * Item 590: the newest live context reading per chat (`""` for a New chat's
 * first turn, before it has an id), from the turn's `context_live` events.
 * Read by the right column's dial while that chat's turn runs.
 */
import type { LiveContext } from "./liveContext";

export const liveContext = $state<{ byChat: Record<string, LiveContext> }>({ byChat: {} });

export function noteContextLive(
  chat: string | null,
  ev: { exact_tokens: number; estimate_tokens: number; rough: boolean; steps: number },
  at: number = Date.now(),
): void {
  liveContext.byChat[chat ?? ""] = {
    exact: ev.exact_tokens,
    estimate: ev.estimate_tokens,
    rough: ev.rough,
    steps: ev.steps,
    at,
  };
}

/** The chat's newest reading, or the New chat's while it has no id yet. */
export function liveContextOf(chat: string | null): LiveContext | null {
  return (chat != null ? liveContext.byChat[chat] : undefined) ?? liveContext.byChat[""] ?? null;
}
